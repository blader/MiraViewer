import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentReference, AlignmentResult, SeriesRef } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import * as mutualInformation from '../src/utils/mutualInformation';
import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  getDerivedAlignmentFrameForReference,
  setDerivedAlignmentFrame,
} from '../src/utils/derivedAlignmentFrame';
import { buildOutputPlaneGrid, outputGridFingerprint } from '../src/utils/outputPlaneGrid';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import type * as LongitudinalFrames from '../src/utils/svr/longitudinalFrames';
import { resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import { deferred } from './helpers/deferred';
import {
  makeTissueLabelPhantom,
  REFERENCE_CONTRAST,
  renderMovingFromFixed,
  renderTissueContrast,
} from './helpers/alignmentSynthetic';

const mocks = vi.hoisted(() => ({
  getSeriesFrameManifest: vi.fn(),
  prepare: vi.fn(),
  prepareReference: vi.fn(),
  decodeReference: vi.fn(),
  planeDrift: vi.fn(),
  register3d: vi.fn(),
  densify: vi.fn(),
  register2d: vi.fn(),
  registerAffine: vi.fn(),
  captureSlice: vi.fn(),
  loadCornerstoneImage: vi.fn(),
  createScorer: vi.fn(),
  closeScorer: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.getSeriesFrameManifest,
  MAX_DERIVED_ALIGNMENT_FRAMES: 32,
}));

vi.mock('../src/utils/cornerstoneSliceCapture', () => ({
  renderSliceToPixels: mocks.captureSlice,
}));

vi.mock('../src/utils/decodedFrame', () => ({
  loadCornerstoneImage: mocks.loadCornerstoneImage,
}));

vi.mock('../src/utils/alignmentScoringRunner', () => ({
  createAlignmentScoringRunner: mocks.createScorer,
}));

vi.mock('../src/utils/elastixRegistration', () => ({
  registerRigid2DWithElastix: mocks.register2d,
  registerAffine2DWithElastix: mocks.registerAffine,
}));

vi.mock('../src/utils/svr/longitudinalFrames', async (importOriginal) => {
  const actual = await importOriginal<typeof LongitudinalFrames>();
  return {
    getLongitudinalReferencePlane: actual.getLongitudinalReferencePlane,
    densifyLongitudinalRegistration: mocks.densify,
    prepareLongitudinalReferenceInput: mocks.prepareReference,
    decodeLongitudinalReferenceFrame: mocks.decodeReference,
    prepareLongitudinalRegistrationInput: mocks.prepare,
    measureLongitudinalPlaneDrift: mocks.planeDrift,
  };
});

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

function displayDerivedReference(
  source: ReturnType<typeof manifest>,
  options: {
    slicesChecked?: number;
    frame?: Partial<NonNullable<AlignmentResult['derivedFrame']>>;
  } = {},
) {
  const originalFrame = source.frames[2]!;
  const outputGrid = buildOutputPlaneGrid(originalFrame, { frameOfReferenceUid: source.frameOfReferenceUid });
  setDerivedAlignmentFrame({
    date: reference.date,
    seriesUid: reference.seriesUid,
    bestSliceIndex: reference.sliceIndex,
    nmiScore: 1,
    computedSettings: reference.settings,
    slicesChecked: options.slicesChecked ?? 1,
    runId: 'previously-verified',
    patientKey: 'patient-a',
    sequenceId: reference.sequenceId,
    datasetRevision: reference.datasetRevision,
    referenceSeriesUid: source.seriesUid,
    outputGrid,
    outcome: 'aligned',
    derivedFrame: {
      pixels: new Float32Array(16),
      rows: outputGrid.rows,
      columns: outputGrid.columns,
      sourceImageId: 'miradb:reference-series-1',
      referenceStudyUid: source.studyUid,
      referenceSeriesUid: source.seriesUid,
      referenceSopInstanceUid: originalFrame.sopInstanceUid,
      referenceFrameIndex: 2,
      targetStudyUid: reference.studyUid,
      targetSopInstanceUid: 'reference-series-1',
      referenceFrameOfReferenceUid: source.frameOfReferenceUid,
      targetFrameOfReferenceUid: 'selected-frame',
      outputGrid,
      ...options.frame,
    },
  });
  return { originalFrame, outputGrid };
}

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

async function configureAutomaticAlignment(size = 4) {
  const sourcePixels = renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST);
  const fixed = Float32Array.from(sourcePixels, (value, index) =>
    value > 0 ? Math.min(0.98, value + 0.04 * Math.sin(index * 0.07) + 0.025 * Math.cos((index / size) * 0.17)) : 0,
  );
  const residual = {
    A: { m00: 1.025, m01: 0.018, m10: -0.012, m11: 0.985 },
    b: { x: 3.5, y: -2.25 },
  };
  const moving = size >= 64 ? renderMovingFromFixed(fixed, size, residual) : fixed;
  const sourceManifest = (seriesUid: string) => {
    const source = manifest(seriesUid, 'patient-a', seriesUid === reference.seriesUid ? 'frame-a' : 'frame-b');
    return {
      ...source,
      frames: source.frames.map((frame) => ({
        ...frame,
        rows: size,
        columns: size,
        windowCenter: 0.5,
        windowWidth: 1,
      })),
    };
  };
  const fixedManifest = sourceManifest(reference.seriesUid);
  const informativeGrid = buildOutputPlaneGrid(fixedManifest.frames[1]!, {
    frameOfReferenceUid: fixedManifest.frameOfReferenceUid,
  });
  const informative = { dsRows: size, dsCols: size, pixels: fixed, valid: new Uint8Array(fixed.length).fill(1) };
  mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => sourceManifest(seriesUid));
  mocks.prepareReference.mockResolvedValue({
    referenceSourceIndex: 1,
    referenceSlices: [informative],
    referenceSliceIndex: 0,
    referenceSourceIndices: [1],
    outputGrid: informativeGrid,
  });
  mocks.prepare.mockResolvedValue({
    referenceSlices: [informative],
    targetSlices: [informative],
    referenceSliceIndex: 0,
    referenceSourceIndices: [1],
    targetSourceIndices: [0, 1, 2],
    outputGrid: informativeGrid,
  });
  mocks.decodeReference.mockResolvedValue(informative);
  const initial = await mocks.register3d();
  mocks.register3d.mockClear();
  mocks.register3d.mockResolvedValue({
    ...initial,
    pixels: moving,
    valid: new Uint8Array(moving.length).fill(1),
    rows: size,
    cols: size,
  });
  mocks.registerAffine.mockResolvedValue({ movingToFixed: residual, webWorker: undefined });
  mocks.densify.mockImplementation(async (_manifest, _reference, estimate, options) => ({
    ...estimate,
    pixels: moving,
    valid: new Uint8Array(moving.length).fill(1),
    rows: size,
    cols: size,
    coverage: 1,
    outputGrid: options.outputGrid,
  }));
}

async function browseAutomatically(
  engine: ReturnType<typeof useAutoAlign>,
  sliceIndex: number,
  requestKey = `view-${sliceIndex}`,
  settings = reference.settings,
  manualSliceOffset = 0,
) {
  let aligned: AlignmentResult[] = [];
  await act(async () => {
    aligned = await engine.alignAllDates(
      { ...reference, sliceIndex, settings, exclusionMask: undefined },
      ['target'],
      { target },
      sliceIndex / 2,
      { reuseRegistration: true, requestKey, targetSliceOffsets: new Map([['target', manualSliceOffset]]) },
    );
  });
  return aligned;
}

