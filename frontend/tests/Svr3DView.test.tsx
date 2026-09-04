import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonData } from '../src/types/api';
import type { SvrLabelVolume, SvrProgress, SvrResult, SvrVolume } from '../src/types/svr';
import { DEFAULT_SVR_PARAMS } from '../src/types/svr';
import { useSvrImaging } from '../src/components/svrImagingContext';
import type * as DerivedAlignmentFrames from '../src/utils/derivedAlignmentFrame';
import type * as ReconstructionHooks from '../src/hooks/useSvrReconstruction';
import type * as DecodedFrames from '../src/utils/decodedFrame';
import type * as InteractiveAdmission from '../src/utils/segmentation/interactiveAdmission';
import {
  estimateInteractiveSelectionMemory,
  interactiveSelectionBudgetBytes,
} from '../src/utils/segmentation/interactiveAdmission';
import type { EnhancementSourceLoader } from '../src/utils/svr/superResolutionRegion';
import type { SelectionProposer } from '../src/utils/segmentation/selectionProposal';
import { planInteractiveSelectionContext } from '../src/utils/svr/interactiveSelectionContext';
import { createNativeSourceContext } from '../src/utils/svr/nativeSourceContext';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import {
  assembleNativeVolume,
  nativePlaneMemoryBytes,
  planNativeVolume,
  retainedSvrVolumeBytes,
} from '../src/utils/svr/nativeVolume';
import { regionalRefinementParameters, selectionFocusRoi } from '../src/utils/svr/refineRegion';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import { deferred } from './helpers/deferred';

const mocks = vi.hoisted(() => ({
  cacheInfo: vi.fn(),
  cachedImages: [] as {
    imageId: string;
    sizeInBytes: number;
    timeStamp: number;
    loaded: boolean;
    image?: { imageId: string; getPixelData?: () => Uint8Array };
    imageLoadObject?: object;
  }[],
  removeCachedImage: vi.fn(),
  cachedImageLoadObject: vi.fn(),
  enabledElements: vi.fn(),
  retainedAlignmentBytes: vi.fn(),
  manifests: vi.fn(),
  previewImage: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  reconstruct: vi.fn(),
  useReconstruction: vi.fn(),
  enhancementLoader: vi.fn(),
  refinementLoader: vi.fn(),
  selectionProposer: vi.fn(),
  operations: vi.fn(),
  admitSelection: vi.fn(),
  proposeSelection: vi.fn(),
  decodedFrame: vi.fn(),
  hook: {
    status: 'idle' as 'idle' | 'running' | 'ready' | 'failed' | 'canceled' | 'canceling',
    isRunning: false,
    progress: null as SvrProgress | null,
    result: null as SvrResult | null,
    resultIdentity: null as string | null,
    error: null as string | null,
  },
}));

// This component suite owns preflight/UI transitions. Real Blob hydration and
// revision guards are exercised in acquisitionProvenance.test.ts.
vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.manifests,
  getDatasetRevision: vi.fn(async () => 7),
  getSelectedPatientKey: vi.fn(async () => 'patient-a'),
}));

vi.mock('../src/utils/decodedFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof DecodedFrames>()),
  getDecodedFrameBySopInstanceUid: mocks.decodedFrame,
  loadCornerstoneImage: mocks.previewImage,
}));
vi.mock('../src/utils/segmentation/interactiveAdmission', async (importOriginal) => ({
  ...(await importOriginal<typeof InteractiveAdmission>()),
  admitInteractiveSelection: mocks.admitSelection,
}));
vi.mock('../src/utils/segmentation/interactiveSelection', () => ({
  proposeInteractiveSelection: mocks.proposeSelection,
}));

vi.mock('../src/hooks/useSvrReconstruction', () => ({
  useSvrReconstruction: () => mocks.useReconstruction(),
}));

vi.mock('../src/utils/svr/reconstructVolume', () => ({ reconstructVolumeMultiPlane: mocks.reconstruct }));

vi.mock('../src/utils/derivedAlignmentFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof DerivedAlignmentFrames>()),
  retainedDerivedAlignmentBytes: mocks.retainedAlignmentBytes,
}));

vi.mock('../src/components/SvrVolume3DViewer', () => ({
  SvrVolume3DViewer: function MockSvrViewer({
    volumeIdentity,
  }: {
    volumeIdentity: { patientKey?: string; studyUid?: string } | null;
  }) {
    const imaging = useSvrImaging();
    mocks.enhancementLoader(imaging.loadEnhancementSource);
    mocks.refinementLoader(imaging.refineRegion);
    mocks.selectionProposer(imaging.proposeSelection);
    mocks.operations(imaging.operations);
    return (
      <div data-testid="accepted-svr-volume">
        {volumeIdentity?.patientKey} / {volumeIdentity?.studyUid}
        <button
          onClick={() => {
            if (imaging.volume)
              imaging.refineRegion?.({
                data: new Uint8Array(imaging.volume.data.length).fill(1),
                dims: imaging.volume.dims,
                meta: [{ id: 1, name: 'Test selection', color: [0, 1, 1] }],
              });
          }}
        >
          Refine test region
        </button>
      </div>
    );
  },
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadImage: vi.fn(),
    getEnabledElements: mocks.enabledElements,
    imageCache: {
      getCacheInfo: mocks.cacheInfo,
      cachedImages: mocks.cachedImages,
      removeImageLoadObject: mocks.removeCachedImage,
      getImageLoadObject: mocks.cachedImageLoadObject,
    },
  },
}));

import { Svr3DView } from '../src/components/Svr3DView';

const EXAMINATION = '2035-01-15T12:00:00';

function data(patient = 'patient-a', orientationCount = 2, unclassified = false): ComparisonData {
  const sourcePlanes = ['Axial', 'Coronal', 'Sagittal'].slice(0, orientationCount);
  const studyUid = 'study-' + patient;
  const sequences = sourcePlanes.map((plane) => ({
    id: plane.toLowerCase() + '-' + patient,
    plane,
    weight: unclassified ? null : 'T2',
    sequence: unclassified ? null : 'FLAIR',
    label: unclassified ? 'Unknown' : plane + ' T2 FLAIR',
    date_count: 1,
  }));

  return {
    planes: sourcePlanes,
    dates: [EXAMINATION],
    sequences,
    series_map: Object.fromEntries(
      sequences.map((sequence) => [
        sequence.id,
        {
          [EXAMINATION]: {
            study_id: studyUid,
            study_uid: studyUid,
            patient_key: patient,
            frame_of_reference_uid: 'frame-' + patient,
            series_uid: sequence.id,
            instance_count: 3,
          },
        },
      ]),
    ),
    selected_patient_key: patient,
    dataset_revision: 7,
    patients: [{ key: patient, patient_id: patient, patient_name: 'Synthetic ' + patient, study_count: 1 }],
  };
}

function manifest(seriesUid: string, patient = 'patient-a', sameOrientation = false, frame = 'frame-' + patient) {
  const isCoronal = seriesUid.startsWith('coronal') && !sameOrientation;
  const isSagittal = seriesUid.startsWith('sagittal') && !sameOrientation;
  const orientation = isCoronal ? '1\\0\\0\\0\\0\\1' : isSagittal ? '0\\1\\0\\0\\0\\1' : '1\\0\\0\\0\\1\\0';

  return {
    seriesUid,
    studyUid: 'study-' + patient,
    patientKey: patient,
    frameOfReferenceUid: frame,
    ordering: 'physical' as const,
    geometryReliable: true,
    sliceSpacingMm: 1,
    frames: Array.from({ length: 3 }, (_, index) => ({
      sopInstanceUid: seriesUid + '-frame-' + index,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: 'study-' + patient,
      instanceNumber: index + 1,
      rows: 8,
      columns: 8,
      dicomByteLength: 8 * 8 * 2,
      imagePositionPatient: isCoronal ? '0\\' + index + '\\0' : isSagittal ? index + '\\0\\0' : '0\\0\\' + index,
      imageOrientationPatient: orientation,
      pixelSpacing: '1\\1',
      frameOfReferenceUid: frame,
      physicalSlicePosition: index,
      acquisitionMetadata: {
        version: 1 as const,
        imageType: ['ORIGINAL', 'PRIMARY'],
        mrAcquisitionType: '2D',
        acquisitionNumber: isCoronal ? 2 : isSagittal ? 3 : 1,
        scanningSequence: ['SE'],
        echoTimeMs: 100,
        repetitionTimeMs: 5000,
        sourceSopInstanceUids: [],
        derivationSopInstanceUids: [],
      },
    })),
  };
}

function identity(comparisonData: ComparisonData): string {
  const patient = comparisonData.selected_patient_key!;
  return JSON.stringify({
    patient,
    study: 'study-' + patient,
    sequence: comparisonData.sequences[0]?.weight
      ? comparisonData.sequences[0].weight + '|||' + comparisonData.sequences[0].sequence
      : '|||',
    revision: 7,
    frame: 'frame-' + patient,
    series: comparisonData.sequences.map((sequence) => sequence.id).sort(),
  });
}

