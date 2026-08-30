import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { createRef, useEffect, useImperativeHandle, useMemo, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cornerstone from 'cornerstone-core';
import { DicomViewer } from '../src/components/DicomViewer';
import { AlignedBrowsingContext } from '../src/hooks/useAlignedFrame';
import { useComparisonAlignment } from '../src/hooks/useComparisonAlignment';
import { usePanelSettings } from '../src/hooks/usePanelSettings';
import type { ComparisonData, PanelSettings, SeriesRef } from '../src/types/api';
import { DEFAULT_ALIGNMENT_ADJUSTMENT, applyAlignmentAdjustment } from '../src/utils/alignmentAdjustment';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { RenderedSlice } from '../src/utils/cornerstoneSliceCapture';
import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrameByImageId,
  type DerivedAlignmentFrame,
} from '../src/utils/derivedAlignmentFrame';
import { createDerivedImagePresentation, type DerivedImagePresentation } from '../src/utils/derivedImagePresentation';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { getProgressFromSlice, getSliceIndex } from '../src/utils/math';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import * as longitudinalFrames from '../src/utils/svr/longitudinalFrames';
import {
  resliceStackToReferencePlane,
  type LongitudinalReferencePlane,
  type LongitudinalRegistrationEstimate,
} from '../src/utils/svr/longitudinalRegistration';
import { deferred } from './helpers/deferred';

const mocks = vi.hoisted(() => ({
  manifest: vi.fn(),
  settings: vi.fn(),
  capture: vi.fn(),
  nativeImage: vi.fn(),
  prepareReference: vi.fn(),
  prepare: vi.fn(),
  decodeReference: vi.fn(),
  register: vi.fn(),
  densify: vi.fn(),
}));
vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.manifest,
  getPanelSettings: mocks.settings,
  savePanelSettings: vi.fn(async () => {}),
  clearPersistedDerivedAlignmentFrames: vi.fn(async () => {}),
  getImageIdForInstance: vi.fn(async (series: string, index: number) => `miradb:${series}-${index}`),
  MAX_DERIVED_ALIGNMENT_FRAMES: 32,
}));
vi.mock('../src/utils/cornerstoneSliceCapture', () => ({ renderSliceToPixels: mocks.capture }));
vi.mock('../src/utils/decodedFrame', () => ({
  loadCornerstoneImage: (imageId: string) => cornerstone.loadImage(imageId),
}));
vi.mock('../src/utils/svr/runLongitudinalRegistration', () => ({ runLongitudinalRegistration: mocks.register }));
vi.mock('../src/utils/svr/longitudinalFrames', async (importOriginal) => ({
  ...(await importOriginal<typeof longitudinalFrames>()),
  prepareLongitudinalReferenceInput: mocks.prepareReference,
  prepareLongitudinalRegistrationInput: mocks.prepare,
  decodeLongitudinalReferenceFrame: mocks.decodeReference,
  densifyLongitudinalRegistration: mocks.densify,
  measureLongitudinalPlaneDrift: () => ({
    angleDegrees: 3,
    maximumThroughPlaneDriftMm: 2,
    frameRelationship: 'different',
  }),
}));
vi.mock('cornerstone-core', () => ({
  default: {
    enable: vi.fn(),
    disable: vi.fn(),
    loadImage: vi.fn(async (imageId: string) => {
      const frame = getDerivedAlignmentFrameByImageId(imageId);
      return frame ? createDerivedImagePresentation(frame, imageId) : mocks.nativeImage(imageId);
    }),
    displayImage: vi.fn(),
    getDefaultViewportForImage: vi.fn(() => ({})),
    resize: vi.fn(),
  },
}));

