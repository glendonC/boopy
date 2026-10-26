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
| Subject | One outlined subject in the room: a soft solid Ember edge with no dashes or corners and a brighter inner rim. A task outlines the grounded item its annotation names. A box with no mask is a rounded outline about 7 mrad outside the box as seen from where the person stands, its corners rounded at three times that, on one plane at the depth measured at its center, not at its corners, with no fill, so it stays approximate. A mask is outlined along its own contour and gets a low fill on the object, nothing past it. One sweep of light, about 0.6 s, crosses the subject itself from Boopy's side when it first appears and when Boopy starts working on it (the box itself, not the margin); reduced motion has no sweep. Up to four live outlines that cannot be tapped; one whose edges cross or touch is left out with its object, and the frame keeps the rest. On a recorded scene the outline lies on the picture itself, on the still's own pixels: a 2D source has no depth, so the picture's plane is where its subject is. |
| Annotation | A chip on saved evidence, with a solid hairline border; proposed shows in its words and tone, not in dashes. A task's chip sits where that item's chip goes, keeps the item's kind, and stays proposed. It keeps the item's gloss, confidence, and emphasis only when its text is the item's label. An item that is not in this room gets no chip. Live names are display only. |
| Dialogue | A caption on the console, with optional local speech. A task's dialogue uses the same line. A turn's answer replaces its thinking phrase in one change, in place: 150 ms after the answer arrives the phrase fades out over 100 ms while the line's panel grows upward over 200 ms, eased out, its bottom edge fixed; the answer fades in from 250 ms to 400 ms. Boopy's voice plays as soon as the Mac returns it; nothing holds it to 250 ms. With reduced motion the same order holds with one cut at 150 ms and no growth. An error cuts in. |
| Choice | Boopy's prompt with one option at a time, paged on the panel; Choose in the row sends the one shown. A first turn with a choice opens no task. A task's choice draws no control yet. |
| VoiceReply | The first tile of the row, labeled Answer, only while Boopy's line asks the person something: the prompt the Mac sends, with Talk's mic glyph, in Talk's place. The prompt is one short word on one line. It records a spoken answer on the task. Once the line shows the person's answer, or when the line asks nothing, Talk is the first tile again. |
| TaskStep | Not built. A task's step draws no control. |
| Detail | The evidence reader on the console. |
| Status | Console notices. A task's status is the line's speaker: "Boopy · Not sent to your AI", or over an answer "You, as heard · Not sent to your AI" when recognition is uncertain and "You · Not sent to your AI" otherwise. |
| AgentPresence | The orb. When a turn that works on the recorded view starts on an outlined subject, it flies beside the subject, never over it or the center of the view, faces it, and lights it with a soft amber cone for as long as the sweep runs. While it thinks, its eyes narrow and its body glows toward Ember, breathing. It returns beside the console 650 ms after the answer lands, once the line has changed. With reduced motion it stays home, turns to the subject, and only the glow changes. A turn without a photo, a choice, or a follow-up that names no observation leaves it home; its eyes and glow still show that it thinks. Not yet split into quiet, near, and present. |

## Placement

Put the label in nearby empty space, not on top of the subject. Its leader stops just outside the
subject's outline and never crosses the object's face. The headset renders without anti-aliasing, so
an outline or leader keeps about one pixel of width at its distance. Use a backing only where the
scene makes the text hard to read. No sheets of glass and no bloom by default; no constant glow:
only the low fill on a subject's mask, and Boopy's glow while it thinks.

The console has one home: right of center and a little down (0.55 and -0.05 of the view frame, 1 m away) in
the view taken at the pinch. A turn puts it there, by fade if it moves, and it stays there from the pinch until
the answer has shown; only the reply's own objects move it, by fade (out 150 ms, moved unseen, in 150 ms) to the
nearest clear spot, or behind the line's fallback strip if none is clear. After a turn it stays fixed in the
room. It comes back home by fade only when home is more than 30 degrees away and the eyes are not on it.

Do not use one large panel, a tilted tray of pieces, a tiny mixed-font scene, a flat stack of
cards, a purple palette, or a column of identical pills.

The segment follows the source mask or region. A saved photo does not become a 3D object.

## Controls