function acceptedResult(): SvrResult {
  return {
    volume: {
      data: Float32Array.of(0.75),
      observedSupport: Uint8Array.of(1),
      supportedVoxelCount: 1,
      dims: [1, 1, 1],
      voxelSizeMm: [1, 1, 1],
      originMm: [0, 0, 0],
      boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    },
  };
}

function nativeEnhancementFixture(
  dims: [number, number, number],
  start: [number, number, number],
  selected: [number, number, number],
  angle = 0,
  sourceSize = 64,
) {
  const base = manifest('axial-patient-a');
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const direction = [c, -s, 0, s, c, 0, 0, 0, 1] as const;
  const sourceManifest = {
    ...base,
    frames: Array.from({ length: sourceSize }, (_, index) => ({
      ...base.frames[0]!,
      rows: sourceSize,
      columns: sourceSize,
      instanceNumber: index + 1,
      sopInstanceUid: `axial-native-${index}`,
      imagePositionPatient: `0\\0\\${index}`,
      imageOrientationPatient: [c, s, 0, -s, c, 0].join('\\'),
      physicalSlicePosition: index,
      acquisitionMetadata: { ...base.frames[0]!.acquisitionMetadata, mrAcquisitionType: '3D' },
    })),
  };
  const geometry = {
    dims,
    originMm: volumeVoxelToPatient({ originMm: [40, -10, 7], voxelSizeMm: [1, 1, 1], direction }, start),
    voxelSizeMm: [1, 1, 1] as [number, number, number],
    direction,
  };
  const count = dims.reduce((total, value) => total * value, 1);
  const volume: SvrVolume = {
    ...geometry,
    data: Float32Array.from({ length: count }, (_, index) => index - 17),
    observedSupport: new Uint8Array(count).fill(1),
    nativeVoxelSizeMm: [1, 1, 1],
    boundsMm: physicalVolumeBounds(geometry),
    intensityRange: [-17, count - 18],
    sourceProvenance: {
      mode: 'native-3d',
      datasetRevision: 7,
      patientKey: 'patient-a',
      studyUid: 'study-patient-a',
      frameOfReferenceUid: 'frame-patient-a',
      fingerprint: 'native-fixture',
      primarySeriesUid: base.seriesUid,
      explanation: 'Synthetic original source',
      sources: [
        {
          seriesUid: base.seriesUid,
          label: 'Original',
          kind: 'original-3d',
          transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translationMm: [40, -10, 7] },
          contributingSopInstanceUids: [],
          frames: sourceManifest.frames.map((frame, index) => ({
            sopInstanceUid: frame.sopInstanceUid,
            rows: sourceSize,
            columns: sourceSize,
            originMm: [0, 0, index] as const,
            columnDirection: [c, s, 0] as const,
            rowDirection: [-s, c, 0] as const,
            pixelSpacingMm: [1, 1] as const,
          })),
        },
      ],
    },
  };
  const labels: SvrLabelVolume = {
    data: new Uint8Array(count),
    dims,
    meta: [{ id: 1, name: 'Selected', color: [0, 1, 1] }],
  };
  labels.data[(selected[2] * dims[1] + selected[1]) * dims[0] + selected[0]] = 1;
  return { sourceManifest, previous: { volume, parameters: DEFAULT_SVR_PARAMS }, labels };
}

function nativeComparisonData(sourceSize = 64) {
  const comparisonData = data('patient-a', 1);
  comparisonData.series_map[comparisonData.sequences[0]!.id]![EXAMINATION]!.instance_count = sourceSize;
  return comparisonData;
}

function openSources() {
  fireEvent.click(screen.getByRole('button', { name: /show reconstruction sources and controls/i }));
}

async function openSourceDetails() {
  openSources();
  fireEvent.click(await screen.findByText('Source details'));
}

