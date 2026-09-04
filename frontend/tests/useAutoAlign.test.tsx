import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AlignmentReference } from '../src/types/api';
import { getAlignmentSliceScore } from '../src/utils/alignmentSliceScoreStore';
import { computeAlignedSettings } from '../src/utils/alignment';
import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  invertStandardAffine2D,
  standardToAffineAboutOrigin,
  type StandardAffine2D,
} from '../src/utils/affine2d';
import { correctedWarpAtSize } from '../src/utils/alignmentTransform';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from '../src/utils/imageCapture';
import { computeMutualInformation } from '../src/utils/mutualInformation';
import { affineAboutCenterToPanelGeometry } from '../src/utils/panelTransform';
import { fillInvalidWarpWithValidMean, warpGrayscaleAffineWithValidity } from '../src/utils/warpAffine';
import {
  makeTissueLabelPhantom,
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  relocateInternalStructures,
  renderMovingFromFixed,
  renderTissueContrast,
  Tissue,
} from './helpers/alignmentSynthetic';

const mocks = vi.hoisted(() => ({
  renderSliceToPixels: vi.fn(),
  registerRigid2DWithElastix: vi.fn(),
  registerAffine2DWithElastix: vi.fn(),
}));

vi.mock('../src/utils/cornerstoneSliceCapture', () => ({
  renderSliceToPixels: mocks.renderSliceToPixels,
}));

vi.mock('../src/utils/elastixRegistration', () => ({
  disposeElastixWorker: (worker: Worker) => worker.terminate(),
  registerRigid2DWithElastix: mocks.registerRigid2DWithElastix,
  registerAffine2DWithElastix: mocks.registerAffine2DWithElastix,
}));

import { useAutoAlign } from '../src/hooks/useAutoAlign';

function makeSlice(size: number, variant: 'reference' | 'missing' | 'different'): Float32Array {
  const output = new Float32Array(size * size);
  const center = size / 2;
  for (let y = Math.round(size * 0.18); y < Math.round(size * 0.82); y++) {
    for (let x = Math.round(size * 0.2); x < Math.round(size * 0.8); x++) {
      const ellipse = ((x - center) / (size * 0.27)) ** 2 + ((y - center) / (size * 0.31)) ** 2;
      if (ellipse <= 1) output[y * size + x] = 0.2 + 0.6 * (x / size);
    }
  }

  const featureX0 = Math.round(size * 0.3);
  const featureX1 = Math.round(size * 0.4);
  const featureY0 = Math.round(size * 0.32);
  const featureY1 = Math.round(size * 0.47);
  if (variant !== 'missing') {
    for (let y = featureY0; y < featureY1; y++) {
      for (let x = featureX0; x < featureX1; x++) output[y * size + x] = variant === 'reference' ? 1 : 0.05;
    }
  }
  if (variant === 'different') {
    const addedX = Math.round(size * 0.66);
    for (let y = Math.round(size * 0.36); y < Math.round(size * 0.68); y++) output[y * size + addedX] = 1;
  }
  return output;
}

function makeBoundarySearchSlice(
  size: number,
  variant: 'reference' | 'near-reference-boundary' | 'relocated-distractor',
): Float32Array {
  if (variant === 'reference') return makeSlice(size, 'reference');
  if (variant === 'near-reference-boundary') {
    const output = makeSlice(size, 'reference');
    const featureX1 = Math.round(size * 0.4);
    const featureY0 = Math.round(size * 0.32);
    const featureY1 = Math.round(size * 0.47);
    const trimmedWidth = Math.max(1, Math.round(size * 0.01));
    for (let y = featureY0; y < featureY1; y++) {
      for (let x = featureX1 - trimmedWidth; x < featureX1; x++) {
        output[y * size + x] = 0.2 + 0.6 * (x / size);
      }
    }
    return output;
  }

  const output = makeSlice(size, 'missing');
  for (let y = Math.round(size * 0.58); y < Math.round(size * 0.74); y++) {
    for (let x = Math.round(size * 0.58); x < Math.round(size * 0.72); x++) {
      output[y * size + x] = 1;
    }
  }
  return output;
}

function renderedSlice(pixels: Float32Array, seriesUid: string, index: number) {
  const imageId = `${seriesUid}:${index}`;
  return {
    pixels,
    imageId,
    timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
  };
}