Every control is one tile: the control plate, 0.124 m by 0.060 m with a 0.014 m corner, a filled
glyph and its label in IBM Plex Sans Regular at the body size, centered as one group inside the
tile. Nothing is filled and nothing is borderless. The recommended action is the row's first tile;
that is the only difference. No tile shows disabled: an action that cannot run now is not shown,
and the panel's words say why. Each glyph has one meaning and stays with its action in every
state: a mic on Talk, Answer and Finish, two bars on Pause and a triangle on Resume, a square on
Stop, a cross on Cancel and Dismiss, three dots on More, two cards on Context, a gear on Settings,
a left chevron on Back, a circular arrow on Check and Retry, a plus on New and Include, a minus on
Exclude, a camera on View and the camera crossed out on No view, a check mark on Choose, Use and
Confirm, a speech bubble on Ask, a tray with an up arrow on Prepare, three bars on Review, an i in
a circle on Status, a framed picture on Source, and on each setting's Turn on or Turn off its own
glyph: a T for Large text, a speaker for Sound, a moving dot for Reduced motion, a waveform for
Voice and the camera for Photo.

Every control is a tile of one row under the console's panel. Nothing sits on a panel, sheet or
card, and there is never a second row, a column or a grid. The row's left edge sits on the panel's
text column, so the orb stays to its left, and it has three slots 0.014 m apart. Pause, the
privacy stop, keeps the middle slot in every state. A speak tile (Talk, Answer, Finish) is always
first, and on a sheet or card Back is always last, so paging never moves Talk, Pause or Back. The
row reads Talk, Pause and More, with Answer in Talk's place while Boopy's line asks; Finish, Pause
and Cancel while recording; Stop and Pause while Boopy works; Pause alone, in the middle, while the
console is busy; Check, Pause and New while an earlier capture waits. While Boopy asks for a fresh
view it reads Talk, Pause and No view: No view turns the next turn's photo off, and the tile then
reads View to turn it back on, until the next turn; the next turn's words show on the line. Under
a choice it reads Talk, Pause and Choose: the panel holds Boopy's prompt and, as its own paragraph
one gap (0.014 m) under it, one option, and Choose sends the option shown in one tap. If the choice
stops or fails before Boopy answers, the card stays: the line says so for a moment, with the
choice's slot left empty, then shows the prompt and option again. Once Boopy is answering, or when
the Mac says the choice is no longer available, the card is gone. On a follow-up question's page it
reads Talk, Pause and Ask.

More swaps the same row in place to Context, Pause and More, then Settings, Pause and Back. The
Context sheet keeps its words, and its actions page with More, the recommended first and the last
ending in Back: Check for an earlier preparation, Prepare for this context, Review for the
conversation's items. The handoff's action is one word, Check, Prepare, Retry or Status, and the
sheet's words say the rest. Settings shows one setting per page, its state as a sentence ("Sound
is on."), with Turn on or Turn off, Pause and Back. Its first page sets nothing: it says what is connected
(your AI, the Mac, outlines, voice) over Pause and Back. While Voice is unavailable its page says so and
shows no left tile. The save
preview reads Use, Pause and Back; a prepared handoff Dismiss, Pause and Back, or Back alone with
nothing to do. The reader reads Exclude or Include, Pause and More, then Source, Pause and Back,
and in Source, Confirm, Pause and Back when the item can be confirmed. Back goes up one level:
from Source to its item, from the reader to the Context sheet, from More or a sheet to the
conversation. Sheets and cards sit on the line's column: their dark panel spans the text column
with the line's 12 mm side margin, and their words start on the text column. The Context sheet's
top line reads Context, as Settings' reads Settings, and its panel hugs its words; the reader
keeps one height across its pages, its tallest page's.

Lists show one item at a time on their own panel, paged with a pinch on the panel, never on the
row, with "n of N" where the speaker line sits: a long line's pages, a choice's options under its
prompt, the follow-up questions after Boopy's line (their speaker line reads "You could ask"), the
reader's items and source pages, and the settings. On the reader's card and on Settings a short
pinch pages and a held pinch talks, on the card about the item it shows, as a hold does everywhere.
The last page wraps to the first, and the row acts on the item shown. The row never moves: the
panel above it ends one gap (0.014 m) over the row in every state and grows upward with its words,
and the speaker label sits right above its line. Each page of a choice keeps its prompt with one
option under it, every page as tall as its tallest, and a question's page may take two more lines,
so a question fits one page. Boopy's words on the console's own panel, with no line over them, such
as the opening greeting or "Talk to continue.", sit on the line's dark panel too, across the text
column, hugging the words and ending one gap over the row.

A capture left pending by a restart is a dialog on the line's dark panel: "Earlier capture" and
one sentence, with no speaker line; Check and New sit on either side of Pause in the row under it.
The sentence says only what the headset knows: Boopy restarted before it heard back from the Mac,
and the picture is gone from the headset. The same dialog opens in the same run after Stop, a lost
connection, a refusal or a storage failure, each with its own sentence.
