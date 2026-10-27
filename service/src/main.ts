import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityStore } from './activity.ts';
import { ActivityCalls } from './activity-call.ts';
import { OllamaActivityAssistant } from './activity-ollama.ts';
import { Boopy } from './boopy.ts';
import { connectorToken, loadConfig } from './config.ts';
import { GrokBotMoments, loadGrokBot } from './grok-bot.ts';
import { HandoffPreparation } from './handoff-preparation.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { CLOSE_GRACE_MS } from './http/shutdown.ts';
import type { PracticeLink } from './http/tasks.ts';
import { TaskStore } from './interaction/tasks.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { Interpreter } from './interpret/interpreter.ts';
import { MuseSparkInterpreter } from './interpret/muse-spark.ts';
import { OllamaInterpreter } from './interpret/ollama.ts';
import { Journal, MediaStore } from './journal.ts';
import { LiveObservation } from './live-observation.ts';
import { LocalScenePerceiver } from './live-scene/local-scene.ts';
import { NvidiaEmbeddingWorker } from './memory/nvidia.ts';
import { practiceRows } from './memory/practice.ts';
import { VisionTextReader } from './ocr.ts';
import { assertNoLiveCaptures, RecordedScenes } from './recorded-source.ts';
import { readTermSnapshot } from './references/wikidata.ts';
import { pickTerm, stagePractice } from './references/zetaris.ts';
import { SamSegmenter } from './segmentation.ts';
import { WhisperEngine } from './speech.ts';
import { QwenSpeechOutput } from './speech-output/qwen.ts';
import { MacSayOutput } from './speech-output.ts';

const SERVICE = 'boopy-service 0.1.0';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const interpreter: Interpreter =
  config.interpreter.kind === 'fixture'
    ? new FixtureInterpreter()
    : config.interpreter.kind === 'ollama'
      ? new OllamaInterpreter(config.interpreter)
      : new MuseSparkInterpreter(config.interpreter);

let neuralVoice = config.neuralVoice ? new QwenSpeechOutput(config.neuralVoice) : null;
let sceneProvider = config.liveScene ? new LocalScenePerceiver(config.liveScene) : null;
// Prewarm with synthetic content before the headset can send a first request.
// Optional worker failure must not take away core conversation or advertise a failed capability.
if (sceneProvider) {
  try {
    await sceneProvider.ready();
  } catch {
    await sceneProvider.close();
    sceneProvider = null;
    console.warn('Local live scene unavailable; explicit conversation remains available.');
  }
}
if (neuralVoice) {
  try {
    await neuralVoice.synthesize('Hello. What would you like to explore?', 'en');
  } catch {
    neuralVoice.close();
    neuralVoice = null;
    console.warn('Local neural voice unavailable; captions remain available.');
  }
}
const sceneJournal = sceneProvider ? Journal.open(join(config.dataDir, 'live-scene.sqlite')) : null;
const liveScene =
  sceneProvider && sceneJournal ? new LiveObservation(sceneProvider, sceneJournal) : undefined;
const journal = Journal.open(join(config.dataDir, 'journal.sqlite'));
const media = new MediaStore(join(config.dataDir, 'media'));
// Recorded footage runs on its own data folder: a journal with a live capture is refused.
if (config.recordedScene) assertNoLiveCaptures(journal);
const recorded = config.recordedScene
  ? new RecordedScenes({
      journal,
      media,
      directory: join(config.dataDir, 'recorded'),
      helper: config.recordedScene.helper,
      ...(sceneProvider ? { outliner: { scene: sceneProvider, interpreter } } : {}),
    })
  : null;
const boopy = new Boopy({
  journal,
  media,
  recorded,
  interpreter,
  speech: config.whisper === null ? null : new WhisperEngine(config.whisper),
  text: config.ocrBinary === null ? null : new VisionTextReader(config.ocrBinary),
  segmenter: config.segmenter === null ? null : new SamSegmenter(config.segmenter),
  service: SERVICE,
  speechOutput: neuralVoice ?? (config.speechOutput === 'mac-say' ? new MacSayOutput() : null),
});

const semanticRanker = config.semanticMemory
  ? new NvidiaEmbeddingWorker(config.semanticMemory)
  : undefined;
if (semanticRanker) {
  try {
    await semanticRanker.rank({
      query: 'Synthetic startup check',
      candidates: [{ sourceId: 'synthetic-startup', text: 'Synthetic startup check only.' }],
    });
    console.log('Local semantic memory ready.');
  } catch {
    console.warn('Local semantic memory unavailable; lexical memory remains available.');
  }
}
const handoff = new HandoffPreparation({
  journal,
  dataDir: config.dataDir,
  outputRoot: join(config.dataDir, 'handoffs'),
  port: config.connectorPort,
  referenceCredentialFile: config.referenceCredentialFile,
  packageForId: (id) => boopy.package(id),
  sessionForId: (id) => boopy.view(id),
  supersessions: () => boopy.supersessions,
});
const activities = new ActivityStore({
  journal,
  preparation: handoff,
  packageForId: (id) => boopy.package(id),
  supersessions: () => boopy.supersessions,
});
const activityCalls = config.activityAssistant
  ? new ActivityCalls({
      store: activities,
      assistant: new OllamaActivityAssistant(config.activityAssistant),
    })
  : undefined;
