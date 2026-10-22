# Memory

Model output stays a proposal until a person acts. Missing information stays missing. A
model's confidence and a person's confirmation are different. Text in the world is kept as
OCR read it, not as a model's paraphrase.

## Saved items

Each saved item says whether it came from a model or a person, and whether a person accepted,
confirmed, wrote, corrected, or left it unconfirmed. OCR lines are stored with the line, a
confidence, and a box. They are not rewritten into the model's sentence.

A correction in a session updates that item. A later replacement links the old item to the new
one. The old text stays as it was. Search uses the link and does not present the old item as
current.

A practice attempt in an interaction task is not one of these items. Speaking a Korean
sentence about a photo is not a claim that the event in the photo happened.

## Search

`service/src/memory/recall.ts` rebuilds a search index from the saved items. The adopted
Meterless code only lowers the score of a replaced item. Boopy leaves replaced items out
before scoring. A ranking score cannot be attached to a replaced item, so ranking cannot put
that item back.

`recall.test.ts` covers a concrete case: a model line, "The person rode a camel in this
picture," is replaced by the person's line that a camel is in the picture and they did not
ride it. A later search for the ride does not return the model line. The original sentence is
unchanged. The attempt "낙타가 있어요" is not returned as the ride.

This is a search test on synthetic items. It does not yet change the next thing the headset
or an assistant says.

## What an image does not prove

Labels, retrieved passages, elapsed time, and models agreeing do not prove what the person
did, felt, or how well they speak. A flat photo has no depth, no hidden surroundings, and no
reliable place in the room later. Do not lay a saved 2D mask onto the live room without a
live registration.
