# Architecture

The Quest talks only to the Boopy service on the Mac. The headset captures, points, and draws.
It holds no model keys and does not decide what something means. The service listens on
loopback. Putting it on the network needs a security review first.

```text
Quest 3                              Mac service
passthrough, pinch, voice            speech, OCR, interpretation
one subject, labels, dialogue  <---> journal
                                     connector for saved context
```

USB `adb reverse` maps the headset's `127.0.0.1:47900` to the service. The connector is on
`47901`.

Results stay local and unsent. Nothing on this path reaches an outside assistant.

## Rules

1. Model output stays proposed until a person acts on it.
2. Missing information stays missing.
3. State comes from the journal.
4. The headset never holds a model key.
5. The service stays on loopback unless that exposure has been reviewed.
