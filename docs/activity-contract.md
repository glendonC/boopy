# Activities

The arrange and sequence files. The general interaction is [protocol.md](protocol.md). New tasks
use that, not another arrange or sequence widget.

Files carry proposed plain data. Boopy assigns ids, revisions, and derived positions. Nothing
here decides whether an answer is correct. The checks are a left/right relation, an order, and
a snapped value.

## Purpose and boundaries

One domain-neutral loop: selected context and the person's goal go to an assistant; the assistant
returns a bounded activity file; the person interacts with it natively in Boopy; Boopy freezes
what they did into a submission file; the assistant's reply file comes back with an optional next
activity. The contract must not assume language learning.

- Files move only by explicit person action. Grok Bot documents JSON attachments and saved result
  files, without a schema guarantee and without disclosing which model answered. Every exchanged
  file is JSON.
- Assistant content is proposed plain data. Boopy owns identifiers, revisions, the practice frame,
  state, events and rendering. Files cannot carry links, code, assets, layout or external actions.
- Boopy's only checks are mechanical: a left/right relation, an order or a snapped value. It never
  says an answer is correct, that anything was mastered, or that the world changed. An arrangement
  is a construction, not an observation; a sequence is the person's attempt, not a statement about
  their life. No activity event enters context packages, items, confirmations or personal accounts.
- An imported file's author is claimed by the file, never authenticated. Label it that way.

## Identifiers and text

Request `arq_…`, activity `act_…`, submission `sub_…`, reply `rep_…`, each matching
`^(arq|act|sub|rep)_[A-Za-z0-9_-]{1,64}$`. Packages are `ctx_…`. Source IDs are the package's
evidence source IDs (`<encoded packageId>:<encoded itemId>`).

Every assistant-supplied string is NFC-normalized and trimmed, within its limit, single line unless
noted, with no `<` or `>`, no control characters and no links (`scheme://` or `www.`). Only
displayable characters are accepted: Latin script, Hangul script, combining marks, and common
punctuation, digits and symbols except emoji. Anything else (for example Arabic or Han script) is
rejected with "Boopy cannot display this script yet. Use Latin letters or Hangul." The headset's
fonts are IBM Plex Sans with a Hangul fallback and do not shape Arabic.

A text item is `{ "text": string, "language": tag, "gloss"?: string }` where the tag matches
`^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$` and the gloss is a translation into the person's language.

## 1. Activity request file (Boopy to assistant)

Written only by an explicit local operator action on the Mac, as a new file with mode 0600, named
`boopy-activity-request-<requestId>.json`. It binds to one completed local handoff preparation for
the package (exactly one, or the named preparation request). If its sources changed since
preparation, refuse. The packet is read through `HandoffPreparation.readPacket`, so the existing
`handoff.packet-read` disclosure is journaled. Allowed sources are the baseline package's evidence
records except `rejected`; a legacy version 1 package allows none (every token uses `null`).

```json
{
  "type": "boopy.activity-request",
  "version": 1,
  "requestId": "arq_…",
  "exportedAt": "<export time>",
  "delivery": "not-sent-by-boopy",
  "note": "The person exported this file from Boopy and chose to share it. Boopy did not send it.",
  "goal": "<the person's words>",
  "personLanguage": "en",
  "background": null,
  "instructions": ["…"],
  "respondWith": { "type": "boopy.activity", "version": 1, "binding": { "…": "filled in" } },
  "sources": [{ "sourceId": "…", "label": "…", "gloss": null, "verification": "accepted" }],
  "context": { "packageId": "ctx_…", "packetSha256": "<64 hex>", "packet": "<exact packet>" }
}
```

`background` is the person's own note; null means not supplied and the assistant must not assume
one. `instructions` must tell the assistant to: return exactly one
downloadable `.json` file whose whole content is one object shaped like `respondWith`; copy
`binding` exactly; use only the components and limits below; reference only listed source IDs or
null; treat an arrangement as a practice construction, not an event; not invent the person's
level, feelings, activities or dates; for language practice, make each `space` tile one spaced word
and never put the full answer anywhere in the file; order hints from gentle to specific; write
`fallbackText` as a plain-text version of the same activity; use only Latin letters or Hangul.

## 2. Activity file (assistant to Boopy)

