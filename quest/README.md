# Boopy for Quest 3

The headset client. It captures what the person looks at, shows the interpretation in the
room, and sends corrections to the Mac service (`../service`). The interface is described in
[../docs/experience.md](../docs/experience.md) and [../docs/design.md](../docs/design.md).

## Requirements

- Unity `6000.3.25f1` with Android Build Support (its own SDK, NDK and OpenJDK).
- A Meta Quest 3 or 3S on Horizon OS v74 or later, in developer mode, connected by a USB-C data
  cable. The Passthrough Camera API exists only on these headsets.
- The service running on the Mac (`../service/README.md`).
- .NET 10 SDK for the core's tests.

Pinned in `Packages/manifest.json`: OpenXR `1.18.0`, and Meta XR Core, Interaction, and MR
Utility Kit `207.0.0`.

## Layout

| Path | What |
| --- | --- |
| `Packages/com.boopy.client` | Engine-free core: protocol, service client, geometry, pinch gesture, WAV, seated pointing, chip states. No `UnityEngine`; tested on .NET |
| `Assets/Boopy/Runtime` | The Unity layer: camera capture and depth, hands, reticles, chips, the session scene, the app loop |
| `Assets/Boopy/Editor/BoopyBuild.cs` | Builds the scene from Meta's prefabs, and the APK |
| `dotnet/` | The core's tests, including a session view the service itself produced |

## Build

With the Unity editor closed:

```bash
/Applications/Unity/Hub/Editor/6000.3.25f1/Unity.app/Contents/MacOS/Unity -batchmode -nographics -quit -projectPath "$PWD" -buildTarget Android -executeMethod Boopy.Quest.Editor.BoopyBuild.BuildApkInBatch -logFile -
```

The APK lands in `Builds/Boopy.apk` (git ignores it). In the editor, **Boopy > Build Quest APK**
does the same; **Boopy > Build Scene** only rebuilds `Assets/Boopy/Scenes/Boopy.unity`.

Core tests:

```bash
~/.dotnet/dotnet test dotnet/Boopy.Client.Tests
```

## Install and connect

```bash
ADB=/Applications/Unity/Hub/Editor/6000.3.25f1/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb
```

```bash
$ADB install -r Builds/Boopy.apk
```

```bash
$ADB reverse tcp:47900 tcp:47900
```

Unity's Android builds restart the adb server, which drops the reverse mapping. Keep this
guard running from the repository root:

```bash
node quest/scripts/tether.mjs
```

It restores only the missing Boopy 47900 USB mapping, checks every two seconds,
and never retries app requests or opens a network listener. Stop it with Ctrl-C when the session
ends. With multiple headsets, select one using `BOOPY_QUEST_SERIAL`; `BOOPY_ADB` overrides the
verified Unity adb path. `--once` performs a single check. Tests: `node --test quest/scripts/tether.test.mjs`.
Without the guard, restore the reverse mapping manually after every Unity build.
Before any install, check a built APK carries none of the Interaction SDK's telemetry:
`node quest/scripts/apk-privacy.mjs quest/Builds/Boopy.apk` (tests: `node --test quest/scripts/apk-privacy.test.mjs`).

On the Mac, start Ollama (`OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 ollama serve`) and the
service (`cd ../service && pnpm start`). Reuse an existing local-only Ollama server when available;
do not restart a shared server during another project's session. For a
quick check of the headset without any model, start the service with `BOOPY_INTERPRETER=fixture`.

## The first headset session

Use bare hands; controller triggers are not bound. Allow microphone, camera and spatial-data
permissions. Touch your thumb to your index finger, ask about the scene, then let go. Boopy acknowledges listening and
returns an actual answer with an optional local voice. One active source annotation remains proposed.

When that first answer is about a grounded subject, the headset shows the session's task from the
Mac. The chip on the outlined subject shows the task's label and stays proposed. The line beside
the companion shows Boopy's words under "Boopy · Not sent". Only while the line asks you something
is the first tile of the row under it **Answer**, the prompt the Mac sends, with Talk's mic, in
**Talk**'s place. Pinch it, speak, then tap **Finish**. The line reads "Saving on your Mac…"
while the Mac records your words on the task, then shows them under "You, as heard · Not sent",
and **Talk** is the first tile again. When the line asks nothing, Talk stays first. Nothing reaches your own assistant. A first answer that
offers a choice shows its choice and no task. A later Talk turn returns to the conversation's
own line.