function manifest(seriesUid: string): SeriesFrameManifest {
  const reference = seriesUid === 'reference';
  return {
    seriesUid,
    studyUid: `study-${seriesUid}`,
    patientKey: 'synthetic-patient',
    frameOfReferenceUid: `space-${seriesUid}`,
    geometryReliable: true,
    ordering: 'physical',
    frames: Array.from({ length: 7 }, (_, index) => ({
      sopInstanceUid: `${seriesUid}-${index}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: `study-${seriesUid}`,
      instanceNumber: index + 1,
      rows: reference ? 4 : 6,
      columns: reference ? 4 : 6,
      imagePositionPatient: `${reference ? 0 : -1}\\${reference ? 0 : -1}\\${index}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      spacingBetweenSlices: 1,
      physicalSlicePosition: index,
      frameOfReferenceUid: `space-${seriesUid}`,
      windowCenter: 0.5,
      windowWidth: 1,
    })),
  };
}
const sources = Object.fromEntries(['reference', 'cold', 'warm'].map((id) => [id, manifest(id)]));
const series: Record<string, SeriesRef> = Object.fromEntries(
  Object.entries(sources).map(([id, source]) => [
    id,
    {
      study_id: source.studyUid,
      series_uid: id,
      instance_count: source.frames.length,
      rows: source.frames[0]!.rows,
      columns: source.frames[0]!.columns,
    },
  ]),
);
const data: ComparisonData = {
  planes: ['Axial'],
  sequences: [],
  dates: ['reference', 'cold', 'warm'],
  selected_patient_key: 'synthetic-patient',
  dataset_revision: 1,
  series_map: { synthetic: series },
};
const adjustment = {
  ...DEFAULT_ALIGNMENT_ADJUSTMENT,
  sliceOffset: 1,
  brightness: 7,
  contrast: -4,
  panX: 0.1,
  panY: -0.05,
  rotation: -1,
  zoom: 1.2,
};
const referenceSettings: PanelSettings = {
  ...DEFAULT_PANEL_SETTINGS,
  progress: 1 / 6,
  brightness: 111,
  contrast: 89,
  zoom: 1.07,
  rotation: 2,
  panX: 0.03,
  panY: 0.02,
  affine00: 1.04,
  affine01: 0.01,
  affine10: -0.02,
  affine11: 0.98,
};
const estimate: LongitudinalRegistrationEstimate = {
  ok: true,
  targetToReference: { tx: 0.2, ty: -0.15, tz: 0.1, rx: 0.02, ry: -0.01, rz: 0.03 },
  centerMm: { x: 1.5, y: 1.5, z: 2 },
  score: 0.8,
  diagnostics: {
    rawScore: 0.8,
    retainedSampleFraction: 1,
    reverseRetainedSampleFraction: 1,
    sampledTargetCount: 16,
    effectiveSampleCount: 16,
    evaluatedCandidates: 1,
    optimizedHypothesisCount: 1,
    optimizedAlternativeCount: 0,
    referenceVoxelSizeMm: 1,
    angleDifferenceDeg: 3,
    scoreMargin: 0.1,
    minimumDistinguishableScoreMargin: 0.01,
    inverseScoreGap: 0,
    referenceIntensityVariance: 0.02,
    targetIntensityVariance: 0.02,
    presentationSourceFrameCount: 7,
    presentationSliceSpacingMm: 1,
  },
  provenance: {
    referenceFrameOfReferenceUid: 'space-reference',
    targetFrameOfReferenceUid: 'space-warm',
    frameRelationship: 'different',
    referenceSliceIndex: 1,
  },
};
function sourceSlice(source: SeriesFrameManifest, index: number) {
  const frame = source.frames[index]!;
  return {
    ...longitudinalFrames.getLongitudinalReferencePlane(source, index, 6),
    pixels: Float32Array.from(
      { length: frame.rows * frame.columns },
      (_, pixel) => 0.1 + index * 0.05 + Math.floor(pixel / frame.columns) * 0.03 + (pixel % frame.columns) * 0.02,
    ),
    valid: new Uint8Array(frame.rows * frame.columns).fill(1),
  };
}
type DensifyOptions = NonNullable<Parameters<typeof longitudinalFrames.densifyLongitudinalRegistration>[3]>;
function reslice(
  source: SeriesFrameManifest,
  plane: LongitudinalReferencePlane,
  pose: LongitudinalRegistrationEstimate,
  options: DensifyOptions,
) {
  return {
    ...pose,
    ...resliceStackToReferencePlane({
      targetSlices: source.frames.map((_, index) => sourceSlice(source, index)),
      referenceSlice: plane,
      targetToReference: pose.targetToReference,
      centerMm: pose.centerMm,
      outputGrid: options.outputGrid,
    }),
    outputGrid: options.outputGrid,
  };
}