```json
{
  "type": "boopy.activity",
  "version": 1,
  "binding": { "requestId": "arq_…", "packageId": "ctx_…", "packetSha256": "<64 hex>" },
  "author": "Grok Bot",
  "fallbackText": "…",
  "activity": {
    "title": "Camel and tent",
    "purpose": "Sample data. Practice saying where things are in Korean, using your desert camp.",
    "instruction": { "text": "낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요.", "language": "ko",
      "gloss": "Put the camel to the left of the tent, then say it in Korean." },
    "components": [],
    "hints": [{ "text": "Start with the camel, then say where it is.", "language": "en" }]
  }
}
```

Limits: `author` optional, 60; `fallbackText` required, 800, may span lines; `title` 60; `purpose`
200; instruction text 200 and gloss 240; one or two components, at most one of each type; zero to
three hints (text 200, gloss 240).

**arrange.** One to four tokens, each on its own horizontal lane; only x carries meaning.

```json
{
  "type": "arrange",
  "axis": { "kind": "viewer-left-right" },
  "tokens": [
    { "key": "a", "label": { "text": "낙타", "language": "ko", "gloss": "camel" }, "sourceId": null },
    { "key": "b", "label": { "text": "텐트", "language": "ko", "gloss": "tent" }, "sourceId": null }
  ],
  "target": { "subject": "a", "relation": "left-of", "object": "b" }
}
```

- `viewer-left-right`: exactly two tokens; optional target with `left-of` or `right-of`, always
  from the person's own view facing the tray. Boopy supplies the end labels "Your left" and
  "Your right".
- `scale`: `{ "kind": "scale", "low": "Cheaper", "high": "Pricier" }` (24 each); two to four
  tokens; no target. Boopy reports only the order.
- `number`: `{ "kind": "number", "min": 0, "max": 200, "step": 5, "unit": "MAD" }`; finite,
  `min < max`, `step > 0`, `(max - min) / step` a whole number of at most 1000; `unit` optional,
  12; one to four tokens; no target. Boopy reports each snapped value.
- Token keys are `a` to `d` in order. Labels are text items (text 24, gloss 40). `sourceId` is
  null or one of the request's sources.

**sequence.** The person builds one ordered row from a bank of tiles. Boopy never checks it.

```json
{ "type": "sequence", "joiner": "space", "language": "ko",
  "tiles": [{ "key": "t1", "text": "있어요" }, { "key": "t2", "text": "낙타가" }] }
```

- `space`: words of one sentence; tile text has no whitespace; 24 each. `list`: ordered steps;
  48 each. Three to eight tiles, keys `t1` to `t8`, texts unique.

**Import order.**

1. At most 64 KiB of UTF-8. The whole content is one JSON object (`json`), or else exactly one
   fenced code block labelled json (`fenced-json`). Otherwise 400 `activity_unreadable`.
2. Strict envelope. Failure is 400 `activity_invalid` with up to eight `path: message` issues and
   nothing journaled.
3. Binding: the request must be recorded with equal `packageId` and `packetSha256`, otherwise 409
   `activity_binding_mismatch` and nothing journaled. Never search for a likely request.
4. An artifact SHA-256 imported before returns the existing activity with `duplicate: true`.
5. Body validation, including sources and display rules. Valid is status `active`. Invalid or
   unsupported (an unknown component or axis kind) is journaled as `fallback-only` with its issues
   and shows only the fallback text.

## 3. Interaction state (Boopy-owned)

- `revision` starts at 0 on import and increases by one with each arranged, sequenced,
  hint-revealed or submitted event. Every headset change names the revision it was made against;
  a mismatch is 409 `stale_activity` and changes nothing.
- Positions: per token, null (not placed) or x from 0 (your left, the low label or `min`) to 1.
  Tokens start not placed at lane center, so no relation, order or value exists before the first
  move. Drag preview is presentation; only the release commits.
- Derived values, recomputed and recorded at submission:
  - left/right `relation` of the target subject versus object (or `a` versus `b`): null if either
    is not placed, `unclear` when they are less than 0.10 apart, else `left-of` or `right-of`.
    `matchesTarget` is null without a target, otherwise true only when the relation equals it.
  - `order`: placed token keys by ascending x; `ties` when any neighbours are less than 0.10 apart.
  - `values` (number axis only): `min + round(x * (max - min) / step) * step`, null if not placed.
- Sequence `chosen` is an ordered list of distinct tile keys; `text` joins tile texts with a space
  (`space`) or with "; " (`list`).
- Hints are revealed in order. Submit is allowed when the activity is active and some token is
  placed or some tile chosen. Each submission freezes positions, derived values, chosen tiles,
  text, revealed hints and revision. Several numbered submissions are allowed.

## 4. Headset routes (loopback headset API; any Origin header is refused with 403)

