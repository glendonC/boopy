# Design

Scene first. A little interface, placed carefully, should feel clearer than many panels.

## Color

| Name | Hex | Use |
| --- | --- | --- |
| Graphite | `#141B21` | Surface |
| Frost | `#F1F5F5` | Main text |
| Mist | `#AABAC1` | Secondary text |
| Glacier | `#82DCE4` | Optional accent |
| Iris | `#B8A6E9` | Optional assistant theme |
| Ember | `#E5B98C` | Optional assistant theme |

These are Boopy colors. They are not a model's brand, and they do not encode confidence.
Errors and waiting need their own colors.

The Quest client still uses IBM Plex, a dark console, and cyan accents in
`quest/Assets/Boopy/Runtime/SpatialTheme.cs`. Change that only after comparing it on the
headset. IBM Plex stays until Inter Variable and Noto Sans KR are checked on device.

## Type

Target faces: Inter Variable for Latin, Noto Sans KR for Korean. Regular or medium weight.
Do not make type thin to look futuristic.

Starting sizes, not a comfort guarantee: labels 22–24 dp, dialogue 18–20 dp, secondary copy
14–16 dp.

## Parts

`Subject`, `Annotation`, `Dialogue`, `Choice`, `VoiceReply`, `TaskStep`, `Detail`, `Status`,
`AgentPresence`.

The assistant chooses content and which of these parts are allowed. Boopy checks the shape
and builds the interface. The model does not send scripts, scene graphs, or HTML. The schema
is `service/src/interaction/contract.ts`. The Quest client draws a task view on the parts a
conversation already uses. A task adds no panel, tray, or card.

| Part | In the client now |
| --- | --- |
| Subject | One outlined subject in the room: a soft solid Ember edge with no dashes or corners and a brighter inner rim. A task outlines the grounded item its annotation names. A box with no mask is a rounded outline about 7 mrad outside the box as seen from where the person stands, its corners rounded at three times that, on one plane at the depth measured at its center, not at its corners, with no fill, so it stays approximate. A mask is outlined along its own contour and gets a low fill on the object, nothing past it. One sweep of light, about 0.6 s, crosses the subject itself from Boopy's side when it first appears and when Boopy starts working on it (the box itself, not the margin); reduced motion has no sweep. Up to four live outlines that cannot be tapped, unchanged. |
| Annotation | A chip on saved evidence, with a solid hairline border; proposed shows in its words and tone, not in dashes. A task's chip sits where that item's chip goes, keeps the item's kind, and stays proposed. It keeps the item's gloss, confidence, and emphasis only when its text is the item's label. An item that is not in this room gets no chip. Live names are display only. |
| Dialogue | A caption on the console, with optional local speech. A task's dialogue uses the same line. |
| Choice | Boopy's prompt with one option at a time, paged on the panel; Choose in the row sends the one shown. A first turn with a choice opens no task. A task's choice draws no control yet. |
| VoiceReply | The first tile of the row, labeled Answer, only while Boopy's line asks the person something: the prompt the Mac sends, with Talk's mic glyph, in Talk's place. The prompt is one short word on one line. It records a spoken answer on the task. Once the line shows the person's answer, or when the line asks nothing, Talk is the first tile again. |
| TaskStep | Not built. A task's step draws no control. |
| Detail | The evidence reader on the console. |
| Status | Console notices. A task's status is the line's speaker: "Boopy · Not sent", or over an answer "You, as heard · Not sent" when recognition is uncertain and "You · Not sent" otherwise. |
| AgentPresence | The orb. When a turn that works on the recorded view starts on an outlined subject, it flies beside the subject, never over it or the center of the view, faces it, and lights it with a soft amber cone for as long as the sweep runs. While it thinks, its eyes narrow and its body glows toward Ember, breathing. It returns beside the console when the answer lands. With reduced motion it stays home, turns to the subject, and only the glow changes. A turn without a photo, a choice, or a follow-up that names no observation leaves it home; its eyes and glow still show that it thinks. Not yet split into quiet, near, and present. |

## Placement

Put the label in nearby empty space, not on top of the subject. Its leader stops just outside the
subject's outline and never crosses the object's face. The headset renders without anti-aliasing, so
an outline or leader keeps about one pixel of width at its distance. Use a backing only where the
scene makes the text hard to read. No sheets of glass and no bloom by default; no constant glow:
only the low fill on a subject's mask, and Boopy's glow while it thinks.

Do not use one large panel, a tilted tray of pieces, a tiny mixed-font scene, a flat stack of
cards, a purple palette, or a column of identical pills.

The segment follows the source mask or region. A saved photo does not become a 3D object.

## Controls

Every control is one tile: the control plate, 0.124 m by 0.060 m with a 0.014 m corner, a filled
glyph and its label in IBM Plex Sans Regular at the body size, centered as one group inside the
tile. Nothing is filled and nothing is borderless. The recommended action is the row's first tile;
that is the only difference. Each glyph has one meaning and stays with its action in every state: a mic on Talk, Answer and
Finish, two bars on Pause and a triangle on Resume, a square on Stop, a cross on Cancel and Dismiss,
three dots on More, two cards on Context, a gear on Settings, a left chevron on Back, a circular
arrow on Check and Retry, a plus on New and Include, a minus on Exclude, a camera on View and the
camera crossed out on No view, a check mark on Choose, Use and Confirm, a speech bubble on Ask, a
tray with an up arrow on Prepare, three bars on Review, an i in a circle on Status, a framed picture
on Source, and on each setting's Turn on or Turn off its own glyph: a T for Large text, a speaker
for Sound, a moving dot for Reduced motion, a waveform for Voice and the camera for Photo.

One row under the console's panel holds the tiles. Its left edge sits on the panel's text column,
so the orb stays to its left, and it has three slots 0.014 m apart. Pause, the privacy stop, keeps
the middle slot in every state: Answer, Pause and More while Boopy's line asks; Talk, Pause and
More otherwise; Finish, Pause and Cancel while recording; Stop and Pause while Boopy works; Check,
Pause and New while an earlier capture waits; Pause alone, in the middle, while the console is
busy. More swaps the same row in place to Context, Pause and Back, and Settings is a tile on the
Context sheet. The row never moves: the panel above it holds only Boopy's line, ends one gap
(0.014 m) over the row in every state and grows upward with its line, and the speaker label sits
right above its line. Paging the line is a pinch on its panel, never on the row. The panel's
question and choice rows stay left-aligned, as content. Sheets and cards sit on the line's
column: their dark panel spans the text column with the line's 12 mm side margin, and their
words start on the text column. Under a choice the row reads Talk, Pause and Choose: the panel holds
Boopy's prompt and, as its own paragraph one gap (0.014 m) under it, one option, and Choose sends
the option shown. On a follow-up question's page the row reads Talk, Pause and Ask.

A capture left pending by a restart is a dialog on the line's dark panel: "Earlier capture" and
one sentence, with no speaker line; Check and New sit on either side of Pause in the row under it.
The sentence says only what the headset knows: Boopy restarted before it heard back from the Mac,
and the picture is gone from the headset. The same dialog opens in the same run after Stop, a lost
connection, a refusal or a storage failure, each with its own sentence.
