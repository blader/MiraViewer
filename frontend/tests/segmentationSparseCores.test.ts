import { describe, expect, it } from 'vitest';
import {
  evaluateSparseCores,
  exactNativeIndex,
  type NativeSamplingGrid,
  type SparseCoreCandidate,
  type SparseCoreReference,
} from './helpers/segmentationSparseCores';

const rectangle = (left: number, top: number, right: number, bottom: number) =>
  [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as const;

function fixture() {
  const reference: SparseCoreReference = {
    sourceGrid: 'synthetic-native',
    dims: [7, 6, 3],
    origin: [10, 20, 30],
    sections: [
      {
        id: 'axial',
        fixedAxis: 2,
        fixedIndex: 31,
        acrossAxis: 0,
        verticalAxis: 1,
        patches: [
          { label: 'inside', polygon: rectangle(11, 21, 13, 23) },
          { label: 'outside', polygon: rectangle(15, 21, 16, 22) },
        ],
      },
    ],
  };
  const candidate: SparseCoreCandidate = {
    sourceGrid: reference.sourceGrid,
    dims: reference.dims,
    origin: reference.origin,
    stride: [1, 1, 1],
    mask: new Uint8Array(7 * 6 * 3),
    support: new Uint8Array(7 * 6 * 3).fill(1),
  };
  const index = (x: number, y: number, z: number) => ((z - 30) * 6 + y - 20) * 7 + x - 10;
  for (let y = 21; y <= 23; y++) for (let x = 11; x <= 13; x++) candidate.mask[index(x, y, 31)] = 1;
  return { reference, candidate, index };
}

describe('sparse source-core consistency without full-anatomy certification', () => {
  it('includes polygon edges, counts only known cores, and preserves reference, mask and acquired support', () => {
    const { reference, candidate, index } = fixture();
    candidate.mask[index(13, 23, 31)] = 0;
    candidate.mask[index(16, 21, 31)] = 1;
    candidate.mask[index(10, 20, 30)] = 1;
    const before = {
      reference: JSON.stringify(reference),
      mask: candidate.mask.slice(),
      support: candidate.support.slice(),
    };
    expect(evaluateSparseCores(reference, candidate)).toEqual({
      scope: 'sparse-core-consistency',
      sourceGrid: reference.sourceGrid,
      inside: {
        referenceVoxels: 9,
        denominator: 9,
        hits: 8,
        misses: 1,
        unsampledReferenceVoxels: 0,
        unsupportedReferenceVoxels: 0,
      },
      outside: {
        referenceVoxels: 4,
        denominator: 4,
        selections: 1,
        rejections: 3,
        unsampledReferenceVoxels: 0,
        unsupportedReferenceVoxels: 0,
      },
      unsampledReferenceVoxels: 0,
      unsupportedReferenceVoxels: 0,
      explicitUncertainReferenceVoxels: 0,
      uncertaintyOverrides: 0,
      supportedUnknownSelections: 1,
      unsupportedSelections: 0,
    });
    expect(JSON.stringify(reference)).toBe(before.reference);
    expect(candidate.mask).toEqual(before.mask);
    expect(candidate.support).toEqual(before.support);
  });

  it('keeps arbitrary selections in unlisted voxels outside the known-core denominators', () => {
    const { reference, candidate, index } = fixture();
    const before = evaluateSparseCores(reference, candidate);
    candidate.mask[index(10, 20, 30)] = 1;
    candidate.mask[index(14, 24, 31)] = 1;
    const after = evaluateSparseCores(reference, candidate);
    expect(after.inside).toEqual(before.inside);
    expect(after.outside).toEqual(before.outside);
    expect(after.supportedUnknownSelections).toBe(2);
  });

  it.each([false, true])(
    'applies 13 explicit cross-plane uncertainty overrides before counting (reversed order: %s)',
    (reverse) => {
      const reference: SparseCoreReference = {
        sourceGrid: 'synthetic-cross-plane',
        dims: [15, 4, 3],
        origin: [0, 0, 0],
        sections: [
          {
            id: 'axial',
            fixedAxis: 2,
            fixedIndex: 0,
            acrossAxis: 0,
            verticalAxis: 1,
            patches: [{ label: 'inside', polygon: rectangle(0, 1, 12, 2) }],
          },
          {
            id: 'coronal',
            fixedAxis: 1,
            fixedIndex: 1,
            acrossAxis: 0,
            verticalAxis: 2,
            patches: [{ label: 'uncertain', polygon: rectangle(0, 0, 12, 1) }],
          },
          {
            id: 'sagittal',
            fixedAxis: 0,
            fixedIndex: 14,
            acrossAxis: 1,
            verticalAxis: 2,
            patches: [{ label: 'outside', polygon: rectangle(1, 1, 2, 2) }],
          },
        ],
      };
      if (reverse) reference.sections = [...reference.sections].reverse();
      const result = evaluateSparseCores(reference, {
        ...reference,
        stride: [1, 1, 1],
        mask: new Uint8Array(180).fill(1),
        support: new Uint8Array(180).fill(1),
      });
      expect(result.inside).toMatchObject({ referenceVoxels: 13, denominator: 13, hits: 13, misses: 0 });
      expect(result.outside).toMatchObject({ referenceVoxels: 4, denominator: 4, selections: 4, rejections: 0 });
      expect(result.explicitUncertainReferenceVoxels).toBe(26);
      expect(result.uncertaintyOverrides).toBe(13);
      expect(result.supportedUnknownSelections).toBe(163);
    },
  );

  it('does not double-count the same known voxel on three source planes or in repeated patches', () => {
    const reference: SparseCoreReference = {
      sourceGrid: 'synthetic-intersection',
      dims: [5, 5, 5],
      origin: [0, 0, 0],
      sections: [
        {
          id: 'axial',
          fixedAxis: 2,
          fixedIndex: 1,
          acrossAxis: 0,
          verticalAxis: 1,
          patches: [
            { label: 'inside', polygon: rectangle(1, 1, 3, 3) },
            { label: 'inside', polygon: rectangle(1, 1, 3, 3) },
          ],
        },
        {
          id: 'coronal',
          fixedAxis: 1,
          fixedIndex: 1,
          acrossAxis: 0,
          verticalAxis: 2,
          patches: [{ label: 'inside', polygon: rectangle(1, 1, 3, 3) }],
        },
        {
          id: 'sagittal',
          fixedAxis: 0,
          fixedIndex: 1,
          acrossAxis: 1,
          verticalAxis: 2,
          patches: [{ label: 'inside', polygon: rectangle(1, 1, 3, 3) }],
        },
      ],
    };
    const result = evaluateSparseCores(reference, {
      ...reference,
      stride: [1, 1, 1],
      mask: new Uint8Array(125).fill(1),
      support: new Uint8Array(125).fill(1),
    });
    expect(result.inside).toMatchObject({ referenceVoxels: 19, denominator: 19, hits: 19, misses: 0 });
  });

  it('rejects unresolved confident conflicts, but explicit uncertainty overrides either class regardless of order', () => {
    const { reference, candidate } = fixture();
    const section = reference.sections[0]!;
    const inside = section.patches[0]!;
    const outside = { ...inside, label: 'outside' as const };
    const uncertain = { ...inside, label: 'uncertain' as const };
    reference.sections = [{ ...section, patches: [inside, outside] }];
    expect(() => evaluateSparseCores(reference, candidate)).toThrow(/contradict/);
    for (const patches of [
      [inside, outside, uncertain],
      [uncertain, outside, inside],
      [outside, uncertain, inside],
    ]) {
      reference.sections = [{ ...section, patches }];
      const result = evaluateSparseCores(reference, candidate);
      expect(result.inside.denominator).toBe(0);
      expect(result.outside.denominator).toBe(0);
      expect(result.uncertaintyOverrides).toBe(9);
      expect(result.explicitUncertainReferenceVoxels).toBe(9);
      expect(result.supportedUnknownSelections).toBe(9);
    }
  });

  it('keeps source unavailability separate from unknown labels, sampling gaps, and core misses', () => {
    const { reference, candidate, index } = fixture();
    for (const [x, y, z] of [
      [11, 21, 31],
      [16, 21, 31],
      [10, 20, 30],
    ] as const) {
      candidate.mask[index(x, y, z)] = 1;
      candidate.support[index(x, y, z)] = 0;
    }
    const result = evaluateSparseCores(reference, candidate);
    expect(result.inside).toMatchObject({
      referenceVoxels: 9,
      denominator: 8,
      hits: 8,
      misses: 0,
      unsupportedReferenceVoxels: 1,
    });
    expect(result.outside).toMatchObject({
      referenceVoxels: 4,
      denominator: 3,
      selections: 0,
      rejections: 3,
      unsupportedReferenceVoxels: 1,
    });
    expect(result.unsupportedReferenceVoxels).toBe(2);
    expect(result.unsupportedSelections).toBe(3);
    expect(result.unsampledReferenceVoxels).toBe(0);
    expect(result.supportedUnknownSelections).toBe(0);
  });

  it.each(['outside-only', 'uncertain-only', 'empty'] as const)(
    'reports zero known-inside denominator without a score or pass for %s references',
    (kind) => {
      const { reference, candidate } = fixture();
      reference.sections = reference.sections.map((section) => ({
        ...section,
        patches:
          kind === 'empty'
            ? []
            : kind === 'outside-only'
              ? [section.patches[1]!]
              : [{ ...section.patches[0]!, label: 'uncertain' }],
      }));
      const result = evaluateSparseCores(reference, candidate);
      expect(result.inside).toMatchObject({ referenceVoxels: 0, denominator: 0, hits: 0, misses: 0 });
      expect(result.outside.denominator).toBe(kind === 'outside-only' ? 4 : 0);
      expect(Object.keys(result)).toEqual([
        'scope',
        'sourceGrid',
        'inside',
        'outside',
        'unsampledReferenceVoxels',
        'unsupportedReferenceVoxels',
        'explicitUncertainReferenceVoxels',
        'uncertaintyOverrides',
        'supportedUnknownSelections',
        'unsupportedSelections',
      ]);
    },
  );

  it('counts only exact sampled centers at stride [1,2,2] and phase [0,0,1], without rounding adjacent sections', () => {
    const reference: SparseCoreReference = {
      sourceGrid: 'synthetic-sampled',
      dims: [5, 7, 7],
      origin: [0, 0, 0],
      sections: [
        {
          id: 'unsampled-axial',
          fixedAxis: 2,
          fixedIndex: 2,
          acrossAxis: 0,
          verticalAxis: 1,
          patches: [{ label: 'inside', polygon: rectangle(0, 0, 1, 1) }],
        },
        {
          id: 'unsampled-coronal',
          fixedAxis: 1,
          fixedIndex: 3,
          acrossAxis: 0,
          verticalAxis: 2,
          patches: [{ label: 'inside', polygon: rectangle(2, 1, 3, 3) }],
        },
        {
          id: 'sampled-sagittal',
          fixedAxis: 0,
          fixedIndex: 4,
          acrossAxis: 1,
          verticalAxis: 2,
          patches: [{ label: 'inside', polygon: rectangle(0, 1, 4, 5) }],
        },
      ],
    };
    const candidate: SparseCoreCandidate = {
      sourceGrid: reference.sourceGrid,
      dims: [5, 3, 3],
      origin: [0, 0, 1],
      stride: [1, 2, 2],
      mask: new Uint8Array(45).fill(1),
      support: new Uint8Array(45).fill(1),
    };
    const result = evaluateSparseCores(reference, candidate);
    expect(result.inside).toEqual({
      referenceVoxels: 35,
      denominator: 9,
      hits: 9,
      misses: 0,
      unsampledReferenceVoxels: 26,
      unsupportedReferenceVoxels: 0,
    });
    expect(result.unsampledReferenceVoxels).toBe(26);
    expect(result.unsupportedReferenceVoxels).toBe(0);
    expect(exactNativeIndex([2, 3, 3], candidate)).toBeNull();
    expect(exactNativeIndex([2, 2, 2], candidate)).toBeNull();
    expect(exactNativeIndex([2, 2, 3], candidate)).toBe(22);
  });

  it('reports known cores outside a cropped candidate as unsampled rather than misses or unavailable source', () => {
    const { reference, candidate } = fixture();
    const result = evaluateSparseCores(reference, {
      ...candidate,
      dims: [2, 2, 1],
      origin: [11, 21, 31],
      mask: new Uint8Array(4).fill(1),
      support: new Uint8Array(4).fill(1),
    });
    expect(result.inside).toMatchObject({
      referenceVoxels: 9,
      denominator: 4,
      hits: 4,
      misses: 0,
      unsampledReferenceVoxels: 5,
    });
    expect(result.outside).toMatchObject({
      referenceVoxels: 4,
      denominator: 0,
      selections: 0,
      rejections: 0,
      unsampledReferenceVoxels: 4,
    });
    expect(result.unsampledReferenceVoxels).toBe(9);
    expect(result.unsupportedReferenceVoxels).toBe(0);
  });

  it('maps signed integer strides exactly without changing canonical axes or promoting fractional centers', () => {
    const grid: NativeSamplingGrid = {
      sourceGrid: 'synthetic-reversed',
      dims: [3, 3, 3],
      origin: [4, 6, 5],
      stride: [-2, -3, -2],
    };
    expect(exactNativeIndex([4, 6, 5], grid)).toBe(0);
    expect(exactNativeIndex([2, 3, 3], grid)).toBe(13);
    expect(exactNativeIndex([0, 0, 1], grid)).toBe(26);
    expect(exactNativeIndex([3, 3, 3], grid)).toBeNull();
    expect(exactNativeIndex([-2, 3, 3], grid)).toBeNull();
    expect(() => exactNativeIndex([2.5, 3, 3], grid)).toThrow(/voxel center/);
  });

  it.each([
    { dims: [2, 0, 3] },
    { dims: [2, 1.5, 3] },
    { dims: [2, 3] },
    { origin: [0, 0, 1e-13] },
    { stride: [1, 0, 1] },
    { stride: [1, 1.5, 1] },
    { stride: [1, Infinity, 1] },
    { origin: [Number.MAX_SAFE_INTEGER, 0, 0] },
    { sourceGrid: '' },
  ])('rejects invalid or nonexact native sampling metadata %j', (change) => {
    const { candidate } = fixture();
    expect(() => exactNativeIndex([0, 0, 0], { ...candidate, ...change } as NativeSamplingGrid)).toThrow(
      /exact integer/,
    );
  });

  it.each(['unrelated grid', 'mask shape', 'support shape', 'nonbinary mask', 'nonbinary support'])(
    'rejects %s rather than manufacturing core evidence',
    (kind) => {
      const { reference, candidate } = fixture();
      if (kind === 'unrelated grid') candidate.sourceGrid = 'another-source';
      if (kind === 'mask shape') candidate.mask = new Uint8Array(1);
      if (kind === 'support shape') candidate.support = new Uint8Array(1);
      if (kind === 'nonbinary mask') candidate.mask[0] = 2;
      if (kind === 'nonbinary support') candidate.support[0] = 2;
      expect(() => evaluateSparseCores(reference, candidate)).toThrow(/unrelated|binary/);
    },
  );

  it.each([
    'draft label',
    'degenerate polygon',
    'nonfinite vertex',
    'outside grid',
    'duplicate axes',
    'fractional section',
    'outside section',
    'duplicate section',
  ])('rejects malformed or unadjudicated-shaped reference input: %s', (kind) => {
    const { reference, candidate } = fixture();
    const section = { ...reference.sections[0]!, patches: [...reference.sections[0]!.patches] };
    if (kind === 'draft label')
      section.patches[0] = { ...section.patches[0]!, label: 'definite-inside-draft' as 'inside' };
    if (kind === 'degenerate polygon')
      section.patches[0] = {
        label: 'inside',
        polygon: [
          [11, 21],
          [12, 22],
          [13, 23],
        ],
      };
    if (kind === 'nonfinite vertex')
      section.patches[0] = {
        label: 'inside',
        polygon: [
          [NaN, 21],
          [12, 22],
          [13, 23],
        ],
      };
    if (kind === 'outside grid') section.patches[0] = { label: 'inside', polygon: rectangle(0, 0, 1, 1) };
    if (kind === 'duplicate axes') section.acrossAxis = section.fixedAxis;
    if (kind === 'fractional section') section.fixedIndex = 31.5;
    if (kind === 'outside section') section.fixedIndex = 40;
    reference.sections = kind === 'duplicate section' ? [section, section] : [section];
    expect(() => evaluateSparseCores(reference, candidate)).toThrow(/Sparse core/);
  });
});