type HarnessHandle = {
  alignment: ReturnType<typeof useComparisonAlignment>;
  panel: ReturnType<typeof usePanelSettings>;
};
function Comparison({
  sliceIndex,
  includeCold = false,
  ref,
}: {
  sliceIndex: number;
  includeCold?: boolean;
  ref: Ref<HarnessHandle>;
}) {
  const panel = usePanelSettings('synthetic', 'cold,reference,warm', 'synthetic-patient', false, series);
  const { setProgress, settingsReady } = panel;
  useEffect(() => {
    if (settingsReady) setProgress(sliceIndex / 6);
  }, [setProgress, settingsReady, sliceIndex]);
  const columns = useMemo(
    () =>
      (includeCold ? ['reference', 'cold', 'warm'] : ['reference', 'warm']).map((date) => ({
        date,
        ref: series[date]!,
      })),
    [includeCold],
  );
  const alignment = useComparisonAlignment({
    panel,
    data,
    sequenceId: 'synthetic',
    columns,
    viewportSize: 512,
    outputMode: 'native',
    enabled: true,
  });
  useImperativeHandle(ref, () => ({ alignment, panel }));
  return (
    <AlignedBrowsingContext.Provider value={alignment.browsing}>
      {columns.map(({ date, ref: scan }) => {
        const settings = panel.panelSettings.get(date) ?? DEFAULT_PANEL_SETTINGS;
        return (
          <section key={date} data-testid={date}>
            <DicomViewer
              {...settings}
              studyId={scan.study_id}
              seriesUid={scan.series_uid}
              instanceCount={scan.instance_count}
              instanceIndex={getSliceIndex(scan.instance_count, panel.progress, settings.offset)}
              onInstanceChange={(index) =>
                panel.setProgress(getProgressFromSlice(index, scan.instance_count, settings.offset))
              }
            />
          </section>
        );
      })}
    </AlignedBrowsingContext.Provider>
  );
}
function displayed(date: string) {
  const call = vi
    .mocked(cornerstone.displayImage)
    .mock.calls.findLast((call: unknown[]) => (call[0] as HTMLElement).closest(`[data-testid="${date}"]`));
  expect(call, `no displayed image for ${date}`).toBeDefined();
  const image = call![1] as unknown as DerivedImagePresentation;
  return {
    image,
    frame: image.derivedSource?.deref() as DerivedAlignmentFrame | undefined,
    element: call![0] as HTMLElement,
  };
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('comparison aligned-pixel browsing while cold alignment is pending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDerivedAlignmentFrames();
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    mocks.manifest.mockImplementation(async (id: string) => sources[id]);
    mocks.settings.mockResolvedValue({
      reference: referenceSettings,
      warm: { ...applyAlignmentAdjustment(DEFAULT_PANEL_SETTINGS, adjustment), offset: 1, progress: 1 / 6 },
      cold: { ...DEFAULT_PANEL_SETTINGS, progress: 1 / 6 },
    });
    mocks.nativeImage.mockImplementation(async (imageId: string) => {
      const [id, index] = imageId.replace('miradb:', '').split('-');
      const source = sources[id!]!;
      const slice = sourceSlice(source, Number(index));
      return {
        imageId,
        rows: slice.dsRows,
        columns: slice.dsCols,
        width: slice.dsCols,
        height: slice.dsRows,
        windowCenter: 0.5,
        windowWidth: 1,
        slope: 1,
        intercept: 0,
        getPixelData: () => slice.pixels,
      };
    });
    mocks.capture.mockImplementation(async (_id: string, index: number, size: number) => ({
      pixels: Float32Array.from(
        { length: size * size },
        (_, pixel) => 0.1 + index * 0.05 + ((pixel % size) / size) * 0.15,
      ),
      imageId: `miradb:reference-${index}`,
      windowCenter: 0.5,
      windowWidth: 1,
      timingMs: { getImageId: 0, loadImage: 0, capture: 0, total: 0 },
    }));
    const fixed = sourceSlice(sources.reference!, 1);
    const outputGrid = buildOutputPlaneGrid(sources.reference!.frames[1]!, { frameOfReferenceUid: 'space-reference' });
    mocks.prepareReference.mockResolvedValue({
      referenceSourceIndex: 1,
      referenceSliceIndex: 0,
      referenceSlices: [fixed],
      referenceSourceIndices: [1],
      outputGrid,
    });
    mocks.prepare.mockResolvedValue({
      referenceSliceIndex: 0,
      referenceSlices: [fixed],
      targetSlices: sources.warm!.frames.map((_, index) => sourceSlice(sources.warm!, index)),
      referenceSourceIndices: [1],
      targetSourceIndices: [0, 1, 2, 3, 4, 5, 6],
      outputGrid,
    });
    mocks.decodeReference.mockImplementation(async (source: SeriesFrameManifest, index: number) =>
      sourceSlice(source, index),
    );
    mocks.register.mockResolvedValue(estimate);
    mocks.densify.mockImplementation(async (...args: Parameters<typeof reslice>) => reslice(...args));
  });
  afterEach(() => {
    cleanup();
    clearDerivedAlignmentFrames();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('advances exact transformed pixels ahead of cold capture, replays cached planes, and rejects a late older reslice', async () => {
    const handle = createRef<HarnessHandle>();
    const { rerender, getByTestId } = render(<Comparison ref={handle} sliceIndex={1} />);
    await tick();
    await tick(650);
    const first = displayed('warm');
    expect(first.frame?.referenceFrameIndex).toBe(1);
    expect(first.frame?.manualSliceOffset).toBe(1);
    expect(first.frame?.displayTone).toBeDefined();
    expect(first.element.parentElement!.style.filter).toBe('brightness(1.18) contrast(0.85)');
    expect(first.element.parentElement!.style.transform).toContain('matrix(1.04, -0.02, 0.01, 0.98, 0, 0)');
    const transform = first.element.parentElement!.style.transform;
    const firstRenderedPixels = Array.from(first.image.getPixelData());
    const acceptedOffset = handle.current!.panel.panelSettings.get('warm')!.offset;
    expect(acceptedOffset).toBe(1);

    // The expensive reference capture cannot complete. A cold target also precedes
    // the warm one in the visible order; neither may hold up its accepted-pose reslice.
    const coldCapture = deferred<RenderedSlice>();
    mocks.capture.mockReturnValue(coldCapture.promise);
    mocks.capture.mockClear();
    mocks.densify.mockClear();
    const displaysAfterAcceptance = vi.mocked(cornerstone.displayImage).mock.calls.length;
    rerender(<Comparison ref={handle} sliceIndex={1} includeCold />);
    expect(handle.current!.panel.progress).toBe(1 / 6);
    fireEvent.wheel(within(getByTestId('reference')).getByRole('button', { name: 'Pan MRI slice 2' }), {
      deltaY: 1,
    });
    expect(handle.current!.panel.progress).toBe(2 / 6);
    await tick();
    const next = displayed('warm');
    expect(displayed('reference').image.imageId).toBe('miradb:reference-2');
    expect(next.frame?.referenceFrameIndex).toBe(2);
    expect(next.frame?.pixels).not.toBe(first.frame!.pixels);
    expect(Array.from(next.image.getPixelData())).not.toEqual(firstRenderedPixels);
    expect(next.frame?.rigidTransform).toEqual(first.frame!.rigidTransform);
    expect(next.frame?.rotationCenterMm).toEqual(first.frame!.rotationCenterMm);
    expect(next.frame?.displayTone).toEqual(first.frame!.displayTone);
    expect(next.element.parentElement!.style.transform).toBe(transform);
    expect(next.element.parentElement!.style.filter).toBe('brightness(1.18) contrast(0.85)');
    expect(handle.current!.panel.panelSettings.get('warm')!.offset).toBe(acceptedOffset);
    expect(handle.current!.panel.panelSettings.get('warm')!.alignmentAdjustment).toEqual(adjustment);
    expect(handle.current!.alignment.isAligning).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.densify).toHaveBeenCalledOnce();
    expect(mocks.densify.mock.lastCall![3].refinePose).toBe(false);
    const subsequentWarmImages = vi
      .mocked(cornerstone.displayImage)
      .mock.calls.slice(displaysAfterAcceptance)
      .filter((call: unknown[]) => (call[0] as HTMLElement).closest('[data-testid="warm"]'));
    expect(subsequentWarmImages.length).toBeGreaterThan(0);
    for (const [, image] of subsequentWarmImages)
      expect((image as unknown as DerivedImagePresentation).derivedSource).toBeDefined();
    await tick(650);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(handle.current!.alignment.isAligning).toBe(true);
    expect(displayed('warm').image).toBe(next.image);

    // Revisit needs neither analysis nor a second native reslice: the exact original
    // array is presented again, with the same manually adjusted transform and tone.
    const reslices = mocks.densify.mock.calls.length;
    fireEvent.wheel(within(getByTestId('reference')).getByRole('button', { name: 'Pan MRI slice 3' }), {
      deltaY: -1,
    });
    expect(handle.current!.panel.progress).toBe(1 / 6);
    await tick();
    expect(displayed('warm').frame?.pixels).toBe(first.frame!.pixels);
    expect(Array.from(displayed('warm').image.getPixelData())).toEqual(firstRenderedPixels);
    expect(displayed('warm').element.parentElement!.style.transform).toBe(transform);
    expect(mocks.densify).toHaveBeenCalledTimes(reslices);

    // A genuinely asynchronous older plane returns after the newest one has been
    // applied. Its result must never roll back the published frame or display packet.
    const oldPlane = deferred<ReturnType<typeof reslice>>();
    let oldResult: ReturnType<typeof reslice> | undefined;
    mocks.densify.mockImplementation(async (...args: Parameters<typeof reslice>) => {
      const result = reslice(...args);
      if (args[3].outputGrid?.referenceSopInstanceUid === 'reference-3') {
        oldResult = result;
        return oldPlane.promise;
      }
      return result;
    });
    rerender(<Comparison ref={handle} sliceIndex={3} includeCold />);
    await tick();
    expect(oldResult).toBeDefined();
    rerender(<Comparison ref={handle} sliceIndex={0} includeCold />);
    await tick();
    const latest = displayed('warm');
    expect(latest.frame?.referenceFrameIndex).toBe(0);
    const latestSettings = handle.current!.panel.panelSettings.get('warm');
    const displayCount = vi.mocked(cornerstone.displayImage).mock.calls.length;
    await act(async () => {
      oldPlane.resolve(oldResult!);
    });
    await tick();
    expect(displayed('warm').image).toBe(latest.image);
    expect(handle.current!.panel.panelSettings.get('warm')).toBe(latestSettings);
    expect(vi.mocked(cornerstone.displayImage).mock.calls).toHaveLength(displayCount);
    expect(latest.element.parentElement!.style.transform).toBe(transform);
    expect(handle.current!.alignment.results.some((result) => result.derivedFrame?.referenceFrameIndex === 3)).toBe(
      false,
    );
  });
});
