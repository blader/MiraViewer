import { describe, expect, it } from 'vitest';
import { normalizeSvrIntensities } from '../src/utils/svr/intensityNormalization';
import {
  buildObservedSupportFromSlices,
  reconstructVolumeFromSlices,
  refineVolumeInPlace,
  resampleVolumeToGridTrilinear,
  type SvrReconstructionOptions,
  type SvrReconstructionSlice,
} from '../src/utils/svr/reconstructionCore';

const SIZE = 36;
const grid = { dims: { nx: SIZE, ny: SIZE, nz: SIZE }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 };
const options: SvrReconstructionOptions = {
  iterations: 3,
  stepSize: 0.6,
  clampOutput: true,
  psfMode: 'gaussian',
  robustLoss: 'huber',
  robustDelta: 0.1,
  laplacianWeight: 0.02,
  regularizationEdgeScale: 0.04,
};

/** Continuous, independently defined texture and small structures, not a production-generated golden volume. */
function anatomy(x: number, y: number, z: number, phase: number): number {
  const radius = ((x - 18) / 13) ** 2 + ((y - 17) / 12) ** 2 + ((z - 18) / 14) ** 2;
  if (radius > 1) return 0.025;
  const lesion = ((x - 20 - phase) / 4.2) ** 2 + ((y - 17) / 5.1) ** 2 + ((z - 19) / 3.4) ** 2 < 1;
  const texture = 0.065 * Math.sin(x * 1.37 + phase) * Math.cos(y * 0.94 - phase) * Math.sin(z * 0.72);
  const thinStructure = Math.abs(x - y * 0.18 - 11) < 0.7 && z > 11 && z < 25;
  return (lesion ? 0.72 : thinStructure ? 0.53 : 0.29) + texture;
}

/** Scanner integration uses 11 through-plane samples and independent sub-pixel quadrature. */
function acquisition(thickness: number, noise: number, phase: number): SvrReconstructionSlice[] {
  const slices: SvrReconstructionSlice[] = [];
  let random = 731 + Math.round(phase * 100);
  for (const plane of [0, 1, 2]) {
    for (let position = 1.2; position < SIZE - 1; position += thickness > 1 ? 2.6 : 1) {
      // A whole central axial observation is withheld from every solver.
      if (plane === 2 && Math.abs(position - 19.4) < 0.1) continue;
      const pixels = new Float32Array(SIZE * SIZE);
      for (let row = 0; row < SIZE; row++)
        for (let col = 0; col < SIZE; col++) {
          let sum = 0,
            weight = 0;
          for (let sample = 0; sample < 11; sample++) {
            const offset = ((sample + 0.5) / 11 - 0.5) * thickness;
            const w = Math.exp(-0.5 * (offset / (thickness / 4)) ** 2);
            for (const a of [-0.22, 0.22])
              for (const b of [-0.22, 0.22]) {
                const x = plane === 0 ? position + offset : col + a;
                const y = plane === 0 ? col + a : plane === 1 ? position + offset : row + b;
                const z = plane === 2 ? position + offset : row + b;
                sum += anatomy(x, y, z, phase) * w;
                weight += w;
              }
          }
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          pixels[row * SIZE + col] = sum / weight + noise * (random / 0xffffffff - 0.5) * 2;
        }
      slices.push({
        pixels,
        dsRows: SIZE,
        dsCols: SIZE,
        ippMm: { x: plane === 0 ? position : 0, y: plane === 1 ? position : 0, z: plane === 2 ? position : 0 },
        rowDir: plane === 0 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 },
        colDir: plane === 2 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
        normalDir: { x: plane === 0 ? 1 : 0, y: plane === 1 ? -1 : 0, z: plane === 2 ? 1 : 0 },
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        sliceThicknessMm: thickness,
        spacingBetweenSlicesMm: thickness > 1 ? 2.6 : 1,
      });
    }
  }
  return slices;
}

