# Architecture

The Quest talks only to the Boopy service on the Mac. The headset captures, points, and draws.
It holds no model keys and does not decide what something means. The service listens on
loopback. Putting it on the network needs a security review first.

```text
Quest 3                              Mac service
passthrough, pinch, voice            speech, OCR, interpretation
one subject, labels, dialogue  <---> journal
                                     connector for saved context
```

USB `adb reverse` maps the headset's `127.0.0.1:47900` to the service. The connector is on
`47901`.

## Headset

Unity, OpenXR, and the Meta XR SDK versions pinned in `quest/Packages/manifest.json`.

On talk, the client takes one passthrough frame, the camera pose at that frame's time, and a
coarse 16 by 12 depth sample. Its cue is gaze only: a head ray marks where the person looks, and the
capture sends that point. The hand that pinches to talk sends no pointer, since it is raised to pinch;
a hand ray still aims the controls. Pinch and hold records speech. A short pinch can act on a control.

The room shows one selected subject and its label. Other detail stays in the reader. Live
outlines can suggest names, and those outlines are not tappable. Dialogue and choices sit on
the console. Losing focus hides the interface and drops a recording in progress.

A saved photo is placed on the photograph. It is not a located object in the room unless the
current view, depth, and tracking actually support that, and the interface must not pretend
they do.

## Service

Node 24. The main pieces:

- Speech through local whisper.cpp, with language detection.
- OCR through Apple Vision. The text that was read is kept as read. A model may interpret it
  and may not replace it.
- An interpreter: a fixture for tests, local Ollama, or Muse Spark on Meta's API when that
  key is configured. Hosted interpretation sends the frame off the Mac. An answer that does not
  match Boopy's schema fails the turn, except a malformed choice or follow-up list, which is
  dropped while the rest of the answer is still checked.
- Optional hosted segmentation for up to four proposed boxes. It is off unless configured.
- A SQLite journal. Every change is appended. Current sessions and saved context are rebuilt
  from that log.
- A read-only connector, MCP and REST, behind a bearer token. Each read is written to the
  journal. Images stay on the Mac unless a later, explicit choice shares one. The same token is
  the local operator's credential for the `/v1/local-*` routes on the Mac, and the journal
  records whoever holds it there as the person.

Coordinates inside Boopy are normalized from 0 to 1, origin at the top left. Each model
adapter converts its own grid at the boundary.

## What gets saved

A session works with items: an object, some text, a goal. Each item has a label, a short
statement, where it sits in the frame, who it came from (`model` or `person`), the model's
confidence, and a separate status from the person: proposed, confirmed, rejected, ignored, or
known.

Committing builds a context package from the journal. Untouched model items stay accepted, not
confirmed. The package does not claim the person reviewed every line.

## Two ways an assistant task can exist

**Interaction tasks** (`service/src/interaction/`) are the general path: one source, a person's
request, a small set of interface parts, and actions such as a spoken answer, wrong subject,
save for later, retry, or cancel. After a capture, the headset reads the session's task. The
service opens it from the first completed visual turn, with that turn's stored frame digest
and the person's words. Its one result is a local stand-in built from Boopy's own reply. The
headset sends a spoken answer as audio, and the Mac transcribes it. Results stay local, and no
assistant's reply comes back on this path. Only when the person opts in with their own Grok
Bot routine's webhook file does each task's opening, and each assessed answer, also go out to
that Bot as a one-way moment; Boopy never reads the Bot's reply. See
[Interaction](protocol.md#moments-to-the-persons-grok-bot).

**Activity files** are the older arrange and sequence loop. Boopy can write a request, import
a reply from a file the person chose, or ask the pinned local model. The local model is not
Grok and is not Muse. See [Activities](activity-contract.md).

## The practice loop

Off unless the person sets a language to practise (`pnpm task goal`) and the Mac runs Zetaris
with the practice account. Capture, correction, and commit work without it.

1. Observe: a capture, or a boop on a recorded photo or clip the person imported on the Mac (see
   [Recorded sources](recorded.md)). A recorded frame is never treated as the live room.
2. Evidence: the local model proposes the subject. Its label is Boopy's guess and stays a proposal.
3. Retrieve: a Meterless H-MEM index over the journal's practice records recalls earlier attempts
   for the same guess or the same source; practice on a subject the person marked wrong is left
   out. Then one fixed Zetaris query on this Mac joins a dated Wikidata snapshot (labels, aliases
   and descriptions in several languages, CC0, not reviewed) with the practice record, rewritten
   from the journal whenever it differs. The model never names a reference id, and the caller
   cannot pass SQL. Every returned row is checked against the import's receipt, kept outside
   Zetaris.
4. Decide: a word shows only for exactly one item whose label or alias matches the guess. Otherwise
   Boopy says plainly that it has no word.
5. Act: the task's line names the guess and the word, as Boopy's own stand-in. It is sent to no
   one, unless the person opted in to moments to their own Grok Bot, which then gets a copy.
6. Update: a spoken answer is heard, not heard, or unclear against the word, never graded; the
   attempt and Boopy's reply are journaled together, and the practice table is rewritten.

`pnpm trace` prints these steps for a session from the journal, without the person's words. See
[Interaction](protocol.md) and [Memory](evidence.md).

## Optional helpers

These are off the main path.

- Memory search over saved items uses the same H-MEM subset. A replaced claim is left out of
  later search. See [Memory](evidence.md).
- NVIDIA embeddings can rank candidates for saved-item recall. A score does not confirm a fact
  and cannot bring back a claim a person replaced. They are not part of the practice loop.

## Rules

1. Model output stays proposed until a person acts on it.
2. Missing information stays missing.
3. State comes from the journal.
4. The headset never holds a model key.
5. The service stays on loopback unless that exposure has been reviewed.
