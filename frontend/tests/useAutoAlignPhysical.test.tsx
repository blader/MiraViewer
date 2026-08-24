import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentReference, SeriesRef } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  setDerivedAlignmentFrame,
} from '../src/utils/derivedAlignmentFrame';

const mocks = vi.hoisted(() => ({
  getSeriesFrameManifest: vi.fn(),
  prepare: vi.fn(),
  planeDrift: vi.fn(),
  register3d: vi.fn(),
  densify: vi.fn(),
  register2d: vi.fn(),
  closeScorer: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.getSeriesFrameManifest,
}));

vi.mock('../src/utils/cornerstoneSliceCapture', () => ({
  createCornerstoneRenderElement: () => document.createElement('div'),
  disposeCornerstoneRenderElement: vi.fn(),
  createPixelCaptureScratch: () => ({}),
  renderSliceToPixels: async (_element: HTMLDivElement, series: string, index: number, size: number) => ({
    pixels: Float32Array.from({ length: size * size }, (_, pixel) => (pixel % size) / Math.max(1, size - 1)),
    imageId: `miradb:${series}-${index}`,
    expectedImageId: `miradb:${series}-${index}`,
    renderedImageId: `miradb:${series}-${index}`,
    renderTimedOut: false,
    sourceCanvasWidth: size,
    sourceCanvasHeight: size,
    targetSize: size,
    timingMs: { getImageId: 0, loadImage: 0, waitForRender: 0, capture: 0, total: 0 },
  }),
}));

vi.mock('../src/utils/alignmentScoringRunner', () => ({
  createAlignmentScoringRunner: async () => ({
    scoreCoarse: vi.fn(),
    scoreFine: vi.fn(),
    close: mocks.closeScorer,
  }),
}));

vi.mock('../src/utils/elastixRegistration', () => ({
  registerRigid2DWithElastix: mocks.register2d,
  registerAffine2DWithElastix: vi.fn(),
}));

vi.mock('../src/utils/svr/longitudinalFrames', () => ({
  densifyLongitudinalRegistration: mocks.densify,
  prepareLongitudinalRegistrationInput: mocks.prepare,
  measureLongitudinalPlaneDrift: mocks.planeDrift,
}));

vi.mock('../src/utils/svr/runLongitudinalRegistration', () => ({
  runLongitudinalRegistration: mocks.register3d,
}));

import { useAutoAlign } from '../src/hooks/useAutoAlign';

function manifest(seriesUid: string, patientKey = 'patient-a', frameUid = 'frame-a') {
  return {
    seriesUid,
    studyUid: `study-${seriesUid}`,
    patientKey,
    frameOfReferenceUid: frameUid,
    ordering: 'physical' as const,
    geometryReliable: true,
    frames: Array.from({ length: 3 }, (_, index) => ({
      sopInstanceUid: `${seriesUid}-${index}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: `study-${seriesUid}`,
      instanceNumber: index + 1,
      rows: 4,
      columns: 4,
      imagePositionPatient: `0\\0\\${index}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      frameOfReferenceUid: frameUid,
      spacingBetweenSlices: 1,
      physicalSlicePosition: index,
    })),
  };
}

const reference: AlignmentReference = {
  date: 'reference-examination',
  seriesUid: 'reference-series',
  sliceIndex: 1,
  sliceCount: 3,
  patientKey: 'patient-a',
  studyUid: 'study-reference-series',
  sequenceId: 'flair',
  datasetRevision: 9,
  settings: DEFAULT_PANEL_SETTINGS,
  exclusionMask: { x: 0, y: 0, width: 0.25, height: 0.25 },
};

const target: SeriesRef = {
  study_id: 'target-study',
  study_uid: 'target-study',
  series_uid: 'target-series',
  instance_count: 3,
  patient_key: 'patient-a',
  frame_of_reference_uid: 'frame-b',
};

