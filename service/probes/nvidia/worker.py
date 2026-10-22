"""Persistent offline NVIDIA open-weight worker. Protocol stdout only; never logs selected text."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--model-dir", required=True)
parser.add_argument("--device", choices=["cpu", "mps"], required=True)
args = parser.parse_args()
for key in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_IMPLICIT_TOKEN"]:
    os.environ[key] = "1"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
MODEL = "nvidia/nemotron-3-embed-1b"
REVISION = "c0c9fea93ea424587517f2c59e20db9f1d6bf615"

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()

try:
    weights = Path(args.model_dir) / "model.safetensors"
    if weights.stat().st_size != 2281852472:
        raise ValueError()
    with weights.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != "f959c3b04e66b42de280bfb97c140cb7e0bfe25e3ecb0b4464c68a8436b2d04f":
            raise ValueError()
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from sentence_transformers import SentenceTransformer
        if args.device == "mps" and not torch.backends.mps.is_available():
            raise ValueError()
        torch.set_num_threads(4)
        model = SentenceTransformer(args.model_dir, device=args.device, local_files_only=True,
                                   trust_remote_code=False,
                                   model_kwargs={"dtype": torch.float32, "attn_implementation": "sdpa"})
        model.max_seq_length = 512
    emit({"type": "ready", "model": MODEL, "revision": REVISION, "dimension": 2048})
except Exception:
    sys.exit(1)

for line in sys.stdin:
    request_id = ""
    try:
        if len(line.encode()) > 256000:
            raise ValueError()
        request = json.loads(line)
        request_id = request.get("id", "")
        candidates = request["candidates"]
        query = request["query"]
        if (set(request) != {"id", "op", "query", "candidates"} or request["op"] != "embed"
                or not isinstance(request_id, str) or not 1 <= len(request_id) <= 100
                or not isinstance(query, str) or not 1 <= len(query) <= 500
                or not isinstance(candidates, list) or not 1 <= len(candidates) <= 20):
            raise ValueError()
        for item in candidates:
            if (set(item) != {"sourceId", "text"} or not isinstance(item["sourceId"], str)
                    or not 1 <= len(item["sourceId"]) <= 512 or not isinstance(item["text"], str)
                    or not 1 <= len(item["text"]) <= 8000):
                raise ValueError()
        # Count the exact supplied role prefix and tokenizer special tokens; never silently truncate.
        texts = ["query: " + query] + ["passage: " + item["text"] for item in candidates]
        encoded = model.tokenizer(texts, truncation=False, add_special_tokens=True)["input_ids"]
        if any(len(tokens) > 512 for tokens in encoded):
            emit({"type": "error", "id": request_id, "code": "too_long"})
            continue
        with contextlib.redirect_stdout(sys.stderr):
            vectors = model.encode_document([item["text"] for item in candidates], batch_size=2,
                                            normalize_embeddings=True, convert_to_numpy=True,
                                            show_progress_bar=False)
            vector = model.encode_query([query], batch_size=1, normalize_embeddings=True,
                                        convert_to_numpy=True, show_progress_bar=False)[0]
        emit({"type": "result", "id": request_id, "query": vector.tolist(),
              "passages": [{"sourceId": item["sourceId"], "embedding": embedding.tolist()}
                           for item, embedding in zip(candidates, vectors, strict=True)]})
    except Exception:
        # No selected text, paths, parser exception or model diagnostics leave the protocol.
        emit({"type": "error", "id": request_id if isinstance(request_id, str) else "", "code": "inference_failed"})
