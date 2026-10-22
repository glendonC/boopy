# AGENTS.md

Rules for AI coding agents working in this repository. Read [docs/architecture.md](docs/architecture.md)
before changing anything structural. Product scope is [docs/product.md](docs/product.md). The
public docs are listed in [docs/README.md](docs/README.md). Working notes stay in `.private/`
and are not part of the published tree.

## Product rules that code must enforce

- Model output is **proposed** until a person acts on it. Never store, label or return a model's
  claim as confirmed.
- Unknown stays unknown. Keep low confidence, open questions and missing data visible; never fill
  gaps with plausible guesses.
- Keep where an item came from: which frame, utterance, and model, and what the person did to it.
  Model confidence and human verification are separate fields.
- Text read from the world is the OCR text, not a vision model's paraphrase.
- Every change is appended to the journal. Current state is rebuilt from the journal.
- If a result was not delivered to the real assistant, say it was not sent. There is no live
  round trip to that assistant.

## Architecture rules

- The headset talks only to the Boopy service. It holds no model keys and makes no interpretation
  decisions.
- Provider-specific coordinate grids are converted at the adapter boundary. Inside Boopy, image
  coordinates are normalized 0 to 1 with the origin at the top-left.
- The service listens on loopback. Anything that exposes it to a network needs a security review
  first.
- No speculative abstractions: no interface without a second implementation or a test double that
  needs it.

## Working rules

1. Check an external API against its current docs or a test before relying on it. Put working
   notes in `.private/`, not in the public docs.
2. Keep facts, choices, and open questions separate. Open questions go in
   `.private/docs/open-questions.md`, not into code.
3. Add tests with every behavior change. `pnpm check` in `service/` must pass.
4. Never log or commit secrets, frames, audio, or transcripts. Test fixtures are synthetic.
5. Keep changes scoped. Update the public doc for any behavior you change.