describe('physically registered longitudinal auto-alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      manifest(seriesUid, 'patient-a', seriesUid === 'reference-series' ? 'frame-a' : 'frame-b'),
    );
    mocks.planeDrift.mockReturnValue({
      angleDegrees: 18,
      maximumThroughPlaneDriftMm: 34,
      frameRelationship: 'different',
    });
    mocks.prepare.mockResolvedValue({
      referenceSlices: [{ dsRows: 4, dsCols: 4, pixels: new Float32Array(16) }],
      targetSlices: [{ dsRows: 4, dsCols: 4, pixels: new Float32Array(16) }],
      referenceSliceIndex: 0,
      referenceSourceIndices: [1],
      targetSourceIndices: [0, 1, 2],
    });
    mocks.register3d.mockResolvedValue({
      ok: true,
      pixels: Float32Array.from({ length: 16 }, (_, index) => index + 1),
      rows: 4,
      cols: 4,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 1 },
      coverage: 0.96,
      score: 0.75,
      diagnostics: { scoreMargin: 0.023, minimumDistinguishableScoreMargin: 0.006 },
      provenance: {
        referenceFrameOfReferenceUid: 'frame-a',
        targetFrameOfReferenceUid: 'frame-b',
        frameRelationship: 'different',
        referenceSliceIndex: 0,
      },
    });
    mocks.densify.mockImplementation(async (_manifest, _reference, registration) => registration);
  });

  it('uses rigid 3D reslicing, preserves lesion exclusion, and exposes verified derived-plane provenance', async () => {
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.densify).toHaveBeenCalledTimes(1);
    const input = mocks.register3d.mock.calls[0]![0];
    expect(input.referenceExclusionMask).toBeInstanceOf(Uint8Array);
    expect(input.referenceExclusionMask[0]).toBe(1);
    expect(mocks.register2d).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      outcome: 'aligned',
      patientKey: 'patient-a',
      sequenceId: 'flair',
      datasetRevision: 9,
      evidence: { geometryMode: 'registered-3d', coverage: 0.96, planeAngleDegrees: 18, runnerUpGap: 0.023 },
      derivedFrame: {
        rows: 4,
        columns: 4,
        referenceFrameOfReferenceUid: 'frame-a',
        targetFrameOfReferenceUid: 'frame-b',
      },
    });
    expect(mocks.closeScorer).toHaveBeenCalledTimes(1);
  });

  it('abstains when a physically incompatible target belongs to a different patient', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      manifest(seriesUid, seriesUid === 'reference-series' ? 'patient-a' : 'patient-b'),
    );
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    expect(results[0]).toMatchObject({ outcome: 'incompatible-geometry' });
    expect(mocks.register3d).not.toHaveBeenCalled();
  });

  it('reports insufficient physical support without applying an invented native-plane transform', async () => {
    mocks.register3d.mockResolvedValue({
      ok: false,
      reason: 'insufficient-coverage',
      message: 'The selected plane lies outside the target volume',
    });
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    expect(results[0]).toMatchObject({ outcome: 'insufficient-overlap' });
    expect(results[0]?.derivedFrame).toBeUndefined();
    expect(mocks.register2d).not.toHaveBeenCalled();
    expect(mocks.densify).not.toHaveBeenCalled();
  });

  it('does not display a coarse sparse-stack preview when dense native-plane reconstruction fails', async () => {
    mocks.densify.mockResolvedValue({
      ok: false,
      reason: 'insufficient-coverage',
      message: 'The registered reference plane requires more native frames than its safe memory budget',
    });
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    expect(results[0]).toMatchObject({ outcome: 'insufficient-overlap' });
    expect(results[0]?.derivedFrame).toBeUndefined();
    expect(mocks.densify).toHaveBeenCalledTimes(1);
  });

  it.each(['ambiguous', 'insufficient-evidence'] as const)(
    'does not turn %s physical evidence into a persisted alignment',
    async (reason) => {
      mocks.register3d.mockResolvedValue({
        ok: false,
        reason,
        message: 'Distinct rigid poses do not have distinguishable anatomical evidence',
      });
      const { result } = renderHook(() => useAutoAlign());
      let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

      await act(async () => {
        results = await result.current.alignAllDates(
          reference,
          ['target-examination'],
          { 'target-examination': target },
          0.5,
        );
      });

      expect(results[0]).toMatchObject({ outcome: 'ambiguous' });
      expect(results[0]?.derivedFrame).toBeUndefined();
      expect(mocks.register2d).not.toHaveBeenCalled();
    },
  );

  it('isolates one worker failure and still aligns later independent examinations', async () => {
    const successfulRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    mocks.register3d
      .mockResolvedValueOnce({ ok: false, reason: 'registration-failed', message: 'Target worker failed' })
      .mockResolvedValueOnce(successfulRegistration);
    const first = { ...target, series_uid: 'first-target-series' };
    const second = { ...target, series_uid: 'second-target-series' };
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['first-examination', 'second-examination'],
        { 'first-examination': first, 'second-examination': second },
        0.5,
      );
    });

    expect(results.map((item) => item.outcome)).toEqual(['failed', 'aligned']);
    expect(results[1]?.seriesUid).toBe('second-target-series');
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
  });

  it('refuses instance-number-only geometry instead of inventing a physical mapping', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => ({
      ...manifest(seriesUid),
      geometryReliable: false,
      ordering: 'instance-number',
    }));
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      results = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    expect(results[0]).toMatchObject({ outcome: 'incompatible-geometry' });
    expect(mocks.register3d).not.toHaveBeenCalled();
  });

  it('does not discard a safely aligned plane when its informational result banner is dismissed', () => {
    setDerivedAlignmentFrame({
      date: 'target-examination',
      seriesUid: 'target-series',
      bestSliceIndex: 1,
      nmiScore: 1,
      computedSettings: DEFAULT_PANEL_SETTINGS,
      slicesChecked: 1,
      runId: 'verified-run',
      outcome: 'aligned',
      derivedFrame: {
        pixels: new Float32Array([1, 2, 3, 4]),
        rows: 2,
        columns: 2,
        sourceImageId: 'miradb:target-series-1',
      },
    });
    const { result } = renderHook(() => useAutoAlign());

    act(() => result.current.clearState());

    expect(getDerivedAlignmentFrame('target-series', 1)).not.toBeNull();
    clearDerivedAlignmentFrames();
  });
});
