import { describe, expect, it } from 'vitest';
import { segmentSeededVolume } from './helpers/legacySeededVolume';
import { segmentationEnclosedPhantom } from './helpers/segmentationEnclosedPhantom';
import { segmentationQuality } from './helpers/segmentationQuality';

// Baseline characterization: complete interior coverage is not an exact outer-boundary claim.
describe('existing geodesic selection retains enclosed mixed-signal tissue', () => {
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
});