function makeAffineRegistration(
  moving: Float32Array,
  worker: Worker,
  movingToFixed: StandardAffine2D,
  options?: {
    resampledMovingPixels?: Float32Array;
    nmi?: number;
    mi?: number;
    elastixFinalMetric?: number;
    elastixMetricSamples?: number;
  },
) {
  const center = (Math.sqrt(moving.length) - 1) / 2;
  const aboutCenter = standardToAffineAboutOrigin(movingToFixed.A, movingToFixed.b, {
    x: center,
    y: center,
  });
  return {
    movingToFixed,
    A: aboutCenter.A,
    translatePx: aboutCenter.t,
    resampledMovingPixels: options?.resampledMovingPixels ?? moving,
    transformParameterObject: [],
    quality: {
      mi: options?.mi ?? 1,
      nmi: options?.nmi ?? 1,
      bins: 64,
      elastixFinalMetric: options?.elastixFinalMetric,
      elastixMetricSamples: options?.elastixMetricSamples,
    },
    webWorker: worker,
  };
}

const IDENTITY_STANDARD_AFFINE: StandardAffine2D = {
  A: { m00: 1, m01: 0, m10: 0, m11: 1 },
  b: { x: 0, y: 0 },
};

function containsFloat32Array(value: unknown, seen = new Set<object>()): boolean {
  if (value instanceof Float32Array) return true;
  if (value == null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsFloat32Array(entry, seen));
}

function removeInternalStructures(labels: Uint8Array): Uint8Array {
  return Uint8Array.from(labels, (label) =>
    label === Tissue.orbit || label === Tissue.nerve || label === Tissue.ventricle || label === Tissue.landmark
      ? Tissue.inner
      : label,
  );
}

