import { describe, expect, it } from 'vitest';
import { reconstructVolumeFromSlices, type SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';

const size = 32,
  pitch = 0.5;
const field = (x: number, y: number, z: number, phase: number) =>
  0.45 + 0.08 * Math.sin(x * 3.7 + phase) + 0.075 * Math.cos(y * 3.2 - phase) + 0.06 * Math.sin(z * 2.7 + phase * 0.4);

/** Test-owned interpolation and acquisition integration do not call the production projector. */
function sampleVolume(volume: Float32Array, x: number, y: number, z: number): number {
  const point = [x / pitch, y / pitch, z / pitch];
  const base = point.map(Math.floor);
  let value = 0;
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const weight = [dx, dy, dz].reduce(
          (product, offset, axis) => product * (offset ? point[axis]! - base[axis]! : 1 - point[axis]! + base[axis]!),
          1,
        );
        value += weight * volume[((base[2]! + dz) * size + base[1]! + dy) * size + base[0]! + dx]!;
      }
  return value;
}

function heldOutAcquiredPixel(sample: (x: number, y: number, z: number) => number, x: number, y: number): number {
  let sum = 0,
    weights = 0;
  for (let index = 0; index < 11; index++) {
    const offset = ((index + 0.5) / 11 - 0.5) * 2;
    const weight = Math.exp(-0.5 * (offset / 0.5) ** 2);
    for (const a of [-0.125, 0.125])
      for (const b of [-0.125, 0.125]) {
        sum += sample(x + a, y + b, 6.25 + offset) * weight;
        weights += weight;
      }
  }
  return sum / weights;
}

/** Independent quadrature of an analytic object, not a production forward-projector oracle. */
function acquire(phase: number, noise: number): SvrReconstructionSlice[] {
  const slices: SvrReconstructionSlice[] = [];
  let random = 8147;
  for (const plane of [0, 1, 2])
    for (let normalPosition = 0.25; normalPosition < 15.5; normalPosition += 1) {
      if (plane === 2 && normalPosition === 6.25) continue;
      const pixels = new Float32Array(size * size);
      for (let row = 0; row < size; row++)
        for (let column = 0; column < size; column++) {
          let sum = 0,
            weights = 0;
          for (let sample = 0; sample < 11; sample++) {
            const offset = ((sample + 0.5) / 11 - 0.5) * 2;
            const weight = Math.exp(-0.5 * (offset / 0.5) ** 2);
            for (const a of [-0.125, 0.125])
              for (const b of [-0.125, 0.125]) {
                const x = plane === 0 ? normalPosition + offset : column * pitch + a;
                const y = plane === 0 ? column * pitch + a : plane === 1 ? normalPosition + offset : row * pitch + b;
                const z = plane === 2 ? normalPosition + offset : row * pitch + b;
                sum += field(x, y, z, phase) * weight;
                weights += weight;
              }
          }
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          pixels[row * size + column] = sum / weights + noise * (random / 0xffffffff - 0.5) * 2;
        }
      slices.push({
        pixels,
        dsRows: size,
        dsCols: size,
        ippMm: {
          x: plane === 0 ? normalPosition : 0,
          y: plane === 1 ? normalPosition : 0,
          z: plane === 2 ? normalPosition : 0,
        },
        rowDir: plane === 0 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 },
        colDir: plane === 2 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
        normalDir: { x: plane === 0 ? 1 : 0, y: plane === 1 ? -1 : 0, z: plane === 2 ? 1 : 0 },
        rowSpacingDsMm: pitch,
        colSpacingDsMm: pitch,
        sliceThicknessMm: 2,
        spacingBetweenSlicesMm: 1,
      });
    }
  return slices;
}

