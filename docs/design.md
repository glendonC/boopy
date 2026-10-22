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
| Subject | One outlined subject in the room. A task outlines the grounded item its annotation names. A box with no mask sits on one plane at the depth measured at its center, not at its corners. Up to four live outlines that cannot be tapped. |
| Annotation | A chip on saved evidence. A task's chip sits where that item's chip goes, keeps the item's kind, and stays proposed. It keeps the item's gloss, confidence, and emphasis only when its text is the item's label. An item that is not in this room gets no chip. Live names are display only. |
| Dialogue | A caption on the console, with optional local speech. A task's dialogue uses the same line. |
| Choice | Buttons on the console for a conversation. A first turn with a choice opens no task. A task's choice draws no control yet. |
| VoiceReply | One control under the task's line, labeled with the prompt, such as "Answer aloud". It records a spoken answer on the task. While it shows, it is the view's one filled control and Talk is plain. |
| TaskStep | Not built. A task's step draws no control. |
| Detail | The evidence reader on the console. |
| Status | Console notices. A task's status is the line's speaker: "Boopy · Not sent", or over an answer "You, as heard · Not sent" when recognition is uncertain and "You · Not sent" otherwise. |
| AgentPresence | The orb. Not yet split into quiet, near, and present. |

## Placement

Put the label in nearby empty space, not on top of the subject. Its leader stops just outside the
subject's outline and never crosses the object's face. The headset renders without anti-aliasing, so
an outline or leader keeps about one pixel of width at its distance. Use a backing only where the
scene makes the text hard to read. No sheets of glass, no constant glow, and no bloom by
default.

Do not use one large panel, a tilted tray of pieces, a tiny mixed-font scene, a flat stack of
cards, a purple palette, or a column of identical pills.

The segment follows the source mask or region. A saved photo does not become a 3D object.
