# Boopy context service

Runs on the Mac. The headset sends it what it saw and heard; it transcribes, reads text,
interprets, records corrections, commits context packages, and serves them to agents. The design
is in [../docs/architecture.md](../docs/architecture.md).

`src/interaction/` is a separate journal projection for task revisions, source identity, user
actions, and stale-result rejection. Its views are `local-only` and `not-sent`. Under a practice
goal it calls Zetaris on this Mac for the subject's word (see "Practice with Zetaris and memory");
it never calls Grok or NVIDIA. The older activity file loop remains in `src/activity.ts`.

## Requirements

- Node.js 24.15 or newer, pnpm.
- Xcode's Swift compiler, for the OCR tool.
- whisper.cpp with `large-v3-turbo` and the Silero VAD model. A build under
  `~/.halcyonic/speech` is used when present. Otherwise set the `BOOPY_WHISPER_*` variables.
- An interpreter: Ollama with a local vision model (default `qwen3.6:35b-a3b-nvfp4`), or a Meta
  Model API key for Muse Spark, or the recorded fixture.
- Optional recorded-media inspect/decode requires existing FFmpeg and FFprobe at
  `/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe`. Version 8.1.1 is runtime verified.
  The real codec tests also require the installed `libx264`, `libx265` and AAC encoders. No tool
  is installed or alternate path selected automatically. This local preflight is separate
  from the service's ordinary live input path.

## Run

```bash
pnpm install
pnpm ocr:build
pnpm start
```

Stop it with Ctrl-C or SIGTERM. Boopy takes no new connections, lets requests in progress finish
for up to 10 s, closes each kept connection as soon as its response ends, and exits. Requests
still running after 10 s are cut. A session start cut this way is marked interrupted when
the service starts again. Another Ctrl-C does not cut the stop short.

Then, without a headset, drive a whole session and read it back over MCP:

```bash
pnpm simulate
```

For an explicit fixture configuration, copy `.env.example` to the ignored `.env` in `service/`
and run `node --env-file=.env src/main.ts`. `pnpm start` does not load `.env` automatically.
The example disables hosted segmentation and request logging, uses fixture interpretation and
stores its journal/token in the ignored `.data/` directory. It does not connect to Muse or any
sponsor. Use only synthetic inputs for a shareable rehearsal; the simulator may still use locally
available OCR tooling. Any optional real key belongs only in the private env/key file.

```bash
pnpm simulate --image fixtures/images/korean-notes.jpg --say "Help me study these notes" --gaze 0.42,0.37
```

Each run writes a picture of the model's grounding to `.build/preview-<session>.jpg`.
If the initial interpretation fails or contains no model proposals, simulation exits with an
error before applying corrections or committing context.

To reach the service from a Quest connected by USB:

```bash
adb reverse tcp:47900 tcp:47900
```

Unity's Android builds restart adb, which drops the mapping; run it again after each build.

## Configuration

All optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOOPY_INTERPRETER` | `ollama` | `ollama`, `muse-spark` or `fixture` |
| `BOOPY_OLLAMA_MODEL` | `qwen3.6:35b-a3b-nvfp4` | A vision model as Ollama lists it, such as `muse-glimmer:30b-mlx` |
| `BOOPY_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama's address |
| `BOOPY_ACTIVITY_ASSISTANT` | `ollama` | Local activity calls; `none` disables them |
| `BOOPY_ACTIVITY_MODEL` | `qwen3.6:35b-a3b-nvfp4` | Only this verified local artifact is accepted; tags/show preflight checks its pinned digest before each prompt |
| `BOOPY_OLLAMA_THINK` | off | `1` lets the model reason first: slower |
| `MODEL_API_KEY` | `$BOOPY_DATA_DIR/model-api-key` when unset | Meta Model API key, for `muse-spark`; environment value takes precedence |
| `BOOPY_MUSE_MODEL` | `muse-spark-1.3` | Standard tier only; Contributor models train on prompts and are refused |
| `BOOPY_SEGMENTER` | `none` | `none` keeps approximate model boxes; `sam` explicitly enables hosted Meta SAM 3.1 contours for up to four grounded objects per capture |
| `BOOPY_DATA_DIR` | `~/.boopy` | Journal, media, connector token, optional model API key |
| `BOOPY_PORT` | `47900` | Headset API, loopback only |
| `BOOPY_CONNECTOR_PORT` | `47901` | Agent connector, loopback |
| `BOOPY_CONNECTOR_URL` | `http://127.0.0.1:47901` | The URL agents use, when a tunnel fronts the connector |
| `BOOPY_WHISPER_BIN`, `BOOPY_WHISPER_MODEL`, `BOOPY_WHISPER_VAD_MODEL` | `~/.halcyonic/speech` when present | whisper.cpp |
| `BOOPY_OCR_BIN` | `.build/boopy-ocr` | The OCR tool |
| `BOOPY_LOG` | on | `0` silences request logs |
| `BOOPY_ZETARIS_PRACTICE_CREDENTIAL_FILE` | unset | The practice account's two-line 0600 file; setting it turns practice on |
| `BOOPY_ZETARIS_TERMS` | none | Folder holding `wikidata_term.csv` and its receipt; required with practice |
| `BOOPY_ZETARIS_PRACTICE_TABLE` | none | `practice_attempt`, or `practice_check` for checks; required with practice |
| `BOOPY_PROBE_JAR` | none | The Zetaris JDBC driver jar the runner uses |
| `BOOPY_GROK_BOT_WEBHOOK_FILE` | unset | A 0600 JSON file with your Grok Bot routine's webhook; setting it sends each boop moment there |