const tasks = new TaskStore(journal);
// Zetaris on this Mac for practice under the person's goal, checked against the import's receipt.
const practiceSettings = config.practice;
const practice: PracticeLink | undefined = practiceSettings
  ? await (async () => {
      const snapshot = await readTermSnapshot(
        join(practiceSettings.termsDirectory, 'wikidata_term.csv'),
        join(practiceSettings.termsDirectory, 'wikidata_term.receipt.json'),
      );
      return {
        table: practiceSettings.table,
        // With the opening's wait for the Grok Bot (at most 6 s from the request), an open stays
        // inside the headset's own 10 s limit.
        timeoutMs: 6_000,
        pick: (request, signal) =>
          pickTerm({
            request,
            credentialFile: practiceSettings.credentialFile,
            snapshot,
            signal,
            // The caller's signal bounds each call; this is only a backstop.
            timeoutMs: 60_000,
          }),
        stage: (rows, signal) =>
          stagePractice({
            table: practiceSettings.table,
            rows,
            credentialFile: practiceSettings.credentialFile,
            signal,
            timeoutMs: 60_000,
          }),
      } satisfies PracticeLink;
    })()
  : undefined;
// The person's own Grok Bot: each boop moment goes there when they name a webhook file.
const grokBot = config.grokBotWebhookFile
  ? new GrokBotMoments(journal, await loadGrokBot(config.grokBotWebhookFile))
  : undefined;
const headset = headsetApp(boopy, {
  logger: config.logger,
  liveScene,
  handoff,
  activities,
  activityCalls,
  tasks,
  ...(practice ? { practice } : {}),
  ...(grokBot ? { grokBot } : {}),
  ...(recorded ? { recorded } : {}),
});
const connector = connectorApp(boopy, {
  token: connectorToken(config.dataDir),
  baseUrl: config.connectorBaseUrl,
  memory: config.memory === 'hmem',
  semanticRanker,
  handoff,
  activities,
  activityCalls,
  ...(config.connectionReplies ? { tasks } : {}),
  ...(practice ? { goal: tasks } : {}),
  ...(recorded ? { recorded } : {}),
  logger: config.logger,
});

await headset.listen({ host: '127.0.0.1', port: config.headsetPort });
await connector.listen({ host: '127.0.0.1', port: config.connectorPort });

console.log(
  [
    `${SERVICE}`,
    `  headset API   http://127.0.0.1:${config.headsetPort} (reach it from the Quest with: adb reverse tcp:47900 tcp:${config.headsetPort})`,
    `  connector     ${config.connectorBaseUrl}/mcp and /v1/context (token in ${join(config.dataDir, 'connector-token')})`,
    `  interpreter   ${interpreter.provider}:${interpreter.model}`,
    `  segmentation  ${config.segmenter === null ? 'off (approximate boxes)' : 'Meta SAM 3.1 (hosted)'}`,
    `  speech        ${config.whisper === null ? 'off (whisper.cpp not found)' : 'whisper.cpp'}`,
    `  text          ${config.ocrBinary === null ? 'off (run pnpm ocr:build)' : 'Apple Vision'}`,
    `  recorded      ${recorded ? 'on: recorded scenes from the local operator' : 'off'}`,
    `  practice      ${practiceSettings ? `Zetaris on this Mac, ${practiceSettings.table}` : 'off'}`,
    `  grok bot      ${grokBot ? 'on: each boop moment goes to your Grok Bot' : 'off'}`,
  ].join('\n'),
);
// One pick at start, so the first boop does not wait for the engine's cold start. It also brings
// the practice table in line with the journal.
if (practice)
  practice
    .pick(
      {
        table: practice.table,
        targetLanguage: 'en',
        personLanguage: 'en',
        matchKey: 'start',
        sourceId: 'src_start',
        recalled: [],
        excluded: [],
        rows: practiceRows(tasks.practiceRecords()),
      },
      AbortSignal.timeout(60_000),
    )
    .then(
      () => console.log('Zetaris practice ready.'),
      () => console.warn('Zetaris practice did not answer at start; a task will say so.'),
    );

let stopping = false;
const stop = async () => {
  // One stop only: a further SIGINT or SIGTERM is ignored, never a forced exit.
  if (stopping) return;
  stopping = true;
  console.log(`Stopping: requests in progress have up to ${CLOSE_GRACE_MS / 1000} s to finish.`);
  // Servers first, so requests in progress keep the workers they use until they finish.
  await Promise.allSettled([
    headset.close(),
    connector.close(),
    activityCalls?.close(CLOSE_GRACE_MS),
  ]);
  neuralVoice?.close();
  semanticRanker?.close();
  await sceneProvider?.close();
  sceneJournal?.close();
  journal.close();
  // Journal appends are synchronous, so none can be part way through when the process exits.
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
