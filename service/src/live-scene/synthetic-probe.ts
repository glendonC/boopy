/** Explicit synthetic-only runtime probe: public local weights, no capture service/media access. */
import sharp from 'sharp';
import { LocalScenePerceiver } from './local-scene.ts';

const [python, detectorModel, segmenterModel] = process.argv.slice(2);
if (!python || !detectorModel || !segmenterModel)
  throw new Error('Supply Python and two local model directories.');
const provider = new LocalScenePerceiver({ python, detectorModel, segmenterModel });
const started = performance.now();
try {
  await provider.ready();
  console.log(
    JSON.stringify({
      phase: 'ready',
      device: provider.device,
      readyMs: performance.now() - started,
    }),
  );
  for (const shift of [0, 40, 80]) {
    const jpeg = await sharp(
      Buffer.from(
        `<svg width="640" height="480"><rect width="640" height="480" fill="#262a2e"/><circle cx="${175 + shift}" cy="200" r="105" fill="#dc5a3c"/><rect x="390" y="180" width="190" height="180" fill="#3cb4dc"/></svg>`,
      ),
    )
      .jpeg()
      .toBuffer();
    const began = performance.now();
    const result = await provider.observe(jpeg);
    console.log(
      JSON.stringify({
        phase: 'synthetic-observation',
        shift,
        wallMs: performance.now() - began,
        latencyMs: result.latencyMs,
        objects: result.objects.map(
          ({ label, confidence, box, contour, maskConfidence, maskPixels }) => ({
            label,
            confidence,
            box,
            contourVertices: contour.length,
            maskConfidence,
            maskPixels,
          }),
        ),
      }),
    );
    const circle = result.objects.find((object) => object.label === 'circle');
    const rectangle = result.objects.find((object) => object.label === 'rectangle');
    if (
      !circle ||
      !rectangle ||
      circle.contour.length < 8 ||
      Math.abs(circle.box.x0 - (70 + shift) / 640) > 0.015 ||
      Math.abs(rectangle.box.x0 - 390 / 640) > 0.015
    )
      throw new Error('Synthetic actual masks did not follow translated pixels.');
  }
} finally {
  await provider.close();
}
