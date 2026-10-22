"""Pinned open-weight NVIDIA probe on explicit CPU/MPS; no network or private inputs at inference."""
import argparse
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument("plan")
parser.add_argument("model_path")
parser.add_argument("output")
parser.add_argument("--device", choices=["cpu", "mps"], required=True)
args = parser.parse_args()
plan = json.loads(Path(args.plan).read_text())
if (plan.get("synthetic") is not True or plan.get("model") != "nvidia/nemotron-3-embed-1b"
        or [body.get("input_type") for body in plan["bodies"]] != ["passage", "query"]
        or any(len(body["input"]) != 6 for body in plan["bodies"])
        or sum(len(text) for body in plan["bodies"] for text in body["input"]) > 10000):
    raise ValueError("Expected bounded preregistered synthetic plan")
weights = Path(args.model_path) / "model.safetensors"
if weights.stat().st_size != 2281852472:
    raise ValueError("Unexpected pinned weight size")
with weights.open("rb") as handle:
    weight_sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
if weight_sha256 != "f959c3b04e66b42de280bfb97c140cb7e0bfe25e3ecb0b4464c68a8436b2d04f":
    raise ValueError("Pinned NVIDIA weight hash mismatch")
# No implicit hub fetch or CUDA/MPS-to-CPU fallback during the actual measurement.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
import torch
from sentence_transformers import SentenceTransformer
if args.device == "mps" and not torch.backends.mps.is_available():
    raise RuntimeError("Explicit MPS device is unavailable")
torch.set_num_threads(4)
started = time.perf_counter()
model = SentenceTransformer(args.model_path, device=args.device, trust_remote_code=False,
                            local_files_only=True,
                            model_kwargs={"dtype": torch.float32, "attn_implementation": "sdpa"})
model.max_seq_length = 512
load_ms = (time.perf_counter() - started) * 1000
vectors = []
latencies = []
for body in plan["bodies"]:
    start = time.perf_counter()
    method = model.encode_document if body["input_type"] == "passage" else model.encode_query
    values = method(body["input"], batch_size=2, normalize_embeddings=True,
                    convert_to_numpy=True, show_progress_bar=False)
    if args.device == "mps":
        torch.mps.synchronize()
    latencies.append((time.perf_counter() - start) * 1000)
    vectors.append(values.tolist())
receipt = {"synthetic": True, "model": plan["model"], "passageSources": plan["passageSources"],
           "queryIds": plan["queryIds"], "passages": vectors[0], "queries": vectors[1],
           "provider": "nvidia-open-weight-local", "device": args.device, "dtype": "float32",
           "revision": "c0c9fea93ea424587517f2c59e20db9f1d6bf615", "weightSha256": weight_sha256, "maxSeqLength": 512,
           "loadMs": load_ms, "latencyMs": latencies,
           "versions": {name: importlib.metadata.version(name) for name in
                        ["torch", "transformers", "sentence-transformers"]}}
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(receipt, handle)
print(json.dumps({key: value for key, value in receipt.items()
                  if key not in ["passages", "queries", "passageSources", "queryIds"]}, indent=2))