For Muse Spark, store the key yourself in `~/.boopy/model-api-key` (or under
`BOOPY_DATA_DIR`) with mode `0600`. When `MODEL_API_KEY` is unset, the service reads that file
and trims surrounding whitespace. A missing, unreadable, empty or incorrectly permissioned file
stops startup with an error that does not include the key. An explicitly empty `MODEL_API_KEY`
also stops startup; it does not fall back to the file. Local and fixture interpreters do not
read or require this key.

After copying the key, store it locally without pasting it into chat:

```bash
mkdir -p ~/.boopy
(umask 077; pbpaste > ~/.boopy/model-api-key)
chmod 600 ~/.boopy/model-api-key
```

Then run `BOOPY_INTERPRETER=muse-spark pnpm start`. Muse Spark uses the Standard-tier
`muse-spark-1.3` model with `reasoning_effort: minimal` for interactive latency; Contributor models
are refused because they train on prompts. Requests time out after 60 seconds.

Segmentation is independently opt-in: `BOOPY_SEGMENTER=sam pnpm start` uses `sam-3.1` through
Meta's Responses API, even when interpretation uses local Qwen. This sends the **full original
frame** to Meta for each distinct concept request. It reads the same private Model API key.
One interpretation can propose several visible objects or text-bearing surfaces with individual
boxes; saying "the whole scene" on the first capture sets scene scope before interpretation.
Targeted requests such as "this" retain their normal referent selection. SAM refines up to four
fresh, model-proposed boxed items, primary referent first, then objects/text in proposal order.
Existing confirmed, rejected or person-created items are preserved. The default `none`
neither reads a key for segmentation nor sends a frame to a hosted segmenter.

SAM accepts one noun-phrase concept per request and returns matching instances. Repeated labels
(ignoring case and surrounding whitespace) share one response; distinct concepts need separate
requests. At most two requests run concurrently, within a shared 12-second refinement deadline.
Completed results survive that deadline; pending work is cancelled and queued work is skipped.
Four distinct concepts cost up to $0.01 at the documented $0.0025 per image request. Actual
multi-object latency on this Mac/headset has not been measured.

The primary item uses the capture point when available; secondary items require mask-box IoU
of at least 0.5. Multiple matching masks or a shared instance assigned to two same-concept items
are ambiguous. Items beyond the four-item limit keep approximate boxes. A valid selected mask
adds a proposed contour while
retaining the interpreter's original box. Detector confidence, provider, latency, source frame,
utterance and private mask hash remain separate from semantic confidence and person verification.
Empty results, ambiguous cue matches, invalid/complex masks or request failures preserve the
original interpretation and report unavailable outlines as approximate boxes. Significant holes
or disconnected regions need richer mask rendering; the current contour may omit tiny extra
boundaries within a 1% area budget. Cropped or occluded objects remain partial: segmentation
cannot recover their invisible edges.

## Interfaces

Headset API on `127.0.0.1:47900`, contracts in `src/contracts.ts`:

`GET /v1/health` reports the configured interpreter and segmenter provider/model (`null` when
segmentation is disabled). It does not contact providers or prove that a hosted request works.