// This suite deliberately exercises production multi-scale descriptors and up to 90 candidates.
// Give the integration workload its own explicit budget; unit suites keep the normal 5-second limit.
describe('useAutoAlign perceptual production path', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const worker = { terminate: vi.fn() } as unknown as Worker;

    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) => {
      const variant =
        seriesUid === 'reference-series' || index === 2 ? 'reference' : index === 1 ? 'missing' : 'different';
      return renderedSlice(makeSlice(size, variant), seriesUid, index);
    });

    mocks.registerRigid2DWithElastix.mockImplementation(async (_fixed: Float32Array, moving: Float32Array) => ({
      movingToFixed: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: { x: 0, y: 0 },
      },
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      resampledMovingPixels: moving,
      transformParameterObject: [],
      quality: { mi: 1, nmi: 1, bins: 64 },
      webWorker: worker,
    }));
    mocks.registerAffine2DWithElastix.mockImplementation(async (_fixed: Float32Array, moving: Float32Array) => ({
      movingToFixed: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: { x: 0, y: 0 },
      },
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      resampledMovingPixels: moving,
      transformParameterObject: [],
      quality: { mi: 1, nmi: 1, bins: 64 },
      webWorker: worker,
    }));
  });

  test('scores every bounded slice, selects by fine structure, and runs affine only after selection', async () => {
    const candidateCount = 21;
    const seedIndex = 10;
    const trueIndex = 16;
    const trueMovingToFixedAtFullSize: StandardAffine2D = {
      A: IDENTITY_STANDARD_AFFINE.A,
      b: { x: 10, y: -6 },
    };
    const pixelsForSlice = (seriesUid: string, index: number, size: number) => {
      const labels = makeTissueLabelPhantom(size);
      if (seriesUid === 'reference-series') {
        return renderTissueContrast(labels, REFERENCE_CONTRAST);
      }
      if (index === trueIndex) {
        return renderMovingFromFixed(renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST), size, {
          A: trueMovingToFixedAtFullSize.A,
          b: {
            x: (trueMovingToFixedAtFullSize.b.x * size) / ALIGNMENT_IMAGE_SIZE,
            y: (trueMovingToFixedAtFullSize.b.y * size) / ALIGNMENT_IMAGE_SIZE,
          },
        });
      }
      if (index === seedIndex) {
        return renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST);
      }
      return renderTissueContrast(removeInternalStructures(labels), REFERENCE_CONTRAST);
    };
    const referenceHistogram = Array.from(pixelsForSlice('reference-series', seedIndex, 64)).sort((a, b) => a - b);
    const seedHistogram = Array.from(pixelsForSlice('target-series', seedIndex, 64)).sort((a, b) => a - b);
    expect(seedHistogram).toEqual(referenceHistogram);
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) =>
      renderedSlice(pixelsForSlice(seriesUid, index, size), seriesUid, index),
    );

    const affineObservedRecordedWinner: boolean[] = [];
    const affineWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.registerAffine2DWithElastix.mockImplementation(async (_fixed: Float32Array, moving: Float32Array) => {
      const winnerScore = getAlignmentSliceScore('target-series', trueIndex);
      affineObservedRecordedWinner.push(
        winnerScore?.selected === true && winnerScore.fineStage != null && winnerScore.finalAffineSelected == null,
      );
      return makeAffineRegistration(moving, affineWorker, IDENTITY_STANDARD_AFFINE);
    });

    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: seedIndex,
      sliceCount: candidateCount,
      settings: { ...DEFAULT_PANEL_SETTINGS },
      exclusionMask: { x: 0.45, y: 0.45, width: 0.05, height: 0.05 },
    };
    const { result } = renderHook(() => useAutoAlign());
    let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
    await act(async () => {
      aligned = await result.current.alignAllDates(
        reference,
        ['2026-02-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'target-series',
            instance_count: candidateCount,
          },
        },
        0.5,
      );
    });

    expect(aligned).toHaveLength(1);
    expect(aligned[0].bestSliceIndex).toBe(trueIndex);
    expect(aligned[0].slicesChecked).toBe(candidateCount);
    expect(mocks.registerRigid2DWithElastix).toHaveBeenCalledTimes(2);
    expect(mocks.registerRigid2DWithElastix.mock.calls[0]?.[3]).toMatchObject({ numberOfResolutions: 3 });
    expect(mocks.registerRigid2DWithElastix.mock.calls[0]?.[3]).not.toHaveProperty('exclusionRect');
    expect(mocks.registerRigid2DWithElastix.mock.calls[1]?.[3]).toMatchObject({
      numberOfResolutions: 3,
      exclusionRect: reference.exclusionMask,
    });
    expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
    expect(affineObservedRecordedWinner).toEqual([true, true]);
    expect(mocks.registerAffine2DWithElastix.mock.calls[0]?.[3]).toMatchObject({ numberOfResolutions: 3 });
    expect(mocks.registerAffine2DWithElastix.mock.calls[1]?.[3]).toMatchObject({ numberOfResolutions: 3 });

    const coarseIndices = mocks.renderSliceToPixels.mock.calls
      .filter((call) => call[0] === 'target-series' && call[2] === 128)
      .map((call) => call[1])
      .sort((a, b) => a - b);
    expect(coarseIndices).toEqual(Array.from({ length: candidateCount }, (_, index) => index));
    expect(mocks.renderSliceToPixels.mock.calls.slice(0, 2).map((call) => call.slice(0, 3))).toEqual([
      ['reference-series', seedIndex, 256],
      ['reference-series', seedIndex, 128],
    ]);
    expect(mocks.renderSliceToPixels.mock.calls.every((call) => call[3]?.signal instanceof AbortSignal)).toBe(true);

    const scoreRecords = Array.from({ length: candidateCount }, (_, index) => ({
      index,
      score: getAlignmentSliceScore('target-series', index),
    }));
    const fineIndices = scoreRecords.filter(({ score }) => score?.fineStage != null).map(({ index }) => index);
    expect(fineIndices).toEqual(scoreRecords.filter(({ score }) => score?.retainedForFine).map(({ index }) => index));
    expect(fineIndices.length).toBeLessThan(candidateCount);
    const coarseOnlyNonwinner = scoreRecords.find(
      ({ index, score }) => index !== trueIndex && score?.coarseStage != null && score.fineStage == null,
    );
    expect(coarseOnlyNonwinner).toBeDefined();
    for (const { score } of scoreRecords) {
      expect(score?.coarseStage).toBeDefined();
      expect(containsFloat32Array(score)).toBe(false);
    }

    const fullSizeTargetIndices = mocks.renderSliceToPixels.mock.calls
      .filter((call) => call[0] === 'target-series' && call[2] === ALIGNMENT_IMAGE_SIZE)
      .map((call) => call[1]);
    expect(fullSizeTargetIndices).toEqual([seedIndex, ...fineIndices, trueIndex]);

    const winningScore = getAlignmentSliceScore('target-series', trueIndex);
    expect(winningScore).toMatchObject({
      distanceFromSeed: trueIndex - seedIndex,
      rigidSeed: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        translatePx: { x: 0, y: 0 },
        gridSize: 256,
      },
      coarseStage: {
        distanceFromSeed: trueIndex - seedIndex,
        rigidSeed: { gridSize: 256 },
        mindRank: expect.any(Number),
        structuralRank: expect.any(Number),
        mindActive: true,
        structuralActive: true,
        phaseInput: 'structural-edge-energy',
      },
      fineStage: {
        distanceFromSeed: trueIndex - seedIndex,
        rigidSeed: { gridSize: 256 },
        mindRank: expect.any(Number),
        structuralRank: expect.any(Number),
        mindActive: true,
        structuralActive: true,
        phaseInput: 'structural-edge-energy',
      },
      selected: true,
      mindRank: expect.any(Number),
      structuralRank: expect.any(Number),
      mindActive: true,
      structuralActive: true,
      phaseInput: 'structural-edge-energy',
      finalAffineSelected: 'seed-only',
    });
    expect(winningScore?.fineStage?.structuralRank).toBeGreaterThan(
      getAlignmentSliceScore('target-series', seedIndex)?.fineStage?.structuralRank ?? 0,
    );
    const winningFineScales = winningScore?.fineStage?.perScale ?? [];
    const expectedMind = winningFineScales.reduce((sum, scale) => sum + scale.mind, 0) / winningFineScales.length;
    const rawMindDistances = winningFineScales.flatMap((scale) =>
      scale.rawMindDistance == null ? [] : [scale.rawMindDistance],
    );
    const expectedRawMindDistance = rawMindDistances.reduce((sum, value) => sum + value, 0) / rawMindDistances.length;
    expect(winningScore?.mind).toBeCloseTo(expectedMind, 12);
    expect(winningScore?.rawMindDistance).toBeCloseTo(expectedRawMindDistance, 12);
  });

  test('selects the structurally improving final affine and derives geometry, quality, and intensity from it', async () => {
    const size = ALIGNMENT_IMAGE_SIZE;
    const labels = makeTissueLabelPhantom(size);
    const referencePixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
    const knownTargetToReference: StandardAffine2D = {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      b: { x: 24, y: -6 },
    };
    const targetPixels = renderMovingFromFixed(
      renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST),
      size,
      knownTargetToReference,
    );
    const pixelsAtSize = (seriesUid: string, targetSize: number) => {
      const targetLabels = makeTissueLabelPhantom(targetSize);
      if (seriesUid === 'reference-series') {
        return renderTissueContrast(targetLabels, REFERENCE_CONTRAST);
      }
      return renderMovingFromFixed(renderTissueContrast(targetLabels, NONFUNCTIONAL_CONTRAST), targetSize, {
        A: knownTargetToReference.A,
        b: {
          x: (knownTargetToReference.b.x * targetSize) / size,
          y: (knownTargetToReference.b.y * targetSize) / size,
        },
      });
    };
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, targetSize: number) =>
      renderedSlice(pixelsAtSize(seriesUid, targetSize), seriesUid, index),
    );

    const intensityWorker = { terminate: vi.fn() } as unknown as Worker;
    const structureWorker = { terminate: vi.fn() } as unknown as Worker;
    const poisonedOptimizerResample = new Float32Array(size * size).fill(0.99);
    let affineStartedAfterFineWinner = false;
    let expectedStructuralResidual: StandardAffine2D | undefined;
    let recordedWinningWarp: ReturnType<typeof correctedWarpAtSize> | undefined;
    mocks.registerAffine2DWithElastix.mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) => {
      const fineWinner = getAlignmentSliceScore('target-series', 0);
      affineStartedAfterFineWinner = fineWinner?.selected === true && fineWinner.finalAffineSelected == null;
      return makeAffineRegistration(
        moving,
        intensityWorker,
        { A: IDENTITY_STANDARD_AFFINE.A, b: { x: -2, y: 2 } },
        { resampledMovingPixels: poisonedOptimizerResample, mi: 0.998, nmi: 0.999 },
      );
    });
    mocks.registerAffine2DWithElastix.mockImplementationOnce(
      async (_fixed: Float32Array, moving: Float32Array, _size: number, options: { webWorker?: Worker }) => {
        expect(options.webWorker).toBe(intensityWorker);
        const fineWinner = getAlignmentSliceScore('target-series', 0);
        if (!fineWinner?.rigidSeed || fineWinner.correctionX == null || fineWinner.correctionY == null) {
          throw new Error('fine winner was not recorded before final affine');
        }
        const winningWarp = correctedWarpAtSize(
          fineWinner.rigidSeed,
          {
            correctionX: fineWinner.correctionX,
            correctionY: fineWinner.correctionY,
            sampleGridSize: 128,
            fftSize: 256,
          },
          size,
        );
        const center = (size - 1) / 2;
        const winningStandard = affineAboutOriginToStandard({
          A: winningWarp.A,
          origin: { x: center, y: center },
          t: { x: winningWarp.translateX, y: winningWarp.translateY },
        });
        const residual = composeStandardAffine2D(knownTargetToReference, invertStandardAffine2D(winningStandard));
        expectedStructuralResidual = residual;
        recordedWinningWarp = winningWarp;
        return makeAffineRegistration(moving, structureWorker, residual, {
          resampledMovingPixels: new Float32Array(size * size).fill(0.73),
          mi: 0.997,
          nmi: 0.998,
        });
      },
    );

    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 0,
      sliceCount: 1,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    const { result } = renderHook(() => useAutoAlign());
    let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
    await act(async () => {
      aligned = await result.current.alignAllDates(
        reference,
        ['2026-02-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'target-series',
            instance_count: 1,
          },
        },
        0.5,
      );
    });

    expect(affineStartedAfterFineWinner).toBe(true);
    expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
    expect(mocks.registerAffine2DWithElastix.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.registerAffine2DWithElastix.mock.invocationCallOrder[0] ?? 0,
    );
    expect(expectedStructuralResidual).toBeDefined();
    expect(recordedWinningWarp).toBeDefined();
    expect(getAlignmentSliceScore('target-series', 0)).toMatchObject({
      finalAffineSelected: 'structure-elastix',
      finalAffineProposals: [
        { kind: 'seed-only', status: 'eligible' },
        { kind: 'intensity-elastix', status: 'eligible' },
        { kind: 'structure-elastix', status: 'selected' },
      ],
    });

    const selectedAboutCenter = standardToAffineAboutOrigin(knownTargetToReference.A, knownTargetToReference.b, {
      x: (size - 1) / 2,
      y: (size - 1) / 2,
    });
    const expectedSelectedRawResample = fillInvalidWarpWithValidMean(
      warpGrayscaleAffineWithValidity(targetPixels, size, {
        A: selectedAboutCenter.A,
        translateX: selectedAboutCenter.t.x,
        translateY: selectedAboutCenter.t.y,
      }),
    );
    const expectedSelectedQuality = computeMutualInformation(referencePixels, expectedSelectedRawResample, {
      bins: 64,
      imageWidth: size,
      imageHeight: size,
    });
    expect(aligned[0]?.nmiScore).toBeCloseTo(expectedSelectedQuality.nmi, 8);
    expect(aligned[0]?.nmiScore).not.toBeCloseTo(0.999, 3);

    const expectedGeometry = affineAboutCenterToPanelGeometry(
      { A: selectedAboutCenter.A, translatePx: selectedAboutCenter.t },
      size,
    );
    const expectedSettings = computeAlignedSettings(
      computeHistogramStats(referencePixels),
      computeHistogramStats(expectedSelectedRawResample),
      0,
      1,
      0.5,
      expectedGeometry,
    );
    expect(aligned[0]?.computedSettings).toMatchObject(expectedSettings);
    const poisonedSettings = computeAlignedSettings(
      computeHistogramStats(referencePixels),
      computeHistogramStats(poisonedOptimizerResample),
      0,
      1,
      0.5,
      expectedGeometry,
    );
    expect(
      aligned[0]?.computedSettings.brightness !== poisonedSettings.brightness ||
        aligned[0]?.computedSettings.contrast !== poisonedSettings.contrast,
    ).toBe(true);
  });

  test('snapshots scalar optimizer provenance before a later attempt releases the full registration result', async () => {
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 0,
      sliceCount: 1,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) =>
      renderedSlice(makeSlice(size, 'reference'), seriesUid, index),
    );

    const worker = { terminate: vi.fn() } as unknown as Worker;
    let releaseFirstQuality: (() => void) | undefined;
    mocks.registerAffine2DWithElastix
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) => {
        const registration = makeAffineRegistration(moving, worker, IDENTITY_STANDARD_AFFINE, {
          mi: 0.41,
          nmi: 1.41,
          elastixFinalMetric: -0.25,
          elastixMetricSamples: 7,
        });
        const quality = registration.quality;
        let released = false;
        releaseFirstQuality = () => {
          released = true;
        };
        Object.defineProperty(registration, 'quality', {
          configurable: true,
          get: () => {
            if (released) throw new Error('released first optimizer result was retained');
            return quality;
          },
        });
        return registration;
      })
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) => {
        releaseFirstQuality?.();
        return makeAffineRegistration(moving, worker, IDENTITY_STANDARD_AFFINE, {
          mi: 0.42,
          nmi: 1.42,
          elastixFinalMetric: -0.2,
          elastixMetricSamples: 8,
        });
      });

    window.localStorage.setItem('miraviewer:debug-alignment', '1');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() => useAutoAlign());
      let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
      await act(async () => {
        aligned = await result.current.alignAllDates(
          reference,
          ['2026-02-01'],
          {
            '2026-02-01': {
              study_id: 'study',
              series_uid: 'target-series',
              instance_count: 1,
            },
          },
          0.5,
        );
      });

      expect(aligned).toHaveLength(1);
      const proposalLog = consoleLog.mock.calls.find(([message]) => message === '[alignment] refine.proposals');
      expect(proposalLog?.[1]).toMatchObject({
        optimizerQuality: [
          {
            kind: 'intensity-elastix',
            mi: 0.41,
            nmi: 1.41,
            elastixFinalMetric: -0.25,
            elastixMetricSamples: 7,
          },
          {
            kind: 'structure-elastix',
            mi: 0.42,
            nmi: 1.42,
            elastixFinalMetric: -0.2,
            elastixMetricSamples: 8,
          },
        ],
      });
      expect(containsFloat32Array(proposalLog?.[1])).toBe(false);
      expect(containsFloat32Array(getAlignmentSliceScore('target-series', 0))).toBe(false);
    } finally {
      consoleLog.mockRestore();
      window.localStorage.removeItem('miraviewer:debug-alignment');
    }
  });

  test('retains seed-only when both optimizer transforms degrade structure', async () => {
    const size = ALIGNMENT_IMAGE_SIZE;
    const labels = makeTissueLabelPhantom(size);
    const referencePixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
    const targetPixels = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, targetSize: number) => {
      const targetLabels = makeTissueLabelPhantom(targetSize);
      const pixels = renderTissueContrast(
        targetLabels,
        seriesUid === 'reference-series' ? REFERENCE_CONTRAST : NONFUNCTIONAL_CONTRAST,
      );
      return renderedSlice(pixels, seriesUid, index);
    });
    const intensityWorker = { terminate: vi.fn() } as unknown as Worker;
    const structureWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.registerAffine2DWithElastix
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(
          moving,
          intensityWorker,
          { A: IDENTITY_STANDARD_AFFINE.A, b: { x: 7, y: -5 } },
          { resampledMovingPixels: new Float32Array(size * size).fill(0.96), nmi: 0.999 },
        ),
      )
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(
          moving,
          structureWorker,
          { A: IDENTITY_STANDARD_AFFINE.A, b: { x: -6, y: 5 } },
          { resampledMovingPixels: new Float32Array(size * size).fill(0.97), nmi: 0.998 },
        ),
      );
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 0,
      sliceCount: 1,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    const { result } = renderHook(() => useAutoAlign());
    let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
    await act(async () => {
      aligned = await result.current.alignAllDates(
        reference,
        ['2026-02-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'target-series',
            instance_count: 1,
          },
        },
        0.25,
      );
    });

    const score = getAlignmentSliceScore('target-series', 0);
    expect(score).toMatchObject({
      finalAffineSelected: 'seed-only',
      finalAffineProposals: [
        { kind: 'seed-only', status: 'selected' },
        { kind: 'intensity-elastix' },
        { kind: 'structure-elastix' },
      ],
    });
    if (!score?.rigidSeed || score.correctionX == null || score.correctionY == null) {
      throw new Error('missing winning seed diagnostics');
    }
    const winningWarp = correctedWarpAtSize(
      score.rigidSeed,
      {
        correctionX: score.correctionX,
        correctionY: score.correctionY,
        sampleGridSize: 128,
        fftSize: 256,
      },
      size,
    );
    const selectedRawResample = fillInvalidWarpWithValidMean(
      warpGrayscaleAffineWithValidity(targetPixels, size, winningWarp),
    );
    const expectedQuality = computeMutualInformation(referencePixels, selectedRawResample, {
      bins: 64,
      imageWidth: size,
      imageHeight: size,
    });
    expect(aligned[0]?.nmiScore).toBeCloseTo(expectedQuality.nmi, 8);
    expect(aligned[0]?.nmiScore).not.toBeCloseTo(0.999, 3);

    const expectedGeometry = affineAboutCenterToPanelGeometry(
      {
        A: winningWarp.A,
        translatePx: { x: winningWarp.translateX, y: winningWarp.translateY },
      },
      size,
    );
    const expectedSettings = computeAlignedSettings(
      computeHistogramStats(referencePixels),
      computeHistogramStats(selectedRawResample),
      0,
      1,
      0.25,
      expectedGeometry,
    );
    expect(aligned[0]?.computedSettings).toMatchObject({
      brightness: expectedSettings.brightness,
      contrast: expectedSettings.contrast,
      offset: expectedSettings.offset,
      progress: expectedSettings.progress,
    });
    expect(aligned[0]?.computedSettings.panX).toBeCloseTo(expectedSettings.panX, 12);
    expect(aligned[0]?.computedSettings.panY).toBeCloseTo(expectedSettings.panY, 12);
    expect(aligned[0]?.computedSettings.rotation).toBeCloseTo(expectedSettings.rotation, 12);
    expect(aligned[0]?.computedSettings.zoom).toBeCloseTo(expectedSettings.zoom, 12);
    expect(aligned[0]?.computedSettings.affine00).toBeCloseTo(expectedSettings.affine00, 12);
    expect(aligned[0]?.computedSettings.affine01).toBeCloseTo(expectedSettings.affine01, 12);
    expect(aligned[0]?.computedSettings.affine10).toBeCloseTo(expectedSettings.affine10, 12);
    expect(aligned[0]?.computedSettings.affine11).toBeCloseTo(expectedSettings.affine11, 12);
  });

  test.each([
    ['intensity', true, false],
    ['structure', false, true],
    ['both', true, true],
  ] as const)(
    'omits %s optimizer failures while preserving the remaining final-affine fallback',
    async (_label, failIntensity, failStructure) => {
      const reference: AlignmentReference = {
        date: '2026-01-01',
        seriesUid: 'reference-series',
        sliceIndex: 0,
        sliceCount: 1,
        settings: { ...DEFAULT_PANEL_SETTINGS },
      };
      mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) =>
        renderedSlice(makeSlice(size, 'reference'), seriesUid, index),
      );
      const intensityWorker = { terminate: vi.fn() } as unknown as Worker;
      const structureWorker = { terminate: vi.fn() } as unknown as Worker;
      if (failIntensity) {
        mocks.registerAffine2DWithElastix.mockRejectedValueOnce(new Error('intensity failed'));
      } else {
        mocks.registerAffine2DWithElastix.mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
          makeAffineRegistration(moving, intensityWorker, IDENTITY_STANDARD_AFFINE),
        );
      }
      if (failStructure) {
        mocks.registerAffine2DWithElastix.mockRejectedValueOnce(new Error('structure failed'));
      } else {
        mocks.registerAffine2DWithElastix.mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
          makeAffineRegistration(moving, structureWorker, IDENTITY_STANDARD_AFFINE),
        );
      }

      const { result } = renderHook(() => useAutoAlign());
      let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
      await act(async () => {
        aligned = await result.current.alignAllDates(
          reference,
          ['2026-02-01'],
          {
            '2026-02-01': {
              study_id: 'study',
              series_uid: 'target-series',
              instance_count: 1,
            },
          },
          0.5,
        );
      });

      expect(aligned).toHaveLength(1);
      expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
      expect(mocks.registerAffine2DWithElastix.mock.calls[1]?.[3]?.webWorker).toBe(
        failIntensity ? undefined : intensityWorker,
      );
      const score = getAlignmentSliceScore('target-series', 0);
      expect(score?.finalAffineSelected).toBe('seed-only');
      expect(score?.finalAffineProposals).toHaveLength(3);
      expect(score?.finalAffineProposals?.find((proposal) => proposal.kind === 'intensity-elastix')).toMatchObject(
        failIntensity ? { status: 'failed', failureMessage: 'intensity failed' } : { status: 'eligible' },
      );
      expect(score?.finalAffineProposals?.find((proposal) => proposal.kind === 'structure-elastix')).toMatchObject(
        failStructure ? { status: 'failed', failureMessage: 'structure failed' } : { status: 'eligible' },
      );
      expect(containsFloat32Array(score?.finalAffineProposals)).toBe(false);
      if (failIntensity && failStructure) {
        expect(score?.finalAffineProposals?.filter((proposal) => proposal.status === 'failed')).toHaveLength(2);
      }
    },
  );

  test('clears failed final-affine workers before the next target date acquires a seed worker', async () => {
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 0,
      sliceCount: 1,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) =>
      renderedSlice(makeSlice(size, 'reference'), seriesUid, index),
    );
    const firstSeedWorker = { terminate: vi.fn() } as unknown as Worker;
    const secondSeedWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.registerRigid2DWithElastix
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(moving, firstSeedWorker, IDENTITY_STANDARD_AFFINE),
      )
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(moving, secondSeedWorker, IDENTITY_STANDARD_AFFINE),
      );
    mocks.registerAffine2DWithElastix
      .mockRejectedValueOnce(new Error('first-date intensity failed'))
      .mockRejectedValueOnce(new Error('first-date structure failed'))
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(moving, secondSeedWorker, IDENTITY_STANDARD_AFFINE),
      )
      .mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
        makeAffineRegistration(moving, secondSeedWorker, IDENTITY_STANDARD_AFFINE),
      );

    const { result } = renderHook(() => useAutoAlign());
    let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
    await act(async () => {
      aligned = await result.current.alignAllDates(
        reference,
        ['2026-02-01', '2026-03-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'first-target-series',
            instance_count: 1,
          },
          '2026-03-01': {
            study_id: 'study',
            series_uid: 'second-target-series',
            instance_count: 1,
          },
        },
        0.5,
      );
    });

    expect(aligned).toHaveLength(2);
    expect(mocks.registerRigid2DWithElastix).toHaveBeenCalledTimes(2);
    expect(mocks.registerRigid2DWithElastix.mock.calls[1]?.[3]?.webWorker).toBeUndefined();
    expect(mocks.registerAffine2DWithElastix.mock.calls[2]?.[3]?.webWorker).toBe(secondSeedWorker);
    expect(getAlignmentSliceScore('first-target-series', 0)?.finalAffineProposals).toMatchObject([
      { kind: 'seed-only', status: 'selected' },
      { kind: 'intensity-elastix', status: 'failed' },
      { kind: 'structure-elastix', status: 'failed' },
    ]);
  });

  test('extends a boundary-peaked window once and reranks the unified candidate universe', async () => {
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 40,
      sliceCount: 90,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    mocks.renderSliceToPixels.mockImplementation(async (seriesUid: string, index: number, size: number) => {
      const variant =
        seriesUid === 'reference-series' || index === 85
          ? 'reference'
          : index === 80
            ? 'near-reference-boundary'
            : 'relocated-distractor';
      return renderedSlice(makeBoundarySearchSlice(size, variant), seriesUid, index);
    });
    const { result } = renderHook(() => useAutoAlign());

    let aligned = [] as Awaited<ReturnType<typeof result.current.alignAllDates>>;
    await act(async () => {
      aligned = await result.current.alignAllDates(
        reference,
        ['2026-02-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'target-series',
            instance_count: 90,
          },
        },
        40 / 89,
      );
    });

    expect(aligned).toHaveLength(1);
    expect(aligned[0].bestSliceIndex).toBe(85);
    expect(aligned[0].slicesChecked).toBe(90);
    const coarseIndices = mocks.renderSliceToPixels.mock.calls
      .filter((call) => call[0] === 'target-series' && call[2] === 128)
      .map((call) => call[1])
      .sort((a, b) => a - b);
    expect(coarseIndices).toEqual(Array.from({ length: 90 }, (_, index) => index));
  });

  test('discards the date when cancellation arrives during the second affine attempt', async () => {
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 1,
      sliceCount: 3,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    const intensityWorker = { terminate: vi.fn() } as unknown as Worker;
    const structureWorker = { terminate: vi.fn() } as unknown as Worker;
    let releaseAffine!: () => void;
    let signalAffineStarted!: () => void;
    const affineStarted = new Promise<void>((resolve) => {
      signalAffineStarted = resolve;
    });
    mocks.registerAffine2DWithElastix.mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) =>
      makeAffineRegistration(moving, intensityWorker, IDENTITY_STANDARD_AFFINE),
    );
    mocks.registerAffine2DWithElastix.mockImplementationOnce(
      async (_fixed: Float32Array, moving: Float32Array, _size: number, options: { webWorker?: Worker }) => {
        expect(options.webWorker).toBe(intensityWorker);
        signalAffineStarted();
        await new Promise<void>((resolve) => {
          releaseAffine = resolve;
        });
        return makeAffineRegistration(moving, structureWorker, IDENTITY_STANDARD_AFFINE);
      },
    );
    const { result } = renderHook(() => useAutoAlign());

    let alignmentPromise!: ReturnType<typeof result.current.alignAllDates>;
    await act(async () => {
      alignmentPromise = result.current.alignAllDates(
        reference,
        ['2026-02-01'],
        {
          '2026-02-01': {
            study_id: 'study',
            series_uid: 'target-series',
            instance_count: 3,
          },
        },
        0.5,
      );
      await affineStarted;
    });
    act(() => result.current.abort());

    let aligned: Awaited<typeof alignmentPromise> = [];
    await act(async () => {
      releaseAffine();
      aligned = await alignmentPromise;
    });

    expect(aligned).toEqual([]);
    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isAligning).toBe(false);
    expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
  });

  test('does not let a cancelled superseded run clobber the active replacement state', async () => {
    const reference: AlignmentReference = {
      date: '2026-01-01',
      seriesUid: 'reference-series',
      sliceIndex: 1,
      sliceCount: 3,
      settings: { ...DEFAULT_PANEL_SETTINGS },
    };
    const seriesMap = {
      '2026-02-01': {
        study_id: 'study',
        series_uid: 'target-series',
        instance_count: 3,
      },
    };
    const worker = { terminate: vi.fn() } as unknown as Worker;
    const makeIdentityRegistration = (moving: Float32Array) => ({
      movingToFixed: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: { x: 0, y: 0 },
      },
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      resampledMovingPixels: moving,
      transformParameterObject: [],
      quality: { mi: 1, nmi: 1, bins: 64 },
      webWorker: worker,
    });

    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    mocks.registerRigid2DWithElastix.mockImplementationOnce(
      async (_fixed: Float32Array, _moving: Float32Array, _size: number, options: { signal?: AbortSignal }) => {
        signalFirstStarted();
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        throw new Error('unreachable');
      },
    );

    let signalReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      signalReplacementStarted = resolve;
    });
    let releaseReplacement!: () => void;
    mocks.registerRigid2DWithElastix.mockImplementationOnce(async (_fixed: Float32Array, moving: Float32Array) => {
      signalReplacementStarted();
      await new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      return makeIdentityRegistration(moving);
    });

    const { result } = renderHook(() => useAutoAlign());
    let firstRun!: ReturnType<typeof result.current.alignAllDates>;
    await act(async () => {
      firstRun = result.current.alignAllDates(reference, ['2026-02-01'], seriesMap, 0.5);
      await firstStarted;
    });

    let replacementRun!: ReturnType<typeof result.current.alignAllDates>;
    await act(async () => {
      replacementRun = result.current.alignAllDates(reference, ['2026-02-01'], seriesMap, 0.5);
      await replacementStarted;
      await firstRun;
    });

    expect(result.current.isAligning).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      releaseReplacement();
      await replacementRun;
    });

    expect(result.current.isAligning).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.results).toHaveLength(1);
  });
});
