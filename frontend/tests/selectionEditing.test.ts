import { describe, expect, it } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import {
  physicalBrushIndices,
  selectionPatch,
  applySelectionPatch,
  combineSelectionPatches,
  SLICE_AXES,
  type SelectionPatch,
} from '../src/utils/segmentation/selectionEditing';
import { voxelIndex, voxelPoint } from '../src/utils/segmentation/voxelGeometry';

function volume(): SvrVolume {
  return {
    data: new Float32Array(11 ** 3),
    observedSupport: new Uint8Array(11 ** 3).fill(1),
    dims: [11, 11, 11],
    voxelSizeMm: [0.5, 1, 2],
    originMm: [10, -20, 30],
    boundsMm: { min: [10, -20, 30], max: [15, -10, 50] },
  };
}

function randomValues(seed: number) {
  return (maximum: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
}

function copyPatch(patch: SelectionPatch): SelectionPatch {
  return { indices: patch.indices.slice(), before: patch.before.slice(), after: patch.after.slice() };
}

function expectTightPatch(patch: SelectionPatch) {
  for (const values of [patch.indices, patch.before, patch.after]) {
    expect(values.byteOffset).toBe(0);
    expect(values.buffer.byteLength).toBe(values.byteLength);
  }
}

// Freeze the previous composition semantics, including stable pairing of repeated indices.
function previousCombinedPatch(first: SelectionPatch, second: SelectionPatch): SelectionPatch {
  const order = (patch: SelectionPatch) =>
    Uint32Array.from(patch.indices, (_, index) => index).sort((a, b) => patch.indices[a]! - patch.indices[b]!);
  const a = order(first),
    b = order(second);
  const indices = new Uint32Array(a.length + b.length);
  const before = new Uint8Array(indices.length);
  const after = new Uint8Array(indices.length);
  let i = 0,
    j = 0,
    length = 0;
  while (i < a.length || j < b.length) {
    const firstIndex = i < a.length ? first.indices[a[i]!]! : Infinity;
    const secondIndex = j < b.length ? second.indices[b[j]!]! : Infinity;
    const index = Math.min(firstIndex, secondIndex);
    const previous = firstIndex === index ? first.before[a[i]!]! : second.before[b[j]!]!;
    const next = secondIndex === index ? second.after[b[j]!]! : first.after[a[i]!]!;
    if (previous !== next) {
      indices[length] = index;
      before[length] = previous;
      after[length++] = next;
    }
    if (firstIndex === index) i++;
    if (secondIndex === index) j++;
  }
  return { indices: indices.slice(0, length), before: before.slice(0, length), after: after.slice(0, length) };
}

describe('physical selection editing', () => {
  it.each([
    ['axial', 7],
    ['coronal', 5],
    ['sagittal', 3],
  ] as const)(
    'draws a one-millimeter disk in %s without confusing voxel counts and physical distances',
    (plane, count) => {
      const source = volume(),
        center = { x: 5, y: 5, z: 5 };
      const indices = physicalBrushIndices(source, plane, center, center, 1);
      expect(indices).toHaveLength(count);
      const axes = SLICE_AXES[plane];
      for (const index of indices) {
        const point = voxelPoint(index, source.dims);
        expect(point[axes.slice]).toBe(5);
        expect((point.x - 5) ** 2 * 0.5 ** 2 + (point.y - 5) ** 2 + (point.z - 5) ** 2 * 2 ** 2).toBeLessThanOrEqual(1);
      }
    },
  );

  it('interpolates fast pointer motion into a continuous stroke with no duplicate writes', () => {
    const source = volume();
    const indices = physicalBrushIndices(source, 'axial', { x: 1, y: 5, z: 5 }, { x: 9, y: 5, z: 5 }, 0.5);
    expect(new Set(indices).size).toBe(indices.length);
    for (let x = 1; x <= 9; x++) expect(indices).toContain(voxelIndex({ x, y: 5, z: 5 }, source.dims));
  });

  it('clips to physical bounds and excludes missing/nonfinite data while preserving observed zero intensity', () => {
    const source = volume();
    source.observedSupport![0] = 0;
    source.data[1] = NaN;
    const indices = physicalBrushIndices(source, 'axial', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2);
    expect(indices).not.toContain(0);
    expect(indices).not.toContain(1);
    expect(indices).toContain(2);
    for (const index of indices) {
      const point = voxelPoint(index, source.dims);
      expect(point.z).toBe(0);
      expect(point.x).toBeLessThanOrEqual(4);
      expect(point.y).toBeLessThanOrEqual(2);
    }
  });

  it('records only changed voxels and exactly reverses sparse edits without mutating source arrays', () => {
    const before = Uint8Array.of(0, 1, 2, 0, 1),
      after = Uint8Array.of(0, 0, 2, 1, 1);
    const patch = selectionPatch(before, after, Uint32Array.of(1, 1, 3, 4));
    expect([...patch.indices]).toEqual([1, 3]);
    expect(applySelectionPatch(after, patch, 'undo')).toEqual(before);
    expect(applySelectionPatch(before, patch, 'redo')).toEqual(after);
    expect([...before]).toEqual([0, 1, 2, 0, 1]);
    expect(() => selectionPatch(before, Uint8Array.of(1))).toThrow(/geometry/);
  });

  it.each(['undo', 'redo'] as const)('keeps the displayed mask identity for a mark-only %s', (direction) => {
    const storage = Uint8Array.of(9, 0, 1, 1, 0, 9);
    const displayed = storage.subarray(1, 5);
    const unchanged = selectionPatch(displayed, displayed, Uint32Array.of(1, 2));
    const result = applySelectionPatch(displayed, unchanged, direction);
    expect(unchanged.indices).toHaveLength(0);
    expect(result).toBe(displayed);
    expect(result.buffer).toBe(storage.buffer);
    expect([...storage]).toEqual([9, 0, 1, 1, 0, 9]);
  });

  it('combines a stroke and auto-fill as one exact reversible edit, including overlaps and reversals', () => {
    const before = Uint8Array.of(0, 1, 2, 0, 1, 0);
    const painted = Uint8Array.of(1, 0, 2, 0, 1, 1);
    const filled = Uint8Array.of(1, 0, 1, 1, 1, 0);
    const stroke = selectionPatch(before, painted, Uint32Array.of(5, 0, 1));
    const suggestion = selectionPatch(painted, filled);
    const combined = combineSelectionPatches(stroke, suggestion);
    expect(combined).toEqual(selectionPatch(before, filled));
    expect(applySelectionPatch(filled, combined, 'undo')).toEqual(before);
    expect(applySelectionPatch(before, combined, 'redo')).toEqual(filled);
    expect([...stroke.indices]).toEqual([5, 0, 1]);
    expect(combined.indices.buffer.byteLength).toBe(combined.indices.byteLength);
  });

  it('preserves first-occurrence order for sparse candidates and ascending order for whole-volume edits', () => {
    const random = randomValues(173);
    for (let trial = 0; trial < 300; trial++) {
      const length = random(65);
      const before = Uint8Array.from({ length: length + 2 }, () => random(4)).subarray(1, length + 1);
      const after = Uint8Array.from({ length: length + 2 }, () => random(4)).subarray(1, length + 1);
      const candidates =
        trial % 3
          ? Uint32Array.from({ length: random(length * 2 + 5) }, (_, offset) =>
              offset % 13 ? random(length + 5) : 0xffffffff,
            )
          : undefined;
      const originalBefore = before.slice(),
        originalAfter = after.slice(),
        originalCandidates = candidates?.slice();
      const expected = [...new Set(candidates ?? before.keys())].filter(
        (index) => index < before.length && before[index] !== after[index],
      );
      const patch = selectionPatch(before, after, candidates);
      expect(patch).toEqual({
        indices: Uint32Array.from(expected),
        before: Uint8Array.from(expected, (index) => before[index]!),
        after: Uint8Array.from(expected, (index) => after[index]!),
      });
      expectTightPatch(patch);
      expect(before).toEqual(originalBefore);
      expect(after).toEqual(originalAfter);
      expect(candidates).toEqual(originalCandidates);
    }
  });

  it('is byte-identical to previous composition for sorted, unsorted, duplicate, empty and reverting patches', () => {
    const random = randomValues(1297);
    for (let trial = 0; trial < 300; trial++) {
      const makePatch = (sorted: boolean): SelectionPatch => {
        const length = random(35);
        const indices = Uint32Array.from({ length: length + 2 }, (_, offset) =>
          offset % 17 ? random(11) : 0xffffffff,
        ).subarray(1, length + 1);
        if (sorted) indices.sort();
        return {
          indices,
          before: Uint8Array.from({ length: length + 2 }, () => random(3)).subarray(1, length + 1),
          after: Uint8Array.from({ length: length + 2 }, () => random(3)).subarray(1, length + 1),
        };
      };
      const first = makePatch(trial % 2 === 0),
        second = makePatch(trial % 3 === 0);
      const originalFirst = copyPatch(first),
        originalSecond = copyPatch(second);
      const combined = combineSelectionPatches(first, second);
      expect(combined).toEqual(previousCombinedPatch(first, second));
      expectTightPatch(combined);
      if (combined.indices.length) {
        combined.indices[0] = 42;
        combined.before[0] = 255;
        combined.after[0] = 255;
      }
      expect(first).toEqual(originalFirst);
      expect(second).toEqual(originalSecond);
    }
  });

  it('keeps randomized brush plus automatic-fill histories exactly reversible without changing either edit', () => {
    const random = randomValues(853);
    for (let trial = 0; trial < 150; trial++) {
      const before = Uint8Array.from({ length: 64 + random(64) }, () => random(3));
      const painted = before.slice();
      const candidates = Uint32Array.from({ length: random(100) }, () => random(before.length + 5));
      for (const index of candidates) if (index < painted.length) painted[index] = random(3);
      const filled = painted.map((value) => (random(3) ? value : random(3)));
      const stroke = selectionPatch(before, painted, candidates),
        suggestion = selectionPatch(painted, filled);
      const originalStroke = copyPatch(stroke),
        originalSuggestion = copyPatch(suggestion);
      const combined = combineSelectionPatches(stroke, suggestion);
      expect(combined).toEqual(selectionPatch(before, filled));
      expect(applySelectionPatch(filled, combined, 'undo')).toEqual(before);
      expect(applySelectionPatch(before, combined, 'redo')).toEqual(filled);
      expect(stroke).toEqual(originalStroke);
      expect(suggestion).toEqual(originalSuggestion);
    }
  });

  it('allocates tight history buffers for a large dense edit and no retained entries for its complete reversal', () => {
    const before = new Uint8Array(120_000),
      after = new Uint8Array(before.length).fill(1);
    const forward = selectionPatch(before, after),
      backward = selectionPatch(after, before);
    expect(forward.indices).toHaveLength(before.length);
    expect(forward.indices[0]).toBe(0);
    expect(forward.indices.at(-1)).toBe(before.length - 1);
    expectTightPatch(forward);
    const reversed = combineSelectionPatches(forward, backward);
    expect(reversed.indices).toHaveLength(0);
    expect(reversed.before).toHaveLength(0);
    expect(reversed.after).toHaveLength(0);
    expectTightPatch(reversed);
    expect(applySelectionPatch(after, forward, 'undo').every((value) => value === 0)).toBe(true);
    expect(applySelectionPatch(before, forward, 'redo').every((value) => value === 1)).toBe(true);
    expect(before.every((value) => value === 0)).toBe(true);
    expect(after.every((value) => value === 1)).toBe(true);
  });
});
