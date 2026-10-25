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

A service that shows recordings takes recorded frames only: a room frame there is refused with 409
`recorded_only`, so its journal never mixes the room with a recording. A service without recordings
refuses a recorded frame with 404 `recorded_unavailable`. Session views and saved context show
`capturedAt` as null when it is unknown, and mark the observation `recorded`.
