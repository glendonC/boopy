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

## Parts

`Subject`, `Annotation`, `Dialogue`, `Choice`, `VoiceReply`, `TaskStep`, `Detail`, `Status`,
`AgentPresence`.

The assistant chooses content and which of these parts are allowed. Boopy checks the shape
and builds the interface. The model does not send scripts, scene graphs, or HTML.
