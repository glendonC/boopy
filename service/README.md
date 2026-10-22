# Boopy context service

Runs on the Mac. The headset sends it what it saw and heard.

`src/interaction/contract.ts` is the shape of one task. A model's parts are a proposal.
A person's action is separate. Every task view is `not-sent`. Nothing here reaches the
person's assistant.

## Check

```bash
pnpm install
pnpm check
```

Typecheck, lint and tests. Tests use synthetic values.