describe('native regional inputs with independent complementary observations', () => {
  it.each([
    { phase: 0.31, noise: 0 },
    { phase: 1.17, noise: 0.01 },
  ])('compares native and pre-averaged sources on one fixed output grid: %j', async ({ phase, noise }) => {
    const native = acquire(phase, noise);
    const averaged = native.map((slice) => {
      const pixels = new Float32Array(16 * 16);
      for (let row = 0; row < 16; row++)
        for (let col = 0; col < 16; col++) {
          const i = row * 2 * size + col * 2;
          pixels[row * 16 + col] =
            (slice.pixels[i]! + slice.pixels[i + 1]! + slice.pixels[i + size]! + slice.pixels[i + size + 1]!) / 4;
        }
      return {
        ...slice,
        pixels,
        dsRows: 16,
        dsCols: 16,
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        ippMm: {
          x: slice.ippMm.x + 0.25 * (slice.rowDir.x + slice.colDir.x),
          y: slice.ippMm.y + 0.25 * (slice.rowDir.y + slice.colDir.y),
          z: slice.ippMm.z + 0.25 * (slice.rowDir.z + slice.colDir.z),
        },
      };
    });
    const run = async (slices: SvrReconstructionSlice[], iterations: number) => {
      const occupancy = new Uint8Array(size ** 3);
      const start = performance.now();
      const volume = await reconstructVolumeFromSlices({
        slices,
        grid: { dims: { nx: size, ny: size, nz: size }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: pitch },
        occupancy,
        options: {
          iterations,
          stepSize: 0.6,
          clampOutput: true,
          psfMode: 'gaussian',
          robustLoss: 'huber',
          robustDelta: 0.1,
          laplacianWeight: 0.02,
          regularizationEdgeScale: 0.04,
        },
      });
      return { volume, occupancy, milliseconds: performance.now() - start };
    };
    const actual = await run(native, 3),
      baseline = await run(averaged, 3);
    expect(actual.occupancy).toEqual(baseline.occupancy);
    const metrics = (volume: Float32Array) => {
      let squared = 0,
        gradientSquared = 0,
        heldOutSquared = 0,
        heldOutObservationSquared = 0,
        count = 0,
        heldOutCount = 0;
      for (let z = 4; z < 28; z++)
        for (let y = 4; y < 28; y++)
          for (let x = 4; x < 27; x++) {
            const index = (z * size + y) * size + x;
            if (
              !actual.occupancy[index] ||
              !baseline.occupancy[index] ||
              !actual.occupancy[index + 1] ||
              !baseline.occupancy[index + 1]
            )
              continue;
            const expected = field(x * pitch, y * pitch, z * pitch, phase);
            squared += (volume[index]! - expected) ** 2;
            gradientSquared +=
              (volume[index + 1]! - volume[index]! - field((x + 1) * pitch, y * pitch, z * pitch, phase) + expected) **
              2;
            count++;
            if (z === 12) {
              const interpolated = (volume[index]! + volume[index + size * size]!) / 2;
              heldOutSquared += (interpolated - field(x * pitch, y * pitch, 6.25, phase)) ** 2;
              const predictedObservation = heldOutAcquiredPixel(
                (px, py, pz) => sampleVolume(volume, px, py, pz),
                x * pitch,
                y * pitch,
              );
              const heldOutObservation = heldOutAcquiredPixel(
                (px, py, pz) => field(px, py, pz, phase),
                x * pitch,
                y * pitch,
              );
              heldOutObservationSquared += (predictedObservation - heldOutObservation) ** 2;
              heldOutCount++;
            }
          }
      return {
        rmse: Math.sqrt(squared / count),
        gradientRmse: Math.sqrt(gradientSquared / count),
        heldOutPointRmse: Math.sqrt(heldOutSquared / heldOutCount),
        heldOutObservationRmse: Math.sqrt(heldOutObservationSquared / heldOutCount),
        count,
        heldOutCount,
      };
    };
    const current = metrics(actual.volume),
      previous = metrics(baseline.volume);
    console.info('[native-input-fidelity]', {
      phase,
      noise,
      current,
      previous,
      nativeMs: actual.milliseconds,
      averagedMs: baseline.milliseconds,
    });
    expect(current.count).toBeGreaterThan(10_000);
    expect(current.heldOutCount).toBeGreaterThan(500);
    expect(current.rmse).toBeLessThan(previous.rmse);
    expect(current.gradientRmse).toBeLessThan(previous.gradientRmse);
    expect(current.heldOutPointRmse).toBeLessThan(previous.heldOutPointRmse);
    expect(current.heldOutObservationRmse).toBeLessThan(previous.heldOutObservationRmse);
    const convergence = [{ iterations: 3, ...current, milliseconds: actual.milliseconds }];
    for (const iterations of [6, 10]) {
      const refined = await run(native, iterations);
      expect(refined.occupancy).toEqual(actual.occupancy);
      expect(refined.volume.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
      convergence.push({ iterations, ...metrics(refined.volume), milliseconds: refined.milliseconds });
    }
    // This is a controlled observation, not a requirement that more iterations always improve fidelity.
    console.info('[native-input-convergence]', {
      phase,
      noise,
      outputPitch: pitch,
      dimensions: [size, size, size],
      convergence,
    });
  });
});