describe('physically registered longitudinal auto-alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCornerstoneImage.mockResolvedValue({ windowCenter: 0.5, windowWidth: 1 });
    mocks.captureSlice.mockImplementation(async (series: string, index: number, size: number) => ({
      pixels: Float32Array.from({ length: size * size }, (_, pixel) => (pixel % size) / Math.max(1, size - 1)),
      imageId: `miradb:${series}-${index}`,
      timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
    }));
    mocks.createScorer.mockResolvedValue({
      scoreCoarse: vi.fn(),
      scoreFine: vi.fn(),
      scoreFinal: vi.fn(),
      close: mocks.closeScorer,
    });
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

  afterEach(() => clearDerivedAlignmentFrames());

  it('estimates at an informative slab, preserves a blank browsing plane, and reuses the verified pose', async () => {
    const fixed = manifest('reference-series');
    const informativeGrid = buildOutputPlaneGrid(fixed.frames[1]!, { frameOfReferenceUid: fixed.frameOfReferenceUid });
    const informative = { dsRows: 4, dsCols: 4, pixels: Float32Array.from({ length: 16 }, (_, i) => i) };
    mocks.prepareReference.mockResolvedValue({
      referenceSourceIndex: 1,
      referenceSlices: [informative],
      referenceSliceIndex: 0,
      referenceSourceIndices: [1],
      outputGrid: informativeGrid,
    });
    mocks.prepare.mockResolvedValue({
      referenceSlices: [informative],
      targetSlices: [informative],
      referenceSliceIndex: 0,
      referenceSourceIndices: [1],
      targetSourceIndices: [0, 1, 2],
      outputGrid: informativeGrid,
    });
    mocks.decodeReference.mockResolvedValue(informative);
    mocks.captureSlice.mockImplementation(async (_series, _index, size) => ({
      pixels: new Float32Array(size * size),
      imageId: 'blank-current-plane',
      timingMs: {},
    }));
    mocks.densify.mockImplementation(async (_manifest, _reference, estimate, options) => ({
      ...estimate,
      pixels: new Float32Array(16).fill(50),
      rows: 4,
      cols: 4,
      coverage: 1,
      outputGrid: options.outputGrid,
    }));
    const { result } = renderHook(useAutoAlign);
    const run = async (sliceIndex: number, revision = reference.datasetRevision) => {
      let aligned: AlignmentResult[] = [];
      await act(async () => {
        aligned = await result.current.alignAllDates(
          { ...reference, sliceIndex, datasetRevision: revision, exclusionMask: undefined },
          ['target'],
          { target },
          sliceIndex / 2,
          { reuseRegistration: true, requestKey: `view-${sliceIndex}` },
        );
      });
      expect(aligned[0]?.outcome).toBe('aligned');
      return aligned[0]!;
    };
    const first = await run(0);
    expect(first.derivedFrame?.referenceFrameIndex).toBe(0);
    expect(first.outputGrid?.referenceSopInstanceUid).toBe('reference-series-0');
    expect(mocks.prepareReference.mock.calls[0]![2].selectInformativeReference).toBe(true);
    expect(mocks.register3d.mock.calls[0]![0].outputGrid).toEqual(informativeGrid);
    expect(mocks.densify.mock.calls[0]![3]).toMatchObject({ referenceSliceIndex: 1, refinePose: true });
    expect(mocks.densify.mock.calls[1]![3].refinePose).toBe(false);
    const next = await run(2);
    expect(next.derivedFrame?.referenceFrameIndex).toBe(2);
    expect(next.derivedFrame?.rigidTransform).toEqual(first.derivedFrame?.rigidTransform);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.densify).toHaveBeenCalledTimes(3);
    expect(mocks.densify.mock.lastCall![3].refinePose).toBe(false);
    await run(2, 10);
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
    act(() => result.current.clearRegistrationCache());
    await run(2, 10);
    expect(mocks.register3d).toHaveBeenCalledTimes(3);
  });

  it('retains the complete verified model when the requested edge plane lacks support, without displaying another plane', async () => {
    await configureAutomaticAlignment(256);
    const supportedReslice = mocks.densify.getMockImplementation()!;
    mocks.densify.mockImplementation(async (manifest, frame, estimate, options) =>
      options.outputGrid.referenceSopInstanceUid === 'reference-series-0'
        ? {
            ok: false,
            reason: 'insufficient-coverage',
            message: 'The requested edge plane is outside acquired support',
          }
        : supportedReslice(manifest, frame, estimate, options),
    );
    const { result } = renderHook(useAutoAlign);
    const [unsupported] = await browseAutomatically(result.current, 0);

    expect(unsupported).toMatchObject({
      outcome: 'insufficient-overlap',
      message: 'The requested edge plane is outside acquired support',
    });
    expect(unsupported?.derivedFrame).toBeUndefined();
    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
    expect(
      result.current.canReuseRegistration({ ...reference, sliceIndex: 2, exclusionMask: undefined }, ['target'], {
        target,
      }),
    ).toBe(true);

    const [supported] = await browseAutomatically(result.current, 2);
    expect(supported).toMatchObject({
      outcome: 'aligned',
      registrationId: unsupported?.runId,
      derivedFrame: { referenceFrameIndex: 2, displayTone: { windowCenter: 0.5, windowWidth: 1 } },
    });
    expect(supported?.computedSettings.affine01).not.toBe(0);
    expect(supported?.computedSettings.rotation).not.toBe(0);
    expect(supported?.computedSettings.brightness).toBe(reference.settings.brightness);
    expect(supported?.computedSettings.contrast).toBe(reference.settings.contrast);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
    expect(mocks.densify.mock.lastCall![3].refinePose).toBe(false);

    const [next] = await browseAutomatically(result.current, 1);
    expect(next?.registrationId).toBe(supported?.registrationId);
    expect(next?.derivedFrame?.displayTone).toBe(supported?.derivedFrame?.displayTone);
    expect(next?.computedSettings.affine01).toBe(supported?.computedSettings.affine01);
  });

  it('reslices manual corrections from one immutable pose, retaining affine and tone through browsing and undo', async () => {
    await configureAutomaticAlignment(256);
    const { result } = renderHook(useAutoAlign);
    const [initial] = await browseAutomatically(result.current, 1, 'baseline');
    expect(initial?.derivedFrame?.displayTone).toBeDefined();
    expect(initial?.computedSettings.affine01).not.toBe(0);
    act(() => setDerivedAlignmentFrame(initial!));
    const initialFrame = getDerivedAlignmentFrameForReference(target.series_uid, reference)!;
    const targetManifest = await mocks.getSeriesFrameManifest(target.series_uid);
    const stack = targetManifest.frames.map((frame: ReturnType<typeof manifest>['frames'][number], index: number) => ({
      ...getSliceGeometryFromInstance(frame),
      pixels: Float32Array.from(initial!.derivedFrame!.pixels, (value) => value + (index - 1) * 0.05),
      valid: new Uint8Array(256 * 256).fill(1),
      dsRows: 256,
      dsCols: 256,
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
      sopInstanceUid: frame.sopInstanceUid,
    }));
    const sourceSnapshots = stack.map((slice: { pixels: Float32Array }) => Array.from(slice.pixels));
    mocks.densify.mockClear();
    mocks.densify.mockImplementation(async (_manifest, _reference, estimate, options) => ({
      ...estimate,
      ...resliceStackToReferencePlane({
        targetSlices: stack,
        referenceSlice: stack[1]!,
        outputGrid: options.outputGrid,
        targetToReference: estimate.targetToReference,
        centerMm: estimate.centerMm,
      }),
    }));

    const run = async (referenceIndex: number, manualSliceOffset: number) => {
      const [aligned] = await browseAutomatically(
        result.current,
        referenceIndex,
        `view-${referenceIndex}-${manualSliceOffset}`,
        reference.settings,
        manualSliceOffset,
      );
      expect(aligned?.outcome).toBe('aligned');
      expect(aligned?.registrationId).toBe(initial?.registrationId);
      expect(aligned?.manualSliceOffset).toBe(manualSliceOffset);
      expect(aligned?.derivedFrame?.displayTone).toBe(initial?.derivedFrame?.displayTone);
      expect(aligned?.computedSettings.affine01).toBe(initial?.computedSettings.affine01);
      expect(aligned?.computedSettings.brightness).toBe(reference.settings.brightness);
      expect(aligned?.computedSettings.contrast).toBe(reference.settings.contrast);
      act(() => setDerivedAlignmentFrame(aligned!));
      return aligned!;
    };
    const plus = await run(1, 1);
    expect(plus.bestSliceIndex).toBe(2);
    expect(plus.derivedFrame?.sourceImageId).toBe('miradb:target-series-2');
    expect(plus.derivedFrame?.referenceSopInstanceUid).toBe('reference-series-1');
    expect(Array.from(plus.derivedFrame!.pixels)).toEqual(Array.from(stack[2]!.pixels));
    expect(mocks.densify).toHaveBeenCalledTimes(1);
    expect(mocks.densify.mock.lastCall![3].refinePose).toBe(false);

    const browsed = await run(0, 1);
    expect(browsed.bestSliceIndex).toBe(1);
    expect(Array.from(browsed.derivedFrame!.pixels)).toEqual(Array.from(stack[1]!.pixels));
    expect(mocks.densify.mock.lastCall![2].targetToReference.tz).toBe(-1);
    const minus = await run(1, -1);
    expect(minus.bestSliceIndex).toBe(0);
    expect(Array.from(minus.derivedFrame!.pixels)).toEqual(Array.from(stack[0]!.pixels));
    expect(mocks.densify.mock.lastCall![2].targetToReference.tz).toBe(1);

    const reslicesBeforeUndo = mocks.densify.mock.calls.length;
    const undone = await run(1, 0);
    expect(undone.derivedFrame?.pixels).toBe(initial?.derivedFrame?.pixels);
    expect(getDerivedAlignmentFrameForReference(target.series_uid, reference)?.imageId).toBe(initialFrame.imageId);
    expect(mocks.densify).toHaveBeenCalledTimes(reslicesBeforeUndo);

    await run(2, 0);
    expect(mocks.densify.mock.lastCall![2].targetToReference.tz).toBe(0);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
    expect(stack.map((slice: { pixels: Float32Array }) => Array.from(slice.pixels))).toEqual(sourceSnapshots);
  });

  it('calibrates a cold model on unadjusted anatomy before applying an existing manual correction', async () => {
    await configureAutomaticAlignment(256);
    const originalReslice = mocks.densify.getMockImplementation()!;
    mocks.densify.mockImplementation(async (...args) => {
      const dense = await originalReslice(...args);
      return args[2].targetToReference.tz === 0 ? dense : { ...dense, pixels: new Float32Array(dense.pixels.length) };
    });
    const { result } = renderHook(useAutoAlign);
    const [corrected] = await browseAutomatically(result.current, 1, 'cold-corrected', reference.settings, 1);

    expect(corrected?.outcome).toBe('aligned');
    expect(corrected?.derivedFrame?.displayTone).toBeDefined();
    expect(corrected?.computedSettings.affine01).not.toBe(0);
    expect(corrected?.derivedFrame?.pixels.every((value) => value === 0)).toBe(true);
    expect(corrected?.derivedFrame?.sourceImageId).toBe('miradb:target-series-2');
    expect(corrected?.derivedFrame?.rigidTransform?.[2]).toBe(-1);
    expect(mocks.densify).toHaveBeenCalledTimes(2);
    expect(mocks.densify.mock.calls[0]![2].targetToReference.tz).toBe(0);
    expect(mocks.densify.mock.calls[0]![3].refinePose).toBe(true);
    expect(mocks.densify.mock.calls[1]![2].targetToReference.tz).toBe(-1);
    expect(mocks.densify.mock.calls[1]![3].refinePose).toBe(false);
    expect(mocks.loadCornerstoneImage).toHaveBeenCalledWith('miradb:target-series-1');
    expect(mocks.loadCornerstoneImage).not.toHaveBeenCalledWith('miradb:target-series-2');

    const [reset] = await browseAutomatically(result.current, 1, 'reset-correction');
    expect(reset?.derivedFrame?.rigidTransform?.[2]).toBe(0);
    expect(reset?.derivedFrame?.displayTone).toBe(corrected?.derivedFrame?.displayTone);
    expect(reset?.computedSettings.affine01).toBe(corrected?.computedSettings.affine01);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
  });

  it.each(['cold', 'warm'])(
    'retains the unadjusted %s model when manual correction leaves acquired support',
    async (cache) => {
      await configureAutomaticAlignment();
      const originalReslice = mocks.densify.getMockImplementation()!;
      mocks.densify.mockImplementation(async (...args) =>
        args[2].targetToReference.tz < -1
          ? { ok: false, reason: 'insufficient-coverage', message: 'Manual plane is outside acquired support' }
          : originalReslice(...args),
      );
      const { result } = renderHook(useAutoAlign);
      if (cache === 'warm') await browseAutomatically(result.current, 1);
      const [unsupported] = await browseAutomatically(
        result.current,
        1,
        'unsupported-correction',
        reference.settings,
        20,
      );
      expect(unsupported).toMatchObject({ outcome: 'insufficient-overlap', manualSliceOffset: 20 });
      expect(unsupported?.derivedFrame).toBeUndefined();

      const [reset] = await browseAutomatically(result.current, 1, 'reset-after-unsupported');
      expect(reset).toMatchObject({ outcome: 'aligned', manualSliceOffset: 0 });
      expect(reset?.derivedFrame?.rigidTransform?.[2]).toBe(0);
      expect(mocks.register3d).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects manual through-plane correction without physical geometry instead of returning a false offset-only success', async () => {
    const { result } = renderHook(useAutoAlign);
    let aligned: AlignmentResult[] = [];
    await act(async () => {
      aligned = await result.current.alignAllDates(
        { ...reference, patientKey: undefined, studyUid: undefined },
        ['target'],
        { target },
        0.5,
        { reuseRegistration: true, targetSliceOffsets: new Map([['target', 1]]) },
      );
    });
    expect(aligned[0]).toMatchObject({ outcome: 'incompatible-geometry', manualSliceOffset: 1 });
    expect(aligned[0]?.derivedFrame).toBeUndefined();
    expect(mocks.createScorer).not.toHaveBeenCalled();
    expect(mocks.register3d).not.toHaveBeenCalled();
  });

  it('replays an exact cached plane without reslicing and only replaces its model after explicit realignment', async () => {
    await configureAutomaticAlignment();
    const { result } = renderHook(useAutoAlign);
    const [first] = await browseAutomatically(result.current, 1, 'initial-view');
    expect(first?.outcome).toBe('aligned');
    expect(first?.registrationId).toBe(first?.runId);
    act(() => setDerivedAlignmentFrame(first!));

    const [next] = await browseAutomatically(result.current, 2);
    expect(next?.registrationId).toBe(first?.registrationId);
    act(() => setDerivedAlignmentFrame(next!));
    const reslicesBeforeRevisit = mocks.densify.mock.calls.length;
    const capturesBeforeRevisit = mocks.captureSlice.mock.calls.length;
    const referenceDecodesBeforeRevisit = mocks.decodeReference.mock.calls.length;
    const [revisited] = await browseAutomatically(result.current, 1, 'revisited-view');

    expect(revisited?.registrationId).toBe(first?.registrationId);
    expect(revisited?.derivedFrame?.pixels).toBe(first?.derivedFrame?.pixels);
    expect(revisited?.runId).not.toBe(first?.runId);
    expect(revisited?.requestKey).toBe('revisited-view');
    expect(mocks.densify).toHaveBeenCalledTimes(reslicesBeforeRevisit);
    expect(mocks.captureSlice).toHaveBeenCalledTimes(capturesBeforeRevisit);
    expect(mocks.decodeReference).toHaveBeenCalledTimes(referenceDecodesBeforeRevisit);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);

    act(() => result.current.clearRegistrationCache());
    expect(
      result.current.canReuseRegistration({ ...reference, exclusionMask: undefined }, ['target'], { target }),
    ).toBe(false);
    const [realigned] = await browseAutomatically(result.current, 1, 'explicit-realignment');
    expect(realigned?.outcome).toBe('aligned');
    expect(realigned?.registrationId).not.toBe(first?.registrationId);
    expect(realigned?.registrationId).toBe(realigned?.runId);
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
    expect(mocks.densify).toHaveBeenCalledTimes(reslicesBeforeRevisit + 1);
  });

  it('refreshes accepted-model recency when browsing before evicting the least recently used pair', async () => {
    await configureAutomaticAlignment();
    const { result } = renderHook(useAutoAlign);
    const pairs = Array.from({ length: 17 }, (_, index) => ({
      date: `lru-date-${index}`,
      series: {
        ...target,
        series_uid: `lru-target-${index}`,
        study_id: `study-lru-target-${index}`,
        study_uid: `study-lru-target-${index}`,
      },
    }));
    const series = Object.fromEntries(pairs.map((pair) => [pair.date, pair.series]));
    const automaticReference = { ...reference, exclusionMask: undefined };
    const browse = async (indices: number[], sliceIndex: number, requestKey: string) => {
      let aligned: AlignmentResult[] = [];
      await act(async () => {
        aligned = await result.current.alignAllDates(
          { ...automaticReference, sliceIndex },
          indices.map((index) => pairs[index]!.date),
          series,
          sliceIndex / 2,
          { reuseRegistration: true, requestKey },
        );
      });
      expect(aligned).toHaveLength(indices.length);
      expect(aligned.every((entry) => entry.outcome === 'aligned')).toBe(true);
      return aligned;
    };

    const first = await browse(
      Array.from({ length: 16 }, (_, index) => index),
      1,
      'fill-sixteen-models',
    );
    expect(mocks.register3d).toHaveBeenCalledTimes(16);
    const [reused] = await browse([0], 2, 'reuse-oldest-model');
    expect(reused?.registrationId).toBe(first[0]!.registrationId);
    expect(mocks.register3d).toHaveBeenCalledTimes(16);
    await browse([16], 2, 'add-seventeenth-model');
    expect(mocks.register3d).toHaveBeenCalledTimes(17);

    for (let index = 0; index < pairs.length; index++)
      expect(
        result.current.canReuseRegistration(automaticReference, [pairs[index]!.date], series),
        `pair ${index}: browsing pair 0 must retain it and evict untouched pair 1`,
      ).toBe(index !== 1);
  });

  it('does not publish or resurrect a model cleared while its warm reslice is pending', async () => {
    await configureAutomaticAlignment(32);
    const { result } = renderHook(useAutoAlign);
    const [first] = await browseAutomatically(result.current, 1, 'accepted-before-cache-clear');
    expect(first?.outcome).toBe('aligned');
    act(() => setDerivedAlignmentFrame(first!));
    const original = mocks.densify.getMockImplementation()!;
    const started = deferred<void>(),
      release = deferred<void>();
    mocks.densify.mockImplementationOnce(async (...args) => {
      const plane = await original(...args);
      started.resolve();
      await release.promise;
      return plane;
    });
    const nextReference = { ...reference, sliceIndex: 2, exclusionMask: undefined };
    let pending: Promise<AlignmentResult[]> = Promise.resolve([]);
    try {
      await act(async () => {
        pending = result.current.alignAllDates(nextReference, ['target'], { target }, 1, {
          reuseRegistration: true,
          requestKey: 'cleared-during-reslice',
        });
        await started.promise;
      });
      act(() => result.current.clearRegistrationCache());
      expect(result.current.canReuseRegistration(nextReference, ['target'], { target })).toBe(false);
      let cancelled: AlignmentResult[] = [];
      await act(async () => {
        release.resolve();
        cancelled = await pending;
      });
      expect(cancelled).toEqual([]);
      expect(result.current.results).toEqual([]);
      expect(result.current.isAligning).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.canReuseRegistration(nextReference, ['target'], { target })).toBe(false);
      expect(getDerivedAlignmentFrameForReference(target.series_uid, nextReference)).toBeNull();
      expect(mocks.register3d).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        result.current.abort();
        release.resolve();
        await pending;
      });
    }
  });

  it('renders a warm physical plane without capture, registration analysis, or tone recalibration', async () => {
    await configureAutomaticAlignment(256);
    const { result } = renderHook(useAutoAlign);
    const initialSettings = { ...reference.settings, brightness: 83, contrast: 117 };
    const [first] = await browseAutomatically(result.current, 1, 'accepted-model', initialSettings);
    expect(first?.outcome).toBe('aligned');
    expect(first?.derivedFrame?.displayTone).toBeDefined();
    expect(first?.computedSettings.affine01).not.toBe(0);
    mocks.densify.mockClear();
    const forbidden = [
      mocks.captureSlice,
      mocks.prepareReference,
      mocks.prepare,
      mocks.decodeReference,
      mocks.register3d,
      mocks.registerAffine,
      mocks.loadCornerstoneImage,
      mocks.createScorer,
    ];
    for (const dependency of forbidden)
      dependency.mockClear().mockImplementation(() => {
        throw new Error('Accepted-model browsing must not wait for registration or calibration.');
      });
    const score = vi.spyOn(mutualInformation, 'computeMutualInformation').mockImplementation(() => {
      throw new Error('An accepted pose must not be rescored before its next plane can display.');
    });
    try {
      const editedSettings = { ...reference.settings, brightness: 126, contrast: 92 };
      const [next] = await browseAutomatically(result.current, 0, 'warm-corrected-plane', editedSettings, 1);
      expect(next).toMatchObject({
        outcome: 'aligned',
        requestKey: 'warm-corrected-plane',
        registrationId: first!.registrationId,
        manualSliceOffset: 1,
        bestSliceIndex: 1,
        computedSettings: { offset: 1, brightness: 126, contrast: 92 },
        derivedFrame: {
          referenceFrameIndex: 0,
          referenceSopInstanceUid: 'reference-series-0',
          sourceImageId: 'miradb:target-series-1',
          rigidTransform: [0, 0, -1, 0, 0, 0],
        },
      });
      expect(next?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
      for (const key of ['affine00', 'affine01', 'affine10', 'affine11', 'rotation', 'zoom', 'panX', 'panY'] as const)
        expect(next?.computedSettings[key]).toBe(first?.computedSettings[key]);
      expect(mocks.densify).toHaveBeenCalledTimes(1);
      expect(mocks.densify.mock.lastCall![3].refinePose).toBe(false);
      expect(mocks.densify.mock.lastCall![1]).not.toHaveProperty('pixels');
      expect(mocks.densify.mock.lastCall![1]).not.toHaveProperty('valid');
      for (const dependency of forbidden) expect(dependency).not.toHaveBeenCalled();
      expect(score).not.toHaveBeenCalled();
    } finally {
      score.mockRestore();
    }
  });

  it.each([
    'missing-grid',
    'shifted-grid',
    'invalid-grid-spacing',
    'rows',
    'columns',
    'pixel-length',
    'support-length',
    'pose-translation',
    'pose-rotation',
    'rotation-center',
  ] as const)('rejects malformed warm %s without replacing the accepted model', async (kind) => {
    await configureAutomaticAlignment(32);
    const { result } = renderHook(useAutoAlign);
    const [first] = await browseAutomatically(result.current, 1, 'accepted-before-malformed-reslice');
    expect(first?.outcome).toBe('aligned');
    act(() => setDerivedAlignmentFrame(first!));
    const accepted = getDerivedAlignmentFrameForReference(target.series_uid, reference);
    const original = mocks.densify.getMockImplementation()!;
    mocks.densify.mockImplementationOnce(async (...args) => {
      const plane = await original(...args);
      switch (kind) {
        case 'missing-grid':
          return { ...plane, outputGrid: undefined };
        case 'shifted-grid':
          return {
            ...plane,
            outputGrid: {
              ...plane.outputGrid,
              originMm: [plane.outputGrid.originMm[0], plane.outputGrid.originMm[1], plane.outputGrid.originMm[2] + 1],
            },
          };
        case 'invalid-grid-spacing':
          return { ...plane, outputGrid: { ...plane.outputGrid, rowSpacingMm: 0 } };
        case 'rows':
          return { ...plane, rows: plane.rows + 1 };
        case 'columns':
          return { ...plane, cols: plane.cols + 1 };
        case 'pixel-length':
          return { ...plane, pixels: plane.pixels.slice(1) };
        case 'support-length':
          return { ...plane, valid: plane.valid.slice(1) };
        case 'pose-translation':
          return { ...plane, targetToReference: { ...plane.targetToReference, tx: plane.targetToReference.tx + 1 } };
        case 'pose-rotation':
          return { ...plane, targetToReference: { ...plane.targetToReference, rz: plane.targetToReference.rz + 0.1 } };
        case 'rotation-center':
          return { ...plane, centerMm: { ...plane.centerMm, z: plane.centerMm.z + 1 } };
      }
    });
    const [rejected] = await browseAutomatically(result.current, 2, `malformed-${kind}`);
    expect(rejected?.outcome).toBe('incompatible-geometry');
    expect(rejected?.message).toMatch(/grid|plane|pose|geometry|support|size|shape|pixel|dimension|center|reslice/i);
    expect(rejected?.derivedFrame).toBeUndefined();
    expect(result.current.results).toEqual([rejected]);
    act(() => setDerivedAlignmentFrame(rejected!));
    expect(getDerivedAlignmentFrameForReference(target.series_uid, reference)).toBe(accepted);
    expect(
      result.current.canReuseRegistration({ ...reference, sliceIndex: 2, exclusionMask: undefined }, ['target'], {
        target,
      }),
    ).toBe(true);

    const [recovered] = await browseAutomatically(result.current, 2, `recovered-${kind}`);
    expect(recovered).toMatchObject({
      outcome: 'aligned',
      registrationId: first!.registrationId,
      manualSliceOffset: 0,
      derivedFrame: { referenceFrameIndex: 2, sourceImageId: 'miradb:target-series-2' },
    });
    expect(recovered?.derivedFrame?.rigidTransform).toEqual(first?.derivedFrame?.rigidTransform);
    expect(recovered?.derivedFrame?.rotationCenterMm).toEqual(first?.derivedFrame?.rotationCenterMm);
    expect(recovered?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.densify).toHaveBeenCalledTimes(3);
  });

  it('allows immediate mixed-target scheduling when a later target already has an accepted model', async () => {
    await configureAutomaticAlignment();
    const { result } = renderHook(useAutoAlign);
    await browseAutomatically(result.current, 1, 'accepted-before-mixed-scheduling');
    expect(
      result.current.canReuseRegistration(
        { ...reference, sliceIndex: 2, exclusionMask: undefined },
        ['cold', 'target'],
        { cold: { ...target, series_uid: 'uncached-series' }, target },
      ),
    ).toBe(true);
  });

  it.each(['capture', 'preparation'] as const)(
    'publishes a warm target while an earlier cold target is waiting for %s',
    async (phase) => {
      await configureAutomaticAlignment(32);
      const { result } = renderHook(useAutoAlign);
      const [first] = await browseAutomatically(result.current, 1, 'accepted-warm-target');
      expect(first?.outcome).toBe('aligned');
      const coldTarget = {
        ...target,
        series_uid: 'cold-target-series',
        study_id: 'study-cold-target-series',
        study_uid: 'study-cold-target-series',
      };
      const started = deferred<void>(),
        release = deferred<void>();
      const prerequisite = phase === 'capture' ? mocks.captureSlice : mocks.prepareReference;
      const original = prerequisite.getMockImplementation()!;
      prerequisite.mockImplementation(async (...args) => {
        started.resolve();
        await release.promise;
        return original(...args);
      });
      let pending: Promise<AlignmentResult[]> = Promise.resolve([]);
      try {
        await act(async () => {
          pending = result.current.alignAllDates(
            { ...reference, sliceIndex: 2, exclusionMask: undefined },
            ['cold', 'target'],
            { cold: coldTarget, target },
            1,
            { reuseRegistration: true, requestKey: `mixed-${phase}` },
          );
          await started.promise;
        });
        expect(result.current.isAligning).toBe(true);
        expect(result.current.results).toHaveLength(1);
        expect(result.current.results[0]).toMatchObject({
          date: 'target',
          outcome: 'aligned',
          registrationId: first!.registrationId,
          requestKey: `mixed-${phase}`,
          derivedFrame: { referenceFrameIndex: 2, referenceSopInstanceUid: 'reference-series-2' },
        });
        expect(result.current.results[0]?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
      } finally {
        await act(async () => {
          result.current.abort();
          release.resolve();
          await pending;
        });
      }
    },
  );

  it('does not publish an older warm reslice after a newer browsing plane has completed', async () => {
    await configureAutomaticAlignment(32);
    const { result } = renderHook(useAutoAlign);
    const [first] = await browseAutomatically(result.current, 1, 'accepted-before-scrolling');
    const original = mocks.densify.getMockImplementation()!;
    const started = deferred<AbortSignal>(),
      release = deferred<void>();
    mocks.densify.mockImplementation(async (...args) => {
      const plane = await original(...args);
      if (args[3].outputGrid.referenceSopInstanceUid === 'reference-series-0') {
        started.resolve(args[3].signal);
        await release.promise; // Deliberately finish after abort, like a late uncancellable source operation.
      }
      return plane;
    });
    let pending: Promise<AlignmentResult[]> = Promise.resolve([]);
    try {
      let oldSignal: AbortSignal | undefined;
      await act(async () => {
        pending = result.current.alignAllDates(
          { ...reference, sliceIndex: 0, exclusionMask: undefined },
          ['target'],
          { target },
          0,
          { reuseRegistration: true, requestKey: 'old-scroll-position' },
        );
        oldSignal = await started.promise;
      });
      const [latest] = await browseAutomatically(result.current, 2, 'latest-scroll-position');
      expect(latest).toMatchObject({
        outcome: 'aligned',
        registrationId: first!.registrationId,
        requestKey: 'latest-scroll-position',
        derivedFrame: { referenceFrameIndex: 2 },
      });
      expect(oldSignal?.aborted).toBe(true);
      let cancelled: AlignmentResult[] = [];
      await act(async () => {
        release.resolve();
        cancelled = await pending;
      });
      expect(cancelled).toEqual([]);
      expect(result.current.requestKey).toBe('latest-scroll-position');
      expect(result.current.results).toEqual([latest]);
      expect(result.current.isAligning).toBe(false);
      expect(result.current.error).toBeNull();
    } finally {
      await act(async () => {
        result.current.abort();
        release.resolve();
        await pending;
      });
    }
  });

  it.each([
    ['missing', undefined, undefined],
    ['different', 20, 40],
  ])(
    'calibrates from decoded windows when manifest windows are %s and retains that anchor while browsing',
    async (_label, windowCenter, windowWidth) => {
      await configureAutomaticAlignment(32);
      const getManifest = mocks.getSeriesFrameManifest.getMockImplementation()!;
      mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => {
        const source = await getManifest(seriesUid);
        return {
          ...source,
          frames: source.frames.map((frame: object) => ({ ...frame, windowCenter, windowWidth })),
        };
      });
      const referenceWindow = { windowCenter: 0.75, windowWidth: 1.5 };
      const movingWindow = { windowCenter: 1, windowWidth: 2 };
      mocks.loadCornerstoneImage.mockImplementation(async (imageId: string) =>
        imageId === 'miradb:reference-series-1'
          ? referenceWindow
          : imageId.startsWith('miradb:target-series-')
            ? movingWindow
            : { windowCenter: 0.5, windowWidth: 1 },
      );
      const { result } = renderHook(useAutoAlign);
      const [first] = await browseAutomatically(result.current, 0);
      const [next] = await browseAutomatically(result.current, 2);

      expect(first?.outcome).toBe('aligned');
      expect(first?.derivedFrame?.displayTone).toMatchObject({ ...movingWindow, referenceWindow });
      expect(first?.derivedFrame?.referenceSopInstanceUid).toBe('reference-series-0');
      expect(next?.derivedFrame?.referenceSopInstanceUid).toBe('reference-series-2');
      expect(next?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
      expect(next?.derivedFrame?.displayTone?.referenceWindow).toBe(first?.derivedFrame?.displayTone?.referenceWindow);
      expect(next?.registrationId).toBe(first?.registrationId);
    },
  );

  it('shares non-neutral reference controls exactly once with calibrated planes, including a cached revisit', async () => {
    await configureAutomaticAlignment(32);
    const { result } = renderHook(useAutoAlign);
    const initialSettings = { ...reference.settings, brightness: 83, contrast: 117 };
    const [first] = await browseAutomatically(result.current, 1, 'initial-tone', initialSettings);
    expect(first?.derivedFrame?.displayTone).toBeDefined();
    expect(first?.computedSettings).toMatchObject({ brightness: 83, contrast: 117 });
    act(() => setDerivedAlignmentFrame(first!));

    const nextSettings = { ...reference.settings, brightness: 126, contrast: 92 };
    const [next] = await browseAutomatically(result.current, 2, 'next-tone', nextSettings);
    expect(next?.computedSettings).toMatchObject({ brightness: 126, contrast: 92 });
    expect(next?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
    act(() => setDerivedAlignmentFrame(next!));
    mocks.densify.mockClear();
    mocks.register3d.mockClear();

    const editedSettings = { ...reference.settings, brightness: 113, contrast: 106 };
    const [revisited] = await browseAutomatically(result.current, 1, 'revisited-tone', editedSettings);
    expect(revisited?.computedSettings).toMatchObject({ brightness: 113, contrast: 106 });
    expect(revisited?.derivedFrame?.displayTone).toBe(first?.derivedFrame?.displayTone);
    expect(revisited?.derivedFrame?.pixels).toBe(first?.derivedFrame?.pixels);
    expect(mocks.densify).not.toHaveBeenCalled();
    expect(mocks.register3d).not.toHaveBeenCalled();
  });

  it.each(['matching', 'missing', 'different'] as const)(
    'keeps initial and cached fallback tone consistent with %s manifest windows and follows edited controls',
    async (metadataKind) => {
      const size = 32;
      await configureAutomaticAlignment(size);
      const getManifest = mocks.getSeriesFrameManifest.getMockImplementation()!;
      mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => {
        const source = await getManifest(seriesUid);
        return {
          ...source,
          frames: source.frames.map((frame: object) => ({
            ...frame,
            ...(metadataKind === 'missing'
              ? { windowCenter: undefined, windowWidth: undefined }
              : metadataKind === 'different'
                ? { windowCenter: 7, windowWidth: 10 }
                : {}),
          })),
        };
      });
      const preparation = await mocks.prepare.getMockImplementation()!();
      const flat = {
        ...preparation.referenceSlices[0],
        pixels: new Float32Array(size * size).fill(0.4),
      };
      mocks.prepare.mockResolvedValue({ ...preparation, referenceSlices: [flat] });
      const preparedReference = await mocks.prepareReference.getMockImplementation()!();
      mocks.prepareReference.mockResolvedValue({ ...preparedReference, referenceSlices: [flat] });
      const fixedValue = (pixel: number, columns: number) =>
        [0.25, 0.35, 0.5, 0.65][Math.floor(((pixel % columns) * 4) / columns)]!;
      mocks.captureSlice.mockImplementation(async (series: string, index: number, columns: number) => ({
        pixels: Float32Array.from({ length: columns * columns }, (_, pixel) => fixedValue(pixel, columns)),
        imageId: `miradb:${series}-${index}`,
        windowCenter: 0.5,
        windowWidth: 1,
        timingMs: {},
      }));
      const moving = Float32Array.from({ length: size * size }, (_, pixel) => fixedValue(pixel, size) * 0.6 + 0.1);
      const reslice = mocks.densify.getMockImplementation()!;
      mocks.densify.mockImplementation(async (...args) => ({ ...(await reslice(...args)), pixels: moving }));
      const { result } = renderHook(useAutoAlign);
      const initialSettings = { ...reference.settings, brightness: 120, contrast: 90 };
      const [first] = await browseAutomatically(result.current, 1, 'flat-calibration', initialSettings);

      expect(first?.outcome).toBe('aligned');
      expect(first?.derivedFrame?.displayTone).toBeUndefined();
      // Displayed fixed = 1.08 * fixed + .05 = 1.8 * moving - .13.
      expect(first?.computedSettings).toMatchObject({ brightness: 143, contrast: 126 });
      act(() => setDerivedAlignmentFrame(first!));
      mocks.densify.mockClear();
      mocks.register3d.mockClear();

      const [unchanged] = await browseAutomatically(result.current, 1, 'flat-calibration-revisited', initialSettings);
      expect(unchanged?.computedSettings).toEqual(first?.computedSettings);
      expect(unchanged?.derivedFrame?.pixels).toBe(first?.derivedFrame?.pixels);

      const editedSettings = { ...reference.settings, brightness: 80, contrast: 110 };
      const [revisited] = await browseAutomatically(
        result.current,
        1,
        'flat-calibration-edited-controls',
        editedSettings,
      );
      // The same native tissue now needs 1.4666... * moving - .19666....
      expect(revisited?.computedSettings).toMatchObject({ brightness: 105, contrast: 139 });
      expect(revisited?.derivedFrame?.displayTone).toBeUndefined();
      expect(revisited?.derivedFrame?.pixels).toBe(first?.derivedFrame?.pixels);
      expect(mocks.densify).not.toHaveBeenCalled();
      expect(mocks.register3d).not.toHaveBeenCalled();
    },
  );

  it.each(['calibration', 'fallback'] as const)(
    'does not cache or publish a model cancelled while its decoded %s window is loading',
    async (loadingPhase) => {
      await configureAutomaticAlignment(32);
      const nativeWindow = { windowCenter: 0.5, windowWidth: 1 };
      const pendingWindow = deferred<typeof nativeWindow>();
      const requested = deferred<void>();
      if (loadingPhase === 'fallback') {
        mocks.loadCornerstoneImage
          .mockResolvedValueOnce({ windowCenter: 0.5, windowWidth: 0 })
          .mockResolvedValueOnce(nativeWindow);
      }
      mocks.loadCornerstoneImage.mockImplementationOnce(() => {
        requested.resolve();
        return pendingWindow.promise;
      });
      const { result } = renderHook(useAutoAlign);
      let cancelled: AlignmentResult[] = [];
      await act(async () => {
        const alignment = result.current.alignAllDates(
          { ...reference, exclusionMask: undefined },
          ['target'],
          { target },
          0.5,
          { reuseRegistration: true, requestKey: 'cancel-during-calibration-window' },
        );
        await requested.promise;
        expect(mocks.register3d).toHaveBeenCalled();
        result.current.abort();
        pendingWindow.resolve(nativeWindow);
        cancelled = await alignment;
      });

      expect(cancelled).toEqual([]);
      expect(result.current.results).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isAligning).toBe(false);
      expect(
        result.current.canReuseRegistration({ ...reference, exclusionMask: undefined }, ['target'], { target }),
      ).toBe(false);
      expect(getDerivedAlignmentFrame(target.series_uid, 1)).toBeNull();
      const [next] = await browseAutomatically(result.current, 1);
      expect(next?.outcome).toBe('aligned');
      expect(next?.derivedFrame?.displayTone).toBeDefined();
      expect(mocks.register3d).toHaveBeenCalledTimes(2);
    },
  );

  it('does not retain a model cancelled during affine calibration after a browsing-plane support failure', async () => {
    await configureAutomaticAlignment(256);
    const supportedReslice = mocks.densify.getMockImplementation()!;
    mocks.densify.mockImplementation(async (manifest, frame, estimate, options) =>
      options.outputGrid.referenceSopInstanceUid === 'reference-series-0'
        ? { ok: false, reason: 'insufficient-coverage', message: 'No acquired support at this browsing plane' }
        : supportedReslice(manifest, frame, estimate, options),
    );
    const { result } = renderHook(useAutoAlign);
    const affine = mocks.registerAffine.getMockImplementation()!;
    mocks.registerAffine.mockImplementationOnce(async (...args) => {
      result.current.abort();
      return affine(...args);
    });

    expect(await browseAutomatically(result.current, 0)).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(
      result.current.canReuseRegistration({ ...reference, exclusionMask: undefined }, ['target'], { target }),
    ).toBe(false);

    const [next] = await browseAutomatically(result.current, 1);
    expect(next?.outcome).toBe('aligned');
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
    expect(mocks.registerAffine).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['invalid-geometry', 'incompatible-geometry'],
    ['insufficient-evidence', 'ambiguous'],
  ])('does not treat a %s presentation as a reusable model', async (reason, outcome) => {
    await configureAutomaticAlignment();
    const supportedReslice = mocks.densify.getMockImplementation()!;
    mocks.densify.mockImplementation(async (manifest, frame, estimate, options) =>
      options.outputGrid.referenceSopInstanceUid === 'reference-series-0'
        ? { ok: false, reason, message: 'The requested presentation is not verified' }
        : supportedReslice(manifest, frame, estimate, options),
    );
    const { result } = renderHook(useAutoAlign);

    const [failed] = await browseAutomatically(result.current, 0);
    expect(failed?.outcome).toBe(outcome);
    expect(failed?.derivedFrame).toBeUndefined();
    expect(
      result.current.canReuseRegistration({ ...reference, exclusionMask: undefined }, ['target'], { target }),
    ).toBe(false);
    expect((await browseAutomatically(result.current, 1))[0]?.outcome).toBe('aligned');
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
  });

  it('never caches malformed informative pixels when the requested browsing plane is unsupported', async () => {
    await configureAutomaticAlignment();
    mocks.densify
      .mockImplementationOnce(async (_manifest, _frame, estimate) => ({ ...estimate, pixels: new Float32Array() }))
      .mockResolvedValueOnce({ ok: false, reason: 'insufficient-coverage', message: 'No acquired support' });
    const { result } = renderHook(useAutoAlign);

    const [failed] = await browseAutomatically(result.current, 0);
    expect(failed?.outcome).toBe('incompatible-geometry');
    expect(failed?.derivedFrame).toBeUndefined();
    expect(
      result.current.canReuseRegistration({ ...reference, exclusionMask: undefined }, ['target'], { target }),
    ).toBe(false);
    expect((await browseAutomatically(result.current, 1))[0]?.outcome).toBe('aligned');
    expect(mocks.register3d).toHaveBeenCalledTimes(2);
  });

  it('keeps a selected derived reference stationary while registering against its verified displayed physical plane', async () => {
    const originalManifest = manifest('original-reference-series', 'patient-a', 'original-frame');
    const { originalFrame, outputGrid } = displayDerivedReference(originalManifest, {
      slicesChecked: 3,
      frame: {
        pixels: Float32Array.from({ length: 16 }, (_, index) => index + 1),
        valid: new Uint8Array(16).fill(1),
        rigidTransform: [0, 0, 0, 0, 0, 0],
        rotationCenterMm: [0, 0, 2],
        contributingSourceSopInstanceUids: ['reference-series-0', 'reference-series-1', 'reference-series-2'],
      },
    });
    const displayedReference = getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)!;
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      seriesUid === originalManifest.seriesUid
        ? originalManifest
        : manifest(seriesUid, 'patient-a', seriesUid === reference.seriesUid ? 'selected-frame' : 'target-frame'),
    );
    mocks.prepare.mockImplementation(async (anchorManifest, _targetManifest, anchorIndex, options) => {
      const anatomy = options.referenceAnatomy;
      const source = anatomy?.manifest ?? anchorManifest;
      const sourceIndex = anatomy?.sourceIndex ?? anchorIndex;
      return {
        referenceSlices: source.frames.map((frame: { sopInstanceUid: string }) => ({
          sopInstanceUid: frame.sopInstanceUid,
          dsRows: 4,
          dsCols: 4,
          pixels: new Float32Array(16),
        })),
        targetSlices: [{ dsRows: 4, dsCols: 4, pixels: new Float32Array(16) }],
        referenceSliceIndex: sourceIndex,
        referenceSourceIndices: [0, 1, 2],
        targetSourceIndices: [0, 1, 2],
      };
    });

    const originalAnchor: SeriesRef = {
      study_id: originalManifest.studyUid,
      study_uid: originalManifest.studyUid,
      series_uid: originalManifest.seriesUid,
      instance_count: originalManifest.frames.length,
      patient_key: 'patient-a',
      frame_of_reference_uid: 'original-frame',
    };
    const { result } = renderHook(() => useAutoAlign());
    let results: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];

    await act(async () => {
      const pending = result.current.alignAllDates(
        { ...reference, alignmentFocus: 'tumor' },
        ['original-examination', 'target-examination'],
        { 'original-examination': originalAnchor, 'target-examination': target },
        0.5,
      );
      expect(getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)?.imageId).toBe(
        displayedReference.imageId,
      );
      results = await pending;
    });

    expect(getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)?.imageId).toBe(
      displayedReference.imageId,
    );
    expect(mocks.captureSlice).not.toHaveBeenCalled();
    expect(mocks.prepareReference).toHaveBeenCalledWith(
      expect.objectContaining({ seriesUid: originalManifest.seriesUid, patientKey: 'patient-a' }),
      2,
      expect.objectContaining({ outputGrid }),
    );
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    const coarseInput = mocks.register3d.mock.calls[0]![0];
    expect(coarseInput.referenceSlices.map((slice: { sopInstanceUid: string }) => slice.sopInstanceUid)).toEqual([
      'reference-series-0',
      'reference-series-1',
      'reference-series-2',
    ]);
    const selectedCoarseReference = coarseInput.referenceSlices[coarseInput.referenceSliceIndex];
    expect(selectedCoarseReference.pixels).toEqual(displayedReference.pixels);
    expect(selectedCoarseReference.valid).toEqual(displayedReference.valid);
    expect(selectedCoarseReference.pixels).not.toBe(displayedReference.pixels);
    const denseReference = mocks.densify.mock.calls[0]![3].referenceImage;
    expect(denseReference).toMatchObject({
      rows: displayedReference.rows,
      columns: displayedReference.columns,
      outputGrid,
    });
    expect(denseReference.pixels).toEqual(displayedReference.pixels);
    expect(denseReference.valid).toEqual(displayedReference.valid);
    expect(denseReference.pixels).not.toBe(selectedCoarseReference.pixels);
    expect(mocks.prepareReference.mock.calls[0]![2].referenceAnatomy).toMatchObject({
      manifest: expect.objectContaining({ seriesUid: reference.seriesUid, patientKey: 'patient-a' }),
      sourceIndex: reference.sliceIndex,
      rigidTransform: [0, 0, 0, 0, 0, 0],
      rotationCenterMm: [0, 0, 2],
    });
    expect(mocks.densify.mock.calls[0]![3].referenceAnatomy).toEqual(
      mocks.prepareReference.mock.calls[0]![2].referenceAnatomy,
    );
    expect(mocks.densify.mock.calls[0]![3]).not.toHaveProperty('alignmentFocus');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      date: 'target-examination',
      referenceSeriesUid: originalManifest.seriesUid,
      outcome: 'aligned',
      derivedFrame: {
        referenceSeriesUid: originalManifest.seriesUid,
        referenceSopInstanceUid: originalFrame.sopInstanceUid,
      },
    });
    expect(outputGridFingerprint(results[0]!.outputGrid!)).toBe(outputGridFingerprint(displayedReference.outputGrid!));
    expect(getDerivedAlignmentFrame(originalManifest.seriesUid, 2)).toBeNull();

    const originalRegistration = await mocks.register3d();
    mocks.register3d.mockClear();
    mocks.register3d.mockResolvedValue({
      ...originalRegistration,
      pixels: new Float32Array(256 * 256).fill(1),
      rows: 256,
      cols: 256,
    });
    let resized: Awaited<ReturnType<typeof result.current.alignAllDates>> = [];
    await act(async () => {
      resized = await result.current.alignAllDates(
        reference,
        ['target-examination'],
        { 'target-examination': target },
        0.5,
        { outputMode: 'fixed-256' },
      );
    });

    expect(resized[0]?.outputGrid).toMatchObject({
      mode: 'fixed-256',
      rows: 256,
      columns: 256,
      fieldOfViewMm: displayedReference.outputGrid!.fieldOfViewMm,
      rowDirection: displayedReference.outputGrid!.rowDirection,
      columnDirection: displayedReference.outputGrid!.columnDirection,
      referenceSopInstanceUid: displayedReference.outputGrid!.referenceSopInstanceUid,
    });
    expect(getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)?.imageId).toBe(
      displayedReference.imageId,
    );
  });

  it('refuses a displayed derived reference whose acquired anchor provenance no longer matches the live patient', async () => {
    const originalManifest = manifest('original-reference-series', 'patient-b', 'original-frame');
    displayDerivedReference(originalManifest);
    const displayedImageId = getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)!.imageId;
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      seriesUid === originalManifest.seriesUid ? originalManifest : manifest(seriesUid, 'patient-a', 'selected-frame'),
    );
    const { result } = renderHook(() => useAutoAlign());

    await act(async () => {
      await expect(
        result.current.alignAllDates(reference, ['target-examination'], { 'target-examination': target }, 0.5),
      ).rejects.toThrow(/patient/i);
    });

    expect(getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex)?.imageId).toBe(displayedImageId);
    expect(mocks.register3d).not.toHaveBeenCalled();
    expect(mocks.captureSlice).not.toHaveBeenCalled();
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
    expect(mocks.captureSlice).toHaveBeenCalledTimes(1);
    expect(mocks.captureSlice.mock.calls[0]?.slice(0, 3)).toEqual(['reference-series', 1, 256]);
    expect(mocks.createScorer).not.toHaveBeenCalled();
    expect(mocks.closeScorer).not.toHaveBeenCalled();
  });

  it('enables explicit tumor-focused slice selection only after exclusion-safe coarse pose registration', async () => {
    const { result } = renderHook(() => useAutoAlign());
    await act(async () => {
      await result.current.alignAllDates(
        { ...reference, alignmentFocus: 'tumor' },
        ['target-examination'],
        { 'target-examination': target },
        0.5,
      );
    });

    const coarse = mocks.register3d.mock.calls[0]?.[0];
    expect(coarse.referenceExclusionMask).toBeInstanceOf(Uint8Array);
    expect(coarse.referenceExclusionMask[0]).toBe(1);
    expect(coarse).not.toHaveProperty('alignmentFocus');
    expect(mocks.densify.mock.calls[0]?.[3]).toMatchObject({
      alignmentFocus: 'tumor',
      referenceExclusionMask: expect.any(Uint8Array),
    });
  });

  it('keeps ordinary alignment fully exclusion-only unless tumor matching is explicitly requested', async () => {
    await runPhysicalAlignment();

    expect(mocks.register3d.mock.calls[0]?.[0]).not.toHaveProperty('alignmentFocus');
    expect(mocks.densify.mock.calls[0]?.[3]).not.toHaveProperty('alignmentFocus');
  });

  it('aligns a verified physical volume without depending on an unavailable 2D scoring worker', async () => {
    mocks.createScorer.mockRejectedValue(new Error('The independent 2D scoring worker could not start'));

    const results = await runPhysicalAlignment();

    expect(results[0]).toMatchObject({ outcome: 'aligned', evidence: { geometryMode: 'registered-3d' } });
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.createScorer).not.toHaveBeenCalled();
    expect(mocks.closeScorer).not.toHaveBeenCalled();
  });

  it('refines a native physical presentation with a structurally verified affine while preserving its acquired grid', async () => {
    const size = 256;
    const fixed = renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST);
    const residual = {
      A: { m00: 1.025, m01: 0.018, m10: -0.012, m11: 0.985 },
      b: { x: 3.5, y: -2.25 },
    };
    const moving = renderMovingFromFixed(fixed, size, residual);
    mocks.captureSlice.mockResolvedValue({
      pixels: fixed,
      validity: new Float32Array(fixed.length).fill(1),
      imageId: 'miradb:reference-series-1',
      timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
    });
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => ({
      ...manifest(seriesUid, 'patient-a', seriesUid === 'reference-series' ? 'frame-a' : 'frame-b'),
      frames: manifest(seriesUid, 'patient-a', seriesUid === 'reference-series' ? 'frame-a' : 'frame-b').frames.map(
        (frame) => ({ ...frame, rows: size, columns: size }),
      ),
    }));
    const initial = await mocks.register3d();
    mocks.register3d.mockResolvedValue({
      ...initial,
      pixels: moving,
      valid: new Uint8Array(moving.length).fill(1),
      rows: size,
      cols: size,
    });
    mocks.registerAffine.mockResolvedValue({ movingToFixed: residual, webWorker: undefined });

    const [aligned] = await runPhysicalAlignment();

    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
    expect(mocks.createScorer).not.toHaveBeenCalled();
    expect(aligned).toMatchObject({ outcome: 'aligned', evidence: { geometryMode: 'registered-3d' } });
    expect(aligned?.computedSettings.affine01).not.toBe(0);
    expect(aligned?.computedSettings.rotation).not.toBe(0);
    expect(aligned?.derivedFrame?.pixels).toBe(moving);
    expect(aligned?.derivedFrame?.outputGrid).toMatchObject({ rows: size, columns: size });
  });

  it('retains a verified physical presentation when optional final affine refinement fails', async () => {
    const size = 64;
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) => ({
      ...manifest(seriesUid, 'patient-a', seriesUid === 'reference-series' ? 'frame-a' : 'frame-b'),
      frames: manifest(seriesUid, 'patient-a', seriesUid === 'reference-series' ? 'frame-a' : 'frame-b').frames.map(
        (frame) => ({ ...frame, rows: size, columns: size }),
      ),
    }));
    const initial = await mocks.register3d();
    mocks.register3d.mockResolvedValue({
      ...initial,
      pixels: Float32Array.from({ length: size * size }, (_, index) => index + 1),
      rows: size,
      cols: size,
    });
    mocks.registerAffine.mockRejectedValue(new Error('optional affine worker unavailable'));

    const [aligned] = await runPhysicalAlignment();

    expect(mocks.registerAffine).toHaveBeenCalledTimes(1);
    expect(aligned).toMatchObject({
      outcome: 'aligned',
      computedSettings: { affine00: 1, affine01: 0, affine10: 0, affine11: 1, rotation: 0 },
    });
  });

  it('keeps an earlier physical result when a later fallback cannot start its independent 2D worker', async () => {
    const physical = { ...target, series_uid: 'physical-target-series' };
    const fallback = { ...target, series_uid: 'fallback-target-series', frame_of_reference_uid: 'frame-a' };
    mocks.getSeriesFrameManifest.mockImplementation(async (seriesUid: string) =>
      manifest(seriesUid, 'patient-a', seriesUid === 'physical-target-series' ? 'frame-b' : 'frame-a'),
    );
    mocks.planeDrift.mockImplementation((_reference, candidate) =>
      candidate.seriesUid === physical.series_uid
        ? { angleDegrees: 18, maximumThroughPlaneDriftMm: 34, frameRelationship: 'different' }
        : { angleDegrees: 0, maximumThroughPlaneDriftMm: 0, frameRelationship: 'same' },
    );
    mocks.createScorer.mockRejectedValue(new Error('The independent 2D scoring worker could not start'));

    const results = await runPhysicalAlignment({ 'physical-examination': physical, 'fallback-examination': fallback });

    expect(results.map((result) => result.outcome)).toEqual(['aligned', 'failed']);
    expect(mocks.register3d).toHaveBeenCalledTimes(1);
    expect(mocks.createScorer).toHaveBeenCalledTimes(1);
    expect(mocks.closeScorer).not.toHaveBeenCalled();
    expect(mocks.captureSlice.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['reference-series', 1, 256],
      ['reference-series', 1, 128],
    ]);
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

    expect(mocks.createScorer).toHaveBeenCalledTimes(1);
    expect(mocks.closeScorer).toHaveBeenCalledTimes(1);
    expect(mocks.captureSlice.mock.calls.slice(0, 2).map((call) => call.slice(0, 3))).toEqual([
      ['reference-series', 1, 256],
      ['reference-series', 1, 128],
    ]);
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
