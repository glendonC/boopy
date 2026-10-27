# Recorded scenes

Code: `service/src/recorded-source.ts`, `service/src/http/recorded.ts`, `service/src/cli/replay.ts`,
and the still helper in `service/tools/recorded/main.swift`.

A person can bring a photo or a video they recorded earlier to the Mac, show it in the headset, and
boop it the way they boop their surroundings. A recorded frame is always a recording. It is never
live, and nothing says it is happening at this moment.

## Turning it on

The routes exist only with `BOOPY_RECORDED_SCENE=1`. That setting needs its own `BOOPY_DATA_DIR`,
never the default one, and the service refuses to start on a data folder whose journal already
holds a live capture. It also refuses a hosted interpreter or hosted segmentation, so every recorded
frame stays on the Mac. Build the still helper once with `pnpm recorded:build`.

## Importing

From `service/`, with the service running:

```sh
pnpm replay import --input FILE --data-dir DIR [--stills N | --at S,S | --every S] [--start S] [--duration S]
pnpm replay list --data-dir DIR
pnpm replay show --data-dir DIR --recording ID [--frame ID | --at S]
pnpm replay clear --data-dir DIR
```

Import copies the chosen file into `DIR/recorded`, named by its SHA-256, with mode 0600. The original
is read and never moved or changed. The command then asks the service through the local connector,
with the connector token, from the Mac only. The service checks the stored file against its SHA-256
before it reads anything.

A photo gives one frame. For a video, the operator chooses which frames to keep:

- `--every S` keeps the frame shown every S seconds (at most 15 a second), inside a window of at
  most 60 seconds set by `--start` and `--duration`.
- With no choice, a clip of at most 60 seconds keeps the frame shown every 0.1 seconds; a longer clip
  needs a window, stills or moments.
- `--stills N` keeps N evenly spaced frames (at most 60).
- `--at S,S` keeps the frame shown at each chosen moment (at most 60).

A recording keeps at most 600 frames. Files are at most 4 GiB and 30 minutes.

Each kept frame is an exact frame of the file, at its own time. Edit lists and variable frame times
are kept as the file has them; a frame is never moved to a neighbouring one. Stills are upright (the
file's rotation or EXIF orientation applied), in standard dynamic range, at most 1280 pixels on the
long edge, and JPEG with no metadata at all.

The headset shows a recorded frame across about 100 degrees, so it also gets a sharper rendition of
every kept frame: long side 2560 pixels, or the source's own size when smaller, made by the same
helper from the original (upright, standard range, no metadata) and journaled once as
`recorded.display.made`. Import makes them; `pnpm replay display --data-dir DIR --recording ID`
makes them for a recording imported earlier. The headset is served the rendition, and the scene view
gives its size and digest; the interpreter and the outlines keep the 1280 stills, and the gaze
crop is cut from the rendition when there is one, for twice the detail around the point. Normalized
points mean the same place in both, since a rendition keeps its still's shape.

For playback, every clip also gets its video once (at import, or by `replay display` for a
recording imported earlier): the video track alone, re-encoded by the helper as H.264 in standard
range with every frame at its own time on the original timeline, then copied by ffmpeg with no tag
at all and its index first. A tag left beyond the container's own refuses it. It is stored 0600 under
the store, named by its SHA-256, and journaled as `recorded.video.made` with the digest only.
`GET /v1/recorded/{recordingId}/video` serves it for the shown recording, with byte ranges (206).
Each frame's `seconds` in the scene is its time in that video.

The scene's `projection` says where the picture's edges were from the capturing camera's forward
axis: `tanLeft`, `tanRight`, `tanUp` and `tanDown`, the positive tangents of the angles to each edge
(a rectilinear picture), so the headset can place it exactly as the camera saw it. It comes from the
35 mm-equivalent focal length a phone writes (the QuickTime camera tag on video, EXIF
`FocalLenIn35mmFilm` on a photo; nothing else is read), as `source: lens-tag` with `centring:
assumed`, since a lens tag gives no optical centre. Or it comes from a profile measured for the
recording device, set with `pnpm replay projection --recording ID --tan-left T --tan-right T
--tan-up T --tan-down T --profile NAME --centring measured|inferred [--reference NAME:L,R,U,D]`, as
`source: measured-device-profile`, with the profile's other measured shape kept beside it in the
journal. Without either it is null, and the headset says so rather than guessing.

The owner's Quest clip uses the profile `quest3-capture-16x9`, measured on 10-26 from a Quest
screenshot of the calibration grid (1440 by 1440, focal 858 pixels on both axes): its horizontal
edges are the square capture's (left 0.8424, right 0.8359), and its vertical edges (0.4720 up and
down) assume the 16:9 crop is centred on the forward axis. That centring is inferred, not measured,
because a headset recording could not be started over adb to measure it; the profile says
`centring: inferred`. The square capture's edges (up 0.7334, down 0.9449) are kept beside it as
`quest3-capture-square`.

