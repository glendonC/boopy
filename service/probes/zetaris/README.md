# Zetaris probes

Local only. Credentials stay in a mode `0600` file outside git: two UTF-8 lines, username then
password. Do not put them in arguments, URLs, or logs.

## Connectivity

Fixed `SELECT 1`. A success means the driver connected. It does not mean a join ran.

```sh
node service/probes/zetaris/run.mjs /absolute/private/credential-file
node service/probes/zetaris/run.mjs /absolute/private/credential-file --metadata
```

`--metadata` prints a bounded schema count and the driver version, not schema names.

## Fixed lookups

`run-federation.mjs` accepts only `discover`, `join`, `reference`, and the setup operations
named in the script. `reference` takes one of `Q25391` (dune), `Q8514` (desert), or `Q71516`
(dromedary).

```sh
node service/probes/zetaris/run-federation.mjs /absolute/private/reader-credential-file reference Q25391
```

The service helper is `lookupZetarisReference` in `service/src/references/zetaris.ts`. It does
not accept SQL, a host, or a journal path, and it does not upload saved context.

Zero rows or duplicate rows fail. A failure does not invent a fallback row.
