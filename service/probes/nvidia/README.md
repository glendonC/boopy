# NVIDIA embedding probe

Local ranking for a fixed set of synthetic passages. A cosine score is not a fact, and it does
not override a correction. Replaced and unselected items are left out before embedding.

The production helper is `service/src/memory/nvidia.ts`. It shells out to `worker.py` and does
not download a model.

Offline checks:

```sh
node --test service/probes/nvidia/evaluate.test.mjs
node service/probes/nvidia/evaluate.mjs
```

A local open-weight run uses `nvidia/Nemotron-3-Embed-1B-BF16` at revision
`c0c9fea93ea424587517f2c59e20db9f1d6bf615`, outside git. Point `local.py` at that directory
and an isolated Python 3.12 environment. It does not use the network at inference time.

```sh
node service/probes/nvidia/evaluate.mjs --requests > /tmp/boopy-nvidia-plan.json
/path/to/python service/probes/nvidia/local.py /tmp/boopy-nvidia-plan.json /path/to/model /tmp/boopy-nvidia-local-vectors.json --device mps
node service/probes/nvidia/evaluate.mjs --vectors /tmp/boopy-nvidia-local-vectors.json
```

Hosted NIM calls, when used, read a key from a private mode `0600` file. `run.mjs` makes two
requests and does not retry.

```sh
node service/probes/nvidia/run.mjs /absolute/private/key-file /tmp/boopy-nvidia-vectors.json
```

A high score can still rank the wrong passage first. Do not treat the top result as truth.
