"""Synthetic mask geometry and label tests; model inference is verified separately by synthetic-probe.ts."""
import unittest
from unittest import mock
import cv2
import numpy as np
import worker
from worker import NOT_SIMPLE, NOUNS, best_noun, mask_geometry, noun_spans, simple_outline

BOW_TIE = [(.1, .1), (.4, .4), (.4, .1), (.1, .4)]
# The fourth point lies on the first edge, so two edges touch without crossing.
TOUCHING = [(.1, .1), (.5, .1), (.5, .5), (.3, .1), (.1, .5)]


def prompt_tokens():
    """The detector's tokens for the vocabulary prompt, one token per noun."""
    tokens = ["[CLS]"]
    for noun in NOUNS:
        tokens += ["a", noun, "."]
    return tokens + ["[SEP]"]


def scores(tokens, values):
    """Token scores for one box: the given value on each named token, 0.05 elsewhere."""
    return np.array([values.get(token, .05) for token in tokens], dtype=np.float32)


class LabelTests(unittest.TestCase):
    def test_each_noun_has_its_own_tokens_without_articles_or_periods(self):
        tokens = prompt_tokens()
        spans = noun_spans(tokens)
        self.assertEqual(len(spans), len(NOUNS))
        self.assertEqual([tokens[span[0]] for span in spans], NOUNS)
        self.assertTrue(all(len(span) == 1 for span in spans))

    def test_a_noun_split_into_word_pieces_keeps_both_pieces(self):
        tokens = prompt_tokens()
        at = tokens.index("cabinet")
        tokens[at:at + 1] = ["cab", "##inet"]
        spans = noun_spans(tokens)
        self.assertEqual(spans[NOUNS.index("cabinet")], [at, at + 1])

    def test_a_prompt_that_does_not_split_into_the_vocabulary_has_no_spans(self):
        merged = prompt_tokens()
        merged.remove(".")
        renamed = prompt_tokens()
        renamed[renamed.index("bottle")] = "flask"
        self.assertIsNone(noun_spans(merged))
        self.assertIsNone(noun_spans(renamed))

    def test_two_nouns_over_the_threshold_give_the_higher_one_never_both(self):
        tokens = prompt_tokens()
        spans = noun_spans(tokens)
        self.assertEqual(best_noun(scores(tokens, {"bottle": .34, "lamp": .31}), spans, .25)[0], "bottle")
        self.assertEqual(best_noun(scores(tokens, {"bottle": .29, "lamp": .52}), spans, .25)[0], "lamp")

    def test_a_name_carries_its_own_score_not_an_article_or_period(self):
        tokens = prompt_tokens()
        spans = noun_spans(tokens)
        name, score = best_noun(scores(tokens, {"a": .9, ".": .8, "lamp": .27}), spans, .25)
        self.assertEqual(name, "lamp")
        self.assertAlmostEqual(score, .27, places=6)

    def test_a_box_under_the_threshold_or_with_a_tie_has_no_name(self):
        tokens = prompt_tokens()
        spans = noun_spans(tokens)
        self.assertIsNone(best_noun(scores(tokens, {"bottle": .24}), spans, .25))
        # A high article or period belongs to no noun, so it names nothing.
        self.assertIsNone(best_noun(scores(tokens, {"a": .9, ".": .9}), spans, .25))
        self.assertIsNone(best_noun(scores(tokens, {"sofa": .4, "bed": .4}), spans, .25))


class MaskGeometryTests(unittest.TestCase):
    def test_actual_circle_boundary_is_not_a_box(self):
        mask = np.zeros((200, 300), np.uint8)
        cv2.circle(mask, (100, 100), 45, 1, -1)
        geometry = mask_geometry(mask)
        self.assertIsNotNone(geometry)
        self.assertGreater(len(geometry['contour']), 8)
        self.assertEqual(geometry['maskPixels'], int(mask.sum()))
        self.assertEqual(len(geometry['maskSha256']), 64)
        self.assertAlmostEqual(geometry['box']['x0'], 55 / 300)
        self.assertTrue(all(0 <= p['x'] <= 1 and 0 <= p['y'] <= 1 for p in geometry['contour']))

    def test_translated_mask_follows_new_pixels(self):
        masks = []
        for x in [70, 110]:
            mask = np.zeros((200, 300), np.uint8)
            cv2.circle(mask, (x, 100), 30, 1, -1)
            masks.append(mask_geometry(mask))
        self.assertAlmostEqual(masks[1]['box']['x0'] - masks[0]['box']['x0'], 40 / 300)
        self.assertNotEqual(masks[0]['maskSha256'], masks[1]['maskSha256'])

    def test_missing_tiny_full_frame_fragmented_and_holey_masks_stay_unavailable(self):
        empty = np.zeros((200, 300), np.uint8)
        tiny = empty.copy(); tiny[20:23, 20:23] = 1
        fragmented = empty.copy(); fragmented[20:70,20:70] = 1; fragmented[100:150,200:250] = 1
        holey = empty.copy(); cv2.circle(holey,(100,100),50,1,-1);cv2.circle(holey,(100,100),25,0,-1)
        for mask in [empty,tiny,np.ones((200,300),np.uint8),fragmented,holey]:
            self.assertIsNone(mask_geometry(mask))

    def test_a_simplified_outline_whose_edges_cross_is_left_out_never_reshaped(self):
        mask = np.zeros((200, 300), np.uint8)
        mask[50:150, 100:200] = 1
        # Within the area tolerance of the square, but its last edges cross.
        crossing = np.array([[100, 50], [199, 50], [199, 149], [100, 145], [105, 149]], np.int32).reshape(-1, 1, 2)
        with mock.patch.object(worker.cv2, 'approxPolyDP', return_value=crossing):
            # Marked apart from other refusals, so the frame can count it as left out.
            self.assertIs(mask_geometry(mask), NOT_SIMPLE)
        self.assertIsNotNone(mask_geometry(mask))


class OutlineTests(unittest.TestCase):
    """The headset's own rule (SurfaceGeometry.TryTriangulate), so it never refuses a frame."""

    def test_crossing_or_touching_edges_are_not_simple(self):
        self.assertFalse(simple_outline(BOW_TIE))
        self.assertFalse(simple_outline(TOUCHING))

    def test_a_simple_outline_concave_or_not_is_kept(self):
        self.assertTrue(simple_outline([(.1, .1), (.4, .1), (.2, .4)]))
        self.assertTrue(simple_outline([(.1, .1), (.5, .1), (.5, .2), (.2, .2), (.2, .5), (.1, .5)]))

    def test_a_repeated_point_no_area_or_too_few_points_is_not_simple(self):
        self.assertFalse(simple_outline([(.1, .1), (.4, .1), (.4, .1), (.2, .4)]))
        self.assertFalse(simple_outline([(.1, .1), (.2, .2), (.3, .3)]))
        self.assertFalse(simple_outline([(.1, .1), (.4, .1)]))

if __name__ == '__main__':
    unittest.main()
