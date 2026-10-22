# AGENTS.md

Rules for AI coding agents working in this repository. Product scope is [docs/product.md](docs/product.md).

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
