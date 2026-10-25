# Interaction

Code: `service/src/interaction/contract.ts`, `service/src/interaction/tasks.ts`,
`service/src/interaction/stand-in.ts`, and `service/src/http/tasks.ts`.

This is the general task path. Arrange and sequence files stay in
[Activities](activity-contract.md). New tasks do not go through that file format.

## Opening a task

A task points at one source: an id, a revision, and the SHA-256 of the source bytes. The
person's words are stored as they said them. Opening a task does not create a lesson, a line
of dialogue, or a story about the person.

Intents:

- `continue_saved_task`
- `consult_source`
- `save_for_later`

The store does not behave differently per intent. Both a speaking task and a manual lookup
use the same actions and the same parts. That is covered by `tasks.test.ts`. It is not a
second headset scene.

## What an assistant may return

`subject`, `annotation`, `dialogue`, `choice`, `voice_reply`, `task_step`, `detail`,
`agent_presence`. At most one of each. At least one of dialogue, choice, voice reply, or task
step. A subject must name the task's source. Labels and dialogue must cite ids included in
that result.

The assistant cannot set status, delivery, or continuity. Every task view says:

- continuity is local only
- delivery is not sent

An extra field claiming a live assistant connection is rejected. An accepted assistant result
is marked as a local stand-in.

Status lines: `checking`, `cant-read-label`, `wrong-item`, `try-again`, `not-sent`,
`still-checking`, `continue-later`.

## Actions

`voice_reply`, `wrong_subject`, `save_for_later`, `retry`, `cancel`.

A spoken answer is kept as a practice attempt, including whether recognition was uncertain.
It is not written onto the source, and it is not a confirmed story about the person.

`wrong_subject` clears the assistant's parts, shows "Wrong item", and leaves the source id,
revision, and digest unchanged.

`cancel` closes the task. Later actions and replies are refused and do not change the revision.

## Conflicts

- The same event id and the same payload is ignored the second time.
- The same event id and a different payload is refused.
- An action that names an old revision is refused. The task does not change. A retry needs a
  new event id.
- An assistant reply that names an old revision does not replace the current interaction.
- A reply whose source id, revision, or digest differs is refused.

## The session's task

`POST /v1/sessions/{sessionId}/task` takes `{ "eventId": "evt_...", "taskId": "tsk_..." }`
and answers with the session's task view. A session has one task. When the session already
has a task with its first result, the route returns that task and does not use the ids in the
body.

Otherwise the route opens the task from the session's first completed visual turn. That turn
must hold Boopy's latest reply in the session. That reply must carry no choice card, because a
choice is the reply's own action and a task would add a second one. The selected subject must
be grounded on that turn's view and must not be rejected or ignored. When the model names no
subject and the person did not ask about the whole scene, the subject is the one proposed object
or text box that holds a cue on a surface at most 0.8 m away and whose own median depth is at
most 0.8 m, and otherwise it stays unknown. The person's words for that turn must be one line of
1 to 400 characters. A session without such a turn gets 409 `task_unavailable`, and nothing is
journaled. An unknown session gets 404. An event id that any journal event already holds gets
409 `duplicate_conflict`. A task id that names another session's task gets 409 `task_exists`.

A task the session already has at revision 0, without a first result, gets one only when its
opening matches that turn. Otherwise the route answers 409 `task_unavailable` and does not
serve the task without its result.

The task's source is that turn's observation: `src_` and the observation id, revision 1, and
the SHA-256 of the frame stored for it. The intent is `consult_source`. The utterance is the
person's words for that turn, exactly as stored. The system is the actor of this opening,
because Boopy opens the task from the person's turn. A task opened directly in the task store
has the person as its actor.

## The local stand-in result

The route records one result with the opening, against revision 0, so the view starts at
revision 1. The result is Boopy's own turn shown as task parts. It is not the person's
assistant, and the journal marks it `simulator: true`. The system is its actor.

The parts are, in order: a subject on the task's source, an annotation with the subject's
label, and a dialogue line with Boopy's reply. A voice reply that prompts "Answer." follows only
when that line asks the person something, which means it ends with a question mark before any
closing quotes or brackets. The annotation cites the subject's item id, and so does the
dialogue unless the cue chose the subject: then it cites Boopy's own reply item, and without
one no task opens. A label or reply that breaks the display rules is left out. It is never
shortened or rewritten. Without Boopy's line there is nothing to answer, so a reply that is
left out opens no task, and the route answers 409 `task_unavailable`.

The opening and the result are appended in one journal transaction. Both are kept, or neither
is. The result id is derived from the session, the reply's utterance, and the reply's time, so
a retry names the same result.

## Answers

`POST /v1/tasks/{taskId}/answers` takes `{ "eventId", "sessionId", "expectedRevision",
"speech": { "wav": "<base64 WAV>" } }`. An answer is audio only. The Mac transcribes it with
the same local recognizer that session turns use. No interpreter runs. The answer starts no
session turn and adds no result.

The transcript is recorded as a `voice_reply` attempt. The recognizer gives no confidence for
its words, so `recognitionUncertain` is always `true`. An unknown confidence is not a certain
one. The journal keeps the SHA-256 of the audio and the recognizer's name with the answer. The
audio itself is not stored. The attempt in the task view has only its event id, text,
`recognitionUncertain`, and kind.

The route checks the event id, the task, the session, the revision, and whether the task asks
for an answer before the audio is transcribed. A cancelled task gets 409 `cancelled`. A
revision other than the task's gets 409 `stale_revision`. A task whose current parts hold no
voice reply gets 409 `answer_not_offered`, so a line that asks nothing, a task still waiting
for its first result, or a "Wrong item" view takes no answer. None of these refusals transcribes
anything or appends to the journal. An event id that another journal event already holds gets
409 `duplicate_conflict`.

