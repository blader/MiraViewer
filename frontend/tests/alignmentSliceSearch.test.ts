import { describe, expect, test } from 'vitest';
import { collectBoundedSliceCandidates, selectFineSliceShortlist } from '../src/utils/alignment';

describe('collectBoundedSliceCandidates', () => {
  test('visits every inclusive index exactly once in center-out order and returns index-sorted records', async () => {
    const visited: number[] = [];

    const candidates = await collectBoundedSliceCandidates({
      minIndex: 0,
      maxIndex: 6,
      startIndex: 3,
      scoreSlice: async (index) => {
        visited.push(index);
        return { score: index === 0 ? 100 : 10 - index };
      },
    });

    expect(visited).toEqual([3, 2, 4, 1, 5, 0, 6]);
    expect(candidates.map((candidate) => candidate.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(candidates[0].value.score).toBe(100);
  });

  test('rejects inverted bounds instead of silently expanding the search', async () => {
    await expect(
      collectBoundedSliceCandidates({
        minIndex: 5,
        maxIndex: 2,
        startIndex: 3,
        scoreSlice: async () => ({ score: 0 }),
      })
    ).rejects.toThrow('minIndex');
  });
});

describe('selectFineSliceShortlist', () => {
  test('collapses plateaus, suppresses nearby peaks, and adds deduplicated neighbors deterministically', () => {
    const scores = [1, 8, 2, 3, 10, 10, 4, 3, 2, 9, 1];
    const candidates = scores.map((score, index) => ({ index, score }));

    const shortlist = selectFineSliceShortlist(candidates, 6, {
      peakCount: 3,
      suppressionRadius: 2,
    });

    expect(shortlist.peakIndices).toEqual([5, 9, 1]);
    expect(shortlist.peakSelections).toEqual([
      { index: 5, reason: 'local-peak' },
      { index: 9, reason: 'local-peak' },
      { index: 1, reason: 'local-peak' },
    ]);
    expect(shortlist.fineIndices).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
  });

  test('uses seed distance and lower index to resolve an all-flat candidate set', () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({ index, score: 1 }));

    const shortlist = selectFineSliceShortlist(candidates, 3, {
      peakCount: 2,
      suppressionRadius: 2,
    });

    expect(shortlist.peakIndices).toEqual([3, 0]);
    expect(shortlist.peakSelections).toEqual([
      { index: 3, reason: 'local-peak' },
      { index: 0, reason: 'fallback-fill' },
    ]);
    expect(shortlist.fineIndices).toEqual([0, 1, 2, 3, 4]);
  });

  test('fills a fixed separated peak budget from a long plateau deterministically', () => {
    const candidates = Array.from({ length: 11 }, (_, index) => ({ index, score: 0.5 }));

    const shortlist = selectFineSliceShortlist(candidates, 5, {
      peakCount: 3,
      suppressionRadius: 1,
    });

    expect(shortlist).toEqual({
      peakIndices: [5, 3, 7],
      peakSelections: [
        { index: 5, reason: 'local-peak' },
        { index: 3, reason: 'fallback-fill' },
        { index: 7, reason: 'fallback-fill' },
      ],
      fineIndices: [2, 3, 4, 5, 6, 7, 8],
    });
  });

  test('rejects duplicate indices and non-finite scores instead of ranking ambiguous input', () => {
    expect(() =>
      selectFineSliceShortlist(
        [
          { index: 1, score: 0.2 },
          { index: 1, score: 0.3 },
        ],
        1
      )
    ).toThrow(/duplicate index/i);

    expect(() => selectFineSliceShortlist([{ index: 1, score: Number.NaN }], 1)).toThrow(/finite score/i);
  });
});