function errors(volume: Float32Array, support: Uint8Array, phase: number) {
  let squared = 0,
    textureSquared = 0,
    count = 0;
  for (let z = 4; z < SIZE - 4; z++)
    for (let y = 4; y < SIZE - 4; y++)
      for (let x = 4; x < SIZE - 4; x++) {
        const index = (z * SIZE + y) * SIZE + x;
        if (!support[index] || !support[index + 1]) continue;
        const expected = anatomy(x, y, z, phase);
        squared += (volume[index]! - expected) ** 2;
        textureSquared += (volume[index + 1]! - volume[index]! - (anatomy(x + 1, y, z, phase) - expected)) ** 2;
        count++;
      }
  return { rmse: Math.sqrt(squared / count), gradientRmse: Math.sqrt(textureSquared / count), count };
}

describe('SVR texture preservation against independent acquisitions', () => {
  it.each([
    { thickness: 0.8, noise: 0, phase: 0 },
    { thickness: 0.8, noise: 0.025, phase: 0.73 },
    { thickness: 3.2, noise: 0, phase: 0.37 },
    { thickness: 3.2, noise: 0.025, phase: 1.13 },
  ])(
    'preserves supported detail with final-grid initialization: %j',
    async ({ thickness, noise, phase }) => {
      const slices = acquisition(thickness, noise, phase);
      const fineSupport = new Uint8Array(SIZE ** 3);
      const fineStart = performance.now();
      const fine = await reconstructVolumeFromSlices({ slices, grid, options, occupancy: fineSupport });
      const fineMs = performance.now() - fineStart;

      const baselineStart = performance.now();
      const coarseGrid = { ...grid, dims: { nx: SIZE / 2 + 1, ny: SIZE / 2 + 1, nz: SIZE / 2 + 1 }, voxelSizeMm: 2 };
      const coarseSupport = new Uint8Array((SIZE / 2 + 1) ** 3);
      const baselineOptions = { ...options, regularizationEdgeScale: Infinity };
      const coarse = await reconstructVolumeFromSlices({
        slices,
        grid: coarseGrid,
        options: { ...baselineOptions, iterations: 1 },
        occupancy: coarseSupport,
      });
      const baseline = await resampleVolumeToGridTrilinear({
        src: coarse,
        srcOccupancy: coarseSupport,
        srcGrid: coarseGrid,
        dstGrid: grid,
      });
      const baselineSupport = await buildObservedSupportFromSlices({ slices, grid, psfMode: 'gaussian' });
      await refineVolumeInPlace({
        volume: baseline,
        slices,
        grid,
        options: baselineOptions,
        occupancy: baselineSupport,
      });
      const baselineMs = performance.now() - baselineStart;

      const actual = errors(fine, fineSupport, phase),
        former = errors(baseline, baselineSupport, phase);
      expect(fineSupport).toEqual(baselineSupport);
      expect(actual.count).toBeGreaterThan(20_000);
      expect(actual.rmse).toBeLessThan(former.rmse);
      expect(actual.gradientRmse).toBeLessThan(former.gradientRmse);
      for (let index = 0; index < fine.length; index++) if (!fineSupport[index]) expect(fine[index]).toBe(0);
      console.info(
        '[svr-texture-phantom]',
        JSON.stringify({ thickness, noise, phase, actual, former, fineMs, baselineMs }),
      );
    },
    30_000,
  );

  it('preserves bright-tail texture and separates it from display windowing', () => {
    const pixels = Float32Array.from({ length: 10_000 }, (_, index) =>
      index < 9_990 ? 20 + (index % 80) : 200 + (index - 9_990) * 10,
    );
    const original = pixels.slice();
    const { displayWindow, robustRangeScale } = normalizeSvrIntensities([{ pixels }], [...pixels]);
    for (let i = 0; i < pixels.length; i++) expect(pixels[i]! * 290).toBeCloseTo(original[i]!, 4);
    expect(new Set(pixels.slice(-10)).size).toBe(10);
    expect(displayWindow[1]).toBeLessThan(1);
    expect(robustRangeScale).toBeGreaterThan(0);
    expect(robustRangeScale).toBeLessThan(1);
  });

  it('does not let missing pixels or nonfinite samples control normalization', () => {
    const pixels = new Float32Array([-4, 0, 8, 1e20, NaN]);
    normalizeSvrIntensities([{ pixels, valid: new Uint8Array([1, 1, 1, 0, 1]) }], [-4, 0, 8]);
    expect(Array.from(pixels)).toEqual([0, expect.closeTo(1 / 3), 1, 0, 0]);
  });
});