`GET /v1/activities` returns `{ "activities": ActivitySummary[] }`, newest import first, at most
20. `GET /v1/activities/:activityId` returns an ActivityView. Changes return the updated view:

- `POST /v1/activities/:activityId/arrangement` `{ "revision": 3, "positions": { "a": 0.22, "b": null } }`
  with exactly this activity's token keys.
- `POST /v1/activities/:activityId/sequence` `{ "revision": 3, "chosen": ["t2", "t4"] }`
- `POST /v1/activities/:activityId/hints` `{ "revision": 3 }` reveals the next hint.
- `POST /v1/activities/:activityId/submissions` `{ "revision": 3 }`

Errors: 404 `activity_unknown`, 409 `stale_activity`, 409 `activity_unavailable` (fallback-only),
409 `nothing_to_submit`, 409 `no_more_hints`, 400 `invalid_request`. `/v1/health` adds
`"activities": true`. Asking Boopy itself for practice, and the reply that follows a submission
on such an activity, are in section 11.

ActivitySummary: `activityId`, `title`, `status`, `importedAt`, `claimedAuthor`, `submissions`
(count), `awaitingReply` (an exported submission without a reply), `replyAvailable`,
`parentActivityId`.

## 5. Local operator routes (connector: bearer token plus the `/v1/local-handoffs` local-only guard)

- `POST /v1/local-activities/requests` `{ packageId, preparationRequestId?, goal (300),
  personLanguage? ("en"), background? (200) }` returns `{ requestId, fileName, fileSha256, file }`.
- `POST /v1/local-activities/imports` `{ content }` returns `{ activityId, status, issues, duplicate }`.
- `POST /v1/local-activities/submissions/:submissionId/export` returns `{ submissionId, fileName,
  fileSha256, file }`. Rendering is deterministic, so a repeat returns the same bytes; journaled once.
- `POST /v1/local-activities/replies` `{ content }` returns `{ replyId, submissionId, activityId,
  nextActivityId, nextStatus, duplicate }`.

`pnpm activity request|import|export|reply` wraps these. Output files are new only (exclusive
create, mode 0600); input files must be regular, not symlinks, at most 64 KiB. It prints a short
message the person can paste beside the attachment. The operator's way to have Boopy ask the
local model instead (`pnpm activity ask`) is in section 11.

## 6. Submission file (Boopy to assistant)

Named `boopy-activity-submission-<submissionId>.json`, with `type: "boopy.activity-submission"`,
`version: 1`, the submission, activity and request IDs, `exportedAt`, `delivery:
"not-sent-by-boopy"`, a note, the exact validated activity body with its claimed author and artifact
hash, the frozen submission (number, time, arrange result, sequence result, revealed hints with
their text), `boopyChecked` (what Boopy checked: at most the arrangement relation), `digest`,
`instructions` and a `respondWith` reply template with binding and echo filled in.

The digest is one line of at most 400 characters, parts joined by ` | `:

- `arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches`.
  Other forms: `right of`, `낙타 and 텐트 too close to tell`, `not placed`, `arrangement does not
  match`. Scale: `order from Cheaper to Pricier: scarf, lamp` plus `(some too close to tell)` and
  `not placed: tagine`. Number: `My estimate = 50 MAD`, or `My estimate not set`.
- `sequence: "낙타가 텐트 왼쪽에 있어요"` or `sequence: (empty)`.
- `hints: 1 of 2`.

## 7. Reply file (assistant to Boopy)

```json
{
  "type": "boopy.activity-reply",
  "version": 1,
  "binding": { "submissionId": "sub_…", "activityId": "act_…" },
  "author": "Grok Bot",
  "echo": "<the exact digest>",
  "reply": {
    "summary": { "text": "…", "language": "en" },
    "points": [{ "about": "sequence", "text": "…", "language": "en", "gloss": "…" }]
  },
  "next": null
}
```

Summary text and gloss 300; one to four points (`about` is `overall`, `arrange`, `sequence` or
`hints`; text and gloss 300). Validation repeats the activity file's container and envelope rules.
The binding must name an exported submission, otherwise 409 `reply_binding_mismatch`. The echo
must equal the digest after whitespace normalization, otherwise 409 `reply_not_matched`; this
proves the reply was made from that exact submission file, not that it teaches well. A `next`
`{ fallbackText, activity }` becomes a new activity bound to the original request (same source
limits) with parent `{ activityId, submissionId, replyId }`: active if valid, fallback-only if not.
