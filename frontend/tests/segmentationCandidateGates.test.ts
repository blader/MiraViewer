import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  segmentSeededVolume as ProductionSolver,
  SeededVolumeInput,
} from '../src/utils/segmentation/seededVolume';
import { segmentationQuality } from './helpers/segmentationQuality';
import { segmentationEnclosedPhantom } from './helpers/segmentationEnclosedPhantom';
import { segmentationTexturedPhantom, type TissueAppearance } from './helpers/segmentationTexturedPhantom';

// These unmet replacement-solver certification targets are not baseline accuracy claims.
// Opt in with MIRAVIEWER_SEGMENTATION_CANDIDATE_SOLVER_PATH=<standalone local TS file>
// and MIRAVIEWER_SEGMENTATION_CANDIDATE_SHA=<sha256>; a bad pin or any failed gate fails the run.
const candidatePath = process.env.MIRAVIEWER_SEGMENTATION_CANDIDATE_SOLVER_PATH;
const candidateSha = process.env.MIRAVIEWER_SEGMENTATION_CANDIDATE_SHA;
let segmentSeededVolume: typeof ProductionSolver;
let resolvedCandidatePath: string | undefined;
const candidateFingerprint = () => createHash('sha256').update(readFileSync(resolvedCandidatePath!)).digest('hex');

function seedConnected(input: SeededVolumeInput, indices: Uint32Array) {
  const selected = new Set(indices);
  const reached = new Set(input.foreground);
  const queue = [...input.foreground];
  const [nx, ny, nz] = input.dims;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!;
    const x = index % nx,
      y = Math.floor(index / nx) % ny,
      z = Math.floor(index / (nx * ny));
    const adjacent = [
      x ? index - 1 : -1,
      x + 1 < nx ? index + 1 : -1,
      y ? index - nx : -1,
      y + 1 < ny ? index + nx : -1,
      z ? index - nx * ny : -1,
      z + 1 < nz ? index + nx * ny : -1,
    ];
    for (const next of adjacent)
      if (selected.has(next) && !reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
  }
  return indices.every((index) => reached.has(index));
}

const cases = (['textured', 'weak', 'cystic', 'dark'] as TissueAppearance[]).flatMap((kind) =>
  [false, true].flatMap((anisotropic) => [false, true].map((insideOnly) => ({ kind, anisotropic, insideOnly }))),
);