function openReconstructionSettings() {
  openSources();
  fireEvent.click(screen.getByText('Reconstruction settings'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useReconstruction.mockImplementation(() => ({
    ...mocks.hook,
    run: mocks.run,
    cancel: mocks.cancel,
    clear: mocks.clear,
  }));
  mocks.run.mockImplementation(async (_sources, options) => {
    options?.prepare?.();
    return { result: null, error: null, durationMs: 0 };
  });
  mocks.reconstruct.mockReset();
  mocks.admitSelection.mockReset().mockImplementation(async (request) => ({
    provider: 'wasm',
    estimate: estimateInteractiveSelectionMemory(request),
  }));
  mocks.proposeSelection.mockReset();
  mocks.decodedFrame.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 0, maximumSizeInBytes: 256 * 1024 * 1024 });
  mocks.cachedImages.length = 0;
  mocks.removeCachedImage.mockReset();
  mocks.removeCachedImage.mockImplementation((imageId: string) => {
    const index = mocks.cachedImages.findIndex((entry) => entry.imageId === imageId);
    if (index < 0) throw new Error('Image is no longer cached');
    mocks.cachedImages.splice(index, 1);
  });
  mocks.enabledElements.mockReturnValue([]);
  mocks.cachedImageLoadObject.mockImplementation(
    (imageId: string) => mocks.cachedImages.find((entry) => entry.imageId === imageId)?.imageLoadObject,
  );
  mocks.retainedAlignmentBytes.mockReturnValue(0);
  mocks.previewImage.mockResolvedValue({ rows: 8, columns: 8, getPixelData: () => new Int16Array(64) });
  mocks.manifests.mockImplementation(async (seriesUid: string) => manifest(seriesUid));
  mocks.hook.status = 'idle';
  mocks.hook.isRunning = false;
  mocks.hook.progress = null;
  mocks.hook.result = null;
  mocks.hook.resultIdentity = null;
  mocks.hook.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Native interactive selection workspace', () => {
  async function setupSelection(angle = 0, sourceSize = 64) {
    const comparisonData = nativeComparisonData(sourceSize);
    const start: [number, number, number] = sourceSize === 64 ? [20, 0, 0] : [52, 32, 32];
    const { sourceManifest, previous, labels } = nativeEnhancementFixture(
      [24, 64, 64],
      start,
      [12, 32, 32],
      angle,
      sourceSize,
    );
    labels.seeds = {
      foreground: Uint32Array.of((32 * 64 + 32) * 24 + 12),
      background: new Uint32Array(),
      lastStroke: { plane: 'axial', slice: 32 },
    };
    mocks.manifests.mockResolvedValue(sourceManifest);
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.status = 'ready';
    mocks.decodedFrame.mockImplementation(async (seriesUid: string, sopInstanceUid: string) => {
      const index = Number(sopInstanceUid.split('-').at(-1));
      return {
        seriesUid,
        sopInstanceUid,
        rows: sourceSize,
        cols: sourceSize,
        pixels: Float32Array.from({ length: sourceSize ** 2 }, (_, pixel) => index * sourceSize ** 2 + pixel - 17),
        validity: new Float32Array(sourceSize ** 2).fill(1),
      };
    });
    mocks.reconstruct.mockImplementation(async (request) => {
      const plan = planNativeVolume(sourceManifest, request.svrParams, {
        retainedBytes: request.retainedBytes,
        budgetBytes: request.nativeContextBudgetBytes,
        decodedCacheBytes: 0,
        transform: previous.volume.sourceProvenance!.sources[0]!.transform,
      });
      const volume = await assembleNativeVolume(
        plan,
        (frame) => mocks.decodedFrame(sourceManifest.seriesUid, frame.sopInstanceUid),
        {
          signal: request.signal,
          onProgress: (current, total) =>
            request.onProgress?.({ phase: 'loading', current, total, message: 'Native source' }),
        },
      );
      return {
        volume: { ...volume, sourceProvenance: previous.volume.sourceProvenance },
        parameters: request.svrParams,
      };
    });
    const result = render(<Svr3DView data={comparisonData} />);
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
    const proposer = mocks.selectionProposer.mock.lastCall![0] as SelectionProposer;
    const request = {
      volume: previous.volume,
      seeds: labels.seeds,
      retainedBytes: 1234,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };
    return { ...result, comparisonData, sourceManifest, previous, labels, proposer, request };
  }

  it('provides a stable native proposer without starting work on hydration or label publication', async () => {
    const { comparisonData, previous, labels, proposer, rerender } = await setupSelection();
    expect(proposer).toBeTypeOf('function');
    expect(mocks.admitSelection).not.toHaveBeenCalled();
    expect(mocks.decodedFrame).not.toHaveBeenCalled();
    expect(mocks.proposeSelection).not.toHaveBeenCalled();
    mocks.hook.result = { ...previous, initialSelection: labels };
    rerender(<Svr3DView data={comparisonData} />);
    expect(mocks.selectionProposer.mock.lastCall![0]).toBe(proposer);
    expect(mocks.admitSelection).not.toHaveBeenCalled();
  });

  it.each([0, 0.31])(
    'loads exact source context, admits distinct crop memory and preserves the accepted grid (rotation %s)',
    async (angle) => {
      const { sourceManifest, previous, labels, proposer, request } = await setupSelection(angle, 128);
      const before = previous.volume.data.slice();
      const markedBefore = labels.data.slice();
      const owners = {
        retainedBytes: retainedSvrVolumeBytes(previous.volume) + request.retainedBytes + 2048,
        nativePlaneBytes: nativePlaneMemoryBytes(previous.volume.sourceProvenance!.sources),
        decodedCacheBytes: 0,
      };
      mocks.retainedAlignmentBytes.mockReturnValue(2048);
      const context = createNativeSourceContext({
        volume: previous.volume,
        nativeSource: sourceManifest,
        selectedSeries: [],
        parameters: previous.parameters,
      });
      const planned = planInteractiveSelectionContext(previous.volume, context.grid, request.seeds);
      const loadPlan = context.plan(planned.loaderRoi, owners);
      const output = { data: new Uint8Array(previous.volume.data.length), boundaryCount: 0, contextLimited: true };
      mocks.proposeSelection.mockImplementation(async (_source, runRequest) => {
        runRequest.onProgress(1);
        return output;
      });
      const result = await proposer(request);
      expect(result).toBe(output);
      expect(mocks.admitSelection).toHaveBeenCalledTimes(3);
      for (const [admission] of mocks.admitSelection.mock.calls) {
        expect(admission).toEqual({
          signal: request.signal,
          retainedRuntimeBytes: 0,
          retainRuntimeAfterRun: true,
          retainedBytes: owners.retainedBytes + owners.nativePlaneBytes + 256 * 1024 * 1024,
          sourceLoadPeakBytes: loadPlan.memoryPlan.totalBytes + 256 * 1024 * 1024,
          contextBytes: planned.contextBytes,
          editingVoxels: previous.volume.data.length,
          width: planned.width,
          height: planned.height,
          frameCount: planned.frameCount,
          conditioningFrames: 1,
          maximumFramePrompts: 1,
          literalMarkCount: request.seeds.foreground.length + request.seeds.background.length,
        });
      }
      if (angle) expect(loadPlan.dims.reduce((count, size) => count * size, 1)).toBeGreaterThan(planned.contextVoxels);
      expect(mocks.reconstruct).toHaveBeenCalledOnce();
      expect(mocks.reconstruct.mock.lastCall![0]).toMatchObject({
        acceptedProvenance: previous.volume.sourceProvenance,
        retainedBytes: owners.retainedBytes,
        nativeContextBudgetBytes: 1536 * 1024 * 1024,
        svrParams: { ...previous.parameters, roi: planned.loaderRoi },
      });
      expect(mocks.proposeSelection).toHaveBeenCalledOnce();
      const [native, forwarded] = mocks.proposeSelection.mock.lastCall!;
      expect(native.provider).toBe('wasm');
      expect(native.retainMarkedComponents).toBe(true);
      expect(native.sourceRange).toEqual([-17, 128 ** 3 - 18]);
      expect(native.nativeContext.dims).toEqual(planned.grid.dims);
      expect(native.nativeContext.originMm).toEqual(planned.grid.originMm);
      expect(native.nativeContext.voxelSizeMm).toEqual(planned.grid.voxelSizeMm);
      expect(native.nativeContext.data.buffer).not.toBe(previous.volume.data.buffer);
      expect(forwarded.volume).toBe(previous.volume);
      expect(forwarded.seeds).toBe(request.seeds);
      expect(forwarded.signal).toBe(request.signal);
      expect(request.onProgress.mock.lastCall![0]).toBe(1);
      expect(previous.volume.data).toEqual(before);
      expect(labels.data).toEqual(markedBefore);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    },
  );

  it('rejects failed admission before any native decode, model call, or accepted-volume change', async () => {
    const { previous, proposer, request } = await setupSelection();
    mocks.admitSelection.mockRejectedValue(new Error('The verified runtime does not fit the browser memory budget.'));
    await expect(proposer(request)).rejects.toThrow(/memory budget/i);
    expect(mocks.decodedFrame).not.toHaveBeenCalled();
    expect(mocks.reconstruct).not.toHaveBeenCalled();
    expect(mocks.proposeSelection).not.toHaveBeenCalled();
    expect(mocks.hook.result?.volume).toBe(previous.volume);
  });

  it('measures one acquisition range across corrections, re-admits current owners and drops it with the accepted source', async () => {
    const { comparisonData, previous, proposer, request, sourceManifest, rerender } = await setupSelection();
    mocks.proposeSelection.mockResolvedValue({
      data: new Uint8Array(previous.volume.data.length),
      boundaryCount: 0,
      contextLimited: true,
    });
    await proposer(request);
    await proposer({ ...request, retainedBytes: request.retainedBytes + 9876 });
    const rangeReads = () => mocks.decodedFrame.mock.calls.filter(([, , options]) => options?.cache === 'reuse-only');
    expect(rangeReads()).toHaveLength(sourceManifest.frames.length);
    expect(mocks.reconstruct).toHaveBeenCalledTimes(2);
    expect(mocks.admitSelection).toHaveBeenCalledTimes(6);
    expect(
      mocks.admitSelection.mock.calls[3]![0].retainedBytes - mocks.admitSelection.mock.calls[0]![0].retainedBytes,
    ).toBe(9876);
    expect(mocks.proposeSelection.mock.calls.map(([source]) => source.sourceRange)).toEqual([
      [-17, 64 ** 3 - 18],
      [-17, 64 ** 3 - 18],
    ]);
    const firstWorker = mocks.proposeSelection.mock.calls[0]![0].worker;
    expect(firstWorker.run).toBeTypeOf('function');
    expect(mocks.proposeSelection.mock.calls[1]![0].worker).toBe(firstWorker);
    expect(mocks.proposeSelection.mock.calls.every(([source]) => source.retainRuntimeAfterRun)).toBe(true);
    const dispose = vi.spyOn(firstWorker, 'dispose');

    const nextVolume = { ...previous.volume };
    mocks.hook.result = { ...previous, volume: nextVolume };
    rerender(<Svr3DView data={comparisonData} />);
    expect(dispose).toHaveBeenCalledOnce();
    const nextProposer = mocks.selectionProposer.mock.lastCall![0] as SelectionProposer;
    await expect(proposer(request)).rejects.toThrow(/source changed/i);
    await nextProposer({ ...request, volume: nextVolume });
    expect(rangeReads()).toHaveLength(sourceManifest.frames.length * 2);
    expect(mocks.proposeSelection.mock.lastCall![0].worker).not.toBe(firstWorker);
  });

  it('rechecks changing retained owners before native crop and inference', async () => {
    const { previous, proposer, request } = await setupSelection();
    const reconstruct = mocks.reconstruct.getMockImplementation()!;
    mocks.reconstruct.mockImplementation(async (value) => {
      const result = await reconstruct(value);
      mocks.retainedAlignmentBytes.mockReturnValue(16_384);
      return result;
    });
    mocks.proposeSelection.mockResolvedValue({
      data: new Uint8Array(previous.volume.data.length),
      boundaryCount: 0,
      contextLimited: true,
    });
    await proposer(request);
    const admissions = mocks.admitSelection.mock.calls.map(([value]) => value);
    expect(admissions).toHaveLength(3);
    expect(admissions[1].retainedBytes - admissions[0].retainedBytes).toBe(16_384);
    expect(admissions[2].retainedBytes).toBe(admissions[1].retainedBytes);
    expect(admissions[1].sourceLoadPeakBytes - admissions[0].sourceLoadPeakBytes).toBe(16_384);
  });

  it.each([false, true])(
    'accounts for retained sessions and reclaims an oversized idle arena before source loading: %s',
    async (oversized) => {
      const { previous, proposer, request } = await setupSelection();
      const result = { data: new Uint8Array(previous.volume.data.length), contextLimited: false };
      mocks.proposeSelection.mockResolvedValue(result);
      await proposer(request);
      const worker = mocks.proposeSelection.mock.lastCall![0].worker;
      const firstAdmission = mocks.admitSelection.mock.calls[0]![0];
      const bytes = oversized
        ? interactiveSelectionBudgetBytes()
        : estimateInteractiveSelectionMemory(firstAdmission).runtimeBytes;
      let retainedBytes = bytes;
      vi.spyOn(worker, 'retainedBytes', 'get').mockImplementation(() => retainedBytes);
      const release = vi.spyOn(worker, 'releaseIdle').mockImplementation(() => {
        retainedBytes = 0;
        return true;
      });
      const load = mocks.reconstruct.getMockImplementation()!;
      mocks.reconstruct.mockImplementation(async (input) => {
        expect(input.retainedBytes).toBe(
          retainedSvrVolumeBytes(previous.volume) + request.retainedBytes + (oversized ? 0 : bytes),
        );
        expect(release).toHaveBeenCalledTimes(oversized ? 1 : 0);
        return load(input);
      });
      await expect(proposer(request)).resolves.toBe(result);
      expect(mocks.proposeSelection.mock.lastCall![0].worker).toBe(worker);
      for (const [admission] of mocks.admitSelection.mock.calls.slice(3)) {
        expect(admission.retainedRuntimeBytes).toBe(oversized ? 0 : bytes);
        expect(admission.retainedBytes).toBe(firstAdmission.retainedBytes);
      }
    },
  );

  it('admits a release-before-publication plan when the same faithful correction cannot retain idle sessions', async () => {
    const { previous, proposer, request } = await setupSelection();
    const result = { data: new Uint8Array(previous.volume.data.length), contextLimited: false };
    mocks.proposeSelection.mockResolvedValue(result);
    await proposer(request);
    const baseline = estimateInteractiveSelectionMemory({
      ...mocks.admitSelection.mock.calls[0]![0],
      retainRuntimeAfterRun: false,
    });
    const extra =
      interactiveSelectionBudgetBytes() - baseline.trackingPeakBytes - Math.floor(baseline.publicationScratchBytes / 2);
    await expect(proposer({ ...request, retainedBytes: request.retainedBytes + extra })).resolves.toBe(result);
    const [source, submitted] = mocks.proposeSelection.mock.lastCall!;
    expect(source.retainRuntimeAfterRun).toBe(false);
    expect(submitted.volume).toBe(request.volume);
    expect(submitted.seeds).toBe(request.seeds);
    for (const [admission] of mocks.admitSelection.mock.calls.slice(3)) {
      expect(admission.retainRuntimeAfterRun).toBe(false);
      expect(estimateInteractiveSelectionMemory(admission).totalBytes).toBeLessThanOrEqual(
        interactiveSelectionBudgetBytes(),
      );
      expect(
        estimateInteractiveSelectionMemory({ ...admission, retainRuntimeAfterRun: true }).totalBytes,
      ).toBeGreaterThan(interactiveSelectionBudgetBytes());
    }
  });

  it.each(['reconstruction', 'refinement', 'enhancement', 'unmount'] as const)(
    'reclaims the source-owned runtime before %s',
    async (operation) => {
      const { previous, labels, proposer, request, unmount } = await setupSelection();
      mocks.proposeSelection.mockResolvedValue({
        data: new Uint8Array(previous.volume.data.length),
        contextLimited: false,
      });
      await proposer(request);
      const dispose = vi.spyOn(mocks.proposeSelection.mock.lastCall![0].worker, 'dispose');
      mocks.run.mockImplementation(async (_sources, options) => {
        options.prepare();
        expect(dispose).toHaveBeenCalled();
        return { result: null, error: null, durationMs: 0 };
      });
      if (operation === 'reconstruction') fireEvent.click(screen.getByRole('button', { name: /open 3d volume/i }));
      else if (operation === 'refinement')
        (mocks.refinementLoader.mock.lastCall![0] as (labels: SvrLabelVolume) => void)(labels);
      else if (operation === 'enhancement') {
        mocks.operations.mock.lastCall![0].prepare('enhancement');
        const load = mocks.reconstruct.getMockImplementation()!;
        mocks.reconstruct.mockImplementation((input) => {
          expect(dispose).toHaveBeenCalled();
          return load(input);
        });
        await (mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader)(labels, {
          signal: new AbortController().signal,
        });
      } else unmount();
      expect(dispose).toHaveBeenCalled();
    },
  );

  it('reserves remaining pixel cache capacity beside parsed buffers without charging that capacity twice', async () => {
    const { previous, proposer, request } = await setupSelection();
    const pixels = new Uint8Array(16),
      parsed = new Uint8Array(32);
    const image = { imageId: 'miradb:visible', getPixelData: () => pixels, data: { byteArray: parsed } };
    mocks.cachedImages.push({ imageId: image.imageId, sizeInBytes: 16, timeStamp: 0, loaded: true, image });
    mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 16, maximumSizeInBytes: 128 });
    mocks.proposeSelection.mockResolvedValue({
      data: new Uint8Array(previous.volume.data.length),
      boundaryCount: 0,
      contextLimited: true,
    });
    await proposer(request);
    const expectedOwners =
      retainedSvrVolumeBytes(previous.volume) +
      request.retainedBytes +
      nativePlaneMemoryBytes(previous.volume.sourceProvenance!.sources);
    for (const [admission] of mocks.admitSelection.mock.calls)
      expect(admission.retainedBytes).toBe(expectedOwners + 128 + parsed.byteLength);
    expect(mocks.removeCachedImage).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'source', 'reconstruct', 'unmount'] as const)(
    'rejects pending work after %s before starting MRI decode',
    async (change) => {
      const { comparisonData, previous, proposer, request, rerender, unmount } = await setupSelection();
      const admission = deferred<'webgpu'>();
      mocks.admitSelection.mockReturnValue(admission.promise);
      const controller = new AbortController();
      const pending = proposer({ ...request, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow(/canceled|source changed/i);
      if (change === 'cancel') controller.abort();
      else if (change === 'unmount') unmount();
      else {
        if (change === 'source') mocks.hook.result = { ...previous, volume: { ...previous.volume } };
        else mocks.hook.isRunning = true;
        rerender(<Svr3DView data={comparisonData} />);
      }
      admission.resolve('webgpu');
      await rejected;
      expect(mocks.decodedFrame).not.toHaveBeenCalled();
      expect(mocks.reconstruct).not.toHaveBeenCalled();
      expect(mocks.proposeSelection).not.toHaveBeenCalled();
    },
  );

  it('preserves learned failures without rerunning reconstruction or another algorithm', async () => {
    const { previous, proposer, request } = await setupSelection();
    const sourceBefore = previous.volume.data.slice();
    mocks.proposeSelection.mockRejectedValue(new Error('Interactive model failed.'));
    await expect(proposer(request)).rejects.toThrow('Interactive model failed.');
    expect(mocks.reconstruct).toHaveBeenCalledOnce();
    expect(mocks.proposeSelection).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(previous.volume.data).toEqual(sourceBefore);
  });
});

