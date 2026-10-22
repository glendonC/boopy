# Boopy context service

Runs on the Mac. The headset sends it what it saw and heard.

`src/interaction/contract.ts` is the shape of one task. A model's parts are a proposal.
A person's action is separate. Every task view is `not-sent`. Nothing here reaches the
person's assistant.

`src/interaction/tasks.ts` opens that task from the person's words and records what they
do next. The record stays on this Mac. Delivery stays `not-sent`.

## Check

```bash
pnpm install
pnpm check
```

Typecheck, lint and tests. Tests use synthetic values.
