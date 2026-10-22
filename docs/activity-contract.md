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

## 8. Journal events

Each event's session is the originating package's session; the actor is the person.

- `activity.request-prepared` `{ requestId, packageId, preparation: { requestId, receiptId,
  packetSha256 }, goal, personLanguage, background, sources, fileSha256, delivery: "not-sent" }`
- `activity.imported` `{ activityId, requestId, artifactSha256, container, claimedAuthor,
  fallbackText, activity | null, issues, parent | null }`
- `activity.arranged` `{ activityId, revision, positions }`, `activity.sequenced` `{ activityId,
  revision, chosen }`, `activity.hint-revealed` `{ activityId, revision, index }`
- `activity.submitted` `{ activityId, revision, submissionId, positions, derived, chosen, text,
  hintsRevealed, digest }`
- `activity.submission-exported` `{ submissionId, activityId, fileSha256, delivery: "not-sent" }`
- `activity.reply-imported` `{ replyId, submissionId, activityId, artifactSha256, container,
  claimedAuthor, reply, nextActivityId }`

The session projection ignores these types. The activity store rebuilds from them at startup.
Events for calls Boopy makes itself are in section 11.

## 9. Headset presentation rules

The headset reads ActivityView and never treats its own drag preview as the saved value. Text
is plain, with rich text off. Each kind of change reads differently: a saved edit
("Saved in Boopy"), a submission ("Submitted in Boopy. Not sent."), an export ("Exported on your
Mac. Boopy cannot see whether it was sent.") and a reply ("Reply from a file claiming Grok Bot.
Not verified.").

## 10a. Extra constraints

These settle points the audit lane found open; they supersede anything above that conflicts.

- `fallbackText` and `author` are part of the envelope: invalid values are 400 with nothing
  journaled, because fallback-only activities display them.
- One reply per submission. A second, different reply is 409 `reply_exists` with nothing
  journaled; identical bytes stay idempotent. For a new reply, submit again.
- Separation: round `|dx|` to 9 decimals (`Math.round(|dx| * 1e9) / 1e9`); unclear only below
  0.10, so exactly 0.10 is apart. The service and the headset preview use this same rounding, not
  a tolerance.
- Number axis: `|min|` and `|max|` at most 1e9, `step` at least 0.000001 and at most 6 decimals in
  each of `min`, `max` and `step`. All arithmetic is exact in integer micro-units
  (`u = Math.round(v * 1e6)`, safe below 2^53): `(maxU - minU)` must be a positive whole multiple
  of `stepU` of at most 1000 steps, so decimal prices such as 999999.99 to 1000000.06 in 0.01
  steps are accepted. A value is `minU + k * stepU` micro-units with
  `k = Math.round(x * (maxU - minU) / stepU)`, printed as an exact decimal without exponent or
  trailing zeros. The service and the headset preview use the same integer method.
- Identifiers are compared exactly after their strict ASCII patterns; nothing is trimmed,
  normalized or case-folded.
- Issue strings repeat a key name only when it matches `^[A-Za-z0-9_-]{1,40}$`; any other
  unknown key is reported as `(unprintable key)`, so issues never carry links or hidden characters
  into a terminal or the headset. The reply `echo` is compared as a plain bounded string and is not
  subject to the text rules.
- A submission's `export` is null until it is exported, then the `exported-not-sent` object in
  section 10. `issues` are plain `path: message` strings. `/v1/health` carries
  `"activities": true`, and the headset hides its activity entry when the flag is absent.
- A fallback-only view has null `title`, `purpose` and `instruction`, no components, hints
  `{ "total": 0, "revealed": [] }` and `canSubmit: false`; its summary title is null and the
  headset supplies its own label. Absent optional strings are null in views. A token's `value`
  is set only on a number axis; `derived.values` only for number and `derived.relation` only for
  left/right. Number tokens in a digest are joined by `; `; when a digest would exceed 400
  characters, only the sequence quote is shortened, ending in an ellipsis inside the quotes.
- Allowed sources also exclude records that have a recorded supersession.
- The submission's attempt data is frozen; the instructions around it are guidance that may
  improve between versions. A re-export renders with the current instructions: identical bytes
  journal nothing new, and different bytes after an upgrade journal a new
  `activity.submission-exported` event with the new `fileSha256`, keeping earlier exports in the
  journal. The view shows the latest export. Replies still bind, because the echo does not depend
  on the instructions. Never answer a re-export with a 500.
- Hints belong to the activity. A frozen submission and its file also carry
  `hintsRevealedSincePrevious` (indexes opened after the previous submission of the same activity,
  or all of them for the first), and the submission instructions say that `hintsRevealed` is
  cumulative, so an assistant does not read carried-over hints as opened again.
- Boopy, not the assistant, decides tile display order: `ActivityView.tiles` (and the bank shown
  on the headset) are ordered by the SHA-256 of `<activityId>:<tileKey>`, ascending, so the order
  is stable across views and restarts and never reveals an answer order the assistant happened to
  write. Keys, `chosen` and the submission file keep the assistant's tile keys. The headset renders
  tiles in view order and never re-sorts them.
- Multi-line fields turn CRLF, CR, U+2028 and U+2029 into line feeds; single-line fields reject
  them. Lengths count code points after NFC and trimming. Code points above U+FFFF are rejected
  as not displayable, so service code-point counts and the headset's UTF-16 counts always agree.
- Other errors: no single completed preparation is 404 `prepared_unavailable`; changed sources are
  409 `sources_changed`; an unknown submission on export is 404 `submission_unknown`; a change to a
  component the activity does not have is 400 `invalid_request`.
- File content must be well-formed Unicode and at most 64 KiB in UTF-8 bytes. Exactly one leading
  byte order mark is removed before parsing; the artifact SHA-256 covers the UTF-8 bytes received.
  The command-line tool decodes files with a fatal UTF-8 decoder. Nesting deeper than 32, a
  duplicate key at any level, or a key named `__proto__`, `constructor` or `prototype` anywhere is
  400 `activity_unreadable` (the same applies to replies).
- Container: after removing the byte order mark and surrounding whitespace, the whole content is
  one JSON object; otherwise the content must contain exactly one fenced block of any kind, and it
  must be labelled exactly `json` (not `jsonc`, `json5` or `json` plus a title). A second fenced
  block of any label makes the content unreadable.
- Text also rejects fullwidth angle brackets; the schemes `javascript:`, `data:`, `mailto:`,
  `file:`, `tel:`, `sms:` and `vbscript:` in any case when they start a word and a non-space
  character follows the colon (so "Mobile data: 5 GB" and "Hotel:" stay valid); the Hangul filler
  characters U+115F, U+1160, U+3164 and U+FFA0, which render blank; any field with no visible
  character; every format character (general category
  Cf, which covers zero-width characters, an inner byte order mark and bidirectional controls);
  U+2028 and U+2029; private use, unassigned and lone surrogate code points; regional indicators,
  variation selectors U+FE0E and U+FE0F, the keycap mark U+20E3, tag characters and
  Extended_Pictographic; and any combining mark left after NFC. Digits stay allowed, so the Emoji
  property is not used. Other scripts, including Cyrillic look-alikes, get the display message.

## 10. Canonical example views (synthetic)

Sample data, after one submission was exported and a reply imported:

```json
{
  "activityId": "act_k1", "revision": 4, "status": "active", "title": "Camel and tent",
  "purpose": "Sample data. Practice saying where things are in Korean, using your desert camp.",
  "instruction": { "text": "낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요.", "language": "ko",
    "gloss": "Put the camel to the left of the tent, then say it in Korean." },
  "fallbackText": "Picture the camel to the left of the tent and say it in Korean.",
  "issues": [],
  "provenance": { "requestId": "arq_k1", "packageId": "ctx_synthetic1",
    "packetSha256": "1111111111111111111111111111111111111111111111111111111111111111",
    "artifactSha256": "2222222222222222222222222222222222222222222222222222222222222222",
    "claimedAuthor": "Grok Bot", "authorship": "claimed-by-file",
    "importedAt": "1970-01-01T00:00:00.000Z", "parent": null },
  "components": [
    { "type": "arrange", "axis": { "kind": "viewer-left-right" },
      "tokens": [
        { "key": "a", "label": { "text": "낙타", "language": "ko", "gloss": "camel" },
          "source": { "sourceId": "ctx_synthetic1:itm_2", "label": "camel" }, "position": 0.22, "value": null },
        { "key": "b", "label": { "text": "텐트", "language": "ko", "gloss": "tent" },
          "source": null, "position": 0.71, "value": null }],
      "target": { "subject": "a", "relation": "left-of", "object": "b" },
      "derived": { "relation": "left-of", "matchesTarget": true, "order": ["a", "b"], "ties": false, "values": null } },
    { "type": "sequence", "joiner": "space", "language": "ko",
      "tiles": [
        { "key": "t1", "text": "있어요", "used": true }, { "key": "t2", "text": "낙타가", "used": true },
        { "key": "t3", "text": "왼쪽에", "used": true }, { "key": "t4", "text": "텐트", "used": true },
        { "key": "t5", "text": "오른쪽에", "used": false }],
      "chosen": ["t2", "t4", "t3", "t1"], "text": "낙타가 텐트 왼쪽에 있어요" }],
  "hints": { "total": 2, "revealed": [{ "index": 0, "text": "Start with the camel, then say where it is.",
    "language": "en", "gloss": null }] },
  "canSubmit": true,
  "submissions": [{
    "submissionId": "sub_k1", "number": 1, "submittedAt": "1970-01-01T00:00:00.000Z", "revision": 4,
    "digest": "arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches | sequence: \"낙타가 텐트 왼쪽에 있어요\" | hints: 1 of 2",
    "arrange": { "positions": { "a": 0.22, "b": 0.71 }, "relation": "left-of", "matchesTarget": true,
      "order": ["a", "b"], "ties": false, "values": null },
    "sequence": { "chosen": ["t2", "t4", "t3", "t1"], "text": "낙타가 텐트 왼쪽에 있어요" },
    "hintsRevealed": [0],
    "hintsRevealedSincePrevious": [0],
    "export": { "state": "exported-not-sent",
      "fileSha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "exportedAt": "1970-01-01T00:00:00.000Z" },
    "reply": { "replyId": "rep_k1", "importedAt": "1970-01-01T00:00:00.000Z", "claimedAuthor": "Grok Bot",
      "artifactSha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "summary": { "text": "Synthetic example reply for rendering tests.", "language": "en", "gloss": null },
      "points": [{ "about": "sequence", "text": "Synthetic point about the sentence.", "language": "en", "gloss": null }],
      "nextActivityId": "act_k2" } }]
}
```

Sample data, one estimate placed and not yet submitted:

```json
{
  "activityId": "act_m1", "revision": 1, "status": "active", "title": "Petit taxi fare",
  "purpose": "Sample data. Check your sense of a fair petit taxi fare before you ride.",
  "instruction": { "text": "What would you expect to pay for a daytime petit taxi from the medina to Gueliz?",
    "language": "en", "gloss": null },
  "fallbackText": "Think of a fair daytime petit taxi fare from the medina to Gueliz in dirhams.",
  "issues": [],
  "provenance": { "requestId": "arq_m1", "packageId": "ctx_synthetic2",
    "packetSha256": "5555555555555555555555555555555555555555555555555555555555555555",
    "artifactSha256": "6666666666666666666666666666666666666666666666666666666666666666",
    "claimedAuthor": "Grok Bot", "authorship": "claimed-by-file",
    "importedAt": "1970-01-01T00:00:00.000Z", "parent": null },
  "components": [
    { "type": "arrange", "axis": { "kind": "number", "min": 0, "max": 200, "step": 5, "unit": "MAD" },
      "tokens": [{ "key": "a", "label": { "text": "My estimate", "language": "en", "gloss": null },
        "source": null, "position": 0.25, "value": 50 }],
      "target": null,
      "derived": { "relation": null, "matchesTarget": null, "order": ["a"], "ties": false, "values": { "a": 50 } } }],
  "hints": { "total": 1, "revealed": [] },
  "canSubmit": true,
  "submissions": []
}
```

## 11. Local model calls

Asking for practice on a saved package, and getting a reply to an attempt, need no file moves:
Boopy sends the request or submission to the local model on this Mac and imports the answer.
Nothing leaves the Mac. Sections 1 to 7 stay as they are for files the person moves themselves,
and an activity imported from a file never triggers a call.
Manual file imports deduplicate only against earlier manual file imports. An identical artifact
received by a call and imported as a file retains separate provenance in each path.

**Provider.** Ollama on this Mac only. `BOOPY_OLLAMA_URL` must be `http` on `127.0.0.1`,
`localhost` or `[::1]`, with no credentials, path, query or fragment. The model is
`qwen3.6:35b-a3b-nvfp4` only; `BOOPY_ACTIVITY_MODEL` may name only that verified local artifact.
Before each prompt, bounded `/api/tags` and `/api/show` requests must match its verified digest
`e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9`, size 23598465691,
format `safetensors`, architecture `qwen3_5_moe` and parameter count 35951479808, with no remote
or cloud metadata markers. Missing, changed or remote metadata fails the call without sending
prompt content. A loopback Ollama can otherwise route cloud models. This trusts the installed
local process and does not attest its behavior or prevent external model replacement between
metadata and chat. Both metadata requests share the call's total timeout and stop cancellation.
Calls are on by default
(`BOOPY_ACTIVITY_ASSISTANT=ollama`); `none` switches them off. When on, `/v1/health` carries
`"activityAssistant": { "provider": "ollama", "model": "…" }`, and the headset offers practice only
then. This path does not call a cloud model. The call lives in
`service/src/activity-ollama.ts`.

**One call at a time.** At most one call runs in the whole service, with no queue and no retry.
A call is one `POST /api/chat` with `stream: false`, `think: false`, `keep_alive: "30m"` (what the
interpreter sends, so a call does not shorten the shared model's stay),
`options: { "temperature": 0.2, "num_predict": 8192 }` and no `format`, because this model's
engine answers 501 to it. A call is stopped after 120 s. Warm calls have taken about 11 to 14 s, and at
the measured 115 tokens per second the 8192-token cap is about 71 s, plus about 9 s for the prompt
and 12 s to load the model, so about 92 s; the rest is room for a turn sharing the model. A
response is not read past 1 MiB. On a stop, a running call gets the same 10 s grace as a request in
progress and is then aborted; the next start journals it interrupted and never sends it again.

**Prompt, from the same renderer.** The system message is one fixed line, then "Answer with one JSON
object, and nothing else, that matches this JSON Schema:" and the schema of the answer. The user
message is the file's `instructions` joined by line feeds, a blank line, and the exact text the
section 1 or section 6 renderer writes for this request or submission. In that text `delivery` is
`"sent-by-boopy-to-local-model"`, the note says "Boopy sent this request (or submission) to the
local model on this Mac.", and `exportedAt` is when Boopy wrote it.

**Answer.** The model returns only `{ "activity", "fallbackText" }` for an activity call or
`{ "reply", "next" }` for a reply call; anything else it returns, such as a binding, an echo or
an author, is ignored. Its message content is read with the section 2 container rules (one JSON
object, or exactly one fenced json block, at most 64 KiB, strict JSON). Boopy then writes the
envelope itself: type, version, the binding (and for a reply the echo) of the file it sent, and no
author. That file goes through the same reader, binding check and validators as an imported file.
Only a fully valid answer is imported, as `active`. A body that does not validate, or a reply
whose `next` does not, imports nothing and fails the call: nothing invalid is stored or shown,
there is no fallback-only activity from a call, and Boopy never makes up an activity of its own.

**Triggers.**

- Headset: `POST /v1/activities/practice-requests` with the section 5 request body
  (`packageId`, `preparationRequestId?`, `goal`, `personLanguage?`, `background?`), bound to
  exactly one completed preparation as in section 1. It answers 202 with the ActivityCall in state
  `running`. `GET /v1/activity-calls` lists calls, newest first, at most 20, and
  `GET /v1/activity-calls/:callId` reads one.
- Local operator: `POST /v1/local-activities/practice-requests` with the same body and answer, and
  `GET /v1/local-activities/calls/:callId`. `pnpm activity ask --package <id> --goal "<words>"`
  starts one, waits for it and prints the outcome.
- Automatic: a submission on a Boopy-called activity, including a next activity from a
  Boopy-called reply, asks for its reply at once. The submission is recorded first and does not
  depend on the call. One reply per submission still holds; after a failed reply call, submit
  again.
- Errors: 409 `assistant_busy` (a call is running; nothing is journaled), 503
  `assistant_unavailable` (calls are off, or Boopy is stopping), 404 `call_unknown`, and the
  section 1 and 10a refusals (`prepared_unavailable`, `sources_changed`, `invalid_request`).
  An automatic reply asked while another call runs is not refused: it is journaled as a failed
  call with `assistant_busy`, so the submission shows why no reply came.

```text
{
  "callId": "cal_k1", "kind": "activity", "state": "running", "provider": "ollama",
  "model": "qwen3.6:35b-a3b-nvfp4", "askedAt": "1970-01-01T00:00:00.000Z", "finishedAt": null,
  "durationMs": null, "packageId": "ctx_synthetic1", "requestId": "arq_k1", "submissionId": null,
  "activityId": null, "replyId": null, "nextActivityId": null, "failure": null, "issues": []
}
```

Call identifiers match `^cal_[A-Za-z0-9_-]{1,64}$`. `kind` is `activity` or `reply`; `state` is
`running`, `imported`, `failed` or `interrupted`. For a reply call, `activityId` names the
submitted activity and `submissionId` the submission; for an activity call, `activityId` is set
once the activity is imported. `failure` is null or `{ "code", "message" }`; `issues` lists up to
eight section 10a issue strings, only for `answer_invalid`.

**Failures.** The message is fixed words, never model text: "Boopy couldn't make practice from
this: " for an activity call or "Boopy couldn't make a reply from this: " for a reply call, then
the reason for the code.

| Code | Reason |
| --- | --- |
| `assistant_unreachable` | the local model isn't answering on this Mac. |
| `assistant_timeout` | the local model didn't answer in time. |
| `assistant_error` | the local model reported an error. |
| `answer_unreadable` | its answer wasn't one JSON object. |
| `answer_invalid` | its answer didn't fit Boopy's format. |
| `assistant_busy` | Boopy was already waiting for the local model. Submit again in a moment. |
| `interrupted` | Boopy stopped before the local model answered. |

**Provenance and views.** Boopy made the call, so provenance is known rather than claimed. A
called activity's `provenance` has `authorship: "called-by-boopy"`, `claimedAuthor: null` and
`call: { callId, provider, model, durationMs }`. A reply from a call has `claimedAuthor: null` and
the same `call` object. A submission of a called activity has `replyCall: { callId, state,
failure }`, or null when no call was asked (calls were off). Files keep their views exactly as
before: no `call` or `replyCall` key. In summaries, a called activity has `call: { provider,
model }` and `awaitingReply` is true while its reply call runs. The headset shows "Made by the
local model on this Mac." for a called activity, "Reply from the local model on this Mac." for a
called reply, "Boopy is asking the local model…" while a call runs, and a failure's message as it
is. A call changes nothing else: Boopy still checks only the mechanics, the content stays
proposed, and no activity event enters a package or a confirmation.

**Events.** Each event's session is the package's session, as in section 8.

- A practice request's `activity.request-prepared` has `delivery: "sent-to-local-model"`.
- `activity.call-asked` `{ callId, kind, provider, model, requestId, submissionId | null,
  fileSha256 }`, where `fileSha256` is the rendered text the model was sent. The actor is the
  person for a practice request and `system` for an automatic reply.
- `activity.imported` and `activity.reply-imported` from a call carry `call: { callId, provider,
  model, durationMs }` and the actor `system`; file imports carry no `call`.
- `activity.call-finished` `{ callId, outcome: "imported" | "failed" | "interrupted",
  durationMs | null, failure | null, issues, activityId | null, replyId | null,
  nextActivityId | null, metrics | null }`, actor `system`, journaled after the import it reports.
  `metrics` holds only Ollama's numbers: prompt and output token counts and durations in
  milliseconds.
- At startup, a call asked but not finished gets `activity.call-finished` with outcome
  `interrupted` and no model request.

Call events never carry prompt or answer text. The imported activity or reply carries the model's
content exactly as a file import does.