describe('SVR reconstruction workspace', () => {
  it('does not offer a native Auto-fill proposer for an accepted independent-2D reconstruction', async () => {
    const comparisonData = data('patient-a');
    const { previous } = nativeEnhancementFixture([4, 4, 4], [0, 0, 0], [1, 1, 1], 0, 8);
    previous.volume.sourceProvenance = { ...previous.volume.sourceProvenance!, mode: 'independent-2d' };
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.status = 'ready';
    render(<Svr3DView data={comparisonData} />);
    openSources();
    await screen.findByText(/2 independent acquisitions · 6 source slices/);
    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();
    expect(mocks.selectionProposer.mock.lastCall![0]).toBeUndefined();
    expect(mocks.proposeSelection).not.toHaveBeenCalled();
  });

  it('starts with one primary action and keeps source details behind an explicit disclosure', async () => {
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeEnabled());
    expect(screen.getAllByRole('button', { name: 'Reconstruct volume' })).toHaveLength(1);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show reconstruction sources and controls/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('banner')).toHaveAccessibleName('3D scan context for Synthetic patient-a');
    expect(screen.queryByText('Synthetic patient-a')).not.toBeInTheDocument();
    expect(screen.queryByText(/independent acquisitions/)).not.toBeInTheDocument();
    expect(mocks.run).not.toHaveBeenCalled();

    openSources();
    const details = screen.getByText('Source details').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Verified source geometry')).not.toBeVisible();
    expect(screen.getByText('Focus region (optional)').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Reconstruction settings').closest('details')).not.toHaveAttribute('open');

    fireEvent.click(screen.getByText('Source details'));
    expect(screen.getByText('Verified source geometry')).toBeVisible();
    expect(screen.getByText(/2 independent acquisitions · 6 source slices/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /hide reconstruction sources and controls/i }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeEnabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('keeps the actual displayed examination and sequence visible without repeating the parent patient band', async () => {
    const comparisonData = data('patient-a');
    const newerExamination = '2035-02-20T09:30:00';
    comparisonData.dates = [newerExamination, EXAMINATION];
    for (const byDate of Object.values(comparisonData.series_map)) {
      const source = byDate[EXAMINATION]!;
      byDate[newerExamination] = { ...source, series_uid: `${source.series_uid}-newer` };
    }
    const { rerender } = render(<Svr3DView data={comparisonData} defaultDateIso={EXAMINATION} />);

    const header = screen.getByRole('banner', { name: /3d scan context for synthetic patient-a/i });
    const date = within(header).getByLabelText(/displayed examination/i);
    expect(date).toHaveAttribute('datetime', EXAMINATION);
    expect(date).toHaveTextContent('Jan 15, 2035');
    expect(within(header).getByText('T2 FLAIR')).toBeVisible();
    expect(within(header).getByRole('button', { name: /show reconstruction sources and controls/i })).toBeVisible();
    expect(within(header).queryByText('3D VIEW')).not.toBeInTheDocument();
    expect(within(header).queryByText('Synthetic patient-a')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeEnabled());

    rerender(<Svr3DView data={comparisonData} defaultDateIso={newerExamination} />);
    expect(within(header).getByLabelText(/displayed examination/i)).toHaveAttribute('datetime', newerExamination);
    expect(within(header).getByText('T2 FLAIR')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeEnabled());
  });

  it.each([false, true])(
    'keeps measured progress and cancellation visible with accepted volume %s and sources closed',
    async (hasAcceptedVolume) => {
      const comparisonData = data('patient-a');
      mocks.hook.status = 'running';
      mocks.hook.isRunning = true;
      mocks.hook.progress = { phase: 'reconstructing', current: 35, total: 100, message: 'Reconstructing anatomy' };
      if (hasAcceptedVolume) {
        mocks.hook.result = acceptedResult();
        mocks.hook.resultIdentity = identity(comparisonData);
      }
      render(<Svr3DView data={comparisonData} />);

      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
      expect(screen.getAllByRole('progressbar')).toHaveLength(1);
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
      expect(screen.getAllByText('Reconstructing anatomy')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Cancel reconstruction' })).toHaveLength(1);
      if (hasAcceptedVolume) expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();

      openSources();
      expect(screen.getAllByRole('progressbar')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Cancel reconstruction' })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /hide reconstruction sources and controls/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel reconstruction' }));
      expect(mocks.cancel).toHaveBeenCalledOnce();

      await waitFor(() => expect(mocks.manifests).toHaveBeenCalledTimes(2));
    },
  );

  it('does not invent measured progress before work reports its first completed unit', async () => {
    mocks.hook.status = 'running';
    mocks.hook.isRunning = true;
    render(<Svr3DView data={data('patient-a')} />);

    expect(screen.getByRole('status')).toHaveTextContent('Preparing MRI source images');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel reconstruction' })).toBeEnabled();
    await waitFor(() => expect(mocks.manifests).toHaveBeenCalledTimes(2));
  });

  it('reports a canceled refinement without hiding the accepted volume or opening sources', async () => {
    const comparisonData = data('patient-a');
    mocks.hook.status = 'canceled';
    mocks.hook.result = acceptedResult();
    mocks.hook.resultIdentity = identity(comparisonData);
    render(<Svr3DView data={comparisonData} />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/volume and selection are unchanged/i));
    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it.each([0, 0.31])('reloads real native context outside a tight accepted focus crop (rotation %s)', async (angle) => {
    const comparisonData = nativeComparisonData();
    const { sourceManifest, previous, labels } = nativeEnhancementFixture(
      [24, 64, 64],
      [20, 0, 0],
      [12, 32, 32],
      angle,
    );
    mocks.manifests.mockResolvedValue(sourceManifest);
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.status = 'ready';
    mocks.retainedAlignmentBytes.mockReturnValue(2048);
    const loaded = acceptedResult();
    mocks.reconstruct.mockResolvedValue(loaded);
    render(<Svr3DView data={comparisonData} />);
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
    const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
    const before = previous.volume.data.slice();
    const result = await load(labels, { retainedBytes: 1234 });
    expect(result).toBe(loaded.volume);
    expect(mocks.reconstruct).toHaveBeenCalledOnce();
    const request = mocks.reconstruct.mock.lastCall![0];
    expect(request.acceptedProvenance).toEqual(previous.volume.sourceProvenance);
    expect(request.svrParams.roi.mode).toBe('box');
    // Native decoding and enhancement worker allocations are sequential peaks,
    // not simultaneous reservations charged against the native assembly phase.
    expect(request.retainedBytes).toBe(retainedSvrVolumeBytes(previous.volume) + 1234 + 2048);
    expect(previous.volume.data).toEqual(before);
    expect(labels.data.reduce((total, value) => total + value, 0)).toBe(1);
  });

  it.each([
    [32, 32, 32],
    [0, 32, 32],
    [63, 32, 32],
  ] as [number, number, number][])(
    'reuses an available native grid and shifts enough real context inward at acquisition edges (%s)',
    async (...point) => {
      const comparisonData = nativeComparisonData();
      const { sourceManifest, previous, labels } = nativeEnhancementFixture([64, 64, 64], [0, 0, 0], point);
      mocks.manifests.mockResolvedValue(sourceManifest);
      mocks.hook.result = previous;
      mocks.hook.resultIdentity = identity(comparisonData);
      mocks.hook.status = 'ready';
      render(<Svr3DView data={comparisonData} />);
      openSources();
      await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
      const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
      const result = await load(labels, {});
      expect(mocks.reconstruct).not.toHaveBeenCalled();
      expect(result.dims.every((size) => size >= 32 && size <= 64)).toBe(true);
      expect(result.voxelSizeMm).toEqual([1, 1, 1]);
      expect(result.observedSupport!.every(Boolean)).toBe(true);
      expect(result.data.buffer).not.toBe(previous.volume.data.buffer);
    },
  );

  it.each([false, true])(
    'reports non-reclaimable retained memory honestly before %s native preparation',
    async (reload) => {
      const comparisonData = nativeComparisonData();
      const { sourceManifest, previous, labels } = nativeEnhancementFixture(
        reload ? [24, 64, 64] : [64, 64, 64],
        reload ? [20, 0, 0] : [0, 0, 0],
        reload ? [12, 32, 32] : [32, 32, 32],
      );
      mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 400 * 1024 * 1024 });
      mocks.manifests.mockResolvedValue(sourceManifest);
      mocks.hook.result = previous;
      mocks.hook.resultIdentity = identity(comparisonData);
      mocks.hook.status = 'ready';
      render(<Svr3DView data={comparisonData} />);
      openSources();
      await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeInTheDocument());
      await waitFor(() => expect(mocks.enhancementLoader.mock.lastCall![0]).toBeTypeOf('function'));
      const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
      await expect(load(labels, { retainedBytes: 100 * 1024 * 1024 })).rejects.toThrow(
        /open volume and working data.*even a small enhancement/i,
      );
      expect(mocks.reconstruct).not.toHaveBeenCalled();
      expect(mocks.removeCachedImage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'reclaims only idle MRI and protects displayed loader aliases before %s native preparation',
    async (reload) => {
      const mib = 1024 * 1024;
      const comparisonData = nativeComparisonData();
      const { sourceManifest, previous, labels } = nativeEnhancementFixture(
        reload ? [24, 64, 64] : [64, 64, 64],
        reload ? [20, 0, 0] : [0, 0, 0],
        reload ? [12, 32, 32] : [32, 32, 32],
      );
      const decodedImage = (imageId: string, sizeMiB: number) => {
        const pixels = new Uint8Array(sizeMiB * mib);
        return { imageId, getPixelData: () => pixels };
      };
      const displayedImage = decodedImage('dicomfile:0', 64);
      mocks.cachedImages.push(
        {
          imageId: 'miradb:displayed',
          sizeInBytes: 64 * mib,
          timeStamp: 1,
          loaded: true,
          image: displayedImage,
          imageLoadObject: {},
        },
        {
          imageId: 'miradb:loading',
          sizeInBytes: 80 * mib,
          timeStamp: 2,
          loaded: false,
          image: decodedImage('miradb:loading', 80),
          imageLoadObject: {},
        },
        // Inner file-manager IDs can be reused; a different object with the
        // same dicomfile ID must not be mistaken for the displayed frame.
        {
          imageId: 'miradb:idle-old',
          sizeInBytes: 80 * mib,
          timeStamp: 3,
          loaded: true,
          image: decodedImage('dicomfile:0', 80),
          imageLoadObject: {},
        },
        {
          imageId: 'miraderived:idle-recent',
          sizeInBytes: 176 * mib,
          timeStamp: 4,
          loaded: true,
          image: decodedImage('miraderived:idle-recent', 176),
          imageLoadObject: {},
        },
      );
      mocks.cacheInfo.mockImplementation(() => ({
        cacheSizeInBytes: mocks.cachedImages.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0),
        maximumSizeInBytes: 512 * mib,
      }));
      mocks.enabledElements.mockReturnValue([{ image: displayedImage }]);
      mocks.manifests.mockResolvedValue(sourceManifest);
      mocks.hook.result = previous;
      mocks.hook.resultIdentity = identity(comparisonData);
      mocks.hook.status = 'ready';
      const loaded = nativeEnhancementFixture([33, 33, 33], [16, 16, 16], [16, 16, 16]).previous;
      mocks.reconstruct.mockResolvedValue(loaded);
      render(<Svr3DView data={comparisonData} />);
      openSources();
      await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
      const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
      const before = previous.volume.data.slice();
      const result = await load(labels, { retainedBytes: 100 * mib });
      expect(result.dims.every((size) => size >= 32)).toBe(true);
      expect(result.voxelSizeMm).toEqual([1, 1, 1]);
      expect(mocks.removeCachedImage.mock.calls).toEqual([['miradb:idle-old']]);
      expect(mocks.cachedImages.map((entry) => entry.imageId)).toEqual([
        'miradb:displayed',
        'miradb:loading',
        'miraderived:idle-recent',
      ]);
      expect(previous.volume.data).toEqual(before);
      expect(labels.data.reduce((total, value) => total + value, 0)).toBe(1);
      if (reload) {
        expect(mocks.reconstruct).toHaveBeenCalledOnce();
        expect(mocks.reconstruct.mock.lastCall![0].retainedBytes).toBe(
          retainedSvrVolumeBytes(previous.volume) + 100 * mib,
        );
      } else expect(mocks.reconstruct).not.toHaveBeenCalled();
    },
  );

  it('counts the raw alignment-frame cache separately from decoded presentation images', async () => {
    const mib = 1024 * 1024;
    const comparisonData = nativeComparisonData();
    const { sourceManifest, previous, labels } = nativeEnhancementFixture([64, 64, 64], [0, 0, 0], [32, 32, 32]);
    mocks.retainedAlignmentBytes.mockReturnValue(64 * mib);
    mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 380 * mib });
    mocks.manifests.mockResolvedValue(sourceManifest);
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.status = 'ready';
    render(<Svr3DView data={comparisonData} />);
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
    const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
    await expect(load(labels, {})).rejects.toThrow(/no room for even a small enhancement/i);
    expect(mocks.reconstruct).not.toHaveBeenCalled();
    expect(mocks.removeCachedImage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rechecks decoded cache after native source loading (new frames protected: %s)',
    async (protectedFrame) => {
      const mib = 1024 * 1024;
      const comparisonData = nativeComparisonData();
      const { sourceManifest, previous, labels } = nativeEnhancementFixture([24, 64, 64], [20, 0, 0], [12, 32, 32]);
      const pixels = new Uint8Array(320 * mib);
      const displayedImage = { imageId: 'miradb:displayed', getPixelData: () => pixels };
      mocks.cachedImages.push({
        imageId: 'miradb:displayed',
        sizeInBytes: 320 * mib,
        timeStamp: 1,
        loaded: true,
        image: displayedImage,
        imageLoadObject: {},
      });
      mocks.cacheInfo.mockImplementation(() => ({
        cacheSizeInBytes: mocks.cachedImages.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0),
        maximumSizeInBytes: 512 * mib,
      }));
      mocks.enabledElements.mockReturnValue([{ image: displayedImage }]);
      mocks.manifests.mockResolvedValue(sourceManifest);
      mocks.hook.result = previous;
      mocks.hook.resultIdentity = identity(comparisonData);
      mocks.hook.status = 'ready';
      const loaded = nativeEnhancementFixture([33, 33, 33], [16, 16, 16], [16, 16, 16]).previous;
      mocks.reconstruct.mockImplementation(async () => {
        const newPixels = new Uint8Array(80 * mib);
        const newImage = { imageId: 'miradb:new-frame', getPixelData: () => newPixels };
        mocks.cachedImages.push({
          imageId: 'miradb:new-frame',
          sizeInBytes: 80 * mib,
          timeStamp: 2,
          loaded: true,
          image: newImage,
          imageLoadObject: {},
        });
        if (protectedFrame) mocks.enabledElements.mockReturnValue([{ image: displayedImage }, { image: newImage }]);
        return loaded;
      });
      render(<Svr3DView data={comparisonData} />);
      openSources();
      await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
      const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
      if (protectedFrame) {
        await expect(load(labels, { retainedBytes: 100 * mib })).rejects.toThrow(
          /no room for even a small enhancement/i,
        );
        expect(mocks.removeCachedImage).not.toHaveBeenCalled();
      } else {
        await expect(load(labels, { retainedBytes: 100 * mib })).resolves.toBe(loaded.volume);
        expect(mocks.removeCachedImage.mock.calls).toEqual([['miradb:new-frame']]);
      }
      expect(mocks.reconstruct).toHaveBeenCalledOnce();
    },
  );

  it('refines accepted source settings and registration instead of the controls for the next run', async () => {
    const comparisonData = data('patient-a');
    const previous = acceptedResult();
    previous.parameters = {
      ...DEFAULT_SVR_PARAMS,
      iterations: 7,
      stepSize: 0.31,
      seriesRegistrationMode: 'roi-rigid',
      roi: {
        mode: 'cube',
        sourcePlane: 'coronal',
        sourceSeriesUid: 'coronal-patient-a',
        boundsMm: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    };
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.status = 'ready';
    render(<Svr3DView data={comparisonData} />);
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /hide reconstruction sources and controls/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Refine test region' }));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [sources, options] = mocks.run.mock.calls[0]!;
    const { params: settings, identity: resultIdentity, selectionToRefine: transfer } = options;
    expect(sources).toHaveLength(2);
    expect(settings).toMatchObject({
      iterations: 7,
      stepSize: 0.31,
      seriesRegistrationMode: 'roi-rigid',
      roi: { sourceSeriesUid: 'coronal-patient-a' },
    });
    expect(resultIdentity).toBe(identity(comparisonData));
    expect(transfer.volume).toBe(previous.volume);
    expect(transfer.labels.data[0]).toBe(1);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('rejects exact native refinement using live retained owners before decoding and preserves the visible draft/settings', async () => {
    const { useSvrReconstruction } = await vi.importActual<typeof ReconstructionHooks>(
      '../src/hooks/useSvrReconstruction',
    );
    mocks.useReconstruction.mockImplementation(useSvrReconstruction);
    const { sourceManifest, previous, labels } = nativeEnhancementFixture([12, 12, 12], [0, 0, 0], [6, 6, 6]);
    labels.reviewState = 'draft';
    labels.seeds = { foreground: Uint32Array.of((6 * 12 + 6) * 12 + 6), background: new Uint32Array() };
    const maskBefore = labels.data.slice();
    const sourceBefore = previous.volume.data.slice();
    const requested = regionalRefinementParameters(
      previous.parameters,
      selectionFocusRoi(previous.volume, labels, 'axial-patient-a'),
    );
    const transform = previous.volume.sourceProvenance!.sources[0]!.transform;
    const retainedVolume = retainedSvrVolumeBytes(previous.volume);
    const base = planNativeVolume(sourceManifest, requested, {
      retainedBytes: retainedVolume,
      decodedCacheBytes: 0,
      transform,
    });
    const decodedCacheBytes = SVR_MEMORY_BUDGET_BYTES - base.totalBytes - 32;
    const editing = new Uint32Array(16);
    const alignment = new Float32Array(32);
    const prepareMemory = vi.fn(() => editing.buffer.byteLength);
    const readFrame = vi.fn();
    mocks.manifests.mockResolvedValue(sourceManifest);
    mocks.reconstruct.mockResolvedValueOnce(previous).mockImplementationOnce(async (request) => {
      expect(request.acceptedProvenance).toBe(previous.volume.sourceProvenance);
      expect(request.svrParams).toEqual(requested);
      expect(request.retainedBytes).toBe(retainedVolume + editing.buffer.byteLength + alignment.buffer.byteLength);
      const plan = planNativeVolume(sourceManifest, request.svrParams, {
        retainedBytes: request.retainedBytes,
        decodedCacheBytes,
        transform,
      });
      const withoutEditing = planNativeVolume(sourceManifest, request.svrParams, {
        retainedBytes: retainedVolume,
        decodedCacheBytes,
        transform,
      });
      expect(withoutEditing.totalBytes).toBeLessThanOrEqual(SVR_MEMORY_BUDGET_BYTES);
      expect(plan.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
      expect(plan.sourceStrides).toEqual([1, 1, 1]);
      expect(plan.voxelSizeMm).toEqual(previous.volume.nativeVoxelSizeMm);
      expect(plan.boundsMm).toEqual(base.boundsMm);
      expect(plan.dims).toEqual(base.dims);
      return { volume: await assembleNativeVolume(plan, readFrame) };
    });
    render(<Svr3DView data={nativeComparisonData()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open 3D volume' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open 3D volume' }));
    await screen.findByTestId('accepted-svr-volume');
    mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: decodedCacheBytes });
    mocks.retainedAlignmentBytes.mockReturnValue(alignment.buffer.byteLength);
    const unregister = mocks.operations.mock.lastCall![0].register('editor', () => ({
      retainedBytes: prepareMemory(),
    }));
    act(() => mocks.refinementLoader.mock.lastCall![0](labels));
    unregister();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/native-resolution region exceeds the browser memory budget/),
    );
    expect(prepareMemory).toHaveBeenCalledOnce();
    expect(mocks.retainedAlignmentBytes).toHaveBeenCalledTimes(2);
    expect(mocks.reconstruct).toHaveBeenCalledTimes(2);
    expect(readFrame).not.toHaveBeenCalled();
    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();
    expect(labels.data).toEqual(maskBefore);
    expect(labels.reviewState).toBe('draft');
    expect(labels.seeds.foreground).toEqual(Uint32Array.of((6 * 12 + 6) * 12 + 6));
    expect(previous.volume.data).toEqual(sourceBefore);
    openSources();
    expect(screen.queryByRole('button', { name: 'Load native region' })).not.toBeInTheDocument();
    mocks.reconstruct.mockResolvedValueOnce(previous);
    fireEvent.click(screen.getByRole('button', { name: 'Open 3D volume' }));
    await waitFor(() => expect(mocks.reconstruct).toHaveBeenCalledTimes(3));
    expect(mocks.reconstruct.mock.calls[2]![0].svrParams).toEqual(mocks.reconstruct.mock.calls[0]![0].svrParams);
    expect(mocks.reconstruct.mock.calls[2]![0].svrParams.roi).toBeNull();
  });

  it('opens one reliable source stack without pretending it is independent multi-acquisition fusion', async () => {
    render(<Svr3DView data={data('patient-a', 1)} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /explore this mri in 3d/i })).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /reconstruct volume/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('accepted-svr-volume')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    openSources();
    const sources = screen.getByRole('complementary', { name: /reconstruction sources and quality/i });
    expect(sources).toBeInTheDocument();
    expect(sources.parentElement).toHaveClass('grid-cols-[minmax(240px,304px)_minmax(0,1fr)]');
  });

  it('keeps unclassified but physically valid acquired sequences visible', async () => {
    render(<Svr3DView data={data('patient-a', 1, true)} />);

    await waitFor(() => {
      expect(screen.getAllByText('Unclassified').length).toBeGreaterThan(0);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
  });

  it('refuses to fuse unclassified orientations without a verified shared contrast', async () => {
    render(<Svr3DView data={data('patient-a', 2, true)} />);

    await waitFor(() => {
      expect(screen.getAllByText(/no verified shared contrast or sequence/i).length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not offer multi-acquisition fusion merely because parallel sources have different plane names', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) => manifest(seriesUid, 'patient-a', true));
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled();
    });

    expect(screen.queryByRole('button', { name: /reconstruct volume/i })).not.toBeInTheDocument();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('chooses an original 3D acquisition and explicitly excludes its averaged viewing planes', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) => {
      const source = manifest(seriesUid);
      return {
        ...source,
        frames: source.frames.map((frame) => ({
          ...frame,
          acquisitionMetadata: {
            ...frame.acquisitionMetadata,
            mrAcquisitionType: '3D',
            imageType: seriesUid.startsWith('axial')
              ? ['ORIGINAL', 'PRIMARY']
              : ['DERIVED', 'SECONDARY', 'REFORMATTED', 'AVERAGE'],
          },
        })),
      };
    });
    render(<Svr3DView data={data('patient-a')} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open 3D volume' })).toBeEnabled());
    await openSourceDetails();
    expect(screen.getByText('Derived view · not fused')).toBeInTheDocument();
    expect(screen.queryByText('Reconstruction settings')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconstruct volume' })).not.toBeInTheDocument();
  });

  it('rejects incompatible spatial reference frames before reconstruction', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) =>
      manifest(seriesUid, 'patient-a', false, seriesUid.startsWith('coronal') ? 'frame-b' : 'frame-a'),
    );
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/incompatible spatial coordinate frames/i);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
  });

  it('rejects a source without a verified spatial frame before enabling reconstruction', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) => ({
      ...manifest(seriesUid),
      frameOfReferenceUid: undefined,
    }));
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/missing a verified spatial coordinate frame/i);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
  });

  it('starts a physically admitted run with an immutable patient and acquisition identity', async () => {
    const comparisonData = data('patient-a');
    render(<Svr3DView data={comparisonData} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]!);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.run.mock.calls[0]?.[1].identity).toBe(identity(comparisonData));
  });

  it.each([0, 256])(
    'admits 702 acquired source frames without reserving an entire new image cache (%i MiB already resident)',
    async (cachedMiB) => {
      const comparisonData = data('patient-a', 3);
      mocks.cacheInfo.mockReturnValue({
        cacheSizeInBytes: cachedMiB * 1024 * 1024,
        maximumSizeInBytes: 256 * 1024 * 1024,
      });
      const sourceFrameCounts = { axial: 221, coronal: 221, sagittal: 260 };

      for (const sequence of comparisonData.sequences) {
        const plane = sequence.plane!.toLowerCase() as keyof typeof sourceFrameCounts;
        comparisonData.series_map[sequence.id]![EXAMINATION]!.instance_count = sourceFrameCounts[plane];
      }

      mocks.manifests.mockImplementation(async (seriesUid: string) => {
        const source = manifest(seriesUid);
        const plane = seriesUid.split('-')[0] as keyof typeof sourceFrameCounts;
        const frame = source.frames[0]!;

        return {
          ...source,
          frames: Array.from({ length: sourceFrameCounts[plane] }, (_, index) => ({
            ...frame,
            sopInstanceUid: `${seriesUid}-frame-${index}`,
            instanceNumber: index + 1,
            rows: 512,
            columns: 512,
            pixelSpacing: '0.43,0.43',
            imagePositionPatient:
              plane === 'coronal' ? `0,${index},0` : plane === 'sagittal' ? `${index},0,0` : `0,0,${index}`,
            physicalSlicePosition: index,
          })),
        };
      });

      render(<Svr3DView data={comparisonData} />);
      await openSourceDetails();

      await waitFor(() => {
        expect(screen.getByText('Conservative peak').parentElement).toHaveTextContent(/(?:[1-4]\d\d|50\d|51[0-2]) MiB/);
      });

      expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeEnabled();
      expect(screen.getByText('Requested voxel spacing').parentElement).toHaveTextContent('1.00 mm');
      expect(screen.getByText('Effective voxel spacing').parentElement).not.toHaveTextContent('1.00 mm');
      const adjusted = screen.queryByText(/automatically adjusted to stay within the 512 mib memory budget/i);
      if (cachedMiB) expect(adjusted).toBeInTheDocument();
      else expect(adjusted).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /reconstruct volume/i }));

      const effectiveParams = mocks.run.mock.calls[0]?.[1].params;
      // Admission includes the bounded native-plane cache and upload transients
      // alongside decoded frames, the solver, and incoming CPU/GPU labels.
      expect(effectiveParams.targetVoxelSizeMm).toBe(cachedMiB ? 1.19 : 1);
      expect(mocks.run.mock.calls[0]?.[1].identity).toBe(identity(comparisonData));
    },
  );

  it('prepares one acquisition at a time and cancels metadata loading with the workspace', async () => {
    let finish!: (value: ReturnType<typeof manifest>) => void;
    mocks.manifests.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Svr3DView data={data('patient-a', 3)} />);
    await waitFor(() => expect(mocks.manifests).toHaveBeenCalledTimes(1));
    const signal = (mocks.manifests.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(manifest('axial-patient-a')));
    expect(mocks.manifests).toHaveBeenCalledTimes(1);
  });

  it('uses prepared source order for the first focus preview, keeps the box on catalog refresh, and retires it on patient change', async () => {
    const comparison = data('preview-patient', 1);
    const source = manifest('axial-preview-patient', 'preview-patient');
    source.frames.forEach((frame, index) => {
      frame.instanceNumber = 3 - index;
    });
    const ready = deferred<typeof source>();
    mocks.manifests.mockReturnValueOnce(ready.promise);
    const props = { data: comparison, fallbackRoiSeriesUid: source.seriesUid, fallbackRoiSliceIndex: 0 };
    const view = render(<Svr3DView {...props} />);
    openSources();
    fireEvent.click(screen.getByText('Focus region (optional)'));
    expect(mocks.previewImage).not.toHaveBeenCalled();
    await act(async () => ready.resolve(source));
    await waitFor(() =>
      expect(mocks.previewImage).toHaveBeenLastCalledWith(`miradb:${source.frames[0]!.sopInstanceUid}`),
    );
    expect(screen.getByText('Slice 1 / 3')).toBeVisible();
    const preview = screen.getByRole('application', { name: /^Focus-box source slice/ });
    fireEvent.keyDown(preview, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(mocks.previewImage).toHaveBeenLastCalledWith(`miradb:${source.frames[1]!.sopInstanceUid}`),
    );
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    Object.defineProperty(preview, 'setPointerCapture', { value: vi.fn(), configurable: true });
    fireEvent.pointerDown(preview, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(preview, { clientX: 70, clientY: 70, pointerId: 1 });
    expect(screen.getByText('Box', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Load native region' })).toBeEnabled();
    const refresh = deferred<typeof source>();
    mocks.manifests.mockReturnValueOnce(refresh.promise);
    view.rerender(<Svr3DView {...props} data={{ ...comparison, series_map: { ...comparison.series_map } }} />);
    expect(screen.getByText('Box', { exact: true })).toBeVisible();
    await act(async () => refresh.resolve({ ...source, frames: source.frames.map((frame) => ({ ...frame })) }));
    expect(screen.getByText('Box', { exact: true })).toBeVisible();
    fireEvent.keyDown(preview, { key: 'ArrowRight' });
    expect(screen.queryByText('Box', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load native region' })).toBeEnabled();
    const replacement = deferred<typeof source>();
    mocks.manifests.mockReturnValueOnce(replacement.promise);
    view.rerender(<Svr3DView data={data('preview-other', 1)} />);
    expect(screen.queryByRole('button', { name: 'Load native region' })).not.toBeInTheDocument();
    expect(screen.getByRole('application', { name: /^Focus-box source slice/ })).toHaveAttribute('tabindex', '-1');
    await act(async () => replacement.resolve(manifest('axial-preview-other', 'preview-other')));
    await waitFor(() => expect(mocks.previewImage).toHaveBeenLastCalledWith('miradb:axial-preview-other-frame-1'));
  });

  it.each(['read', 'geometry', 'coordinate frame'] as const)(
    'keeps a valid individual source preview when another acquisition has a %s failure',
    async (failure) => {
      mocks.manifests.mockImplementation(async (seriesUid: string) => {
        const source = manifest(seriesUid);
        if (seriesUid.startsWith('axial')) {
          if (failure === 'read') throw new Error('Synthetic source is unavailable.');
          if (failure === 'geometry') {
            source.geometryReliable = false;
            source.frames[0]!.imagePositionPatient = 'invalid';
          } else source.frameOfReferenceUid = 'different-frame';
        }
        return source;
      });
      render(<Svr3DView data={data('patient-a')} />);
      openSources();
      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeDisabled();
      expect(screen.queryByText('Verified source geometry')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Focus region (optional)'));
      fireEvent.change(screen.getByLabelText('Draw on'), { target: { value: 'coronal-patient-a' } });
      await waitFor(() => expect(mocks.previewImage).toHaveBeenLastCalledWith('miradb:coronal-patient-a-frame-1'));
      expect(screen.getByRole('application', { name: /^Focus-box source slice/ })).toHaveAttribute('tabindex', '0');
    },
  );

  it('never renders the previous patient volume after a patient switch', async () => {
    const first = data('patient-a');
    mocks.hook.status = 'ready';
    mocks.hook.result = acceptedResult();
    mocks.hook.resultIdentity = identity(first);
    const { rerender } = render(<Svr3DView data={first} />);

    expect(screen.getByTestId('accepted-svr-volume')).toHaveTextContent('patient-a');

    mocks.manifests.mockImplementation(async (seriesUid: string) => manifest(seriesUid, 'patient-b'));
    rerender(<Svr3DView data={data('patient-b')} />);

    expect(screen.queryByTestId('accepted-svr-volume')).not.toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.manifests).toHaveBeenCalledWith(
        'axial-patient-b',
        expect.objectContaining({ selectedPatientKey: 'patient-b', signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('shows one actionable refinement error while preserving the accepted result', async () => {
    const comparisonData = data('patient-a');
    mocks.hook.status = 'failed';
    mocks.hook.result = acceptedResult();
    mocks.hook.resultIdentity = identity(comparisonData);
    mocks.hook.error = 'This region exceeds the memory budget. The original selection is unchanged.';
    mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 600 * 1024 * 1024, maximumSizeInBytes: 600 * 1024 * 1024 });
    render(<Svr3DView data={comparisonData} />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(mocks.hook.error);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText(/exceeds the safe browser-memory budget/i)).not.toBeInTheDocument();
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconstruct volume' })).toBeDisabled());
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').closest('aside')).toBeNull();
  });

  it('distinguishes next-run estimates from the immutable accepted reconstruction', async () => {
    const comparisonData = data('patient-a');
    mocks.hook.status = 'ready';
    mocks.hook.result = acceptedResult();
    mocks.hook.resultIdentity = identity(comparisonData);

    render(<Svr3DView data={comparisonData} />);
    await openSourceDetails();

    await waitFor(() => {
      expect(screen.getByText('Next source data')).toBeInTheDocument();
    });

    expect(screen.getByText('Next conservative peak')).toBeInTheDocument();
    expect(screen.getByText('Next effective spacing')).toBeInTheDocument();
    expect(screen.getByText('Accepted reconstruction').parentElement).toHaveTextContent('1 × 1 × 1 voxels · 1.00 mm');
    expect(screen.queryByText('Acquired source data')).not.toBeInTheDocument();
    expect(screen.queryByText('Conservative peak')).not.toBeInTheDocument();
    expect(screen.queryByText('Effective voxel spacing')).not.toBeInTheDocument();
  });

  it('never renders an accepted volume against a changed source-data revision', async () => {
    const original = data('patient-a');
    mocks.hook.status = 'ready';
    mocks.hook.result = acceptedResult();
    mocks.hook.resultIdentity = identity(original);
    const { rerender } = render(<Svr3DView data={original} />);

    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();

    rerender(<Svr3DView data={{ ...original, dataset_revision: 8 }} />);

    expect(screen.queryByTestId('accepted-svr-volume')).not.toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.manifests).toHaveBeenCalled();
    });
  });

  it('automatically admits recoverable output quality without changing the requested manual settings', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) => {
      const source = manifest(seriesUid);
      return {
        ...source,
        frames: source.frames.map((frame) => ({ ...frame, rows: 1024, columns: 1024 })),
      };
    });
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });

    openReconstructionSettings();
    fireEvent.change(screen.getByLabelText(/max volume dim/i), { target: { value: '384' } });

    await waitFor(() => {
      expect(screen.getByText(/automatically adjusted to stay within the 512 mib memory budget/i)).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/voxel size/i)).toHaveValue(1);
    expect(screen.getByLabelText(/max volume dim/i)).toHaveValue(384);
    expect(screen.queryByText(/exceeds the safe browser-memory budget/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /reconstruct volume/i }));

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0]?.[1].params.targetVoxelSizeMm).toBeGreaterThan(1);
    expect(mocks.run.mock.calls[0]?.[1].params.maxVolumeDim).toBe(384);
  });

  it('still rejects reconstruction when the independently resident decoded cache cannot fit at any quality', async () => {
    mocks.cacheInfo.mockReturnValue({
      cacheSizeInBytes: 513 * 1024 * 1024,
      maximumSizeInBytes: 768 * 1024 * 1024,
    });

    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getAllByText(/exceeds the safe browser-memory budget/i).length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(screen.queryByText(/automatically adjusted/i)).not.toBeInTheDocument();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not reject a physically small scan solely because its maximum dimension is high', async () => {
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });

    openReconstructionSettings();
    fireEvent.change(screen.getByLabelText(/max volume dim/i), { target: { value: '384' } });

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });
    expect(screen.queryByText(/exceeds the safe browser-memory budget/i)).not.toBeInTheDocument();
  });

  it('enforces safe numeric reconstruction bounds even when typed values bypass input attributes', async () => {
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });

    openReconstructionSettings();
    const voxelSize = screen.getByLabelText(/voxel size/i);
    fireEvent.change(voxelSize, { target: { value: '0' } });
    expect(voxelSize).toHaveValue(0.1);
    fireEvent.change(voxelSize, { target: { value: '0.35' } });
    expect(voxelSize).toHaveValue(0.35);
    fireEvent.change(voxelSize, { target: { value: '999' } });
    expect(voxelSize).toHaveValue(10);
    expect(voxelSize).toHaveAttribute('max', '10');

    const iterations = screen.getByLabelText(/iterations/i);
    fireEvent.change(iterations, { target: { value: '99' } });
    expect(iterations).toHaveValue(10);
    fireEvent.change(iterations, { target: { value: '-2' } });
    expect(iterations).toHaveValue(0);

    const sliceDownsample = screen.getByLabelText(/slice downsample max/i);
    fireEvent.change(sliceDownsample, { target: { value: '1' } });
    expect(sliceDownsample).toHaveValue(32);
    fireEvent.change(sliceDownsample, { target: { value: '1024' } });
    expect(sliceDownsample).toHaveValue(512);

    const maxVolumeDimension = screen.getByLabelText(/max volume dim/i);
    fireEvent.change(maxVolumeDimension, { target: { value: '1' } });
    expect(maxVolumeDimension).toHaveValue(64);
    fireEvent.change(maxVolumeDimension, { target: { value: '1024' } });
    expect(maxVolumeDimension).toHaveValue(384);
  });

  it('counts the retained prior reconstruction before admitting another same-patient run', async () => {
    const original = data('patient-a');
    const previous = acceptedResult();
    // Model a legitimately large previous typed array without making this UI
    // regression itself reserve hundreds of MiB in every parallel test run.
    Object.defineProperty(previous.volume.data, 'byteLength', { value: 512 * 1024 * 1024 });
    mocks.hook.status = 'ready';
    mocks.hook.result = previous;
    mocks.hook.resultIdentity = identity(original);

    render(<Svr3DView data={original} />);

    await waitFor(() => {
      expect(screen.getAllByText(/clear the previous reconstruction/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Next reconstruction:');
    expect(screen.getByTestId('accepted-svr-volume')).toBeInTheDocument();
    openSources();
    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
