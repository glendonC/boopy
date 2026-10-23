import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityStore } from './activity.ts';
import { ActivityCalls } from './activity-call.ts';
import { OllamaActivityAssistant } from './activity-ollama.ts';
import { Boopy } from './boopy.ts';
import { connectorToken, loadConfig } from './config.ts';
import { HandoffPreparation } from './handoff-preparation.ts';
import { connectorApp } from './http/connector.ts';
import { headsetApp } from './http/headset.ts';
import { CLOSE_GRACE_MS } from './http/shutdown.ts';
import { TaskStore } from './interaction/tasks.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import type { Interpreter } from './interpret/interpreter.ts';
import { MuseSparkInterpreter } from './interpret/muse-spark.ts';
import { OllamaInterpreter } from './interpret/ollama.ts';
import { Journal, MediaStore } from './journal.ts';
import { LiveObservation } from './live-observation.ts';
import { LocalScenePerceiver } from './live-scene/local-scene.ts';
import { NvidiaEmbeddingWorker } from './memory/nvidia.ts';
import { VisionTextReader } from './ocr.ts';
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
const boopy = new Boopy({
  journal,
  media: new MediaStore(join(config.dataDir, 'media')),
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
const headset = headsetApp(boopy, {
  logger: config.logger,
  liveScene,
  handoff,
  activities,
  activityCalls,
  tasks,
});
const connector = connectorApp(boopy, {
  token: connectorToken(config.dataDir),
  baseUrl: config.connectorBaseUrl,
  memory: config.memory === 'hmem',
  semanticRanker,
  handoff,
  activities,
  activityCalls,
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
  ].join('\n'),
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
