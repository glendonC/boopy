"""Local detector + actual SAM2 masks. Stdout is bounded protocol data, never debug/media."""
import argparse
import base64
import hashlib
import io
import json
import os
import sys
import time
import warnings

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor
from transformers.utils import logging

logging.set_verbosity_error()
warnings.filterwarnings("ignore", category=FutureWarning)
VOCABULARY = "a person. a chair. a table. a sofa. a door. a window. a monitor. a laptop. a phone. a book. a bottle. a cup. a plant. a lamp. a picture. a bag. a shelf. a cabinet. a bed. a sign. a circle. a rectangle."
MAX_INPUT = 6 * 1024 * 1024


def mask_geometry(mask):
    """Return a simple mask boundary, never a bounding box substituted for a mask."""
    binary = np.asarray(mask, dtype=np.uint8)
    h, w = binary.shape
    pixels = int(binary.sum())
    if pixels < 64 or pixels / (w * h) > .80:
        return None
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hierarchy is None:
        return None
    exterior = [i for i, entry in enumerate(hierarchy[0]) if entry[3] == -1]
    index = max(exterior, key=lambda i: cv2.contourArea(contours[i]))
    contour = contours[index]
    area = float(cv2.contourArea(contour))
    if area < 64 or area < pixels * .90:
        return None  # Do not invent a connected boundary for fragmented foreground.
    holes = sum(cv2.contourArea(contours[i]) for i, entry in enumerate(hierarchy[0]) if entry[3] == index)
    if holes > area * .02:
        return None  # Current client contract has one loop and cannot preserve material holes.
    perimeter = cv2.arcLength(contour, True)
    simplified = cv2.approxPolyDP(contour, max(.6, perimeter * .003), True)
    for fraction in (.005, .008, .012):
        if len(simplified) <= 64:
            break
        simplified = cv2.approxPolyDP(contour, perimeter * fraction, True)
    if len(simplified) < 3 or len(simplified) > 64 or abs(cv2.contourArea(simplified) - area) > area * .08:
        return None
    x, y, bw, bh = cv2.boundingRect(contour)
    return {
        "box": {"x0": x / w, "y0": y / h, "x1": min(1, (x + bw) / w), "y1": min(1, (y + bh) / h)},
        "contour": [{"x": float(point[0][0]) / w, "y": float(point[0][1]) / h} for point in simplified],
        "maskSha256": hashlib.sha256(binary.tobytes()).hexdigest(),
        "maskPixels": pixels,
    }


def overlap(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0


class Perceiver:
    def __init__(self, detector_path, segmenter_path):
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.detector = AutoModelForZeroShotObjectDetection.from_pretrained(detector_path, local_files_only=True).to(self.device).eval()
        self.detector_processor = AutoProcessor.from_pretrained(detector_path, local_files_only=True)
        self.segmenter = Sam2Model.from_pretrained(segmenter_path, local_files_only=True).to(self.device).eval()
        self.segmenter_processor = Sam2Processor.from_pretrained(segmenter_path, local_files_only=True)

    def observe(self, image):
        started = time.perf_counter()
        # Restrict inference resolution and memory independently of input JPEG dimensions.
        image.thumbnail((640, 480), Image.Resampling.LANCZOS)
        w, h = image.size
        inputs = self.detector_processor(images=image, text=VOCABULARY, return_tensors="pt", size={"shortest_edge": min(h, w, 480), "longest_edge": 640}).to(self.device)
        with torch.inference_mode():
            detected = self.detector(**inputs)
        results = self.detector_processor.post_process_grounded_object_detection(detected, inputs.input_ids, threshold=.30, text_threshold=.25, target_sizes=[(h, w)])[0]
        labels = results["text_labels"]
        choices = []
        for index in results["scores"].argsort(descending=True).tolist():
            box = results["boxes"][index].detach().cpu().tolist()
            box = [max(0, min(w, box[0])), max(0, min(h, box[1])), max(0, min(w, box[2])), max(0, min(h, box[3]))]
            if box[2] - box[0] < 8 or box[3] - box[1] < 8 or (box[2]-box[0])*(box[3]-box[1]) / (w*h) > .80:
                continue
            if any(overlap(box, choice[0]) > .65 for choice in choices):
                continue
            choices.append((box, str(labels[index]), float(results["scores"][index].detach().cpu())))
            if len(choices) == 4:
                break
        objects = []
        accepted_masks = []
        if choices:
            inputs = self.segmenter_processor(images=image, input_boxes=[[choice[0] for choice in choices]], return_tensors="pt").to(self.device)
            with torch.inference_mode():
                segmented = self.segmenter(**inputs, multimask_output=False)
            masks = self.segmenter_processor.post_process_masks(segmented.pred_masks.cpu(), inputs["original_sizes"])[0]
            scores = segmented.iou_scores.detach().cpu().reshape(-1).tolist()
            for index, (_, label, confidence) in enumerate(choices):
                if not .70 <= scores[index] <= 1:
                    continue
                binary = masks[index, 0].numpy().astype(bool)
                if any(np.logical_and(binary, previous).sum() / max(1, np.logical_or(binary, previous).sum()) > .75 for previous in accepted_masks):
                    continue
                geometry = mask_geometry(binary)
                if geometry is None:
                    continue
                accepted_masks.append(binary)
                objects.append({"label": label.removeprefix("a ").removeprefix("an "), "confidence": confidence,
                                "maskConfidence": float(scores[index]), **geometry})
        return {"objects": objects, "latencyMs": (time.perf_counter() - started) * 1000}


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--detector-model", required=True)
    parser.add_argument("--segmenter-model", required=True)
    args = parser.parse_args()
    try:
        perceiver = Perceiver(args.detector_model, args.segmenter_model)
        # Genuine synthetic inference warms Metal kernels before accepting headset frames.
        warm = Image.new("RGB", (640, 480), (38, 42, 46))
        draw = ImageDraw.Draw(warm)
        draw.ellipse((70, 90, 280, 310), fill=(220, 90, 60))
        draw.rectangle((350, 160, 560, 370), fill=(60, 180, 220))
        perceiver.observe(warm)
        emit({"type": "ready", "device": perceiver.device})
    except Exception:
        emit({"type": "startup-error"})
        return 1
    while True:
        line = sys.stdin.buffer.readline(MAX_INPUT + 1)
        if not line:
            break
        identity = None
        try:
            if len(line) > MAX_INPUT or not line.endswith(b"\n"):
                raise ValueError()
            request = json.loads(line)
            identity = request["id"]
            if not isinstance(identity, int) or identity < 1:
                raise ValueError()
            jpeg = base64.b64decode(request["jpeg"], validate=True)
            if len(jpeg) > 4 * 1024 * 1024 or not jpeg.startswith(b"\xff\xd8"):
                raise ValueError()
            with Image.open(io.BytesIO(jpeg)) as source:
                if source.width * source.height > 20_000_000 or source.width < 8 or source.height < 8:
                    raise ValueError()
                image = source.convert("RGB")
            emit({"type": "result", "id": identity, **perceiver.observe(image)})
        except Exception:
            emit({"type": "error", "id": identity})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