Nothing the commands print carries a file name, a path, a capture time or any other metadata value.

## What the journal keeps

One `recorded.source.imported` event per recording: an opaque recording id, the file's SHA-256, its
kind and size, the upright still size, its duration, whether it was HDR, its rotation, the sampling,
its capture time, and each kept frame with its own opaque id, exact time and still digest. Showing
and clearing are `recorded.scene.shown` and `recorded.scene.cleared`.

The journal never keeps the file's name, its path, a location, or the recording's audio. Voices in a
recording are not transcribed.

## Capture time

The capture time is the file's own claim, or unknown. For a video it comes from the
`creation_time` and Apple `creationdate` tags; two that differ are a conflict, and the time stays
unknown. For a photo it comes from EXIF `DateTimeOriginal` with its own offset; without an offset it
stays unresolved, and the Mac's timezone is never assumed. The GPS block is never read, so its time
stamp is not used either. A claim is shown as unverified, never as checked. A frame's capture time is
the file's start time plus the frame's place in the file.

## The headset

`GET /v1/recorded-scene` answers `{"scene": null}` or the shown recording:

```json
{
  "scene": {
    "recordingId": "rec_...",
    "frameId": "rfr_...",
    "kind": "video",
    "width": 960,
    "height": 1280,
    "sourceTimeSeconds": 4.2,
    "durationSeconds": 12.2,
    "capturedAt": { "value": null, "trust": "unknown" },
    "frameSha256": "...",
    "frames": [{ "frameId": "rfr_...", "seconds": 0, "frameSha256": "..." }]
  }
}
```

`GET /v1/recorded-scene/frames/{frameId}` returns one still of the shown recording as `image/jpeg`.
Both routes send `Cache-Control: no-store` and no CORS header, and refuse any request with an
`Origin` header or a `Sec-Fetch-Site` other than `none`, so a web page cannot load the footage.

## Booping a recorded frame

A turn names the frame instead of sending one: `recordedFrame: {recordingId, frameId}` in
`POST /v1/sessions` or `POST /v1/sessions/{id}/utterances`, with `attention.source` set to
`past-recollection` and the gaze as a point in the upright still (0 to 1, origin at the top left).
The Mac builds the observation from its own stored still. It has no camera pose and no depth, so the
rule that picks a subject held up close never applies to it.

The request is refused (400) when it also carries a frame, a pointer, a world point, a gaze on a
surface, or another source. A frame from a recording that is no longer shown is refused with 409
`recorded_frame_changed` before any session starts; an unknown frame is 404
`recorded_frame_unknown`.

The observation is journaled with source `past-recollection`, `timestampTrusted: false`, its capture
time or null, and a `recorded` block (recording, frame, file digest, time in the file). Then the turn
runs as a capture does: speech, attention, text reading, interpretation and the journal. The
interpreter is told it is looking at the person's own recording, where in it, and whether a capture
time exists; the time itself is not sent.

When the recording has an outline run, each object the interpreter places on that frame takes the
shape of the frame's own outline whose box overlaps its box by at least half (intersection over
union), an outline whose noun names the object first. The object keeps its label and its box, and
gains `grounding.contour` with `spatial` marked `from: recorded-outline`, the worker, the overlap
and `verification: proposed`, so the headset draws its silhouette instead of a box. Without an
outline run on the frame, or without such an overlap, the box stays.