describe.skipIf(!candidatePath && !candidateSha)(
  'replacement segmentation candidate certification (explicit opt-in)',
  () => {
    beforeAll(async () => {
      expect(candidatePath, 'An explicit local candidate solver path is required.').toBeTruthy();
      expect(candidateSha, 'An exact candidate SHA-256 is required.').toMatch(/^[a-f0-9]{64}$/);
      resolvedCandidatePath = resolve(candidatePath!);
      expect(candidateFingerprint(), 'Candidate source differs from its frozen SHA-256.').toBe(candidateSha);
      const candidate = await import(/* @vite-ignore */ pathToFileURL(resolvedCandidatePath).href);
      expect(typeof candidate.segmentSeededVolume).toBe('function');
      segmentSeededVolume = candidate.segmentSeededVolume;
    });

    afterAll(() => {
      if (resolvedCandidatePath)
        expect(candidateFingerprint(), 'Candidate source changed during certification.').toBe(candidateSha);
    });

    it.each(cases)(
      'retains $kind anatomy, anisotropic=$anisotropic, insideOnly=$insideOnly',
      async ({ kind, anisotropic, insideOnly }) => {
        const { input, truth } = segmentationTexturedPhantom(kind, anisotropic, 'edge', insideOnly);
        const before = input.volume.slice();
        const result = await segmentSeededVolume(input);
        const quality = segmentationQuality(truth, result.indices);
        console.info('[textured-selection-robustness]', { kind, anisotropic, insideOnly, ...quality });
        expect(quality.dice).toBeGreaterThan(kind === 'weak' ? 0.84 : 0.94);
        expect(quality.precision).toBeGreaterThan(kind === 'weak' ? 0.8 : 0.94);
        expect(quality.recall).toBeGreaterThan(kind === 'weak' ? 0.8 : 0.9);
        expect(seedConnected(input, result.indices)).toBe(true);
        expect(input.volume).toEqual(before);
        const selected = new Set(result.indices);
        expect([...input.foreground].every((index) => selected.has(index))).toBe(true);
        expect([...input.background].some((index) => selected.has(index))).toBe(false);
        expect(
          result.indices.every((index) => input.observedSupport![index] && Number.isFinite(input.volume[index])),
        ).toBe(true);
      },
    );

    it('does not fill the whole head when acquired air separates exterior seeds from brain tissue', async () => {
      const { input, truth } = segmentationTexturedPhantom('weak', true, 'edge', true, true);
      const result = await segmentSeededVolume(input);
      const quality = segmentationQuality(truth, result.indices);
      console.info('[air-shell-selection]', quality);
      expect(quality.dice).toBeGreaterThan(0.75);
      expect(quality.recall).toBeGreaterThan(0.9);
      expect(result.indices.length).toBeLessThan(truth.reduce((sum, value) => sum + value, 0) * 2);
      expect(seedConnected(input, result.indices)).toBe(true);
    });

    it('is stable when a physical inside brush moves within the same weak-boundary structure', async () => {
      const center = segmentationTexturedPhantom('weak', true, 'center');
      const edge = segmentationTexturedPhantom('weak', true, 'edge');
      const first = await segmentSeededVolume(center.input);
      const second = await segmentSeededVolume(edge.input);
      const firstMask = new Uint8Array(center.truth.length);
      for (const index of first.indices) firstMask[index] = 1;
      expect(segmentationQuality(firstMask, second.indices).dice).toBeGreaterThan(0.97);
    });

    it('does not globally shrink correct tissue after an additional inside brush near the boundary', async () => {
      const { input, truth } = segmentationTexturedPhantom('textured', true, 'edge', true);
      const before = await segmentSeededVolume(input);
      const added: number[] = [];
      const [nx, ny] = input.dims;
      const [sx, sy, sz] = input.voxelSizeMm;
      for (let index = 0; index < truth.length; index++) {
        if (!truth[index]) continue;
        const x = (index % nx) * sx,
          y = (Math.floor(index / nx) % ny) * sy,
          z = Math.floor(index / (nx * ny)) * sz;
        if (Math.abs(z - 20) < sz * 0.51 && Math.hypot(x - 18.4, y - 20.8) <= 1.45) added.push(index);
      }
      expect(added.length).toBeGreaterThan(0);
      const after = await segmentSeededVolume({
        ...input,
        foreground: Uint32Array.from([...input.foreground, ...added]),
      });
      const allMarks = new Set([...input.foreground, ...added]);
      const heldOutTruth = truth.slice();
      for (const index of allMarks) heldOutTruth[index] = 0;
      const oldQuality = segmentationQuality(
        heldOutTruth,
        before.indices.filter((index) => !allMarks.has(index)),
      );
      const newQuality = segmentationQuality(
        heldOutTruth,
        after.indices.filter((index) => !allMarks.has(index)),
      );
      console.info('[inside-correction-heldout]', { before: oldQuality, after: newQuality });
      expect(newQuality.recall).toBeGreaterThanOrEqual(oldQuality.recall);
      expect(newQuality.dice).toBeGreaterThanOrEqual(oldQuality.dice - 0.01);
      const selected = new Set(after.indices);
      expect([...allMarks].every((index) => selected.has(index))).toBe(true);
    });

    it.each([2, 4, 6])(
      'keeps the whole gray interior when a %imm bright brush dominates mark counts',
      async (radiusMm) => {
        const { input, truth, outerEnvelope, grayInterior, grayMark } = segmentationEnclosedPhantom(radiusMm);
        const original = input.volume.slice();
        expect(input.foreground.length).toBeGreaterThan(10);
        const result = await segmentSeededVolume(input);
        const selected = new Set(result.indices);
        const grayCount = grayInterior.reduce((sum, value) => sum + value, 0);
        const retainedGray = result.indices.reduce((sum, index) => sum + grayInterior[index]!, 0);
        // Score the whole independently defined interior, not just the conspicuous bright component or painted voxels.
        expect(retainedGray / grayCount).toBeGreaterThan(0.98);
        const quality = segmentationQuality(truth, result.indices);
        // Keep the mathematical interior as truth: selecting its dark outer rim is still a false positive.
        console.info('[enclosed-gray-selection]', { radiusMm, ...quality, selected: result.indices.length });
        expect(quality.recall).toBeGreaterThan(0.98);
        // Separately reject propagation into unrelated exterior tissue, without relabeling the rim as truth.
        expect(result.indices.every((index) => outerEnvelope[index] === 1)).toBe(true);
        expect(selected.has(grayMark)).toBe(true);
        expect([...input.foreground].every((index) => selected.has(index))).toBe(true);
        expect(input.volume).toEqual(original);
      },
    );
  },
);