A retry with the same event id, task, session, revision, and audio returns the recorded
outcome without transcribing again. The same event id with other audio gets 409
`duplicate_conflict`. A retry that arrives while the first is still being transcribed waits for
it. Only recorded outcomes replay, so a retry after a 422, 502, or 503 transcribes again.

An empty transcript gets 422 `no_words`. A transcript longer than 400 characters or on more
than one line gets 422 `answer_unusable`. A recognizer that fails gets 502 `speech_failed`. A
Mac without speech set up gets 503 `recognizer_unavailable`. None of these appends to the
journal.

## Task actions

`POST /v1/tasks/{taskId}/actions` takes `{ "eventId", "sessionId", "expectedRevision",
"action": { "type": "wrong_subject" } }`, or `save_for_later`, `retry`, or `cancel` as the
type. A `voice_reply` here is a bad request, because answers go through the answers route. An
event id that an answer is still using gets 409 `duplicate_conflict`.

Both routes answer 200 with the task view. An unknown task gets 404 `unknown_task`. A refusal
from the store gets 409 with its code: `stale_revision`, `cancelled`, `session_mismatch`, or
`duplicate_conflict`, and on the answers route also `answer_not_offered`. A body with a field
the route does not know gets 400, so no request can set delivery or continuity. The open and
action routes take a body of at most 16 KiB. An answer has the headset API's 8 MiB limit. A 200
means the Mac recorded the change. It does not mean anything was delivered.

`GET /v1/tasks/{taskId}` returns one task view, or `null`.

## A second kind of task

A capture of a device label goes through the same headset routes as any other capture.
`task-routes.test.ts` covers it. When OCR read the label inside the item's box, the annotation
is that text as written; otherwise it is the model's reading, still proposed. The parts, the
answer, and the actions are the ones every task uses, and no route or part is specific to it.

A second task also shows what this version cannot do yet:

- It is a label consult, not a consult of a verified device manual. A manual is an outside
  source, and a task cites only its one frame and the session's items.
- A spoken answer is always kept as a `practice-attempt`, whatever the task. The headset refuses
  any other kind of attempt.
- Whether Boopy's line asks something is read from its final question mark. The interpreter has
  no field that says so; its open questions are separate items the task view does not show.
- A label with a character outside Boopy's display rules (Latin and Hangul letters and common
  signs), such as Ω or µ, gets no annotation. It is left out like an over-long label, never
  rewritten.

## A reply from a named connection

Code: `service/src/interaction/connection-files.ts` and the task store. The person carries a
task to a connection they name on the Mac, such as a chat with their own assistant, and brings
its reply back as a file. Boopy sends nothing, so delivery stays `not-sent` and continuity stays
`local-only`. The person's steps are `pnpm task connect`, `request` and `reply`, on the
connector's local-only routes under `/v1/local-tasks/`; nothing here runs from the headset.

- A connection has a `con_` id, the channel `person-file`, and a label of at most 40 characters
  that the person types. The label is shown as typed and never checked. Boopy records no
  provider, assistant or model, because it cannot know who answers through a connection.
- A request file, `boopy.task-request` version 1, is written for the task's current revision on
  the person's command. It holds the person's words, the subject's label and the model's
  confidence (null when unknown) as the model's proposal, Boopy's line as its local proposal,
  the spoken answers with `recognitionUncertain`, and a `respondWith` template. The source is
  its id, revision and digest only: no picture, path or secret. The file says Boopy did not send
  it. A task revision gets one request; a second gets `request_exists`. The journal keeps the
  file's SHA-256 and its nonce's SHA-256, never the nonce. The same request again, with the same
  ids and nonce, gets the same file and journals nothing; any other difference gets
  `duplicate_conflict`, and a task that has moved to another revision gets
  `request_unavailable`.
- A reply file, `boopy.task-reply` version 1, is at most 16 KiB: one JSON object or one fenced
  json block. It echoes the request id, task id, base revision, source and nonce, has a
  `previousReplyId` of null, and holds one dialogue and at most one voice reply. Any other field
  is refused. The subject and its chip stay Boopy's, because the connection never saw the
  picture.
- A reply counts only for the request it answers, checked in this order: a prepared request, a
  valid envelope (`reply_invalid`), the nonce (`nonce_mismatch`), the task and source
  (`source_mismatch`), no earlier reply to that request (`duplicate_conflict`), an open task
  (`cancelled`) still at the request's revision (`stale_revision`), and parts the contract
  allows (`reply_invalid`). A request stays open until its task moves to another revision or is
  cancelled.
- A refusal is journaled with the file's SHA-256 and its code, and changes no part or revision.
  A file that cannot be read (`reply_unreadable`) or names no prepared request
  (`unknown_request`) journals nothing. The same file again returns the recorded outcome.
- A match is the next revision, journaled as `task.reply-matched` with the person as its actor
  and the authorship `claimed-by-file`. The reply's line takes the place of Boopy's, and the
  view adds `reply: { "connection": "<label>" }`. The reply stays a proposal. It says which
  connection it came through, never who wrote it. `task.provider-accepted` still marks only the
  local stand-in.

## Where tasks go

The task routes are on the loopback headset API, behind the same Host check as the other
headset routes. Every task route refuses a request that carries a browser `Origin`.

Task events do not create conversation items or dialogue in the session. The headset reads the
session's task and sends answers to the Mac. Nothing on this path reaches an outside assistant.