A service that shows recordings takes recorded frames only: a room frame there is refused with 409
`recorded_only`, so its journal never mixes the room with a recording. A service without recordings
refuses a recorded frame with 404 `recorded_unavailable`. Session views and saved context show
`capturedAt` as null when it is unknown, and mark the observation `recorded`.

A boop on a recorded frame needs no words. `"speech": {"gesture": "tap"}` sends a quick tap, and a
held boop whose recording has no words counts the same way. Boopy answers as it does for "What is
this?" about the subject at the gaze point. The journal keeps that nothing was said: the utterance
has empty text and source `pointing` for a tap, or `speech` with the audio's digest. A tap without a
recorded frame is refused (400), and a live turn with no words is still refused with 422 `no_words`.

Such a boop is about the thing at the point, never the whole scene, in its first turn or a later
one. So is one whose words only ask what the thing is, from a closed list ("What is this?", "What's
that?", "이게 뭐야?"); a question in other words, such as "What is this place?", is answered as the
model reads it. When the model answers with the scene or names no subject, the Mac takes the smallest object
box the model placed over the gaze, else the recording's own outline around it (one the
interpreter proposed, or a person from the general list, never another general-list thing), added
as a proposed item that keeps the outline's label and confidence. Whoever chose the subject, Boopy says only that
guess ("Tent, I think."), never the model's own sentences, which can state unchecked things as
fact. The guess is named as the word Boopy can teach that the model's label names. The label as it
is may match any English label or alias in the snapshot; every looser step matches item labels
only, never an alias: the label in the singular, then without a trailing "in", "with", "of", "on",
"at" or "from" phrase, then that phrase's last word. So "tents" and "desert tent" show and pick
their word as "tent", while "camera mount" never finds a mountain's alias "mount". Any other label
stays exactly as the model gave it, and the model's own label stays in `raw`. With no subject it says "I'm not sure what that is."; an earlier turn's subject never carries
over. On such a boop the model is also given the words Boopy can teach: the English labels and
aliases of the term snapshot practice uses. If one names the thing at the point, the model uses it
as the label; if none does, it uses its own short noun. The interpretation records that it was
given them (`hint`: `teachable-words`, their count and the snapshot's digest). The interpretation records `referentPoint` (`from`:
`model-object`, `recorded-outline` or `nothing`), and keeps the model's own answer in `raw`. A task
opened from such a boop has `utterance` `""`: nothing is put in the person's mouth.

## Outlines over a recording

`pnpm replay outline --data-dir DIR --recording ID` starts one outline run and returns at once;
`pnpm replay list` shows it running, then how many frames have outlines. The run needs the local scene
worker (`BOOPY_LIVE_SCENE=local`).

The local interpreter looks once at the recording's middle frame and proposes up to eight nouns for
it. The scene worker then runs on every kept frame, one at a time, with its general list of common
indoor and outdoor things plus those proposed nouns. Each outline says whether its noun came from
the general list (`base`) or from the interpreter (`proposed`). A noun the interpreter proposed and
the detector placed is still the interpreter's proposal: the two are never counted as agreeing.

The run is journaled once, as `recorded.outlines.made`: the worker and interpreter, the proposed
nouns, each frame's outlines with its frame id and time taken, the frames that failed, and the wall
time. A frame whose run failed has no outlines, and no outline moves to another frame.

`GET /v1/recorded-scene/outlines` answers the shown recording's outlines in frame order:

```json
{
  "samples": [
    {
      "frameId": "rfr_...",
      "seconds": 4.2,
      "provider": "local",
      "model": "...",
      "latencyMs": 640,
      "leftOut": 0,
      "verification": "proposed",
      "objects": [{ "label": "...", "confidence": 0.41, "origin": "proposed", "box": {}, "contour": [] }]
    }
  ]
}
```

It serves the outlines whose noun the interpreter proposed, and from the general list only its
people (`origin: "base"`, label `person`), so the headset keeps its text off a person the model did
not name. Those people are never drawn or named; nothing else from the general list is served.

The headset draws a frame's outlines only on that frame, never on the next one.
