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
  prepareReference: vi.fn(),
  planeDrift: vi.fn(),
  register3d: vi.fn(),
  densify: vi.fn(),
  register2d: vi.fn(),
  closeScorer: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.getSeriesFrameManifest,
  MAX_DERIVED_ALIGNMENT_FRAMES: 12,
}));

vi.mock('../src/utils/cornerstoneSliceCapture', () => ({
  renderSliceToPixels: async (series: string, index: number, size: number) => ({
    pixels: Float32Array.from({ length: size * size }, (_, pixel) => (pixel % size) / Math.max(1, size - 1)),
    imageId: `miradb:${series}-${index}`,
    timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
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
  prepareLongitudinalReferenceInput: mocks.prepareReference,
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

async function runPhysicalAlignment(
  series: Record<string, SeriesRef> = { 'target-examination': target },
  options: Parameters<ReturnType<typeof useAutoAlign>['alignAllDates']>[4] = {},
  align = renderHook(() => useAutoAlign()).result.current.alignAllDates,
) {
  let results: Awaited<ReturnType<typeof align>> = [];
  await act(async () => {
    results = await align(reference, Object.keys(series), series, 0.5, options);
  });
  return results;
}

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
    mocks.prepareReference.mockResolvedValue({
      referenceSlices: [{ dsRows: 4, dsCols: 4, pixels: new Float32Array(16) }],
      referenceSliceIndex: 0,
      referenceSourceIndices: [1],
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
    const results = await runPhysicalAlignment();

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

  it('binds the selected physical output lattice to preparation, both registration stages, and durable provenance', async () => {
    const initialRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    mocks.register3d.mockResolvedValue({
      ...initialRegistration,
      pixels: Float32Array.from({ length: 256 * 256 }, (_, index) => (index % 256) + 1),
      rows: 256,
      cols: 256,
    });
    const results = await runPhysicalAlignment(undefined, { outputMode: 'fixed-256' });

    expect(mocks.prepare.mock.calls[0]?.[3]).toMatchObject({
      outputGrid: expect.objectContaining({ mode: 'fixed-256', rows: 256, columns: 256 }),
      outputMaxDimension: 256,
    });
    expect(mocks.register3d.mock.calls[0]?.[0]).toMatchObject({
      outputGrid: expect.objectContaining({
        mode: 'fixed-256',
        rows: 256,
        columns: 256,
        rowSpacingMm: 4 / 256,
        columnSpacingMm: 4 / 256,
      }),
    });
    expect(mocks.densify.mock.calls[0]?.[3]).toMatchObject({
      outputGrid: expect.objectContaining({ mode: 'fixed-256', rows: 256, columns: 256 }),
      maxDimension: 256,
      referenceManifest: expect.objectContaining({ seriesUid: 'reference-series' }),
      referenceSliceIndex: 1,
      referenceExclusionMask: expect.any(Uint8Array),
    });
    expect(results[0]).toMatchObject({
      outcome: 'aligned',
      outputGrid: expect.objectContaining({ mode: 'fixed-256', rows: 256, columns: 256 }),
      derivedFrame: {
        rows: 256,
        columns: 256,
        outputGrid: expect.objectContaining({ mode: 'fixed-256', rowSpacingMm: 4 / 256 }),
      },
    });
  });

  it('refuses a derived presentation whose returned dimensions disagree with the operation output lattice', async () => {
    const results = await runPhysicalAlignment(undefined, { outputMode: 'fixed-256' });

    expect(results[0]).toMatchObject({ outcome: 'incompatible-geometry' });
    expect(results[0]?.derivedFrame).toBeUndefined();
  });

  it('retains valid-support, optimized-pose evidence, and every contributing native source image', async () => {
    const initialRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    const validity = new Uint8Array(16).fill(1);
    validity[15] = 0;
    mocks.register3d.mockResolvedValue({
      ...initialRegistration,
      valid: validity,
      targetToReference: { tx: 0.2, ty: -0.1, tz: 0.05, rx: 0.01, ry: -0.02, rz: 0.03 },
      contributingSourceSopInstanceUids: ['target-series-0', 'target-series-1', 'target-series-2'],
      diagnostics: {
        ...initialRegistration.diagnostics,
        retainedSampleFraction: 0.91,
        reverseRetainedSampleFraction: 0.88,
        effectiveSampleCount: 744,
        inverseConsistencyErrorMm: 0.12,
      },
    });
    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({
      outcome: 'aligned',
      evidence: {
        forwardAnatomicalSupport: 0.91,
        reverseAnatomicalSupport: 0.88,
        outputPlaneSupport: 0.96,
        effectiveSampleCount: 744,
        inverseConsistencyError: 0.12,
        translationMm: [0.2, -0.1, 0.05],
      },
      derivedFrame: {
        valid: validity,
        contributingSourceSopInstanceUids: ['target-series-0', 'target-series-1', 'target-series-2'],
      },
    });
    expect(results[0]?.evidence?.outputGridFingerprint).toEqual(expect.any(String));
    expect(results[0]?.evidence?.rotationDegrees?.[0]).toBeCloseTo(0.01 * (180 / Math.PI));
  });

  it('preserves lesion exclusion for native refinement after the coarse worker transfers its mask', async () => {
    const successfulRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    mocks.register3d.mockImplementation(async (input: { referenceExclusionMask: Uint8Array }) => {
      structuredClone(input.referenceExclusionMask, { transfer: [input.referenceExclusionMask.buffer] });
      return successfulRegistration;
    });
    await runPhysicalAlignment();

    const nativeRefinementMask = mocks.densify.mock.calls[0]?.[3]?.referenceExclusionMask as Uint8Array;
    expect(nativeRefinementMask.byteLength).toBe(16);
    expect(nativeRefinementMask[0]).toBe(1);
  });

  it('publishes the validated native-slab pose instead of the superseded coarse-volume pose', async () => {
    mocks.densify.mockImplementation(async (_manifest, _reference, registration) => ({
      ...registration,
      targetToReference: { tx: 0.125, ty: -0.075, tz: 0.05, rx: 0, ry: 0, rz: 0.001 },
      nativeRefinement: {
        score: 0.94,
        forwardCoverage: 0.97,
        reverseCoverage: 0.96,
        sampleCount: 816,
        heldOutSampleCount: 120,
        effectiveIndependentSamples: 204,
        heldOutEffectiveIndependentSamples: 98,
        optimizedAlternativeCount: 1,
        scoreMargin: 0.041,
        minimumDistinguishableScoreMargin: 0.012,
        translationStepMm: 0.1,
        rotationStepRadians: 0.001,
        evaluations: 40,
      },
    }));
    const results = await runPhysicalAlignment();

    expect(mocks.register3d.mock.calls[0]?.[0]).toMatchObject({ deferPresentationValidation: true });
    expect(results[0]).toMatchObject({
      outcome: 'aligned',
      evidence: {
        structuralScore: 0.94,
        runnerUpGap: 0.041,
        forwardAnatomicalSupport: 0.97,
        reverseAnatomicalSupport: 0.96,
        effectiveSampleCount: 816,
        heldOutSampleCount: 120,
        effectiveIndependentSamples: 204,
        heldOutEffectiveIndependentSamples: 98,
        minimumDistinguishableScoreMargin: 0.012,
        translationMm: [0.125, -0.075, 0.05],
      },
      derivedFrame: { rigidTransform: [0.125, -0.075, 0.05, 0, 0, 0.001] },
    });
  });

  it('retains the optimized coarse rival when native refinement needs only its unambiguous winner', async () => {
    mocks.densify.mockImplementation(async (_manifest, _reference, registration) => ({
      ...registration,
      nativeRefinement: {
        score: 0.94,
        forwardCoverage: 0.97,
        reverseCoverage: 0.96,
        sampleCount: 816,
        effectiveIndependentSamples: 204,
        heldOutEffectiveIndependentSamples: 98,
        optimizedAlternativeCount: 0,
        scoreMargin: 0,
        minimumDistinguishableScoreMargin: 0.012,
        translationStepMm: 0.1,
        rotationStepRadians: 0.001,
        evaluations: 40,
      },
    }));
    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({
      outcome: 'aligned',
      evidence: {
        structuralScore: 0.94,
        runnerUpGap: 0.023,
        minimumDistinguishableScoreMargin: 0.006,
      },
    });
  });

  it('keeps unsupported derived-plane values out of normalization, image quality, and display matching', async () => {
    const initialRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    const validity = new Uint8Array(16).fill(1);
    validity[15] = 0;
    const { result } = renderHook(() => useAutoAlign());

    const alignWithInvalidValue = async (invalidValue: number) => {
      const pixels = Float32Array.from(initialRegistration.pixels);
      pixels[15] = invalidValue;
      mocks.register3d.mockResolvedValue({ ...initialRegistration, pixels, valid: validity });
      const results = await runPhysicalAlignment(undefined, undefined, result.current.alignAllDates);
      return results[0]!;
    };

    const negativePadding = await alignWithInvalidValue(-100_000);
    const positivePadding = await alignWithInvalidValue(100_000);

    expect(negativePadding.outcome).toBe('aligned');
    expect(positivePadding.nmiScore).toBeCloseTo(negativePadding.nmiScore, 8);
    expect(positivePadding.computedSettings.brightness).toBe(negativePadding.computedSettings.brightness);
    expect(positivePadding.computedSettings.contrast).toBe(negativePadding.computedSettings.contrast);
  });

  it('refuses an otherwise supported derived plane when acquired anatomy is missing inside the lesion region', async () => {
    const initialRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    const validity = new Uint8Array(16).fill(1);
    validity[0] = 0;
    mocks.register3d.mockResolvedValue({ ...initialRegistration, valid: validity, coverage: 15 / 16 });
    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({ outcome: 'insufficient-overlap', message: expect.stringMatching(/lesion/i) });
    expect(results[0]?.derivedFrame).toBeUndefined();
  });

  it('abstains when a physically incompatible target belongs to a different patient', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      manifest(seriesUid, seriesUid === 'reference-series' ? 'patient-a' : 'patient-b'),
    );
    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({ outcome: 'incompatible-geometry' });
    expect(mocks.register3d).not.toHaveBeenCalled();
  });

  it('routes on local target acquired-center spacing instead of the unrelated reference slice thickness', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => {
      const source = manifest(seriesUid, 'patient-a', 'shared-frame');
      const spacing = seriesUid === 'reference-series' ? 8 : 4;
      return {
        ...source,
        sliceSpacingMm: spacing,
        frames: source.frames.map((frame) => ({ ...frame, spacingBetweenSlices: spacing, sliceThickness: spacing })),
      };
    });
    mocks.planeDrift.mockReturnValue({
      angleDegrees: 1,
      maximumThroughPlaneDriftMm: 2.4,
      frameRelationship: 'same',
    });
    await runPhysicalAlignment({ 'target-examination': { ...target, frame_of_reference_uid: 'shared-frame' } });

    expect(mocks.register3d).toHaveBeenCalledTimes(1);
  });

  it('calibrates same-frame rigid registration with independent reference and target physical analysis spacings', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => {
      const source = manifest(seriesUid, 'patient-a', 'shared-frame');
      const spacing = seriesUid === 'reference-series' ? '0.4\\0.8' : '0.5\\1.2';
      return { ...source, frames: source.frames.map((frame) => ({ ...frame, pixelSpacing: spacing })) };
    });
    mocks.planeDrift.mockReturnValue({
      angleDegrees: 0,
      maximumThroughPlaneDriftMm: 0,
      frameRelationship: 'same',
    });
    mocks.register2d.mockResolvedValue({
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      movingToFixed: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 0 } },
      quality: { mi: 1, nmi: 1 },
    });
    await runPhysicalAlignment({ 'target-examination': { ...target, frame_of_reference_uid: 'shared-frame' } });

    expect(mocks.register2d.mock.calls[0]?.[3]).toMatchObject({
      fixedPixelSpacing: [(4 * 0.4) / 256, (4 * 0.8) / 256],
      movingPixelSpacing: [(4 * 0.5) / 256, (4 * 1.2) / 256],
    });
  });

  it('reports insufficient physical support without applying an invented native-plane transform', async () => {
    mocks.register3d.mockResolvedValue({
      ok: false,
      reason: 'insufficient-coverage',
      message: 'The selected plane lies outside the target volume',
    });
    const results = await runPhysicalAlignment();

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
    const results = await runPhysicalAlignment();

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
      const results = await runPhysicalAlignment();

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
    const results = await runPhysicalAlignment({ 'first-examination': first, 'second-examination': second });

    expect(results.map((item) => item.outcome)).toEqual(['failed', 'aligned']);
    expect(results[1]?.seriesUid).toBe('second-target-series');
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
    expect(mocks.prepareReference).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls[0]?.[3]?.preparedReference).toBe(
      mocks.prepare.mock.calls[1]?.[3]?.preparedReference,
    );
  });

  it('refuses instance-number-only geometry instead of inventing a physical mapping', async () => {
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => ({
      ...manifest(seriesUid),
      geometryReliable: false,
      ordering: 'instance-number',
    }));
    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({ outcome: 'incompatible-geometry' });
    expect(mocks.register3d).not.toHaveBeenCalled();
    expect(mocks.prepareReference).not.toHaveBeenCalled();
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
