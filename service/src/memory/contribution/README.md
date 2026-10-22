# Korean tokenization patch

`unicode-tokenizer.patch` applies to the Meterless pin in `../hmem/NOTICE.md`. It keeps
Unicode letters and numbers, including Korean, instead of stripping them.

`../recall.test.ts` checks that. The patch does not translate, and it does not add a semantic
embedding model. It has not been sent upstream.
