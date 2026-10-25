"""Local detector + actual SAM2 masks. Stdout is bounded protocol data, never debug/media."""
import argparse
import base64
import hashlib
import io
import json
import os
import re
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
# One general base list for live and recorded frames alike: common indoor things, then common
# outdoor people, animals, vehicles and features. It is never chosen for one picture or recording.
# Shape words are not in it: a probe that draws shapes asks for them as its own nouns.
NOUNS = ["person", "chair", "table", "sofa", "door", "window", "monitor", "laptop", "phone", "book",
         "bottle", "cup", "plant", "lamp", "picture", "bag", "shelf", "cabinet", "bed", "sign",
         "animal", "bird", "dog", "horse", "vehicle", "car", "truck", "motorcycle", "bicycle",
         "boat", "tree", "building", "rock"]
# Per request, up to this many nouns the local interpreter proposed for that picture join the list.
# They are the interpreter's proposals placed by the detector, never a second opinion.
MAX_PROPOSED = 8
PROPOSED = r"^[a-z]+(?:[ -][a-z]+){0,3}$"


def vocabulary(nouns):
    """The detector prompt for these nouns: "a person. a chair. ..."."""
    return " ".join(f"a {noun}." for noun in nouns)


def request_nouns(proposed):
    """The base list plus the request's proposed nouns, and which of them are proposals.

    A proposed noun is lowercase words joined by single spaces or hyphens, never "a" or "an" on
    its own, at most 32 characters; anything else refuses the request rather than being cleaned.
    """
    if not isinstance(proposed, list) or len(proposed) > MAX_PROPOSED:
        raise ValueError()
    extra = []
    for noun in proposed:
        if not isinstance(noun, str) or len(noun) > 32 or not re.fullmatch(PROPOSED, noun):
            raise ValueError()
        if any(word in ("a", "an") for word in re.split(r"[ -]", noun)):
            raise ValueError()
        if noun not in NOUNS and noun not in extra:
            extra.append(noun)
    return NOUNS + extra, set(extra)
DETECTION_THRESHOLD = .30
TEXT_THRESHOLD = .25
MAX_INPUT = 6 * 1024 * 1024


def noun_spans(tokens, nouns=NOUNS):
    """Token positions of each vocabulary noun in the tokenized prompt, in vocabulary order.

    Special tokens, articles and periods belong to no noun. None when the prompt does not split
    into exactly the vocabulary's nouns, so a label can never come from a misaligned token.
    """
    spans, current = [], []
    for position, token in enumerate(tokens):
        if token in ("[CLS]", "[SEP]", "a", "an"):
            continue
        if token == ".":
            if current:
                spans.append(current)
            current = []
            continue
        current.append(position)
    if current:
        spans.append(current)
    if len(spans) != len(nouns):
        return None
    for noun, span in zip(nouns, spans):
        # A noun of several words comes back as its word pieces with no spaces between them.
        if "".join(tokens[position].removeprefix("##") for position in span) != noun.replace(" ", ""):
            return None
    return spans


def best_noun(token_scores, spans, threshold, nouns=NOUNS):
    """The one vocabulary noun the detector scores highest for a box, with that noun's own score.

    None when that score is under the threshold or another noun has exactly the same score: an
    unclear name is left out, never guessed, and a joined phrase of several nouns is never a name.
    """
    scores = [max(float(token_scores[position]) for position in span) for span in spans]
    best = max(scores)
    if best < threshold or scores.count(best) > 1:
        return None
    return nouns[scores.index(best)], best