| Route | Does |
| --- | --- |
| `POST /v1/sessions` | Frame, cues and speech at the start of a pinch; answers with the interpretation |
| `POST /v1/sessions/:id/utterances` | Anything said next: a correction, a new question, "use the whole scene", "save it" |
| `POST /v1/sessions/:id/actions` | A pinch on a card: confirm, reject, ignore, known, matters, reset |
| `POST /v1/sessions/:id/commit` | Commit the session as a context package |
| `GET /v1/sessions/:id` | The session as the headset renders it |
| `POST /v1/sessions/:id/task` | The session's one task, opened from its first completed visual turn with a local stand-in result |
| `POST /v1/tasks/:taskId/answers` | A spoken answer as WAV, transcribed on the Mac and recorded on the task |
| `POST /v1/tasks/:taskId/actions` | Wrong subject, save for later, retry, or cancel |
| `GET /v1/tasks/:taskId` | One task view, or `null` |

Task views are always `local-only` and `not-sent`. See [Interaction](../docs/protocol.md).

Connector on `127.0.0.1:47901`, bearer token from `$BOOPY_DATA_DIR/connector-token`:

| Route | Does |
| --- | --- |
| `/mcp` | MCP over Streamable HTTP: tools `search` and `fetch`, resources `boopy://context/{id}` |
| `GET /v1/context?query=` | Search committed context, newest first |
| `GET /v1/context/:id` | One context package |
| `GET /openapi.json` | The REST API as OpenAPI 3.1, no token needed |

Every context read by an agent is journaled as a disclosure, including titles returned by MCP
resource listings. All connector routes except `/health` and `/openapi.json` require bearer auth,
including encoded URL variants. A configured empty/whitespace-only token is rejected. The published connector
URL must be HTTP(S) and cannot contain credentials, a query or a fragment, because it appears
in public OpenAPI metadata and returned package links. The bearer token authorizes all committed
packages in that data directory, not a selected package. A tunnel in front of the connector
is a separate choice. Muse does not fetch context on its own.

Packages and connector descriptions say **committed context**, not that every claim is verified.
Untouched model claims remain accepted/unconfirmed. A commit does not establish that someone
opened Review, and a package is not a guarantee of the latest cross-session correction.

To try it from Claude Code on this Mac:

```bash
claude mcp add --transport http boopy http://127.0.0.1:47901/mcp --header "Authorization: Bearer $(cat ~/.boopy/connector-token)"
```

## Assistant activity files

For practice without file moves, first prepare the saved package through the existing local
handoff preparation, then run `pnpm activity ask --package ctx_ID --goal "your goal"`. This
starts one asynchronous local-model call and polls its outcome. An attempt submitted on a called
activity automatically asks the local model for a reply; file-imported activities keep the manual
flow below. Called content remains proposed, with known provider/model provenance. Nothing invalid
is imported and there is no invented fallback. The headset offers practice when `/v1/health`
advertises `activityAssistant`; health reports configuration, not current model availability.

The local model is pinned to the section 11 digest and metadata. Loopback transport alone does not
prove local inference: Ollama supports cloud models. Every call first checks bounded `/api/tags`
and `/api/show` metadata and refuses changed, missing or remote models without sending prompt
content. This trusts the installed local Ollama process. No cloud provider is configured. All
metadata and generation work shares a 120-second deadline; only one call runs, with no queue or
retry. A stop grants the existing 10-second grace then aborts; startup records unfinished calls as
interrupted without replaying them. The CLI exits 0 for ready practice, 1 for a failed/interrupted
call or wait timeout, and 2 for a refused request. The authenticated local routes are
`POST /v1/local-activities/practice-requests` and `GET /v1/local-activities/calls/:callId`.