Without a task, a response may offer up to two contextual questions, each on its own page behind
Boopy's line. Pinch the line's panel to page to one, then tap **Ask**: the same conversation
continues against its recorded evidence; it does not open the microphone, capture another view or
confirm a claim. You can continue speaking instead. A choice shows its prompt with one option;
pinch the panel for the next and tap **Choose** to send the one shown. Caption paging preserves
exact returned text, with "n of N" on the speaker line.

Every control is a tile of the row under the console. **More** shows **Context** and **More** in
its place, then **Settings** and **Back**. **Context** opens evolving context and exact evidence;
its actions page with **More** in the row, ending in **Back**, and the reader pages its items and
sources with a short pinch on its card. Correct a selected reference through speech, with a held
pinch on the card, or explicitly confirm or exclude an item. **Prepare → Use** creates the local
context snapshot. **Settings** shows one setting per page, pinched to the next, with **Turn on** or
**Turn off**. The receipt reads **Ready on your Mac. Not sent.** Boopy does not send it. An agent
you connect to the Mac's connector can read it.

A successful build is not a worn test. Segmentation is optional and off unless the service
enables it. Boxes stay approximate until a mask exists.

## Check first on the headset

These cannot be settled off the device:

- **Frame orientation.** Open the newest JPEG in `~/.boopy/media/` after a capture: it must be
  upright, not mirrored or flipped. If it is flipped, the camera colors arrive top-down and
  `RoomCamera.Capture` must flip rows.
- **Placement.** Does the outline land on the real referent, and do pinned chips sit on their
  things? If not, compare the frame's grounding preview (`pnpm simulate` writes one for a test
  image) with where it lands.
- **Depth.** Are cue points found for objects near the edge of view? The camera image is smaller
  than the display, and depth answers only inside its own view. Compare a complete slanted painting
  with a small natural object. The captured 16 x 12 grid can sample background or miss small
  objects; a strongly supported interior plane fit stabilizes flat surfaces but does not recover
  hidden edges or prove a complete 3D shape. Missing boundary depth disables fill.
- **Multiple objects.** One capture should expose eligible discovered objects without another
  pinch per object. Check secondary masks against their own boxes, not the primary capture cue,
  and keep approximate/unavailable results visible as such. More than four refinements remain
  approximate; all evidence is still accessible in Review.
- **Hangul.** The device log says which system font was used (`adb logcat -s Unity | grep Korean`).
- **Legibility and comfort.** Chip size, distance and the status line's height.
- **Latency.** The headset shows no timer; the service records model latency.
- **Pinch.** Whether holding to talk feels natural, and whether taps are mistaken for holds.
  If nothing happens, inspect `adb logcat -s Unity` for `Boopy: input` events and blocked reasons.
  Diagnostics contain interaction states and timings only. A palm/system block asks the wearer
  to turn their palm toward the scene; tracking/confidence blocks ask them to keep the hand visible.

Captures of what the wearer sees, without the wearer touching anything:

```bash
$ADB shell am startservice -n com.oculus.metacam/.capture.CaptureService -a TAKE_SCREENSHOT
```

They land in `/sdcard/Oculus/Screenshots` and can show the room; keep them out of the repository.


## Synthetic visual preview

With the editor closed, run the same Unity executable in batch mode **without** `-nographics`,
using `-executeMethod Boopy.Quest.Editor.SpatialPreview.Render` instead of the APK build method.
It renders actual modular surfaces, actions, labels and two attributed object contours over a
procedural room/photo. Overview keeps the evidence reader closed; Review,
capture, details, options, large-size, listening, processing and saved PNGs land under the Mac temporary
directory in `boopy-spatial-preview`;
the log prints the absolute directory. It makes no service requests and uses no private frames.
This checks typography and composition, not headset comfort or live depth placement.

The preview also writes 60 processing animation frames in `boopy-spatial-preview/motion/` and
24 contour trace/fill frames in `boopy-spatial-preview/contour-motion/`. The contour fixtures use
a synthetic 16 x 12 captured-depth grid and the actual `GroundedOverlay` renderer, including a
concave shape. Reduced-motion assertions check a completed static boundary and constant fill.
These
are production shader/text/companion renders with synthetic content, not a concept illustration.
The console stays where the pinch put it until the answer has shown, then stays fixed in the room;
it comes back in front by fade after a turn of more than 30 degrees, never while targeted. Object
annotations remain world-anchored. No Meta-button recenter is intended for routine access. Validate this while worn.