def turn(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def meets(a, b, c, d):
    """Whether two edges cross or touch, the headset's own test."""
    def within(p, q, r):
        return (min(p[0], q[0]) - 1e-8 <= r[0] <= max(p[0], q[0]) + 1e-8
                and min(p[1], q[1]) - 1e-8 <= r[1] <= max(p[1], q[1]) + 1e-8)
    x, y, u, v = turn(a, b, c), turn(a, b, d), turn(c, d, a), turn(c, d, b)
    return ((x * y < 0 and u * v < 0) or (abs(x) < 1e-8 and within(a, b, c)) or (abs(y) < 1e-8 and within(a, b, d))
            or (abs(u) < 1e-8 and within(c, d, a)) or (abs(v) < 1e-8 and within(c, d, b)))


def simple_outline(points):
    """Whether the headset can draw this outline, by its own rule (SurfaceGeometry.TryTriangulate):
    3 to 256 points within the frame, no repeated point, no edge that crosses or touches another,
    some area, and an ear-clipping triangulation."""
    n = len(points)
    if n < 3 or n > 256:
        return False
    area = 0.0
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        if not (0 <= a[0] <= 1 and 0 <= a[1] <= 1):
            return False
        if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 1e-12:
            return False
        area += a[0] * b[1] - a[1] * b[0]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if meets(a, b, points[j], points[(j + 1) % n]):
                return False
    if abs(area) < 1e-6:
        return False
    winding = 1 if area > 0 else -1
    remaining = list(range(n))
    while len(remaining) > 3:
        found = False
        for i in range(len(remaining)):
            a, b, c = remaining[i - 1], remaining[i], remaining[(i + 1) % len(remaining)]
            cross = turn(points[a], points[b], points[c]) * winding
            if abs(cross) < 1e-8:
                remaining.pop(i)
                found = True
                break
            if cross < 0:
                continue
            if any(p not in (a, b, c)
                   and turn(points[a], points[b], points[p]) * winding >= -1e-8
                   and turn(points[b], points[c], points[p]) * winding >= -1e-8
                   and turn(points[c], points[a], points[p]) * winding >= -1e-8 for p in remaining):
                continue
            remaining.pop(i)
            found = True
            break
        if not found or len(remaining) < 3:
            return False
    return True


# Returned for an outline left out because its edges cross or touch, so the frame can count it.
NOT_SIMPLE = object()


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
    outline = [(float(point[0][0]) / w, float(point[0][1]) / h) for point in simplified]
    if not simple_outline(outline):
        return NOT_SIMPLE  # Simplifying can cross edges; the headset refuses such a frame, so leave it out.
    x, y, bw, bh = cv2.boundingRect(contour)
    return {
        "box": {"x0": x / w, "y0": y / h, "x1": min(1, (x + bw) / w), "y1": min(1, (y + bh) / h)},
        "contour": [{"x": px, "y": py} for px, py in outline],
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

    def observe(self, image, proposed=()):
        started = time.perf_counter()
        nouns, proposals = request_nouns(list(proposed))
        # Restrict inference resolution and memory independently of input JPEG dimensions.
        image.thumbnail((640, 480), Image.Resampling.LANCZOS)
        w, h = image.size
        inputs = self.detector_processor(images=image, text=vocabulary(nouns), return_tensors="pt", size={"shortest_edge": min(h, w, 480), "longest_edge": 640}).to(self.device)
        with torch.inference_mode():
            detected = self.detector(**inputs)
        results = self.detector_processor.post_process_grounded_object_detection(detected, inputs.input_ids, threshold=DETECTION_THRESHOLD, text_threshold=TEXT_THRESHOLD, target_sizes=[(h, w)])[0]
        # The detector's own token scores for each kept box, in the order post-processing keeps them.
        token_scores = torch.sigmoid(detected.logits[0]).detach().cpu()
        best = token_scores.max(dim=-1)[0]
        kept = (best > DETECTION_THRESHOLD).nonzero(as_tuple=True)[0]
        if len(kept) != len(results["scores"]) or not torch.allclose(best[kept], results["scores"].detach().cpu()):
            raise ValueError("Kept boxes do not match the detector's scores.")
        spans = noun_spans(self.detector_processor.tokenizer.convert_ids_to_tokens(inputs.input_ids[0].tolist()), nouns)
        if spans is None:
            raise ValueError("The prompt does not split into the vocabulary.")
        choices = []
        for index in results["scores"].argsort(descending=True).tolist():
            box = results["boxes"][index].detach().cpu().tolist()
            box = [max(0, min(w, box[0])), max(0, min(h, box[1])), max(0, min(w, box[2])), max(0, min(h, box[3]))]
            if box[2] - box[0] < 8 or box[3] - box[1] < 8 or (box[2]-box[0])*(box[3]-box[1]) / (w*h) > .80:
                continue
            named = best_noun(token_scores[kept[index]], spans, TEXT_THRESHOLD, nouns)
            if named is None:
                continue  # The headset needs a name for every outline, so an unnamed box is left out.
            if any(overlap(box, choice[0]) > .65 for choice in choices):
                continue
            # The confidence beside a name is that name's own score, not an article's or a period's.
            choices.append((box, *named))
            if len(choices) == 4:
                break
        objects = []
        accepted_masks = []
        left_out = 0
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
                if geometry is NOT_SIMPLE:
                    left_out += 1
                    continue
                if geometry is None:
                    continue
                accepted_masks.append(binary)
                objects.append({"label": label, "confidence": confidence,
                                "origin": "proposed" if label in proposals else "base",
                                "maskConfidence": float(scores[index]), **geometry})
        return {"objects": objects, "leftOut": left_out, "latencyMs": (time.perf_counter() - started) * 1000}


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
            emit({"type": "result", "id": identity, **perceiver.observe(image, request.get("nouns", []))})
        except Exception:
            emit({"type": "error", "id": identity})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
