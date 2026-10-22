"""Synthetic mask geometry tests; model inference is verified separately by synthetic-probe.ts."""
import unittest
import cv2
import numpy as np
from worker import mask_geometry

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

if __name__ == '__main__':
    unittest.main()
