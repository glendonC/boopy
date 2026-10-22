# Adopted H-MEM reference subset

Source: https://github.com/Meterless/Meterless
Pin: 0aa7417ba5c826396d91e891328be78c45e6fbf6
Original paths: engines/hmem/reference/src/{types,embeddings,memoryStore,memoryRetrieval,trustLedger}.ts
License: Apache-2.0; full license is retained beside this notice.

This is an adopted store/retrieval/ledger subset, not full H-MEM conformance. The original
reference labels its embedder deterministic/mock, not a semantic model. No mining, dreaming,
sleep, automatic conflict resolution or provider call is adopted.

Boopy modifications: erasable constructor syntax and strict indexed-access assertions;
Unicode-letter/number token preservation; removal of automatic similarity-based supersession;
query ledger/trace stores operation/domain without query text; optional finite [-1, 1]
semantic-score override in scoreOne replaces only the semantic term of the existing hybrid
formula. The caller validates scoped source identity and supplies optional local NVIDIA scores;
the adopted reference itself makes no provider call. Formatting follows Boopy.

Boopy reconstructs an ephemeral index per query, keeps source evidence unchanged, requires
explicit journaled correction endpoints, and excludes superseded evidence from current results.
H-MEM confidence is a retrieval parameter, never human verification or original model confidence.
