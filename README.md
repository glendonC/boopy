# Boopy

**Your AI, in your world.**

The spatial interface for a person's existing personal AI.

A local model on your Mac guesses what you point at, live or in your own footage. If you set a
language to practise, Zetaris gives the word and Meterless recalls what you practised, and if you
connect it, your Grok Bot gets the moment.

A proposal stays a proposal until a person acts. If a result was not delivered, it was not sent.
There is no live round trip unless a send to the person's own assistant actually started.

Read the [manual](docs/README.md).

## How it works with Zetaris and Meterless

You point at something in front of you, or in your own footage at the size you saw it. A local
model on your Mac guesses what it is, and Boopy keeps that a guess. If you have set a language to
practise, Boopy gives you the word for it and listens for you to say it. It tells you only whether
it heard the word, never whether you are right, because the recognizer can be wrong. `pnpm trace`
prints each step (observe, evidence, retrieve, decide, act, send, update) without any of your
words.

### Zetaris: Boopy's data layer

- **What it holds.** The word list Boopy can teach: 14 concepts with 268 label, alias and
  description rows in 8 languages, from a dated Wikidata snapshot (CC0, revision ids kept). And your
  practice record, staged from every counted attempt in Boopy's journal (ids, concept, language,
  result and time; no words you said). Zetaris runs locally on the Mac, in Docker, on loopback only.
- **How it decides.** One fixed, governed query, `term-pick-v1`, joins the word list with your
  practice record and returns the word to teach with a reason: new, heard before, or not heard
  before. That reason is what changes Boopy's line when you come back to the same thing: "Tent, I
  think. Last time I heard 천막. Can you say it again?", or "Last time 천막 didn't come through.
  Want to try again?". The model never picks the word; your guess has to match a label or alias in
  the list, by itself, its singular or its head noun.
- **Access rules.** Boopy's practice account can read the word list and its own practice tables,
  and Zetaris refuses it any other table. Writes go through Boopy's fixed statements only, and every
  word row a pick returns is checked against the import's receipt, kept outside Zetaris. See
  [the Zetaris probes](service/probes/zetaris/README.md).
- **Without Zetaris,** Boopy gives no word and says so. It never falls back to the model's own
  translation.

### Meterless: recall of earlier practice

An adopted subset of Meterless H-MEM (`service/src/memory/hmem/`, upstream `Meterless/Meterless`
at `0aa7417`, Apache-2.0, with its licence and notice beside the code) recalls your earlier practice
from the journal, by the same guess and by the same recording. It leaves out anything from a task
whose subject you marked wrong, and adds the recalled concepts to the Zetaris query. Its visible
effect: when you boop something else in footage where you practised before, the detail under the
word adds what you tried there, for example "You tried 천막 (tent) before." on the sky. The changed
line on a return visit to the same thing comes from the Zetaris practice record, not from recall.
This is not full H-MEM conformance: the reference embedder is deterministic, not semantic.

### Moments to your Grok Bot

If you set up a Grok Bot routine with a webhook trigger, each boop's moment goes to it, one way: the
guess, the word and its source, whether Boopy heard you, Boopy's spoken line, and on the first moment a
small picture of what you pointed at. Boopy says "Sent to your Grok Bot" only once the Bot's
run has started; the Bot's reply stays in its chat. With no routine, or a send that failed or has
not started, it says "Not sent to your AI". No transcript, time or place is sent. Setup and limits
are in [the service README](service/README.md#moments-to-your-grok-bot).

### A rehearsal on the Mac

With a real photo of a camel (the answers were synthetic voice clips, not a person): the model
guessed "Camel" in 17.0 s on a cold start and 3.2 s warm, and the Zetaris pick took 1.2 s and
1.6 s. After a wrong answer, the next look said "Last time 낙타 didn't come through. Want to try
again?".

### Data and licences

The word list is Wikidata labels, aliases and descriptions under CC0. The Meterless H-MEM subset is
Apache-2.0. The trip footage is the owner's own and is not in this repository. Tests use synthetic
fixtures only. Korean text on a Morocco photo is sample data, not the product.