`BOOPY_ACTIVITY_ASSISTANT=none` disables calls; the headset health capability disappears. When
enabled, `BOOPY_OLLAMA_URL` must be credential-free loopback HTTP with no path, query or fragment.
See [local model calls](../docs/activity-contract.md#11-local-model-calls).

The manual path in [the activity contract](../docs/activity-contract.md) moves through files
the person chooses to share. Boopy writes and reads them on the Mac; it never sends them.

```bash
pnpm activity request --package ctx_ID --goal "Practice saying where things are in Korean" --out-dir ~/Desktop
```

```bash
pnpm activity import --file ~/Downloads/activity.json
```

```bash
pnpm activity export --submission sub_ID --out-dir ~/Desktop
```

```bash
pnpm activity reply --file ~/Downloads/reply.json
```

- `request` needs one completed local handoff preparation for the package, or
  `--preparation REQUEST_ID` when there are several. It writes
  `boopy-activity-request-<requestId>.json`. Optional: `--language` (the person's language tag,
  default `en`) and `--background` (the person's own note, such as a level).
- `import` and `reply` take the assistant's `.json` file: the whole file is one JSON object, or the
  file holds exactly one fenced block labelled `json`. A reply with a next activity creates it.
- `export` writes `boopy-activity-submission-<submissionId>.json` for a submission made in the
  headset. Exporting again gives the same bytes.
- Common options: `--data-dir` (default `$BOOPY_DATA_DIR` or `~/.boopy`, where the connector token
  is read) and `--port` (default `$BOOPY_CONNECTOR_PORT` or `47901`). The service must be running.

Output files are new files with mode 0600, and an existing file is never overwritten. `export`
knows its file name, so it creates that file before asking the service: an existing file or link
refuses the export before anything is recorded. When a command fails or is stopped (Ctrl-C or
SIGTERM) before its output file is fully written, that file is removed, so no partial file is left
and the next export into the folder is not refused. Only the file the command created is removed:
it compares the name with the file it still holds open (device and inode, read at that moment,
since FAT32 and exFAT volumes renumber a file once it holds data), and leaves alone a file another
process has put at that name since; only a volume that gave another file the open file's number
could make the two look alike. If the name no longer holds the file the command wrote, or cannot
be checked, the command says so and fails instead of reporting the file as written, and it removes
nothing it could not confirm as its own. A write that fails after the service answered leaves the
export recorded; exporting into another folder gives exactly the recorded bytes. `request` gets
its file name from the service, so it first creates a private probe file in the output folder and
removes it again, also when stopped; nothing is requested when the folder cannot take a new file.
Inputs must be regular files of at most 64 KiB of UTF-8, not links, folders or devices. Each
command prints a short message to paste beside the attachment.

`node probes/activity-loop.mjs` runs the whole loop with synthetic content on a separate service it
starts itself (ports 47910 and 47911 by default, never 47900 or 47901 or a port in use, and a new
private folder under `.data/activity-loop/`), restarts it on the same journal, and prints the
checks that passed.

The commands use the connector's local-only routes under `/v1/local-activities/`: bearer token,
loopback Host and peer, and no Origin or forwarding headers. They are not in OpenAPI or MCP. The
headset lists, reads and changes activities on `/v1/activities` (view, arrangement, sequence,
hints and submissions), which refuse any browser Origin.

## A reply from a named connection

The person can take a task to a chat they name, such as one with their own assistant, and bring
its reply back by hand. Boopy sends nothing; see [Interaction](../docs/protocol.md). The
commands need `BOOPY_CONNECTION_REPLIES=1` on the service, which is off by default until the
headset can say which connection a reply came through.

- `pnpm task connect --label "your name for it"` names the connection and prints its `con_` id.
- `pnpm task request --task tsk_ID --connection con_ID --out-dir FOLDER` writes
  `boopy-request-<id>.json` as a new 0600 file in that folder. It checks the folder before it
  asks for anything and never overwrites a file.
- `pnpm task reply --file REPLY.json` reads a regular file of at most 16 KiB, never through a
  link, and says which connection the reply came through. A reply that does not answer that
  exact request is refused, and the command says why.

The commands use the connector's local-only routes under `/v1/local-tasks/`: bearer token,
loopback Host and peer, and no Origin or forwarding headers. They are not in OpenAPI or MCP, and
the headset API has none of them.

## Practice with Zetaris and memory

With the four `BOOPY_ZETARIS_*`/`BOOPY_PROBE_JAR` settings, the service checks the word list against
its receipt at start (a mismatch stops the start), makes one warm-up pick, and logs
`Zetaris practice ready.`. Zetaris runs locally in Docker on loopback; see
[the Zetaris probes](probes/zetaris/README.md) for the import, the tables and the account.

```bash
pnpm task goal --language ko        # the person's own goal, journaled as theirs; --off ends it
pnpm trace                          # every session with a practice retrieval, from the journal
pnpm trace ses_ID                   # one session
```

`pnpm task goal` and `pnpm trace` take `--data-dir`/`--port` and `--journal` like the other local
commands, and default to `$BOOPY_DATA_DIR` or `~/.boopy`. The trace is read-only and prints no
words the person said, no transcript, no OCR text, no path and no frame.

The practice table in Zetaris is a copy of the journal's practice records (ids, the item, the
language, the result, the time). It lives in the Zetaris stack's own Docker volume under
`shared/boopy/`. To empty it:

```bash
printf 'end\n' | node probes/zetaris/run-federation.mjs /absolute/private/practice-credential-file practice-stage
```

## Moments to your Grok Bot

With `BOOPY_GROK_BOT_WEBHOOK_FILE` set, each boop moment also goes to your own Grok Bot, so you
can pick it up later from your other devices. The file is yours to make, mode `0600`:

```json
{ "url": "https://...your routine's webhook URL...", "key": "crsr_... or whsec_..." }
```

The service refuses a file others can read, a URL that is not https, and any other kind of key. A
`crsr_` key goes as a Bearer token; a `whsec_` secret signs each body the Standard Webhooks way
(`webhook-id`, `webhook-timestamp`, `webhook-signature`). The key and the URL are never logged or
journaled.

A moment goes out when a task opens and again, with the same `momentId`, after each answer Boopy
assesses, in the background, so a turn never waits: one POST, a 10 s bound, no retry. Its JSON body holds `source`
`"Boopy"`, `kind` `"moment"`, `momentId`, one plain `message` sentence for the Bot to read first,
`subject` (Boopy's guess), `term` (`text`, `language`, `source`), `heard` (`true`, `false`, or
`null` before an answer), `memory` (the line Boopy's memory of earlier practice shaped, if any),
`recorded` (`true` for recorded footage), and on the opening's moment `image`: the view around
where you looked, the subject's box drawn on it, as a JPEG of about 40 KB or less with no capture
metadata. No transcript, capture time or place is sent.

The journal records `grokbot.delivery.started` (with the Bot's run id when it gives one) or
`grokbot.delivery.failed` (the HTTP status only). A started delivery means the Bot's run began,
not that it finished. Only after one has started for a task does that task's view carry
`"sentTo": "grok-bot"`. An opening's own response comes before its moment is sent, so the headset
sees the field when it next reads the task.

## Check

```bash
pnpm check
```

Typecheck, lint and tests. Tests use synthetic images and test doubles; nothing reaches a model.
Recorded-media path, container, probe, limit, child-budget and privacy guards use generated
structural containers and test doubles, so they run without optional FFmpeg tools. Separate
H.264/MOV and HEVC/MP4 integration tests generate temporary synthetic clips with installed tools;
they explicitly skip with a reason when either tool is unavailable. The synthetic AAC audit case
also skips without those tools. A skipped codec test provides no codec proof; check the reported
pass and skip counts. An installed encoder that fails to generate its fixture fails the test.


## Bounded conversation rehearsal

`pnpm demo:readiness` checks the fixed local provider prerequisites without reading configuration,
keys, context or media. Its `providerPrerequisitesReady` result is separate from service reachability
and unverified headset state. It starts nothing.

`pnpm probe:local` uses isolated synthetic fixture data and real ephemeral loopback REST/MCP.
`pnpm probe:local-model` uses synthetic repo imagery and file-only speech with the actual local
Whisper, Vision OCR, Qwen and MacSay adapters. It exercises generated-question selection, exact
source/proposal provenance, context preparation and readback. It does not play audio or contact
Muse. The model must already be available at loopback 11434; no hosted fallback is used.

## Local scene outlines and voice

Two optional local providers. Both use model directories on this Mac and are warmed before the
headset listener opens. They make no hosted calls and do not fall back to another provider.

- `BOOPY_LIVE_SCENE=local` requires `BOOPY_SCENE_PYTHON`, `BOOPY_SCENE_DETECTOR`, and
  `BOOPY_SCENE_SEGMENTER` absolute paths. `POST /v1/scene/observe` accepts one UUID-tagged frame and
  returns proposed Grounding DINO/SAM2 contours with the source and mask ids. Each outline's name is
  the single vocabulary word the detector scores highest for that box, its confidence is that word's
  own score, and it stays a proposal; a box whose best word is under the text threshold, or exactly
  tied with another word, is left out. An outline whose edges cross or touch is left out with its
  object, never reshaped, and the scene journal counts how many each frame left out. The separate
  scene journal keeps geometry and hashes, not image bytes. No live observation enters a Muse
  package.
- `BOOPY_SPEECH_OUTPUT=qwen` requires `BOOPY_VOICE_PYTHON` and `BOOPY_VOICE_MODEL` absolute paths.
  The selected model is Qwen3-TTS 1.7B 8-bit, with one Sohee voice across English/Korean. Output is
  native 24 kHz PCM16. Synthesis failures leave captions; there is no system-voice fallback.

Do not run a second service against the same journal. These providers stay off unless the
paths above are set. Neither is required to run the service.
