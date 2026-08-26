import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentReference, ExclusionMask } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

const mocks = vi.hoisted(() => ({
  registerRigid: vi.fn(),
  registerAffine: vi.fn(),
  coverage: 1,
  padded: false,
}));

vi.mock('../src/utils/cornerstoneSliceCapture', () => ({
  renderSliceToPixels: async (seriesUid: string, index: number, size: number) => {
    const pixels = Float32Array.from({ length: size * size }, (_, pixel) => (pixel % 251) / 250);
    if (seriesUid === 'reference-series') {
      pixels[Math.floor(size / 2) * size + Math.floor(size / 2)] = 500;
    } else {
      pixels[0] = index;
    }
    const validity = new Float32Array(size * size).fill(1);
    if (mocks.padded) {
      pixels[1] = seriesUid === 'reference-series' ? 100_000 : -100_000;
      validity[1] = 0;
    }
    const imageId = `miradb:${seriesUid}-${index}`;
    return {
      pixels,
      validity,
      imageId,
      timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
    };
  },
}));

vi.mock('../src/utils/alignmentScoringRunner', () => ({
  createAlignmentScoringRunner: async () => ({
    scoreCoarse: async (pixels: Float32Array) => score(pixels[0] ?? 0),
    scoreFine: async (pixels: Float32Array) => score(pixels[0] ?? 0),
    scoreFinal: async () => {
      const identity = { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 0 } };
      const selected = {
        kind: 'seed-only',
        residualMovingToFixed: identity,
        totalMovingToFixed: identity,
        eligible: true,
        components: { forward: score(0).components, sourceCoverage: 1 },
        mindScore: 0.5,
        ngfScore: 0.5,
        structuralScore: 0.5,
        bidirectionalCoverage: 1,
        deformationMagnitude: 0,
      };
      return { selected, proposals: [selected] };
    },
    close: vi.fn(),
  }),
}));

vi.mock('../src/utils/elastixRegistration', () => ({
  registerRigid2DWithElastix: mocks.registerRigid,
  registerAffine2DWithElastix: mocks.registerAffine,
}));

import { useAutoAlign } from '../src/hooks/useAutoAlign';

function score(index: number) {
  const mind = 0.500001 + index * 0.00000025;
  return {
    phase: { correctionX: 0, correctionY: 0, sampleGridSize: 128, fftSize: 256 },
    components: {
      coverage: mocks.coverage,
      perScale: [
        {
          size: 64,
          contrastStructure: 0.5,
          lncc: 0.5,
          ngf: 0.5,
          rawNgf: 0,
          mind,
          rawMindDistance: 1 - mind,
          lowerQuartile: 0.5,
        },
      ],
    },
  };
}

function reference(exclusionMask?: ExclusionMask): AlignmentReference {
  return {
    date: 'reference-date',
    seriesUid: 'reference-series',
    sliceIndex: 0,
    sliceCount: 9,
    settings: DEFAULT_PANEL_SETTINGS,
    exclusionMask,
  };
}

describe('auto-alignment fail-closed clinical evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coverage = 1;
    mocks.padded = false;
    mocks.registerRigid.mockImplementation(async (_fixed: Float32Array, moving: Float32Array) => ({
      movingToFixed: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 0 } },
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      resampledMovingPixels: moving,
      transformParameterObject: [],
      quality: { mi: 1, nmi: 1, bins: 64 },
    }));
  });

  async function run(exclusionMask?: ExclusionMask) {
    const hook = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof hook.result.current.alignAllDates>> = [];
    await act(async () => {
      results = await hook.result.current.alignAllDates(
        reference(exclusionMask),
        ['target-date'],
        { 'target-date': { study_id: 'target-study', series_uid: 'target-series', instance_count: 9 } },
        0,
      );
    });
    return results;
  }

  it('applies the best valid ranked winner even when another slice is numerically indistinguishable', async () => {
    const results = await run();

    expect(results[0]).toMatchObject({ outcome: 'aligned', bestSliceIndex: 8 });
    expect(results[0]?.evidence?.runnerUpGap).toBeLessThan(0.0001);
    expect(mocks.registerAffine).toHaveBeenCalledTimes(2);
  });

  it('reports partial reference anatomy as insufficient overlap instead of a confident match', async () => {
    mocks.coverage = 0.54;

    const results = await run();

    expect(results[0]).toMatchObject({ outcome: 'insufficient-overlap' });
    expect(mocks.registerAffine).not.toHaveBeenCalled();
  });

  it('removes lesion influence from the fixed image before the first rigid pose exists', async () => {
    const mask = { x: 0.45, y: 0.45, width: 0.1, height: 0.1 };

    await run(mask);

    const firstFixed = mocks.registerRigid.mock.calls[0]![0] as Float32Array;
    const firstMoving = mocks.registerRigid.mock.calls[0]![1] as Float32Array;
    const center = 128 * 256 + 128;
    expect(firstFixed[center]).toBeLessThan(10);
    expect(firstMoving[center]).toBeLessThan(1);
    expect(mocks.registerRigid.mock.calls[0]![3]).not.toHaveProperty('exclusionRect');
    expect(mocks.registerRigid.mock.calls[1]![3]).toMatchObject({ exclusionRect: mask });
  });

  it('never exposes invalid fixed or moving padding to the initial rigid optimizer', async () => {
    mocks.padded = true;

    await run();

    const firstFixed = mocks.registerRigid.mock.calls[0]![0] as Float32Array;
    const firstMoving = mocks.registerRigid.mock.calls[0]![1] as Float32Array;
    expect(firstFixed[1]).toBeGreaterThanOrEqual(0);
    expect(firstFixed[1]).toBeLessThan(2);
    expect(firstMoving[1]).toBeGreaterThanOrEqual(0);
    expect(firstMoving[1]).toBeLessThan(2);
  });
});
