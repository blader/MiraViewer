import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useLayoutEffect, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer as ContextViewer, type SvrVolume3DViewerProps } from '../src/components/SvrVolume3DViewer';
import type * as OnnxHook from '../src/hooks/useOnnxTumorSession';
import type * as SegmentationEditor from '../src/components/SvrSegmentationEditor';
import { createSvrImagingOperations, SvrImagingContext, useSvrImaging } from '../src/components/svrImagingContext';
import { useSvrNativePlane } from '../src/hooks/useSvrNativePlane';
import type { SvrLabelVolume, SvrNativeSource, SvrVolume } from '../src/types/svr';
import type { VolumeSegmentationRow } from '../src/db/schema';
import { DatasetReplacedError } from '../src/db/db';
import { SavedSelectionChangedError } from '../src/db/volumeSegmentations';
import type { DecodedFrame } from '../src/utils/decodedFrame';
import {
  deleteVolumeSegmentation,
  getVolumeSegmentation,
  getVolumeSegmentationSnapshot,
  saveVolumeSegmentation,
} from '../src/utils/localApi';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { SVR3D_FOCAL_Z } from '../src/utils/svr/glRaymarch';
import { makeNativePlaneData, makeVolumePlaneData, nativeDisplayWindow } from '../src/utils/svr/nativePlane';
import { defaultVolumeWindow } from '../src/utils/svr/volumeDisplay';
import { runSuperResolution } from '../src/utils/svr/superResolutionWorker';
import type { SvrEnhancedVolume } from '../src/utils/svr/superResolutionTypes';
import type { EnhancementSourceLoader } from '../src/utils/svr/superResolutionRegion';
import type { SelectionProposer, SelectionProposalResult } from '../src/utils/segmentation/selectionProposal';
import {
  ENHANCED_TEXTURE_BYTES_PER_VOXEL,
  ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL,
} from '../src/utils/svr/enhancedVolumeBinding';
import { volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import type * as SelectionMigration from '../src/utils/svr/selectionMigration';
import { deferred } from './helpers/deferred';
import { paint, setAutoFill, proposedRegion, testSelectionProposer } from './helpers/selectionInteraction';
import {
  findTransferableSelection,
  transferSavedSelection,
  type SavedSelectionMigration,
} from '../src/utils/svr/selectionMigration';

vi.mock('../src/utils/svr/selectionMigration', async (importOriginal) => ({
  ...(await importOriginal<typeof SelectionMigration>()),
  findTransferableSelection: vi.fn(async () => ({
    candidate: null,
    retainedCount: 0,
    unavailableCount: 0,
    message: null,
  })),
  transferSavedSelection: vi.fn(),
}));

vi.mock('../src/hooks/useSvrNativePlane', () => ({
  useSvrNativePlane: vi.fn(() => ({ plane: null, loading: false, error: null })),
}));

vi.mock('../src/utils/svr/superResolutionWorker', () => ({ runSuperResolution: vi.fn() }));

const modelSession = vi.hoisted(() => ({
  cached: false,
  verified: false,
  loading: false,
  running: false,
  memoryBlocked: false,
  message: undefined as string | undefined,
  run: vi.fn(),
  selectFiles: vi.fn(),
  cancel: vi.fn(),
  retained: vi.fn(),
  proposer: vi.fn(),
}));

vi.mock('../src/components/SvrSegmentationEditor', async (importOriginal) => {
  const original = await importOriginal<typeof SegmentationEditor>();
  return {
    ...original,
    SvrSegmentationEditor: function RecordProposal(props: ComponentProps<typeof original.SvrSegmentationEditor>) {
      modelSession.proposer(useSvrImaging().proposeSelection);
      return <original.SvrSegmentationEditor {...props} />;
    },
  };
});

vi.mock('../src/hooks/useOnnxTumorSession', () => ({
  useOnnxTumorSession: (...args: Parameters<typeof OnnxHook.useOnnxTumorSession>) => {
    modelSession.retained(args[2]?.prepare);
    return {
      status: {
        cached: modelSession.cached,
        verified: modelSession.verified,
        savedAtMs: null,
        loading: modelSession.loading,
        message: modelSession.message,
      },
      preflight: modelSession.memoryBlocked
        ? { blockedByDefault: true, estimatedPeakBytes: 600 * 1024 ** 2, budgetBytes: 512 * 1024 ** 2 }
        : null,
      segRunning: modelSession.running,
      fileInputRef: { current: null },
      uploadClick: vi.fn(),
      handleSelectedFiles: modelSession.selectFiles,
      clearModel: vi.fn(),
      runSegmentation: () => {
        args[2]?.prepare?.();
        modelSession.run();
      },
      cancelSegmentation: modelSession.cancel,
    };
  },
}));

vi.mock('../src/utils/localApi', () => {
  const getVolumeSegmentation = vi.fn<(_key: string) => Promise<VolumeSegmentationRow | null>>(async () => null);
  return {
    deleteVolumeSegmentation: vi.fn(async () => undefined),
    getVolumeSegmentation,
    getVolumeSegmentationSnapshot: vi.fn(),
    saveVolumeSegmentation: vi.fn(async () => undefined),
  };
});

const observedVolume: SvrVolume = {
  data: new Float32Array([0.5, 0, 0.7, 0]),
  observedSupport: new Uint8Array([1, 0, 1, 0]),
  dims: [2, 2, 1],
  voxelSizeMm: [1, 1, 3],
  originMm: [0, 0, 0],
  boundsMm: { min: [0, 0, 0], max: [2, 2, 3] },
};

function SvrVolume3DViewer({
  volume,
  labels,
  initialSelection,
  busy,
  proposeSelection = testSelectionProposer,
  loadEnhancementSource,
  releaseSelectionRuntime,
  ...props
}: SvrVolume3DViewerProps & {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  initialSelection?: SvrLabelVolume;
  busy?: boolean;
  proposeSelection?: SelectionProposer;
  loadEnhancementSource?: EnhancementSourceLoader;
  releaseSelectionRuntime?: () => void;
}) {
  const [operations] = useState(createSvrImagingOperations);
  const propose = useCallback<SelectionProposer>(
    async (request) => {
      const snapshot = operations.prepare('selection', request);
      return proposeSelection({ ...request, retainedBytes: snapshot.retainedBytes });
    },
    [operations, proposeSelection],
  );
  useLayoutEffect(
    () =>
      operations.register('selection-runtime', (kind) => {
        if (kind !== 'selection') releaseSelectionRuntime?.();
        return {};
      }),
    [operations, releaseSelectionRuntime],
  );
  return (
    <SvrImagingContext.Provider
      value={{
        volume,
        labels,
        initialSelection,
        busy,
        proposeSelection: propose,
        loadEnhancementSource,
        operations,
      }}
    >
      <ContextViewer {...props} />
    </SvrImagingContext.Provider>
  );
}

function createViewportRecorder(
  viewport: { width: number; height: number },
  failures: { occupancyUpload?: boolean; nativeUpload?: boolean } = {},
) {
  const uniform1f = vi.fn<(location: unknown, value: number) => void>();
  const uniform1i = vi.fn<(location: unknown, value: number) => void>();
  let activeTexture = 33984;
  let occupancyUploadFailed = false;
  const volumeUploads: unknown[][] = [];
  const texImage3D = vi.fn((...args: unknown[]) => {
    if (activeTexture === 33984) volumeUploads.push(args);
    if (failures.occupancyUpload && activeTexture === 33987) occupancyUploadFailed = true;
  });
  const texSubImage3D = vi.fn();
  const texSubImage2D = vi.fn();
  const createProgram = vi.fn(() => ({}));
  let nativeUploadFailed = false;
  const texImage2D = vi.fn((...args: unknown[]) => {
    // Fail only actual native intensity uploads, not palettes or 1×1 placeholders.
    if (failures.nativeUpload && Number(args[3]) > 1 && Number(args[4]) > 1 && args[8] instanceof Float32Array)
      nativeUploadFailed = true;
  });
  const drawArrays = vi.fn();
  const axisText = vi.fn<(text: string, x: number, y: number) => void>();
  const axisOutline = vi.fn<(text: string, x: number, y: number) => void>();
  const matrices = new Map<string, number[]>();
  const vectors = new Map<string, number[]>();
  const axesContext = new Proxy(
    { fillText: axisText, strokeText: axisOutline, font: '' },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
  );
  const getError = vi.fn(() => {
    if (nativeUploadFailed) {
      nativeUploadFailed = false;
      return 1285;
    }
    if (occupancyUploadFailed) {
      occupancyUploadFailed = false;
      return 1285;
    }
    return 0;
  });
  const methods = {
    NO_ERROR: 0,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TEXTURE2: 33986,
    TEXTURE3: 33987,
    TEXTURE4: 33988,
    activeTexture: (texture: number) => {
      activeTexture = texture;
    },
    createShader: () => ({}),
    createProgram,
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => name,
    getParameter: () => 8192,
    getError,
    isContextLost: () => false,
    uniform1f,
    uniform1i,
    texImage3D,
    texSubImage3D,
    texImage2D,
    texSubImage2D,
    drawArrays,
    uniformMatrix3fv: (name: string, _transpose: boolean, value: Float32Array) => matrices.set(name, [...value]),
    uniform3f: (name: string, x: number, y: number, z: number) => vectors.set(name, [x, y, z]),
  };
  const gl = new Proxy(methods, {
    get(target, property: string) {
      if (property in target) return target[property as keyof typeof target];
      return property === property.toUpperCase() ? 1 : () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;

  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewport.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport.height);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, id: string) {
    return id === 'webgl2' ? gl : id === '2d' && this.getAttribute('aria-hidden') === 'true' ? axesContext : null;
  } as typeof HTMLCanvasElement.prototype.getContext);

  return {
    createProgram,
    getError,
    texImage3D,
    volumeUploads,
    texSubImage3D,
    texImage2D,
    texSubImage2D,
    drawArrays,
    axisText,
    axisOutline,
    axesFont: () => axesContext.font,
    latestMatrix: (name: string) => matrices.get(name),
    latestVector: (name: string) => vectors.get(name),
    uniform1f,
    latestFloat: (name: string) => uniform1f.mock.calls.filter(([location]) => location === name).at(-1)?.[1],
    latestInteger: (name: string) => uniform1i.mock.calls.filter(([location]) => location === name).at(-1)?.[1],
    latestZoom: () => uniform1f.mock.calls.filter(([location]) => location === 'u_zoom').at(-1)?.[1],
  };
}

/** Project using the actual shader uniforms, not the camera-fitting implementation. */
function projectBoxCorners(
  recorder: ReturnType<typeof createViewportRecorder>,
  min: readonly number[],
  max: readonly number[],
  aspect: number,
) {
  const inverse = recorder.latestMatrix('u_invRot')!;
  const center = recorder.latestVector('u_cameraCenter')!;
  const distance = recorder.latestFloat('u_cameraZ')!;
  const zoom = recorder.latestZoom()!;
  return [min[0]!, max[0]!].flatMap((x) =>
    [min[1]!, max[1]!].flatMap((y) =>
      [min[2]!, max[2]!].map((z) => {
        const offset = [x - center[0]!, y - center[1]!, z - center[2]!];
        const view = [0, 3, 6].map(
          (start) => inverse[start]! * offset[0]! + inverse[start + 1]! * offset[1]! + inverse[start + 2]! * offset[2]!,
        );
        const depth = distance - view[2]!;
        expect(depth).toBeGreaterThan(0);
        return [(view[0]! * SVR3D_FOCAL_Z * zoom) / (depth * aspect), (view[1]! * SVR3D_FOCAL_Z * zoom) / depth];
      }),
    ),
  );
}

function syntheticVolume(boxScale: readonly [number, number, number]): SvrVolume {
  return {
    ...observedVolume,
    data: new Float32Array(64).fill(0.5),
    observedSupport: new Uint8Array(64).fill(1),
    dims: [4, 4, 4],
    voxelSizeMm: [boxScale[0], boxScale[1], boxScale[2]],
  };
}

const identity = { patientKey: 'patient', studyUid: 'study', seriesUids: ['source'] };

function editingVolume(size = 12): SvrVolume {
  return {
    ...syntheticVolume([1, 1, 1]),
    dims: [size, size, size],
    data: new Float32Array(size ** 3).fill(0.5),
    observedSupport: new Uint8Array(size ** 3).fill(1),
  };
}

/** The worker is mocked; real UI, source cropping, presentation and persistence stay integrated. */
function enhancedFixture(source: SvrVolume): SvrEnhancedVolume {
  const dims = source.dims.map((size) => size * 2) as [number, number, number];
  return {
    ...source,
    data: new Float32Array(dims[0] * dims[1] * dims[2]).fill(0.55),
    observedSupport: new Uint8Array(dims[0] * dims[1] * dims[2]).fill(1),
    dims,
    voxelSizeMm: source.voxelSizeMm.map((pitch) => pitch / 2) as [number, number, number],
    originMm: volumeVoxelToPatient(source, [-0.25, -0.25, -0.25]),
    stats: {
      method: 'synthetic-UI-worker-fixture',
      trainingSamples: 100,
      calibrationSamples: 20,
      heldOutSamples: 20,
      trainingBlocks: 5,
      calibrationBlocks: 2,
      heldOutBlocks: 2,
      baselineMse: 1,
      enhancedMse: 0.8,
      consistencyMaxError: 0,
      durationMs: 100,
      modelStrength: 1,
    },
  };
}
function nativeViewerFixture(orientation: 'sagittal' | 'axial' | 'oblique' = 'sagittal') {
  const volume = editingVolume(4);
  const source: SvrNativeSource = {
    seriesUid: 'native-source',
    label: `Original ${orientation} source`,
    kind: 'original-3d',
    transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translationMm: [0, 0, 0] },
    contributingSopInstanceUids: ['native-0', 'native-1', 'native-2', 'native-3'],
    frames: [0, 1, 2, 3].map((slice) => ({
      sopInstanceUid: `native-${slice}`,
      rows: 4,
      columns: 4,
      originMm:
        orientation === 'axial'
          ? [0, 3, slice]
          : orientation === 'oblique'
            ? [-slice * Math.SQRT1_2, slice * Math.SQRT1_2, 3]
            : [slice, 0, 3],
      columnDirection:
        orientation === 'axial' ? [1, 0, 0] : orientation === 'oblique' ? [Math.SQRT1_2, Math.SQRT1_2, 0] : [0, 1, 0],
      rowDirection: orientation === 'axial' ? [0, -1, 0] : [0, 0, -1],
      pixelSpacingMm: [1, 1],
    })),
  };
  volume.reconstructionFingerprint = 'native-test';
  volume.sourceProvenance = {
    mode: 'native-3d',
    datasetRevision: 1,
    patientKey: 'patient',
    studyUid: 'study',
    frameOfReferenceUid: 'frame',
    fingerprint: 'native-test',
    primarySeriesUid: source.seriesUid,
    sources: [source],
    explanation: 'Original-source test volume',
  };
  const pixels = Float32Array.from({ length: 16 }, (_, index) => -100 + index * 10);
  const plane = makeNativePlaneData(volume, source, 2, {
    pixels,
    validity: new Float32Array(16).fill(1),
    rows: 4,
    cols: 4,
    imageId: 'miradb:native-2',
    sopInstanceUid: 'native-2',
    seriesUid: source.seriesUid,
    windowCenter: 0,
    windowWidth: 201,
  });
  return { volume, plane, pixels };
}

function rawNativeViewerFixture(mode: 'native-3d' | 'source-stack', intensityRange: [number, number] = [-100, 1100]) {
  const { volume, plane: original } = nativeViewerFixture('axial');
  const [low, high] = intensityRange;
  volume.data = Float32Array.from({ length: 64 }, (_, index) => low + ((index % 16) * (high - low)) / 15);
  volume.intensityRange = intensityRange;
  volume.sourceProvenance = { ...volume.sourceProvenance!, mode };
  original.source.kind = mode === 'native-3d' ? 'original-3d' : 'original-2d';
  // The acquired axial frame is z=2, with native rows running opposite volume y.
  const pixels = Float32Array.from(
    { length: 16 },
    (_, index) => volume.data[(2 * 4 + 3 - Math.floor(index / 4)) * 4 + (index % 4)]!,
  );
  const plane = makeNativePlaneData(volume, original.source, 2, { ...original.image, pixels });
  volume.displayWindow = [...plane.windowRange];
  return { volume, plane, pixels };
}

function openSelectionEditor() {
  fireEvent.click(screen.getByRole('button', { name: /^(Select tissue|Edit selection|View slices)$/ }));
}
function open3DSettings(section?: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
  if (section) fireEvent.click(within(screen.getByRole('complementary', { name: '3D settings' })).getByText(section));
}
function recordSlices() {
  let imageAllocations = 0;
  const contexts = new Map<
    HTMLCanvasElement,
    {
      createImageData: (width: number, height: number) => ImageData;
      putImageData: ReturnType<typeof vi.fn>;
      drawImage: ReturnType<typeof vi.fn>;
    }
  >();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, id: string) {
    if (id !== '2d') return null;
    if (!contexts.has(this))
      contexts.set(
        this,
        new Proxy(
          {
            createImageData: (width: number, height: number) => {
              imageAllocations++;
              return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
            },
            putImageData: vi.fn(),
            drawImage: vi.fn(),
          },
          { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
        ),
      );
    return contexts.get(this);
  } as typeof HTMLCanvasElement.prototype.getContext);
  return Object.assign(
    (plane: string) => {
      const canvas = screen.getByRole('application', {
        name: new RegExp(plane + ' reconstructed slice', 'i'),
      }) as HTMLCanvasElement;
      const draw = contexts.get(canvas)?.drawImage.mock.lastCall;
      const image = contexts.get(draw?.[0])?.putImageData.mock.lastCall?.[0] as ImageData;
      return {
        canvas,
        image,
        width: draw?.[3] as number,
        height: draw?.[4] as number,
        drawImage: contexts.get(canvas)!.drawImage,
        sourceWrites: contexts.get(draw?.[0])!.putImageData,
      };
    },
    { imageAllocations: () => imageAllocations },
  );
}
beforeEach(() => {
  testSelectionProposer.mockReset();
  vi.clearAllMocks();
  Object.assign(modelSession, {
    cached: false,
    verified: false,
    loading: false,
    running: false,
    memoryBlocked: false,
    message: undefined,
  });
  vi.mocked(useSvrNativePlane).mockReset().mockReturnValue({ plane: null, loading: false, error: null });
  vi.mocked(getVolumeSegmentation).mockReset().mockResolvedValue(null);
  vi.mocked(getVolumeSegmentationSnapshot)
    .mockReset()
    .mockImplementation(async (key: string) => {
      const record = await getVolumeSegmentation(key);
      return { record, revision: record ? 'saved-revision' : null, datasetToken: 'test-dataset-token' };
    });
  vi.mocked(saveVolumeSegmentation).mockReset().mockResolvedValue(undefined);
  vi.mocked(findTransferableSelection).mockReset().mockResolvedValue({
    candidate: null,
    retainedCount: 0,
    unavailableCount: 0,
    message: null,
  });
  vi.mocked(transferSavedSelection).mockReset();
  vi.mocked(runSuperResolution).mockReset().mockRejectedValue(new Error('Unexpected enhancement-worker invocation'));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SvrVolume3DViewer evidence-aware interaction', () => {
  const migration: SavedSelectionMigration = {
    candidate: {
      record: { volumeKey: 'previous-grid', updatedAt: 1 },
    },
    retainedCount: 1,
    unavailableCount: 0,
    message: 'A saved selection from another grid can be copied as a draft. Its original remains saved.',
  };
  function transferredSelection(volume: SvrVolume): SvrLabelVolume {
    const data = new Uint8Array(volume.data.length);
    data[30] = 1;
    return {
      dims: volume.dims,
      data,
      meta: SELECTION_LABEL_META,
      seeds: { foreground: new Uint32Array([30]), background: new Uint32Array([32]) },
      reviewState: 'draft',
    };
  }

  it('copies another grid only on request and saves the result as a draft without deleting the original', async () => {
    const volume = editingVolume();
    const selection = transferredSelection(volume);
    vi.mocked(findTransferableSelection).mockResolvedValue(migration);
    vi.mocked(transferSavedSelection).mockResolvedValue(selection);
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    const copy = await screen.findByRole('button', { name: 'Copy saved selection as draft' });
    expect(transferSavedSelection).not.toHaveBeenCalled();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    fireEvent.click(copy);
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels).toBe(selection.data));
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('draft');
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].seeds?.foreground).toEqual(new Uint32Array([30]));
    expect(deleteVolumeSegmentation).not.toHaveBeenCalledWith('previous-grid');
    openSelectionEditor();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('retains older unverifiable selections without offering an unsafe transfer', async () => {
    vi.mocked(findTransferableSelection).mockResolvedValue({
      candidate: null,
      retainedCount: 2,
      unavailableCount: 2,
      message: 'Two older selections remain saved; their source registration cannot be verified.',
    });
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    expect(await screen.findByText(/Two older selections remain saved/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy saved selection as draft' })).not.toBeInTheDocument();
    expect(transferSavedSelection).not.toHaveBeenCalled();
  });

  it('cancels a pending transfer immediately and ignores a late completion', async () => {
    const volume = editingVolume();
    let complete!: (value: SvrLabelVolume) => void;
    vi.mocked(findTransferableSelection).mockResolvedValue(migration);
    vi.mocked(transferSavedSelection).mockReturnValue(new Promise((resolve) => (complete = resolve)));
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy saved selection as draft' }));
    const signal = vi.mocked(transferSavedSelection).mock.lastCall?.[4];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel copy' }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy saved selection as draft' })).toBeEnabled();
    await act(async () => complete(transferredSelection(volume)));
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
  });

  it('rejects a transfer completed after the dataset identity changes even if the volume is retained', async () => {
    const volume = editingVolume();
    let complete!: (value: SvrLabelVolume) => void;
    vi.mocked(findTransferableSelection).mockResolvedValue(migration);
    vi.mocked(transferSavedSelection).mockReturnValue(new Promise((resolve) => (complete = resolve)));
    const view = render(<SvrVolume3DViewer volume={volume} volumeIdentity={{ ...identity, datasetRevision: 1 }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy saved selection as draft' }));
    const signal = vi.mocked(transferSavedSelection).mock.lastCall?.[4];
    view.rerender(<SvrVolume3DViewer volume={volume} volumeIdentity={{ ...identity, datasetRevision: 2 }} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => complete(transferredSelection(volume)));
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
  });

  it('keeps the original selection available after a failed copy', async () => {
    vi.mocked(findTransferableSelection).mockResolvedValue(migration);
    vi.mocked(transferSavedSelection).mockRejectedValue(new Error('A hard mark is outside the supported region.'));
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy saved selection as draft' }));
    expect(await screen.findByText(/A hard mark is outside the supported region/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy saved selection as draft' })).toBeEnabled();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    expect(deleteVolumeSegmentation).not.toHaveBeenCalledWith('previous-grid');
  });

  it.each([12, 180])('accepts an editable restored selection on a %i-cubed reconstruction', async (size) => {
    const volume = editingVolume(size);
    const labels = new Uint8Array(volume.data.length);
    labels[30] = 1;
    vi.mocked(getVolumeSegmentation).mockResolvedValueOnce({
      volumeKey: 'test',
      dims: volume.dims,
      labels,
      reviewState: 'draft',
      seeds: { foreground: new Uint32Array([30]), background: new Uint32Array([32]) },
      classMetadata: [{ id: 1, name: 'Selected tissue', color: [103, 207, 193] }],
      updatedAt: 0,
    });
    render(
      <SvrVolume3DViewer
        volume={volume}
        volumeIdentity={{ studyUid: 'synthetic', seriesUids: ['synthetic-source'] }}
      />,
    );
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels).toBe(labels);
  });

  it('fits the physical reconstruction box to landscape and portrait viewports without clipping', async () => {
    const viewport = { width: 1472, height: 972 };
    const recorder = createViewportRecorder(viewport);
    const view = render(<SvrVolume3DViewer volume={syntheticVolume([1, 1, 1])} />);

    for (const [boxScale, width, height] of [
      [[1, 1, 1], 1472, 972],
      [[1, 0.25, 0.5], 1200, 800],
      [[1, 0.45, 0.25], 500, 900],
    ] as const) {
      viewport.width = width;
      viewport.height = height;
      recorder.uniform1f.mockClear();
      view.rerender(<SvrVolume3DViewer volume={syntheticVolume(boxScale)} />);
      await waitFor(() => expect(recorder.latestZoom()).toBeDefined());
      const corners = projectBoxCorners(
        recorder,
        boxScale.map((size) => -size / 2),
        boxScale.map((size) => size / 2),
        width / height,
      );
      const extent = Math.max(...corners.flat().map(Math.abs));
      expect(extent).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(extent).toBeCloseTo(0.9);
    }
  });

  it('fits acquired visible anatomy instead of padded reconstruction bounds in landscape and portrait', async () => {
    const dims: [number, number, number] = [96, 80, 112];
    const createPaddedVolume = (): SvrVolume => {
      const data = new Float32Array(dims[0] * dims[1] * dims[2]);
      const observedSupport = new Uint8Array(data.length).fill(1);
      for (let z = 28; z < 84; z++) {
        for (let y = 20; y < 60; y++) {
          for (let x = 24; x < 72; x++) {
            data[z * dims[0] * dims[1] + y * dims[0] + x] = 0.6;
          }
        }
      }
      return {
        ...observedVolume,
        data,
        observedSupport,
        dims,
        voxelSizeMm: [1, 1, 1],
        boundsMm: { min: [0, 0, 0], max: dims },
      };
    };

    const viewport = { width: 1472, height: 972 };
    const recorder = createViewportRecorder(viewport);
    const view = render(<SvrVolume3DViewer volume={createPaddedVolume()} />);
    const visibleMin = [24, 20, 28].map((value, axis) => (value - dims[axis]! / 2) / dims[2]);
    const visibleMax = [72, 60, 84].map((value, axis) => (value - dims[axis]! / 2) / dims[2]);

    for (const [width, height] of [
      [1472, 972],
      [500, 900],
    ] as const) {
      viewport.width = width;
      viewport.height = height;
      recorder.uniform1f.mockClear();
      view.rerender(<SvrVolume3DViewer volume={createPaddedVolume()} />);
      await waitFor(() => expect(recorder.latestZoom()).toBeDefined());

      const corners = projectBoxCorners(recorder, visibleMin, visibleMax, width / height);
      const extent = Math.max(...corners.flat().map(Math.abs));
      expect(extent).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(extent).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('keeps later user zoom relative to the physically fitted diagnostic view', async () => {
    const recorder = createViewportRecorder({ width: 1440, height: 900 });
    render(<SvrVolume3DViewer volume={syntheticVolume([1, 0.75, 0.5])} />);
    await waitFor(() => expect(recorder.latestZoom()).toBeDefined());
    const fittedZoom = recorder.latestZoom()!;
    const corners = projectBoxCorners(recorder, [-0.5, -0.375, -0.25], [0.5, 0.375, 0.25], 1440 / 900);
    expect(Math.max(...corners.flat().map(Math.abs))).toBeCloseTo(0.9);

    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    fireEvent.keyDown(viewer, { key: '+' });
    await waitFor(() => expect(recorder.latestZoom()).toBeCloseTo(fittedZoom * 1.15));

    fireEvent.keyDown(viewer, { key: '0' });
    await waitFor(() => expect(recorder.latestZoom()).toBeCloseTo(fittedZoom));
  });

  it('hides unavailable rendering, lesion, and ONNX controls before reconstruction exists', () => {
    render(<SvrVolume3DViewer volume={null} />);

    expect(screen.queryByRole('button', { name: 'Show 3D settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select tissue' })).not.toBeInTheDocument();
    expect(screen.queryByText('Custom model', { selector: 'summary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enhance selection/ })).not.toBeInTheDocument();
  });

  it('explains tumor isolation and keeps label-dependent views unavailable until observed tumor exists', async () => {
    render(<SvrVolume3DViewer volume={observedVolume} />);

    expect(screen.getByRole('heading', { name: '3D volume' })).toBeInTheDocument();
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /region visualization/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overlay' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Selection only' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enhance selection/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    expect(screen.queryByText('Slice settings', { selector: 'summary' })).not.toBeInTheDocument();
    openSelectionEditor();
    expect(screen.getByText(/Auto-fill follows your brush/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
  });

  it('focuses the disclosed 3D settings and restores its trigger after Escape or close', async () => {
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    const trigger = screen.getByRole('button', { name: 'Show 3D settings' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary', { name: '3D settings' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const settings = screen.getByRole('complementary', { name: '3D settings' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(settings).toHaveFocus();
    expect(within(settings).getByRole('region', { name: '3D appearance' })).toBeInTheDocument();
    fireEvent.keyDown(settings, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '3D settings' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute('data-editing', 'false');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close 3D settings' }));
    expect(screen.queryByRole('complementary', { name: '3D settings' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('reclaims interactive sessions before custom inference or upload, without a separate initialization step', async () => {
    modelSession.cached = true;
    modelSession.verified = true;
    const release = vi.fn();
    modelSession.run.mockImplementationOnce(() => expect(release).toHaveBeenCalledOnce());
    const { container } = render(<SvrVolume3DViewer volume={editingVolume()} releaseSelectionRuntime={release} />);
    expect(screen.queryByRole('button', { name: 'Suggest with model' })).not.toBeInTheDocument();
    open3DSettings('Custom model');
    expect(screen.queryByRole('button', { name: /init/i })).not.toBeInTheDocument();
    const suggest = screen.getByRole('button', { name: 'Suggest with model' });
    expect(suggest).toBeEnabled();
    fireEvent.click(suggest);
    expect(modelSession.run).toHaveBeenCalledOnce();
    const files = [new File([Uint8Array.of(1)], 'synthetic-model.onnx'), new File(['{}'], 'manifest.json')];
    modelSession.selectFiles.mockImplementationOnce((selected) => {
      expect(release).toHaveBeenCalledTimes(2);
      expect(selected).toEqual(files);
    });
    fireEvent.change(container.querySelector('input[type="file"][accept=".onnx,.json"]')!, { target: { files } });
    expect(modelSession.selectFiles).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it.each(['unverified', 'loading', 'model running', 'reconstructing', 'memory'] as const)(
    'gates model actions during %s, with fresh admission available after a memory rejection',
    async (blocked) => {
      modelSession.cached = true;
      modelSession.verified = blocked !== 'unverified';
      modelSession.loading = blocked === 'loading';
      modelSession.running = blocked === 'model running';
      modelSession.memoryBlocked = blocked === 'memory';
      render(<SvrVolume3DViewer volume={editingVolume()} busy={blocked === 'reconstructing'} />);
      open3DSettings('Custom model');
      const suggest = screen.getByRole('button', { name: 'Suggest with model' });
      if (blocked === 'memory') {
        expect(suggest).toBeEnabled();
        fireEvent.click(suggest);
        expect(modelSession.run).toHaveBeenCalledOnce();
      } else {
        expect(suggest).toBeDisabled();
        fireEvent.click(suggest);
        expect(modelSession.run).not.toHaveBeenCalled();
      }
      if (blocked === 'model running') {
        fireEvent.click(screen.getByRole('button', { name: 'Close 3D settings' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel model suggestion' }));
        expect(modelSession.cancel).toHaveBeenCalledOnce();
      }
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
    },
  );

  it('isolates supported tumor or restores anatomy without reallocating the accepted label texture', async () => {
    const recorder = createViewportRecorder({ width: 1440, height: 900 });
    const acceptedLabels = new Uint8Array([1, 0, 1, 0]);
    render(
      <SvrVolume3DViewer
        volume={observedVolume}
        labels={{
          data: acceptedLabels,
          dims: observedVolume.dims,
          meta: [{ id: 1, name: 'Observed tumor', color: [192, 156, 106] }],
        }}
      />,
    );

    // The visibility uniform can be submitted before the passive upload effect.
    // Begin the no-reallocation assertion only once the actual accepted bytes are resident.
    await waitFor(() => expect(recorder.texImage3D.mock.calls.some((call) => call[9] === acceptedLabels)).toBe(true));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(1));
    const controls = screen.getByRole('group', { name: /region visualization/i });
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toHaveAttribute('aria-pressed', 'true');
    const initialTextureAllocations = recorder.texImage3D.mock.calls.length;

    fireEvent.click(within(controls).getByRole('button', { name: 'Selection only' }));
    await waitFor(() => expect(recorder.latestInteger('u_tumorOnly')).toBe(1));
    expect(within(controls).getByRole('button', { name: 'Selection only' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(controls).getByRole('button', { name: 'Anatomy' }));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(0));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);

    fireEvent.click(within(controls).getByRole('button', { name: 'Overlay' }));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(1));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
    expect(recorder.texImage3D).toHaveBeenCalledTimes(initialTextureAllocations);
  });

  it('does not redraw unchanged pixels for model-status updates, but still redraws display changes', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { rerender } = render(<SvrVolume3DViewer volume={observedVolume} />);
    await waitFor(() => expect(recorder.drawArrays).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    const draws = recorder.drawArrays.mock.calls.length;

    for (const message of ['Loading model', 'Running model', 'Model canceled']) {
      modelSession.message = message;
      rerender(<SvrVolume3DViewer volume={observedVolume} />);
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(recorder.drawArrays).toHaveBeenCalledTimes(draws);
    }

    fireEvent.click(screen.getByRole('button', { name: 'MRI slice', exact: true }));
    await waitFor(() => expect(recorder.drawArrays.mock.calls.length).toBeGreaterThan(draws));
    expect(recorder.latestInteger('u_nativeEnabled')).toBe(0);
  });

  it('announces graphics-context loss and waits for safe restoration', async () => {
    render(<SvrVolume3DViewer volume={observedVolume} />);
    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });

    fireEvent(viewer, new Event('webglcontextlost', { cancelable: true }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/graphics context was lost/i));
  });

  it('surfaces an occupancy-texture upload failure while preserving accepted slice inspection', async () => {
    const recorder = createViewportRecorder({ width: 1440, height: 900 }, { occupancyUpload: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={observedVolume} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/gpu.*empty-space acceleration/i));
    expect(recorder.getError.mock.results.some((call) => call.value === 1285)).toBe(true);
    openSelectionEditor();
    expect(screen.getByRole('application', { name: /axial reconstructed slice/i })).toBeInTheDocument();
    open3DSettings('Volume details');
    expect(screen.getByText(/acquired support: 2 of 4 voxels/i)).toBeInTheDocument();
  });

  it('recovers ordinary volume rendering when a failed native MRI texture is disabled', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 }, { nativeUpload: true });
    const { volume, pixels, plane } = nativeViewerFixture();
    // Keep a decoded result available even after disable to exercise the renderer's
    // own enable gate, independently of the hook's normal stale-result suppression.
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/gpu.*original MRI plane.*native resolution/i),
    );
    const nativeUploads = () => recorder.texImage2D.mock.calls.filter((args) => args[8] === pixels).length;
    expect(nativeUploads()).toBeGreaterThan(0);
    const failedUploads = nativeUploads();
    const volumeAllocations = recorder.texImage3D.mock.calls.length;
    const drawCount = recorder.drawArrays.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'MRI slice', exact: true }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(recorder.latestInteger('u_nativeEnabled')).toBe(0);
      expect(recorder.drawArrays.mock.calls.length).toBeGreaterThan(drawCount);
    });
    expect(vi.mocked(useSvrNativePlane).mock.lastCall?.[0].volume).toBeNull();
    expect(screen.getByRole('button', { name: 'MRI slice', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(nativeUploads()).toBe(failedUploads);
    expect(recorder.texImage3D).toHaveBeenCalledTimes(volumeAllocations);
    openSelectionEditor();
    expect(screen.getByRole('application', { name: /axial reconstructed slice/i })).toBeInTheDocument();
  });

  it.each(['crop', 'reorder', 'different examination'] as const)(
    'keeps the chosen native series by identity across %s, using the new primary only when absent',
    async (change) => {
      createViewportRecorder({ width: 800, height: 600 });
      const { volume } = nativeViewerFixture();
      const sagittal = volume.sourceProvenance!.sources[0]!;
      const axial: SvrNativeSource = {
        ...sagittal,
        seriesUid: 'native-axial',
        label: 'Axial reformat',
        kind: 'derived',
        frames: sagittal.frames.map((frame, index) => ({
          ...frame,
          sopInstanceUid: `axial-${index}`,
          originMm: [0, 0, index],
          columnDirection: [1, 0, 0],
          rowDirection: [0, 1, 0],
        })),
      };
      volume.sourceProvenance = { ...volume.sourceProvenance!, sources: [sagittal, axial] };
      const { rerender } = render(<SvrVolume3DViewer volume={volume} />);
      open3DSettings('Source image');
      fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane source' }), { target: { value: '1' } });
      expect(screen.getByRole('combobox', { name: 'MRI plane source' })).toHaveValue('1');
      expect(vi.mocked(useSvrNativePlane).mock.lastCall![0].sourceIndex).toBe(1);

      const next: SvrVolume = {
        ...volume,
        data: volume.data.slice(),
        sourceProvenance: { ...volume.sourceProvenance },
      };
      if (change === 'crop') {
        next.dims = [2, 4, 2];
        next.data = volume.data.slice(0, 16);
        next.observedSupport = new Uint8Array(16).fill(1);
        next.originMm = [1, 0, 1];
        next.boundsMm = { min: [0.5, -0.5, 0.5], max: [2.5, 3.5, 2.5] };
      } else if (change === 'reorder') {
        next.sourceProvenance!.sources = [axial, sagittal];
      } else {
        next.sourceProvenance = {
          ...next.sourceProvenance!,
          patientKey: 'other-patient',
          studyUid: 'other-study',
          primarySeriesUid: 'other-primary',
          sources: [
            { ...sagittal, seriesUid: 'other-primary', label: 'Other original' },
            { ...axial, seriesUid: 'other-axial', label: 'Other axial' },
          ],
        };
      }
      rerender(<SvrVolume3DViewer volume={next} />);
      const expectedIndex = change === 'crop' ? 1 : 0;
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'MRI plane source' })).toHaveValue(String(expectedIndex)),
      );
      expect(vi.mocked(useSvrNativePlane).mock.lastCall![0]).toMatchObject({
        volume: next,
        sourceIndex: expectedIndex,
      });
      expect(volume.sourceProvenance.sources).toEqual([sagittal, axial]);
    },
  );

  it('discards obsolete window and cursor owners instead of resurrecting them after A to B to A replacement', async () => {
    createViewportRecorder({ width: 800, height: 600 });
    const a = nativeViewerFixture(),
      b = nativeViewerFixture();
    // These normalized reconstructions and raw acquired planes have independent domains.
    a.volume.sourceProvenance!.mode = 'independent-2d';
    b.volume.sourceProvenance!.mode = 'independent-2d';
    a.volume.displayWindow = [0.1, 0.9];
    b.volume.displayWindow = [0.2, 0.6];
    vi.mocked(useSvrNativePlane).mockImplementation(({ volume }) => ({
      plane: volume === a.volume ? a.plane : volume === b.volume ? b.plane : null,
      loading: false,
      error: null,
    }));
    const { rerender } = render(<SvrVolume3DViewer volume={a.volume} />);
    openSelectionEditor();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    open3DSettings('Source image');
    const value = (label: string) => Number((screen.getByLabelText(label) as HTMLInputElement).value);
    await waitFor(() => expect(screen.getByLabelText('Original MRI window width')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('MRI window width'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Original MRI window width'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Axial slice'), { target: { value: '1' } });
    expect(value('MRI window width')).toBeCloseTo(0.3);
    expect(value('Original MRI window width')).toBe(80);
    expect(value('Axial slice')).toBe(1);

    rerender(<SvrVolume3DViewer volume={b.volume} />);
    expect(value('MRI window width')).toBeCloseTo(0.4);
    expect(value('Axial slice')).toBe(3);
    rerender(<SvrVolume3DViewer volume={a.volume} />);
    await waitFor(() => expect(value('MRI window width')).toBeCloseTo(0.8));
    expect(value('Original MRI window width')).toBeCloseTo(a.plane.windowRange[1] - a.plane.windowRange[0]);
    expect(value('Axial slice')).toBe(3);
  });

  it('contains resident-plane validation failures in the plane notice without unmounting the viewer', async () => {
    createViewportRecorder({ width: 800, height: 600 });
    const { volume } = nativeViewerFixture();
    volume.sourceProvenance = undefined;
    volume.observedSupport = new Uint8Array(1);
    render(<SvrVolume3DViewer volume={volume} />);
    expect(
      await screen.findByText('The MRI reformat does not match a slice of the resident volume.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 3D settings' })).toBeInTheDocument();
  });

  it('defaults to exact source pixels and switches to disclosed blending without reuploading the image', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture();
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeExact')).toBe(1));
    const uploads = recorder.texImage2D.mock.calls.length;
    open3DSettings('Source image');
    expect(screen.getByLabelText('Interpolate display')).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane presentation' }), {
      target: { value: 'blended' },
    });
    await waitFor(() => expect(recorder.latestInteger('u_nativeExact')).toBe(0));
    expect(screen.getByText(/Display luminance is not the calibrated source window/)).toBeInTheDocument();
    expect(recorder.texImage2D.mock.calls.length).toBe(uploads);
    fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane presentation' }), { target: { value: 'exact' } });
    await waitFor(() => expect(recorder.latestInteger('u_nativeExact')).toBe(1));
  });

  it.each([
    { mode: 'native-3d', range: [10, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'source-stack', range: [10, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'independent-2d', range: [10, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'native-3d', range: [NaN, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'source-stack', range: [-Infinity, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'native-3d', range: [10, Infinity], stored: [30, 40], expected: [30, 40] },
    { mode: 'source-stack', range: [90, 90], stored: [30, 40], expected: [30, 40] },
    { mode: 'native-3d', range: [90, 10], stored: [30, 40], expected: [30, 40] },
    { mode: 'native-3d', range: undefined, stored: [30, 40], expected: [30, 40] },
    { mode: 'source-stack', range: undefined, stored: undefined, expected: [0, 1] },
    { mode: 'native-3d', range: [10, 90], stored: undefined, expected: [10, 90] },
    { mode: 'native-3d', range: [10, 90], stored: [NaN, 50], expected: [10, 90] },
    { mode: 'native-3d', range: [10, 90], stored: [50, 30], expected: [10, 90] },
    { mode: 'native-3d', range: [10, 90], stored: [30, 30], expected: [30, 30] },
  ] as const)('chooses the $mode default window for measured range $range', ({ mode, range, stored, expected }) => {
    const { volume } = nativeViewerFixture();
    volume.sourceProvenance!.mode = mode;
    volume.intensityRange = range ? [...range] : undefined;
    volume.displayWindow = stored ? [...stored] : undefined;
    expect(defaultVolumeWindow(volume)).toEqual(expected);
  });

  it.each([
    { mode: 'native-3d', invert: false },
    { mode: 'source-stack', invert: true },
  ] as const)(
    'shares raw $mode contrast in both directions and resets without changing acquired or selection data',
    async ({ mode, invert }) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const { volume, plane, pixels } = rawNativeViewerFixture(mode);
      volume.displayInvert = invert;
      plane.image.invert = invert;
      plane.invert = invert;
      vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
      const selection: SvrLabelVolume = {
        data: new Uint8Array(volume.data.length),
        dims: volume.dims,
        meta: SELECTION_LABEL_META,
        seeds: { foreground: Uint32Array.of(42), background: Uint32Array.of(43) },
      };
      selection.data[42] = 1;
      const sourceValues = volume.data.slice();
      const sourcePixels = pixels.slice();
      const sourceSupport = volume.observedSupport!.slice();
      const sourceValidity = plane.image.validity.slice();
      const sourceLabels = selection.data.slice();
      const sourceWindow = [...volume.displayWindow!];
      const sourcePlaneWindow = [...plane.windowRange];
      const sourceVoi = [plane.image.windowCenter, plane.image.windowWidth, plane.image.invert];
      render(<SvrVolume3DViewer volume={volume} initialSelection={selection} />);
      openSelectionEditor();
      fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
      open3DSettings('Source image');
      const input = (label: string) => screen.getByRole('slider', { name: label }) as HTMLInputElement;
      const expectWindow = async (low: number, high: number) => {
        const span = volume.intensityRange![1] - volume.intensityRange![0];
        const gpuLow = invert
          ? 1 - (high - volume.intensityRange![0]) / span
          : (low - volume.intensityRange![0]) / span;
        const gpuWidth = (high - low) / span;
        await waitFor(() => {
          for (const prefix of ['MRI', 'Original MRI']) {
            expect(Number(input(`${prefix} window width`).value)).toBeCloseTo(high - low);
            expect(Number(input(`${prefix} window level`).value)).toBeCloseTo((low + high) / 2);
          }
          expect(recorder.latestFloat('u_nativeWindowLow')).toBeCloseTo(low);
          expect(recorder.latestFloat('u_nativeWindowWidth')).toBeCloseTo(high - low);
          expect(recorder.latestFloat('u_windowLow')).toBeCloseTo(gpuLow);
          expect(recorder.latestFloat('u_windowWidth')).toBeCloseTo(gpuWidth);
        });
      };

      await expectWindow(-100.5, 99.5);
      expect(recorder.latestInteger('u_nativeInvert')).toBe(Number(invert));
      for (const control of ['width', 'level']) {
        for (const attribute of ['min', 'max', 'step'])
          expect(input(`Original MRI window ${control}`).getAttribute(attribute)).toBe(
            input(`MRI window ${control}`).getAttribute(attribute),
          );
      }
      fireEvent.change(input('Original MRI window width'), { target: { value: '600' } });
      await expectWindow(-300.5, 299.5);
      fireEvent.change(input('Original MRI window level'), { target: { value: '320' } });
      await expectWindow(20, 620);
      fireEvent.change(input('MRI window width'), { target: { value: '240' } });
      await expectWindow(200, 440);
      fireEvent.change(input('MRI window level'), { target: { value: '620' } });
      await expectWindow(500, 740);
      fireEvent.click(screen.getByRole('button', { name: 'Reset source contrast' }));
      await expectWindow(-100.5, 99.5);
      fireEvent.change(input('MRI window width'), { target: { value: '300' } });
      await expectWindow(-150.5, 149.5);
      fireEvent.click(screen.getByRole('button', { name: 'Reset contrast', exact: true }));
      await expectWindow(-100.5, 99.5);

      expect(volume.data).toEqual(sourceValues);
      expect(pixels).toEqual(sourcePixels);
      expect(volume.observedSupport).toEqual(sourceSupport);
      expect(plane.image.validity).toEqual(sourceValidity);
      expect(selection.data).toEqual(sourceLabels);
      expect(selection.seeds).toEqual({ foreground: Uint32Array.of(42), background: Uint32Array.of(43) });
      expect(volume.displayWindow).toEqual(sourceWindow);
      expect(plane.windowRange).toEqual(sourcePlaneWindow);
      expect([plane.image.windowCenter, plane.image.windowWidth, plane.image.invert]).toEqual(sourceVoi);
      expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    },
  );

  it.each(['independent-2d', 'native-3d', 'source-stack'] as const)(
    'keeps source VOI independent for %s when the plane does not share the volume intensity domain',
    async (mode) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const fixture = mode === 'independent-2d' ? nativeViewerFixture() : rawNativeViewerFixture(mode);
      const { volume, plane } = fixture;
      volume.sourceProvenance!.mode = mode;
      if (mode === 'independent-2d') volume.displayWindow = [0.1, 0.9];
      const source =
        mode === 'independent-2d'
          ? plane.source
          : { ...plane.source, seriesUid: 'other-source', label: 'Other acquired source' };
      const independentPlane = makeNativePlaneData(volume, source, plane.frameIndex, {
        ...plane.image,
        seriesUid: source.seriesUid,
      });
      if (mode !== 'independent-2d') volume.sourceProvenance!.sources = [plane.source, source];
      vi.mocked(useSvrNativePlane).mockImplementation(({ sourceIndex }) => ({
        plane: mode === 'independent-2d' || sourceIndex === 1 ? independentPlane : plane,
        loading: false,
        error: null,
      }));
      render(<SvrVolume3DViewer volume={volume} />);
      openSelectionEditor();
      fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
      open3DSettings('Source image');
      if (mode !== 'independent-2d')
        fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane source' }), { target: { value: '1' } });
      const input = (label: string) => screen.getByRole('slider', { name: label }) as HTMLInputElement;
      const volumeWidth = mode === 'independent-2d' ? 0.8 : 200;
      const changedWidth = mode === 'independent-2d' ? 0.4 : 600;
      await waitFor(() => expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(200));
      fireEvent.change(input('Original MRI window width'), { target: { value: '80' } });
      await waitFor(() => expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(80));
      expect(Number(input('MRI window width').value)).toBeCloseTo(volumeWidth);
      fireEvent.change(input('MRI window width'), { target: { value: String(changedWidth) } });
      await waitFor(() =>
        expect(recorder.latestFloat('u_windowWidth')).toBeCloseTo(mode === 'independent-2d' ? 0.4 : 0.5),
      );
      expect(Number(input('Original MRI window width').value)).toBe(80);
      expect(recorder.latestFloat('u_nativeWindowLow')).toBe(-40.5);
      fireEvent.click(screen.getByRole('button', { name: 'Reset contrast', exact: true }));
      expect(Number(input('MRI window width').value)).toBeCloseTo(volumeWidth);
      expect(Number(input('Original MRI window width').value)).toBe(80);
      fireEvent.change(input('MRI window width'), { target: { value: String(changedWidth) } });
      fireEvent.click(screen.getByRole('button', { name: 'Reset source contrast' }));
      await waitFor(() => expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(200));
      expect(recorder.latestFloat('u_nativeWindowLow')).toBe(-100.5);
      expect(Number(input('MRI window width').value)).toBeCloseTo(changedWidth);
    },
  );

  it('discards shared raw contrast overrides after A to B to A replacement', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const a = rawNativeViewerFixture('native-3d');
    const b = rawNativeViewerFixture('source-stack', [200, 800]);
    vi.mocked(useSvrNativePlane).mockImplementation(({ volume }) => ({
      plane: volume === a.volume ? a.plane : volume === b.volume ? b.plane : null,
      loading: false,
      error: null,
    }));
    const { rerender } = render(<SvrVolume3DViewer volume={a.volume} />);
    openSelectionEditor();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    open3DSettings('Source image');
    fireEvent.change(screen.getByRole('slider', { name: 'Original MRI window width' }), { target: { value: '600' } });
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window level' }), { target: { value: '320' } });
    await waitFor(() => expect(recorder.latestFloat('u_nativeWindowLow')).toBe(20));
    rerender(<SvrVolume3DViewer volume={b.volume} />);
    await waitFor(() => {
      expect(recorder.latestFloat('u_nativeWindowLow')).toBe(-100.5);
      expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(200);
      expect(recorder.latestFloat('u_windowLow')).toBeCloseTo((-100.5 - b.volume.intensityRange![0]) / 600);
      expect(recorder.latestFloat('u_windowWidth')).toBeCloseTo(200 / 600);
    });
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window width' }), { target: { value: '300' } });
    await waitFor(() => expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(300));
    rerender(<SvrVolume3DViewer volume={a.volume} />);
    await waitFor(() => {
      expect(recorder.latestFloat('u_nativeWindowLow')).toBe(-100.5);
      expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(200);
      expect(recorder.latestFloat('u_windowLow')).toBeCloseTo(-0.5 / 1200);
      expect(recorder.latestFloat('u_windowWidth')).toBeCloseTo(200 / 1200);
    });
    expect(screen.getByRole('slider', { name: 'MRI window width' })).toHaveValue('200');
    expect(screen.getByRole('slider', { name: 'Original MRI window width' })).toHaveValue('200');
  });

  it('fits selection without clipping anatomy, and uses one selection-only mode for the volume and native MRI', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane, pixels } = nativeViewerFixture();
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    const data = new Uint8Array(volume.data.length);
    data[42] = 1;
    const originalPixels = pixels.slice();
    render(<SvrVolume3DViewer volume={volume} labels={{ data, dims: volume.dims, meta: SELECTION_LABEL_META }} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    await waitFor(() => expect(recorder.texImage3D.mock.calls.some((call) => call[9] === data)).toBe(true));
    const projectedMask = recorder.texImage2D.mock.calls.find(
      (call) => call[3] === 4 && call[4] === 4 && call[8] instanceof Uint8Array && call[8].some((value) => value === 1),
    )?.[8] as Uint8Array;
    expect(projectedMask).toHaveLength(plane.image.pixels.length);
    expect([...projectedMask]).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const original2DAllocations = recorder.texImage2D.mock.calls.length;
    const original3DAllocations = recorder.texImage3D.mock.calls.length;
    const controls = screen.getByRole('group', { name: /region visualization/i });
    open3DSettings('Source image');
    expect(screen.queryByRole('group', { name: 'MRI plane coverage' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit selection' }));
    await waitFor(() => expect(recorder.latestInteger('u_focusEnabled')).toBe(0));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
    expect(recorder.latestInteger('u_nativeSelectionOnly')).toBe(0);

    fireEvent.click(within(controls).getByRole('button', { name: 'Selection only' }));
    await waitFor(() => {
      expect(recorder.latestInteger('u_tumorOnly')).toBe(1);
      expect(recorder.latestInteger('u_nativeSelectionOnly')).toBe(1);
    });
    expect(recorder.latestInteger('u_focusEnabled')).toBe(1);
    expect(recorder.latestInteger('u_nativeMaskEnabled')).toBe(1);
    expect(recorder.latestInteger('u_nativeEnabled')).toBe(1);

    fireEvent.click(within(controls).getByRole('button', { name: 'Anatomy' }));
    await waitFor(() => {
      expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
      expect(recorder.latestInteger('u_nativeSelectionOnly')).toBe(0);
    });
    expect(recorder.latestInteger('u_focusEnabled')).toBe(0);
    expect(recorder.latestInteger('u_labelsEnabled')).toBe(0);

    fireEvent.click(within(controls).getByRole('button', { name: 'Overlay' }));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(1));
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toHaveAttribute('aria-pressed', 'true');
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
    expect(recorder.latestInteger('u_nativeSelectionOnly')).toBe(0);
    expect(recorder.texImage2D).toHaveBeenCalledTimes(original2DAllocations);
    expect(recorder.texImage3D).toHaveBeenCalledTimes(original3DAllocations);
    expect(recorder.texImage2D.mock.calls.some((call) => call[8] === pixels)).toBe(true);
    expect(pixels).toEqual(originalPixels);
    expect(data[42]).toBe(1);
  });

  it.each([
    { nativeEnabled: true, selected: false },
    { nativeEnabled: true, selected: true },
    { nativeEnabled: false, selected: false },
    { nativeEnabled: false, selected: true },
  ])(
    'preserves MRI slice visibility=$nativeEnabled when returning to 3D with selected tissue=$selected',
    async ({ nativeEnabled, selected }) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const { volume, plane } = nativeViewerFixture();
      vi.mocked(useSvrNativePlane).mockImplementation(({ volume: requestedVolume }) => ({
        plane: requestedVolume ? plane : null,
        loading: false,
        error: null,
      }));
      const data = new Uint8Array(volume.data.length);
      data[42] = 1;
      render(
        <SvrVolume3DViewer
          volume={volume}
          initialSelection={selected ? { data, dims: volume.dims, meta: SELECTION_LABEL_META } : undefined}
        />,
      );
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
      if (selected) await screen.findByRole('button', { name: 'Selection only' });
      if (!nativeEnabled) fireEvent.click(screen.getByRole('button', { name: 'MRI slice', exact: true }));
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled)));

      for (let visit = 0; visit < 2; visit++) {
        openSelectionEditor();
        expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute(
          'data-editing',
          'true',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute(
          'data-editing',
          'false',
        );
        expect(screen.getByRole('button', { name: 'MRI slice', exact: true })).toHaveAttribute(
          'aria-pressed',
          String(nativeEnabled),
        );
        await waitFor(() => {
          expect(recorder.latestInteger('u_tumorOnly')).toBe(Number(selected));
          expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled));
        });
        if (selected && nativeEnabled) expect(recorder.latestInteger('u_nativeSelectionOnly')).toBe(1);
      }
      expect(data[42]).toBe(1);
    },
  );

  it.each(['sagittal', 'axial', 'oblique'] as const)(
    'opens and resets to a depth-revealing %s view, reserving face-on source inspection for Face slice',
    async (orientation) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const { volume, plane } = nativeViewerFixture(orientation);
      vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
      render(<SvrVolume3DViewer volume={volume} />);
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
      const initial = recorder.latestMatrix('u_invRot')!;
      const toViewDirection = (direction: number[]) => {
        const inverse = recorder.latestMatrix('u_invRot')!;
        const length = Math.hypot(...direction);
        return [0, 3, 6].map(
          (start) =>
            (inverse[start]! * direction[0]! +
              inverse[start + 1]! * direction[1]! +
              inverse[start + 2]! * direction[2]!) /
            length,
        );
      };
      const normal = [
        plane.columnStep[1] * plane.rowStep[2] - plane.columnStep[2] * plane.rowStep[1],
        plane.columnStep[2] * plane.rowStep[0] - plane.columnStep[0] * plane.rowStep[2],
        plane.columnStep[0] * plane.rowStep[1] - plane.columnStep[1] * plane.rowStep[0],
      ];
      // The default reveals depth without turning the source edge-on or upside down.
      expect(Math.abs(toViewDirection(normal)[2]!)).toBeGreaterThan(0.3);
      expect(Math.abs(toViewDirection(normal)[2]!)).toBeLessThan(0.95);
      expect(toViewDirection(plane.columnStep)[0]).toBeGreaterThan(0.3);
      expect(toViewDirection(plane.rowStep)[1]).toBeLessThan(-0.3);

      open3DSettings();
      fireEvent.click(screen.getByRole('button', { name: 'Face slice' }));
      await waitFor(() => expect(Math.abs(toViewDirection(normal)[2]!)).toBeCloseTo(1));
      expect(toViewDirection(plane.columnStep)[0]).toBeCloseTo(1);
      expect(toViewDirection(plane.columnStep)[1]).toBeCloseTo(0);
      expect(toViewDirection(plane.rowStep)[0]).toBeCloseTo(0);
      expect(toViewDirection(plane.rowStep)[1]).toBeCloseTo(-1);

      fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
      await waitFor(() => expect(recorder.latestMatrix('u_invRot')).toEqual(initial));
      const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
      fireEvent.keyDown(viewer, { key: 'ArrowRight' });
      await waitFor(() => expect(recorder.latestMatrix('u_invRot')).not.toEqual(initial));
      fireEvent.keyDown(viewer, { key: '0' });
      await waitFor(() => expect(recorder.latestMatrix('u_invRot')).toEqual(initial));
    },
  );

  it.each(['anatomy', 'selection'] as const)(
    'keeps the 3D %s camera fixed while the original MRI plane moves through the volume',
    async (mode) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const { volume, plane } = nativeViewerFixture();
      const planes = plane.source.frames.map((frame, frameIndex) =>
        makeNativePlaneData(volume, plane.source, frameIndex, {
          ...plane.image,
          imageId: `miradb:${frame.sopInstanceUid}`,
          sopInstanceUid: frame.sopInstanceUid,
        }),
      );
      vi.mocked(useSvrNativePlane).mockImplementation(({ frameIndex }) => ({
        plane: planes[frameIndex]!,
        loading: false,
        error: null,
      }));
      const data = new Uint8Array(volume.data.length);
      data[42] = 1;
      render(<SvrVolume3DViewer volume={volume} labels={{ data, dims: volume.dims, meta: SELECTION_LABEL_META }} />);
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
      if (mode === 'selection') {
        fireEvent.click(screen.getByRole('button', { name: 'Selection only' }));
        await waitFor(() => expect(recorder.latestInteger('u_tumorOnly')).toBe(1));
      }
      const camera = () => ({
        center: recorder.latestVector('u_cameraCenter'),
        distance: recorder.latestFloat('u_cameraZ'),
        zoom: recorder.latestZoom(),
        rotation: recorder.latestMatrix('u_invRot'),
      });
      const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
      const original = camera();
      fireEvent.keyDown(viewer, { key: '+' });
      fireEvent.keyDown(viewer, { key: 'ArrowRight' });
      await waitFor(() => {
        expect(camera().zoom).not.toBe(original.zoom);
        expect(camera().rotation).not.toEqual(original.rotation);
      });
      const chosenCamera = camera();
      for (const frameIndex of [0, 3, 1, 2]) {
        fireEvent.change(screen.getByRole('slider', { name: 'Original MRI slice position' }), {
          target: { value: String(frameIndex) },
        });
        await waitFor(() => expect(recorder.latestVector('u_nativeOrigin')).toEqual(planes[frameIndex]!.origin));
        expect(vi.mocked(useSvrNativePlane).mock.lastCall?.[0].frameIndex).toBe(frameIndex);
        expect(camera()).toEqual(chosenCamera);
      }
    },
  );

  it('keeps a pending MRI section at its displayed geometry and discloses the requested slice', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture();
    let loading = false;
    vi.mocked(useSvrNativePlane).mockImplementation(() => ({ plane, loading, error: null }));
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    const camera = recorder.latestMatrix('u_invRot');
    const uploads = recorder.texSubImage2D.mock.calls.length;
    loading = true;
    fireEvent.change(screen.getByRole('slider', { name: 'Original MRI slice position' }), {
      target: { value: '0' },
    });
    expect(screen.getByText(`Showing ${plane.frameIndex + 1} · loading 1…`)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(1);
    expect(recorder.latestInteger('u_nativeEnabled')).toBe(1);
    expect(recorder.latestVector('u_nativeOrigin')).toEqual(plane.origin);
    expect(recorder.latestMatrix('u_invRot')).toEqual(camera);
    expect(recorder.texSubImage2D).toHaveBeenCalledTimes(uploads);
  });

  it('browses missing source planes from the resident grid without rebuilding MRI textures for in-plane or contrast edits', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = rawNativeViewerFixture('native-3d');
    vi.mocked(useSvrNativePlane).mockImplementation(({ volume: owner }) => ({
      plane: owner ? plane : null,
      loading: false,
      error: null,
    }));
    const pixels = volume.data.slice();
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    const camera = recorder.latestMatrix('u_invRot');
    const volumeUploads = recorder.volumeUploads.length;
    const programs = recorder.createProgram.mock.calls.length;
    const choices = within(screen.getByRole('group', { name: 'MRI slice plane' }));
    fireEvent.click(choices.getByRole('button', { name: 'Coronal', exact: true }));
    await waitFor(() =>
      expect(recorder.latestVector('u_nativeOrigin')).toEqual(makeVolumePlaneData(volume, 'coronal', 2).origin),
    );
    expect(screen.getByText('Volume reformat', { selector: '.svr-native-source-note' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(3);
    expect(vi.mocked(useSvrNativePlane).mock.lastCall?.[0].volume).toBeNull();
    expect(recorder.latestMatrix('u_invRot')).toEqual(camera);

    openSelectionEditor();
    const uploads = () => recorder.texImage2D.mock.calls.length + recorder.texSubImage2D.mock.calls.length;
    const beforeInPlane = uploads();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice', exact: true }), { target: { value: '1' } });
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(3);
    open3DSettings();
    fireEvent.click(screen.getByText('Source image'));
    fireEvent.change(screen.getByRole('slider', { name: 'Original MRI window width' }), { target: { value: '600' } });
    await waitFor(() => expect(recorder.latestFloat('u_nativeWindowWidth')).toBe(600));
    expect(uploads()).toBe(beforeInPlane);
    expect(recorder.volumeUploads).toHaveLength(volumeUploads);
    expect(recorder.createProgram).toHaveBeenCalledTimes(programs);
    expect(volume.data).toEqual(pixels);
  });

  it('uses the accepted source when a previously missing orientation becomes available in the next volume', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture();
    vi.mocked(useSvrNativePlane).mockImplementation(({ volume: owner, sourceIndex, frameIndex }) => {
      const source = owner?.sourceProvenance?.sources[sourceIndex];
      const frame = source?.frames[frameIndex];
      return {
        plane:
          owner && source && frame
            ? makeNativePlaneData(owner, source, frameIndex, {
                ...plane.image,
                seriesUid: source.seriesUid,
                sopInstanceUid: frame.sopInstanceUid,
                imageId: `miradb:${frame.sopInstanceUid}`,
              })
            : null,
        loading: false,
        error: null,
      };
    });
    const { rerender } = render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'MRI slice plane' })).getByRole('button', { name: 'Coronal' }),
    );
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(3);
    const coronal: SvrNativeSource = {
      ...plane.source,
      seriesUid: 'new-coronal',
      frames: plane.source.frames.map((frame, index) => ({
        ...frame,
        sopInstanceUid: `coronal-${index}`,
        originMm: [0, index, 3],
        columnDirection: [1, 0, 0],
      })),
    };
    const next = { ...volume, sourceProvenance: { ...volume.sourceProvenance!, sources: [plane.source, coronal] } };
    rerender(<SvrVolume3DViewer volume={next} />);
    await waitFor(() =>
      expect(vi.mocked(useSvrNativePlane).mock.lastCall?.[0]).toMatchObject({ volume: next, sourceIndex: 1 }),
    );
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    expect(screen.queryByRole('spinbutton', { name: 'Volume reformat slice' })).not.toBeInTheDocument();
  });

  it('applies every batched wheel and keyboard slice step and uploads only the latest resident plane', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const volume = editingVolume(12);
    const pixels = volume.data.slice();
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed MRI volume/i });
    const programs = recorder.createProgram.mock.calls.length;
    const uploads = recorder.volumeUploads.length;
    const camera = recorder.latestMatrix('u_invRot');
    act(() => {
      for (let step = 0; step < 3; step++) fireEvent.wheel(viewer, { deltaY: -1 });
    });
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(4);
    act(() => {
      fireEvent.keyDown(viewer, { key: ']' });
      fireEvent.keyDown(viewer, { key: ']' });
    });
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(6);
    await waitFor(() =>
      expect(recorder.latestVector('u_nativeOrigin')).toEqual(makeVolumePlaneData(volume, 'axial', 5).origin),
    );
    expect(recorder.latestMatrix('u_invRot')).toEqual(camera);
    expect(recorder.createProgram).toHaveBeenCalledTimes(programs);
    expect(recorder.volumeUploads).toHaveLength(uploads);
    const zoom = recorder.latestZoom();
    fireEvent.wheel(viewer, { deltaY: -100, ctrlKey: true });
    await waitFor(() => expect(recorder.latestZoom()).toBeGreaterThan(zoom!));
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(6);
    expect(volume.data).toEqual(pixels);
    expect(vi.mocked(useSvrNativePlane).mock.calls.every(([options]) => options.volume === null)).toBe(true);
  });

  it('does not mislabel an ambiguous oblique acquisition as an axial section', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture('oblique');
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    expect(screen.getByText('Oblique source')).toBeInTheDocument();
    const choices = within(screen.getByRole('group', { name: 'MRI slice plane' }));
    expect(choices.getAllByRole('button').every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(
      true,
    );
    fireEvent.click(choices.getByRole('button', { name: 'Axial', exact: true }));
    await waitFor(() =>
      expect(recorder.latestVector('u_nativeOrigin')).toEqual(makeVolumePlaneData(volume, 'axial', 2).origin),
    );
    expect(choices.getByRole('button', { name: 'Axial', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Oblique source')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(3);
  });

  it('keeps overlay density and typography fixed while the volume switches interaction resolution', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    render(<SvrVolume3DViewer volume={editingVolume(4)} />);
    await waitFor(() => expect(recorder.latestInteger('u_steps')).toBe(1024));
    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    const axes = document.querySelector<HTMLCanvasElement>('canvas[aria-hidden="true"]')!;
    const dimensions = [axes.width, axes.height];
    const font = recorder.axesFont();
    fireEvent.keyDown(viewer, { key: ']' });
    await waitFor(() => expect(recorder.latestInteger('u_steps')).toBe(96));
    expect([axes.width, axes.height]).toEqual(dimensions);
    expect(recorder.axesFont()).toBe(font);
    await waitFor(() => expect(recorder.latestInteger('u_steps')).toBe(1024));
    expect([axes.width, axes.height]).toEqual(dimensions);
    expect(recorder.axesFont()).toBe(font);
  });

  it('keeps outlined orientation letters above the dimension readout while rotating', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    // Posterior points downward in this valid source-grid orientation, as in
    // the face-on axial source that exposed the overlapping legend.
    render(<SvrVolume3DViewer volume={{ ...editingVolume(4), direction: [1, 0, 0, 0, -1, 0, 0, 0, -1] }} />);
    await waitFor(() => expect(recorder.axisText).toHaveBeenCalled());
    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    for (let step = 0; step < 4; step++) {
      recorder.axisText.mockClear();
      recorder.axisOutline.mockClear();
      fireEvent.keyDown(viewer, { key: 'ArrowRight' });
      await waitFor(() => expect(recorder.axisText).toHaveBeenCalled());
      const calls = recorder.axisText.mock.calls.slice(-4);
      expect(recorder.axisOutline.mock.calls.slice(-4)).toEqual(calls);
      recorder.axisOutline.mock.invocationCallOrder.slice(-4).forEach((outlineOrder, index) => {
        expect(outlineOrder).toBeLessThan(recorder.axisText.mock.invocationCallOrder.slice(-4)[index]!);
      });
      const dimensions = calls.find(([text]) => text.endsWith(' mm'))!;
      const lowestDirection = Math.max(...calls.filter(([text]) => /^[LPS]$/.test(text)).map(([, , y]) => y));
      // Use the readout's known viewport position to compare CSS-space clearance.
      const dpr = dimensions[2] / (600 - 40);
      expect((dimensions[2] - lowestDirection) / dpr).toBeGreaterThanOrEqual(16);
    }
  });

  it('discloses source sampling estimates without calling stored spacing measured resolution', async () => {
    render(
      <SvrVolume3DViewer
        volume={{
          ...observedVolume,
          acquiredOrientationCount: 2,
          effectiveResolutionMm: [0.45, 0.6, 3.25],
          sliceProfileSource: 'mixed',
        }}
      />,
    );

    open3DSettings('Volume details');
    expect(screen.getByText(/2 source orientations/i)).toBeInTheDocument();
    expect(screen.getByText(/source sampling estimate: 0\.45 × 0\.60 × 3\.25 mm/i)).toBeInTheDocument();
    expect(screen.getByText(/slice profile: mixed/i)).toBeInTheDocument();
    expect(screen.queryByText(/clinical confidence/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
  });

  it('binds persisted lesion hydration to the accepted reconstruction fingerprint', async () => {
    const identity = { patientKey: 'synthetic-patient', studyUid: 'synthetic-study', seriesUids: ['series-1'] };
    const { rerender } = render(
      <SvrVolume3DViewer
        volume={{ ...observedVolume, reconstructionFingerprint: 'reconstruction-a' }}
        volumeIdentity={identity}
      />,
    );

    await waitFor(() => expect(getVolumeSegmentation).toHaveBeenCalledOnce());
    const firstKey = vi.mocked(getVolumeSegmentation).mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(firstKey)).toMatchObject({ reconstruction: 'reconstruction-a' });

    rerender(
      <SvrVolume3DViewer
        volume={{ ...observedVolume, reconstructionFingerprint: 'reconstruction-b' }}
        volumeIdentity={identity}
      />,
    );

    await waitFor(() => expect(getVolumeSegmentation).toHaveBeenCalledTimes(2));
    const secondKey = vi.mocked(getVolumeSegmentation).mock.calls[1]?.[0] ?? '';
    expect(JSON.parse(secondKey)).toMatchObject({ reconstruction: 'reconstruction-b' });
    expect(secondKey).not.toBe(firstKey);
  });

  it('preserves exact legacy annotation keys when reconstruction fingerprints are unavailable', async () => {
    const identity = { patientKey: 'synthetic-patient', studyUid: 'synthetic-study', seriesUids: ['series-1'] };
    render(<SvrVolume3DViewer volume={observedVolume} volumeIdentity={identity} />);

    await waitFor(() => expect(getVolumeSegmentation).toHaveBeenCalledOnce());
    const legacyKey = JSON.parse(vi.mocked(getVolumeSegmentation).mock.calls[0]?.[0] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(legacyKey).not.toHaveProperty('reconstruction');
    expect(legacyKey).toMatchObject({ patient: identity.patientKey, study: identity.studyUid, series: ['series-1'] });
  });

  it('keeps all three linked editing planes available when 3D controls are opened and closed', async () => {
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    openSelectionEditor();
    const planes = ['Axial', 'Coronal', 'Sagittal'].map((plane) =>
      screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
    );
    open3DSettings('Custom model');
    expect(screen.getByText(/use your own verified ONNX model/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide 3D settings' }));
    for (const canvas of planes) expect(canvas).toBeInTheDocument();
    fireEvent.keyDown(planes[0]!, { key: '2' });
    expect(planes[1]).toHaveFocus();
    fireEvent.keyDown(planes[1]!, { key: 'ArrowUp' });
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(8);
  });

  it.each([false, true])(
    'paints exact marks with auto-fill off, fills on re-enable, and restores edits with outside marks: %s',
    async (withOutside) => {
      const volume = editingVolume();
      const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
      const grown = [at(5, 6), at(6, 6), at(5, 7)];
      const background = withOutside ? [at(9, 6)] : [];
      const run = testSelectionProposer.mockResolvedValue({
        ...proposedRegion(Uint32Array.from(grown)),
        boundaryCount: 0,
        contextLimited: false,
      });
      const recorder = createViewportRecorder({ width: 400, height: 320 });
      render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      setAutoFill(false);
      const planes = ['Axial', 'Coronal', 'Sagittal'].map((plane) =>
        screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
      );
      expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
      if (withOutside) {
        paint(9, 6, 'Remove');
        expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
        expect(run).not.toHaveBeenCalled();
      }
      paint(5, 6);
      expect(run).not.toHaveBeenCalled();
      expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeEnabled();
      setAutoFill(true);
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect([...run.mock.calls[0]![0].seeds.foreground]).toEqual([at(5, 6)]);
      expect([...run.mock.calls[0]![0].seeds.background]).toEqual(background);
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels[at(5, 6)]).toBe(1);
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.foreground]).toEqual([at(5, 6)]);
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.background]).toEqual(background);
      expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
      setAutoFill(false);
      paint(6, 6, 'Remove');
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
      expect(run).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.background]).toEqual(background);
      fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
      expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute(
        'data-editing',
        'false',
      );
      expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
      expect(screen.queryByText('Slice settings', { selector: 'summary' })).not.toBeInTheDocument();
      for (const plane of planes) expect(plane).not.toBeInTheDocument();
      expect(recorder.texSubImage3D.mock.calls.some((args) => args.slice(5, 8).every((value) => value === 1))).toBe(
        true,
      );
      openSelectionEditor();
      for (const plane of ['Axial', 'Coronal', 'Sagittal'])
        expect(
          screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
        ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toBeEnabled();
      expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).not.toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
      await waitFor(() =>
        expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels.some(Boolean)).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
    },
  );

  it.each([false, true])(
    'saves and reopens a confirmed clipped selection with context %s without rerunning',
    async (contextLimited) => {
      const volume = editingVolume();
      const predicted = new Uint8Array(volume.data.length);
      predicted[(6 * 12 + 6) * 12 + 6] = 1;
      const proposeSelection = vi.fn<SelectionProposer>().mockResolvedValue({
        data: predicted,
        boundaryCount: 0,
        contextLimited,
        clippedNativeVoxels: 152,
      });
      createViewportRecorder({ width: 400, height: 320 });
      const view = render(
        <SvrVolume3DViewer volume={volume} volumeIdentity={identity} proposeSelection={proposeSelection} />,
      );
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      paint(5, 6);
      await screen.findByText(/only part of the predicted tissue is retained/i);
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].clippedNativeVoxels).toBe(152));
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
      const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
      expect(saved.clippedNativeVoxels).toBe(152);
      expect(saved.contextLimited).toBe(contextLimited);
      view.unmount();
      vi.mocked(getVolumeSegmentation).mockResolvedValue(saved);
      render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} proposeSelection={proposeSelection} />);
      const warning = await screen.findByText(/only part of the predicted tissue is retained/i);
      expect(warning).toBeVisible();
      openSelectionEditor();
      expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
      expect(proposeSelection).toHaveBeenCalledOnce();
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].clippedNativeVoxels).toBe(152);
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].contextLimited).toBe(contextLimited);
      if (contextLimited) expect(screen.getByText(/limited source region/i)).toBeVisible();
      else expect(screen.queryByText(/limited source region/i)).not.toBeInTheDocument();
    },
  );

  it('does not commit canceled pointer strokes or paint unsupported anatomy', async () => {
    const volume = editingVolume();
    volume.observedSupport!.fill(0);
    const run = testSelectionProposer;
    render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    paint(5, 6);
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    cleanup();
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    openSelectionEditor();
    paint(5, 6, 'Add', true);
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
  });

  it.each(['finish', 'cancel'] as const)(
    'blocks enhancement while a boundary suggestion runs and resumes after %s',
    async (completion) => {
      const volume = editingVolume();
      const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
      const suggestion = deferred<SelectionProposalResult>();
      const run = testSelectionProposer.mockReturnValue(suggestion.promise);
      modelSession.cached = true;
      modelSession.verified = true;
      createViewportRecorder({ width: 400, height: 320 });
      render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
      openSelectionEditor();
      open3DSettings('Custom model');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      setAutoFill(false);
      paint(5, 6);
      await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      setAutoFill(true);
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const enhance = screen.getByRole('button', { name: /Enhance selection/ });
      expect(enhance).toBeDisabled();
      expect(enhance).toHaveAttribute(
        'title',
        'Wait for the boundary suggestion to finish before enhancing this region.',
      );
      fireEvent.click(enhance);
      expect(runSuperResolution).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Suggest with model' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Suggest with model' }));
      expect(modelSession.run).not.toHaveBeenCalled();
      if (completion === 'cancel') {
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(run.mock.calls[0]![0]?.signal?.aborted).toBe(true);
        await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      }
      await act(async () =>
        suggestion.resolve({
          ...proposedRegion(Uint32Array.of(at(5, 6), at(6, 6)), volume.data.length),
          boundaryCount: 0,
          contextLimited: false,
        }),
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      expect(screen.getByRole('button', { name: 'Suggest with model' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(runSuperResolution).not.toHaveBeenCalled();
      // A control becoming available is not the passive persistence effect's
      // completion signal. Observe the saved selection, including late cancel.
      await waitFor(() =>
        expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels[at(6, 6)]).toBe(
          completion === 'finish' ? 1 : 0,
        ),
      );
    },
  );

  it('reports enhancement progress, cancels and reruns, and compares detail without changing the saved selection', async () => {
    const volume = editingVolume();
    const sourceValues = volume.data.slice(),
      acquiredSupport = volume.observedSupport!.slice();
    const first = deferred<SvrEnhancedVolume>(),
      replacement = deferred<SvrEnhancedVolume>();
    vi.mocked(runSuperResolution).mockReturnValueOnce(first.promise).mockReturnValueOnce(replacement.promise);
    const recorder = createViewportRecorder({ width: 400, height: 320 });
    const suggestion = testSelectionProposer;
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    setAutoFill(false);
    paint(5, 6);
    paint(8, 6, 'Remove');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
    const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
    const labels = saved.labels.slice();
    const foreground = saved.seeds!.foreground.slice(),
      background = saved.seeds!.background.slice();
    const writes = vi.mocked(saveVolumeSegmentation).mock.calls.length;
    const reviewedMeasurement = screen.getByText(/Reviewed selection ·/).textContent;
    const unchanged = () => {
      expect(volume.data).toEqual(sourceValues);
      expect(volume.observedSupport).toEqual(acquiredSupport);
      expect(vi.mocked(saveVolumeSegmentation).mock.calls).toHaveLength(writes);
      const latest = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
      expect(latest.labels).toBe(saved.labels);
      expect(latest.labels).toEqual(labels);
      expect(latest.seeds!.foreground).toEqual(foreground);
      expect(latest.seeds!.background).toEqual(background);
      expect(latest.reviewState).toBe('reviewed');
      expect(screen.getByText(/Reviewed selection ·/).textContent).toBe(reviewedMeasurement);
    };

    openSelectionEditor();
    fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
    await waitFor(() => expect(runSuperResolution).toHaveBeenCalledOnce());
    const firstCall = vi.mocked(runSuperResolution).mock.calls[0]!;
    expect(firstCall[0].data).not.toBe(volume.data);
    expect(firstCall[0].data).toEqual(sourceValues);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    act(() =>
      firstCall[1]!.onProgress?.({ phase: 'training', current: 2, total: 4, message: 'Learning local 3D detail' }),
    );
    expect(
      (screen.getByRole('progressbar', { name: 'Enhancement progress' }) as HTMLProgressElement).value,
    ).toBeCloseTo(0.4);
    expect(screen.getByText('Learning local 3D detail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel enhancement' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-fill' }));
    expect(suggestion).not.toHaveBeenCalled();
    unchanged();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel enhancement' }));
    expect(firstCall[1]!.signal!.aborted).toBe(true);
    expect(screen.getByText('Enhancement canceled. Original data is unchanged.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
    await waitFor(() => expect(runSuperResolution).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve(enhancedFixture(firstCall[0])));
    expect(screen.getByRole('button', { name: 'Cancel enhancement' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Volume detail comparison' })).not.toBeInTheDocument();
    const secondCall = vi.mocked(runSuperResolution).mock.calls[1]!;
    act(() =>
      secondCall[1]!.onProgress?.({ phase: 'enhancing', current: 5, total: 10, message: 'Enhancing selected detail' }),
    );
    expect(
      (screen.getByRole('progressbar', { name: 'Enhancement progress' }) as HTMLProgressElement).value,
    ).toBeCloseTo(0.76);
    const enhanced = enhancedFixture(secondCall[0]);
    await act(async () => replacement.resolve(enhanced));
    const comparison = await screen.findByRole('group', { name: 'Volume detail comparison' });
    await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(1));
    expect(within(comparison).getByRole('button', { name: 'Enhanced · 2×' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Inferred detail—not acquired/)).toHaveTextContent('Saved selection unchanged');
    expect(screen.queryByRole('progressbar', { name: 'Enhancement progress' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Super-resolution strength' })).not.toBeInTheDocument();
    unchanged();

    open3DSettings('Enhanced detail');
    fireEvent.click(within(comparison).getByRole('button', { name: 'Original' }));
    expect(within(comparison).getByRole('button', { name: 'Original' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: 'Super-resolution strength' })).toBeDisabled();
    await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(0));
    expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(1);
    expect(screen.getByText(/Original source detail/)).toHaveTextContent('Saved selection unchanged');
    fireEvent.click(within(comparison).getByRole('button', { name: 'Enhanced · 2×' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Super-resolution strength' }), { target: { value: '65' } });
    await waitFor(() =>
      expect(recorder.uniform1f.mock.calls.filter(([name]) => name === 'u_enhancedStrength').at(-1)?.[1]).toBe(0.65),
    );
    unchanged();

    fireEvent.click(screen.getByRole('button', { name: 'Discard enhancement' }));
    await waitFor(() => expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(0));
    expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled();
    expect(screen.queryByRole('group', { name: 'Volume detail comparison' })).not.toBeInTheDocument();
    unchanged();
  });

  it('prepares enhancement from the settled editor on click without changing saved edits', async () => {
    const volume = editingVolume();
    const source = volume.data.slice();
    const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
    testSelectionProposer.mockResolvedValue({
      ...proposedRegion(Uint32Array.of(at(5, 6), at(6, 6)), volume.data.length),
      boundaryCount: 0,
      contextLimited: false,
    });
    vi.mocked(runSuperResolution).mockImplementation(async (crop) => {
      return enhancedFixture(crop);
    });
    createViewportRecorder({ width: 400, height: 320 });
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    setAutoFill(false);
    paint(5, 6);
    paint(8, 6, 'Remove');
    setAutoFill(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
    const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
    const writes = vi.mocked(saveVolumeSegmentation).mock.calls.length;
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
    await screen.findByRole('group', { name: 'Volume detail comparison' });
    expect(runSuperResolution).toHaveBeenCalledOnce();
    expect(vi.mocked(saveVolumeSegmentation).mock.calls).toHaveLength(writes);
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0]).toBe(saved);
    expect(volume.data).toEqual(source);

    open3DSettings('Enhanced detail');
    fireEvent.click(screen.getByRole('button', { name: 'Discard enhancement' }));
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.calls.length).toBeGreaterThan(writes));
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds).toEqual(saved.seeds);
    expect(screen.getByRole('button', { name: 'Redo selection edit' })).toBeEnabled();
  });

  it.each([
    { outcome: 'rejected', mode: 'refinement' },
    { outcome: 'replaced', mode: 'refinement' },
    { outcome: 'rejected', mode: 'ordinary' },
    { outcome: 'replaced', mode: 'ordinary' },
  ] as const)(
    'retains completed enhancement and editing through $mode admission until the source is $outcome',
    async ({ outcome, mode }) => {
      const source = { ...editingVolume(), nativeVoxelSizeMm: [0.5, 0.5, 1] as [number, number, number] };
      const native = { ...source, data: source.data.slice(), observedSupport: source.observedSupport!.slice() };
      const output = enhancedFixture(native);
      const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
      vi.mocked(runSuperResolution).mockResolvedValue(output);
      const completion = deferred<SvrVolume | null>();
      const admitted = vi.fn();
      const recorder = createViewportRecorder({ width: 400, height: 320 });
      const operations = createSvrImagingOperations();
      function Workspace() {
        const [volume, setVolume] = useState<SvrVolume>(source);
        const [busy, setBusy] = useState(false);
        return (
          <SvrImagingContext.Provider
            value={{
              volume,
              busy,
              operations,
              loadEnhancementSource: loadSource,
              refineRegion: (labels) => {
                admitted(labels, operations.prepare('refinement').retainedBytes);
                setBusy(true);
                void completion.promise.then((replacement) => {
                  if (replacement) setVolume(replacement);
                  setBusy(false);
                });
              },
            }}
          >
            <button
              onClick={() => {
                const snapshot = operations.prepare('reconstruction');
                admitted(snapshot.labels, snapshot.retainedBytes);
                setBusy(true);
                void completion.promise.then((replacement) => {
                  if (replacement) setVolume(replacement);
                  setBusy(false);
                });
              }}
            >
              Reopen source
            </button>
            <ContextViewer volumeIdentity={identity} />
          </SvrImagingContext.Provider>
        );
      }
      render(<Workspace />);
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      setAutoFill(false);
      paint(5, 6);
      paint(8, 6, 'Remove');
      await waitFor(() =>
        expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].seeds!.background.length).toBe(1),
      );
      const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
      const writes = vi.mocked(saveVolumeSegmentation).mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
      const comparison = await screen.findByRole('group', { name: 'Volume detail comparison' });
      await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(1));
      if (outcome === 'rejected') fireEvent.click(within(comparison).getByRole('button', { name: 'Original' }));
      const displayEnabled = outcome === 'replaced' ? 1 : 0;
      await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(displayEnabled));
      const retainedDisplay =
        native.data.byteLength +
        native.observedSupport!.byteLength +
        output.data.byteLength +
        output.observedSupport.byteLength +
        output.data.length * ENHANCED_TEXTURE_BYTES_PER_VOXEL +
        native.data.length * ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL;
      const editingBytes = loadSource.mock.calls[0]![1].retainedBytes!;
      expect(editingBytes).toBeGreaterThan(0);
      expect((modelSession.retained.mock.lastCall![0] as () => number)()).toBe(editingBytes + retainedDisplay);
      fireEvent.click(
        screen.getByRole('button', { name: mode === 'ordinary' ? 'Reopen source' : 'Use original detail' }),
      );
      expect(admitted).toHaveBeenCalledOnce();
      const [current, bytes] = admitted.mock.lastCall!;
      expect(current.data).toBe(saved.labels);
      expect(current.seeds).toEqual(saved.seeds);
      expect(bytes).toBe(editingBytes + retainedDisplay);
      expect(screen.getByRole('button', { name: 'Use original detail' })).toBeDisabled();
      expect(screen.getByRole('group', { name: 'Volume detail comparison' })).toBe(comparison);
      await waitFor(() => expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(1));
      expect(recorder.latestInteger('u_enhancedEnabled')).toBe(displayEnabled);
      expect(vi.mocked(saveVolumeSegmentation)).toHaveBeenCalledTimes(writes);
      await act(async () =>
        completion.resolve(outcome === 'replaced' ? { ...source, data: source.data.slice() } : null),
      );
      if (outcome === 'rejected') {
        expect(screen.getByRole('group', { name: 'Volume detail comparison' })).toBe(comparison);
        expect(screen.getByRole('button', { name: 'Use original detail' })).toBeEnabled();
        expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(1);
        expect(recorder.latestInteger('u_enhancedEnabled')).toBe(displayEnabled);
        expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
        expect(vi.mocked(saveVolumeSegmentation)).toHaveBeenCalledTimes(writes);
        expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0]).toBe(saved);
      } else {
        await waitFor(() =>
          expect(screen.queryByRole('group', { name: 'Volume detail comparison' })).not.toBeInTheDocument(),
        );
        await waitFor(() => expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(0));
      }
      expect(native.data).toEqual(source.data);
      expect(native.observedSupport).toEqual(source.observedSupport);
      expect(runSuperResolution).toHaveBeenCalledOnce();
      expect(loadSource).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    'counts completed enhancement with its comparison textures during learned suggestions (display enabled=%s)',
    async (enabled) => {
      const volume = editingVolume();
      const native = { ...volume, data: volume.data.slice(), observedSupport: volume.observedSupport!.slice() };
      const output = enhancedFixture(native);
      const loadEnhancementSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
      vi.mocked(runSuperResolution).mockResolvedValue(output);
      const proposeSelection = vi.fn<SelectionProposer>().mockRejectedValue(new Error('Controlled proposal failure'));
      const recorder = createViewportRecorder({ width: 400, height: 320 });
      render(
        <SvrVolume3DViewer
          volume={volume}
          volumeIdentity={identity}
          proposeSelection={proposeSelection}
          loadEnhancementSource={loadEnhancementSource}
        />,
      );
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      setAutoFill(false);
      paint(5, 6);
      paint(8, 6, 'Remove');
      const wrapped = modelSession.proposer.mock.lastCall![0];
      fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
      const comparison = await screen.findByRole('group', { name: 'Volume detail comparison' });
      await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(1));
      if (!enabled) fireEvent.click(within(comparison).getByRole('button', { name: 'Original' }));
      await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(enabled ? 1 : 0));
      expect(modelSession.proposer.mock.lastCall![0]).toBe(wrapped);
      const enhancedBytes =
        native.data.byteLength +
        native.observedSupport!.byteLength +
        output.data.byteLength +
        output.observedSupport.byteLength +
        output.data.length * ENHANCED_TEXTURE_BYTES_PER_VOXEL +
        native.data.length * ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL;
      const editingBytes = loadEnhancementSource.mock.calls[0]![1].retainedBytes!;
      setAutoFill(true);
      await screen.findByText('Controlled proposal failure');
      expect(proposeSelection).toHaveBeenCalledOnce();
      expect(proposeSelection.mock.calls[0]![0].retainedBytes).toBe(editingBytes + enhancedBytes);
      expect(screen.getByRole('group', { name: 'Volume detail comparison' })).toBe(comparison);
      expect(modelSession.proposer.mock.lastCall![0]).toBe(wrapped);
      paint(5, 6); // An agreeing hard mark keeps the completed display's mask identity.
      await waitFor(() => expect(proposeSelection).toHaveBeenCalledTimes(2));
      expect(proposeSelection.mock.calls[1]![0].retainedBytes).toBeGreaterThan(editingBytes + enhancedBytes);
      expect(screen.getByRole('group', { name: 'Volume detail comparison' })).toBe(comparison);
      expect(modelSession.proposer.mock.lastCall![0]).toBe(wrapped);
      expect(recorder.latestInteger('u_enhancedOriginalAvailable')).toBe(1);
      await act(async () => {
        await expect(
          (wrapped as SelectionProposer)({
            ...proposeSelection.mock.calls[1]![0],
            retainedBytes: Number.MAX_SAFE_INTEGER,
          }),
        ).rejects.toThrow(/valid retained-memory estimate/i);
      });
      expect(proposeSelection).toHaveBeenCalledTimes(2);
    },
  );

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid learned-proposal retained bytes (%s)', async (retainedBytes) => {
    const volume = editingVolume();
    const proposeSelection = vi.fn<SelectionProposer>();
    render(<SvrVolume3DViewer volume={volume} proposeSelection={proposeSelection} />);
    const wrapped = modelSession.proposer.mock.lastCall![0] as SelectionProposer;
    await act(async () => {
      await expect(
        wrapped({
          volume,
          seeds: { foreground: Uint32Array.of(1), background: new Uint32Array() },
          retainedBytes,
          signal: new AbortController().signal,
          onProgress: vi.fn(),
        }),
      ).rejects.toThrow(/valid retained-memory estimate/i);
    });
    expect(proposeSelection).not.toHaveBeenCalled();
  });

  it('keeps a completed or canceled model outcome visible when its settings are closed', () => {
    modelSession.message = 'Model suggestion canceled. The worker was stopped; your selection is unchanged.';
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    expect(screen.getByText(modelSession.message)).toBeVisible();
    expect(screen.queryByRole('complementary', { name: '3D settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel model suggestion' })).not.toBeInTheDocument();
  });

  it('rejects a canceled request before asking the learned model to allocate', async () => {
    const volume = editingVolume();
    const proposeSelection = vi.fn<SelectionProposer>();
    render(<SvrVolume3DViewer volume={volume} proposeSelection={proposeSelection} />);
    const wrapped = modelSession.proposer.mock.lastCall![0] as SelectionProposer;
    const controller = new AbortController();
    controller.abort();
    await expect(
      wrapped({
        volume,
        seeds: { foreground: Uint32Array.of(1), background: new Uint32Array() },
        retainedBytes: 0,
        signal: controller.signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(proposeSelection).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves MRI slice visibility=%s when enhancement completes and detail is toggled',
    async (nativeEnabled) => {
      const recorder = createViewportRecorder({ width: 800, height: 600 });
      const { volume, plane, pixels } = nativeViewerFixture();
      const sourceValues = volume.data.slice();
      const originalPixels = pixels.slice();
      vi.mocked(useSvrNativePlane).mockImplementation(({ volume: requestedVolume }) => ({
        plane: requestedVolume ? plane : null,
        loading: false,
        error: null,
      }));
      const data = new Uint8Array(volume.data.length);
      data[42] = 1;
      const completion = deferred<SvrEnhancedVolume>();
      vi.mocked(runSuperResolution).mockReturnValue(completion.promise);
      render(
        <SvrVolume3DViewer
          volume={volume}
          initialSelection={{ data, dims: volume.dims, meta: SELECTION_LABEL_META }}
        />,
      );
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
      await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      if (!nativeEnabled) fireEvent.click(screen.getByRole('button', { name: 'MRI slice', exact: true }));
      await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled)));
      fireEvent.click(screen.getByRole('button', { name: /Enhance selection/ }));
      await waitFor(() => expect(runSuperResolution).toHaveBeenCalledOnce());
      expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled));
      const enhancementInput = vi.mocked(runSuperResolution).mock.lastCall![0];
      await act(async () => completion.resolve(enhancedFixture(enhancementInput)));
      const comparison = await screen.findByRole('group', { name: 'Volume detail comparison' });
      await waitFor(() => {
        expect(recorder.latestInteger('u_enhancedEnabled')).toBe(1);
        expect(recorder.latestInteger('u_tumorOnly')).toBe(1);
        expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled));
      });
      expect(screen.getByRole('button', { name: 'MRI slice', exact: true })).toHaveAttribute(
        'aria-pressed',
        String(nativeEnabled),
      );
      expect(screen.getByText(/Inferred detail—not acquired/)).toHaveTextContent(
        nativeEnabled ? 'MRI plane shows exact source pixels' : 'Saved selection unchanged',
      );
      for (const [label, enabled] of [
        ['Original', 0],
        ['Enhanced · 2×', 1],
      ] as const) {
        fireEvent.click(within(comparison).getByRole('button', { name: label }));
        await waitFor(() => expect(recorder.latestInteger('u_enhancedEnabled')).toBe(enabled));
        expect(recorder.latestInteger('u_nativeEnabled')).toBe(Number(nativeEnabled));
        expect(screen.getByRole('button', { name: 'MRI slice', exact: true })).toHaveAttribute(
          'aria-pressed',
          String(nativeEnabled),
        );
      }
      expect(pixels).toEqual(originalPixels);
      expect(volume.data).toEqual(sourceValues);
      expect(data[42]).toBe(1);
      expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    },
  );

  it.each(['slice', 'tool', 'escape'] as const)('discards an unfinished stroke after a %s change', (kind) => {
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    openSelectionEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 160 };
    fireEvent.pointerDown(canvas, point);
    if (kind === 'slice')
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '8' } });
    else if (kind === 'tool') fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    else fireEvent.keyDown(canvas, { key: 'Escape' });
    fireEvent.pointerUp(canvas, point);
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
  });

  it('keeps navigation available during reconstruction while preserving the frozen selection', () => {
    const volume = editingVolume();
    const run = testSelectionProposer;
    const view = render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    setAutoFill(false);
    paint(5, 6);
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeEnabled();
    view.rerender(<SvrVolume3DViewer volume={volume} busy />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to 3D' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-fill' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Browse' })).toBeEnabled();
    expect(screen.getByText(/your current selection is preserved/i)).toBeInTheDocument();
    view.rerender(<SvrVolume3DViewer volume={volume} />);
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('reports exact patient-space crosshair coordinates without treating observed zero as missing data', () => {
    const volume = {
      ...observedVolume,
      originMm: [10, -4, 20] as [number, number, number],
      voxelSizeMm: [0.5, 2, 3] as [number, number, number],
    };
    const view = render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    expect(screen.getByRole('status', { name: 'Crosshair position' })).toHaveTextContent(
      'No acquired support · Patient position: (10.50, -2.00, 20.00) mm',
    );
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'ArrowLeft' });
    expect(screen.getByRole('status', { name: 'Crosshair position' })).toHaveTextContent(
      'Acquired support · Patient position: (10.00, -2.00, 20.00) mm',
    );
    view.rerender(<SvrVolume3DViewer volume={{ ...volume, observedSupport: Uint8Array.of(1, 0, 1, 1) }} />);
    expect(screen.getByRole('status', { name: 'Crosshair position' })).toHaveTextContent(
      'Acquired support · Patient position: (10.50, -2.00, 20.00) mm',
    );
  });

  it('never uploads a previous source buffer under a replacement volume even if dimensions match', async () => {
    const recorder = createViewportRecorder({ width: 400, height: 320 });
    const original = editingVolume(4);
    const view = render(<SvrVolume3DViewer volume={original} />);
    await waitFor(() => expect(recorder.volumeUploads.some((args) => args[9] instanceof Uint16Array)).toBe(true));
    const oldBits = (recorder.volumeUploads.find((args) => args[9] instanceof Uint16Array)![9] as Uint16Array)[0];
    recorder.texImage3D.mockClear();
    recorder.volumeUploads.length = 0;
    view.rerender(<SvrVolume3DViewer volume={{ ...original, data: new Float32Array(64).fill(0.9) }} />);
    await waitFor(() => expect(recorder.volumeUploads.some((args) => args[9] instanceof Uint16Array)).toBe(true));
    for (const args of recorder.volumeUploads) if (args[9] instanceof Uint16Array) expect(args[9][0]).not.toBe(oldBits);
  });

  it('keeps physical aspect, radiological orientation, and unmodified source samples in all planes', () => {
    const volume: SvrVolume = {
      ...observedVolume,
      data: Float32Array.from({ length: 24 }, (_, index) => (index + 1) / 25),
      observedSupport: Uint8Array.from({ length: 24 }, (_, index) => (index === 14 ? 0 : 1)),
      dims: [2, 3, 4],
      voxelSizeMm: [0.5, 2, 3],
      originMm: [10, -4, 20],
    };
    const source = volume.data.slice();
    const read = recordSlices();
    render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    for (const [plane, width, height, first, aspect] of [
      ['axial', 2, 3, 133, 1 / 6],
      ['coronal', 2, 4, 214, 1 / 12],
      ['sagittal', 3, 4, 204, 6 / 12],
    ] as const) {
      const { image, width: renderWidth, height: renderHeight } = read(plane);
      expect([image.width, image.height]).toEqual([width, height]);
      expect([...image.data.slice(0, 4)]).toEqual([first, first, first, 255]);
      expect(renderWidth / renderHeight).toBeCloseTo(aspect);
    }
    expect([...read('axial').image.data.slice(8, 12)]).toEqual([0, 0, 0, 255]);
    expect(volume.data).toEqual(source);
  });

  it('coalesces a long brush draft to one frame without rebuilding grayscale or copying its accumulated raster', async () => {
    const read = recordSlices();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    setAutoFill(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const { canvas, drawImage, sourceWrites } = read('axial');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
    const allocations = read.imageAllocations();
    const grayWrites = sourceWrites.mock.calls.length;
    const draws = drawImage.mock.calls.length;
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, isPrimary: true, clientX: 120, clientY: 160 });
    for (let x = 124; x <= 280; x += 4) fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x, clientY: 160 });
    expect(frames.size).toBe(1);
    expect(drawImage).toHaveBeenCalledTimes(draws);
    expect(read.imageAllocations()).toBe(allocations);
    const frame = frames.values().next().value!;
    frames.clear();
    act(() => frame(performance.now()));
    expect(drawImage.mock.calls.length).toBe(draws + 1); // one retained native-resolution composite
    expect(sourceWrites).toHaveBeenCalledTimes(grayWrites);
    expect(read.imageAllocations()).toBe(allocations);
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 280, clientY: 160 });
    expect(sourceWrites).toHaveBeenCalledTimes(grayWrites);
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![1]!.patch!.indices.length).toBeGreaterThan(1);
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.foreground.length).toBeGreaterThan(1);
  });

  it('does not erase native slice texture by reducing a large plane to a fixed-size inspector', () => {
    const read = recordSlices();
    const volume = {
      ...observedVolume,
      dims: [1024, 1, 1] as [number, number, number],
      data: Float32Array.from({ length: 1024 }, (_, i) => (i % 2 ? 0.25 : 0.75)),
      observedSupport: new Uint8Array(1024).fill(1),
      voxelSizeMm: [1, 1, 1] as [number, number, number],
    };
    render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    const { image } = read('axial');
    expect(image.width).toBe(1024);
    expect(image.data[0]).toBe(191);
    expect(image.data[4]).toBe(64);
    expect(image.data[1022 * 4]).toBe(191);
  });

  it.each([
    { invert: false, width: 201, values: [-100.5, -0.5, 99.5, 100.5], expected: [0, 128, 255, 0] },
    { invert: true, width: 201, values: [-100.5, -0.5, 99.5, 100.5], expected: [255, 128, 0, 0] },
    { invert: false, width: 1, values: [-1, -0.5, 0, 1], expected: [0, 0, 255, 0] },
    { invert: true, width: 1, values: [-1, -0.5, 0, 1], expected: [255, 255, 0, 0] },
  ])(
    'matches source VOI in the slice editor for invert=$invert and DICOM width=$width',
    async ({ invert, width, values, expected }) => {
      const read = recordSlices();
      const pixels = Float32Array.from(values);
      const decoded: DecodedFrame = {
        pixels,
        validity: Float32Array.of(1, 1, 1, 0),
        rows: 1,
        cols: 4,
        imageId: 'miradb:source-window',
        seriesUid: 'source',
        sopInstanceUid: 'source-window',
        windowCenter: 0,
        windowWidth: width,
        invert,
      };
      const sourceValues = pixels.slice();
      const volume: SvrVolume = {
        ...observedVolume,
        dims: [4, 1, 1],
        voxelSizeMm: [1, 1, 1],
        data: pixels,
        observedSupport: Uint8Array.of(1, 1, 1, 0),
        intensityRange: [-400, 400],
        displayWindow: nativeDisplayWindow(decoded),
        displayInvert: invert,
      };
      render(<SvrVolume3DViewer volume={volume} />);
      openSelectionEditor();
      const { image } = read('axial');
      for (const [index, gray] of expected.entries())
        expect([...image.data.slice(index * 4, index * 4 + 4)]).toEqual([gray, gray, gray, 255]);
      expect(volume.data).toEqual(sourceValues);
      expect(volume.displayWindow).toEqual(width === 1 ? [-0.5, -0.5] : [-100.5, 99.5]);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
    },
  );

  it('shares display window with the GPU and links the exact cutaway to the axial crosshair without changing MRI data', async () => {
    const volume = editingVolume();
    const source = volume.data.slice();
    const recorder = createViewportRecorder({ width: 400, height: 320 });
    render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    await waitFor(() => expect(recorder.latestZoom()).toBeDefined());
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window width' }), { target: { value: '0.5' } });
    await waitFor(() =>
      expect(recorder.uniform1f.mock.calls.filter(([key]) => key === 'u_windowWidth').at(-1)?.[1]).toBe(0.5),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Interpolated cutaway' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '4' } });
    await waitFor(() => expect(recorder.latestInteger('u_clipEnabled')).toBe(1));
    expect(recorder.uniform1f.mock.calls.filter(([key]) => key === 'u_clipZ').at(-1)?.[1]).toBeCloseTo(3.5 / 12);
    expect(screen.getByRole('button', { name: 'MRI slice', exact: true })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'MRI slice', exact: true }));
    await waitFor(() => expect(recorder.latestInteger('u_clipEnabled')).toBe(0));
    expect(screen.getByRole('button', { name: 'Interpolated cutaway' })).toHaveAttribute('aria-pressed', 'false');
    expect(volume.data).toEqual(source);
  });

  it('keeps editing locked on restore failure and retries without overwriting the saved selection', async () => {
    const volume = editingVolume();
    const labels = new Uint8Array(volume.data.length);
    labels[30] = 1;
    vi.mocked(getVolumeSegmentation).mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce({
      volumeKey: 'saved',
      dims: volume.dims,
      labels,
      updatedAt: 0,
      reviewState: 'reviewed',
      classMetadata: SELECTION_LABEL_META,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry loading' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
  });

  it('preserves edits through a failed save and retries the same selection', async () => {
    vi.mocked(saveVolumeSegmentation).mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    setAutoFill(false);
    paint(5, 6);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry saving' })).toBeInTheDocument());
    const unsaved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels;
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).not.toBeInTheDocument());
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels).toBe(unsaved);
  });

  it('keeps recovered work read-only until editing and retains the original-write guard through a failed save', async () => {
    const { volume } = nativeViewerFixture('axial');
    const scope = { ...identity, seriesUids: ['native-source'], frameOfReferenceUid: 'frame', datasetRevision: 1 };
    const labels = new Uint8Array(volume.data.length);
    labels[30] = 1;
    const legacySource = { volumeKey: 'legacy-grid', revision: 'legacy-revision', updatedAt: 1 };
    vi.mocked(getVolumeSegmentationSnapshot).mockResolvedValueOnce({
      record: {
        volumeKey: legacySource.volumeKey,
        dims: volume.dims,
        labels,
        updatedAt: 1,
        classMetadata: SELECTION_LABEL_META,
        seeds: { foreground: Uint32Array.of(30), background: Uint32Array.of(32) },
        reviewState: 'reviewed',
      },
      revision: null,
      datasetToken: 'test-dataset-token',
      legacySource,
    });
    vi.mocked(saveVolumeSegmentation).mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={scope} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    const currentKey = vi.mocked(getVolumeSegmentationSnapshot).mock.lastCall![0];
    expect(JSON.parse(currentKey)).toMatchObject({ version: 2, study: 'study', series: ['native-source'] });
    expect(vi.mocked(getVolumeSegmentationSnapshot).mock.lastCall![1]).toMatchObject({
      patientKey: 'patient',
      datasetRevision: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry saving' })).toBeInTheDocument());
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![1]).toMatchObject({ expectedRevision: null, legacySource });
    const unsaved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
    expect(unsaved.volumeKey).toBe(currentKey);
    expect(unsaved.labels!.some(Boolean)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).not.toBeInTheDocument());
    const committed = vi.mocked(saveVolumeSegmentation).mock.lastCall!;
    expect(committed[0].labels).toBe(unsaved.labels);
    expect(committed[1]).toMatchObject({ expectedRevision: null, legacySource });
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels![30]).toBe(1));
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![1]!.expectedRevision).toBe(committed[1]!.revision);
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![1]!.legacySource).toBeUndefined();
    expect(deleteVolumeSegmentation).not.toHaveBeenCalled();
  });

  it.each([SavedSelectionChangedError, DatasetReplacedError])(
    'keeps unsaved edits visible and offers explicit discard/reload after %s',
    async (Conflict) => {
      vi.mocked(saveVolumeSegmentation).mockRejectedValueOnce(new Conflict());
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
      setAutoFill(false);
      paint(5, 6);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Discard edits and reload' })).toBeInTheDocument());
      expect(screen.getByText(/unsaved edits remain visible/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry saving' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels[(6 * 12 + 6) * 12 + 5]).toBe(1);
    },
  );

  it('hydrates a new same-key volume before any write and ignores late hydration from another volume', async () => {
    const first = editingVolume(),
      second = editingVolume();
    const load = deferred<Awaited<ReturnType<typeof getVolumeSegmentation>>>();
    const labels = new Uint8Array(second.data.length);
    labels[32] = 1;
    const run = testSelectionProposer;
    vi.mocked(getVolumeSegmentation).mockReturnValueOnce(load.promise).mockResolvedValueOnce({
      volumeKey: 'saved',
      dims: second.dims,
      labels,
      updatedAt: 0,
      reviewState: 'draft',
      classMetadata: SELECTION_LABEL_META,
    });
    const view = render(<SvrVolume3DViewer volume={first} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(getVolumeSegmentation).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse' })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    view.rerender(<SvrVolume3DViewer volume={second} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
    await act(async () =>
      load.resolve({ volumeKey: 'old', dims: first.dims, labels: new Uint8Array(first.data.length), updatedAt: 0 }),
    );
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('finishes a submitted save after navigation without silently dropping the last edit', async () => {
    const save = deferred<void>();
    vi.mocked(saveVolumeSegmentation).mockReturnValueOnce(save.promise);
    const view = render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    setAutoFill(false);
    paint(5, 6);
    await waitFor(() => expect(saveVolumeSegmentation).toHaveBeenCalledOnce());
    const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
    view.unmount();
    await act(async () => save.resolve());
    expect(saved.labels[(6 * 12 + 6) * 12 + 5]).toBe(1);
  });

  it('keeps transferred annotations as editable drafts and lets saved edits take precedence', async () => {
    const volume = editingVolume();
    const data = new Uint8Array(volume.data.length);
    data[31] = 1;
    const initialSelection: SvrLabelVolume = {
      data,
      dims: volume.dims,
      meta: SELECTION_LABEL_META,
      reviewState: 'draft',
      seeds: { foreground: Uint32Array.of(31), background: Uint32Array.of(33) },
    };
    const view = render(
      <SvrVolume3DViewer volume={volume} initialSelection={initialSelection} volumeIdentity={identity} />,
    );
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeEnabled());
    expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
    view.unmount();
    const saved = data.slice();
    saved[31] = 0;
    saved[36] = 1;
    vi.mocked(saveVolumeSegmentation).mockClear();
    vi.mocked(getVolumeSegmentation).mockResolvedValueOnce({
      volumeKey: 'saved',
      dims: volume.dims,
      labels: saved,
      updatedAt: 0,
      reviewState: 'reviewed',
      classMetadata: SELECTION_LABEL_META,
    });
    render(<SvrVolume3DViewer volume={volume} initialSelection={initialSelection} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
  });

  it('keeps external labels read-only, sanitizes missing support, and withholds a stale reviewed volume', async () => {
    render(
      <SvrVolume3DViewer
        volume={observedVolume}
        labels={{
          data: Uint8Array.of(1, 1, 1, 1),
          dims: observedVolume.dims,
          meta: SELECTION_LABEL_META,
          reviewState: 'reviewed',
        }}
      />,
    );
    openSelectionEditor();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByText(/Draft · review/)).toBeInTheDocument();
    expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
    open3DSettings('Selection measurements');
    expect(screen.getByText(/review and confirm the selection/i)).toBeInTheDocument();
    expect(screen.queryByText(/total labeled:/i)).not.toBeInTheDocument();
  });

  it('reports only reviewed observed tissue and warns when it touches the volume boundary', () => {
    render(
      <SvrVolume3DViewer
        volume={observedVolume}
        labels={{
          data: Uint8Array.of(1, 0, 1, 0),
          dims: observedVolume.dims,
          meta: SELECTION_LABEL_META,
          reviewState: 'reviewed',
        }}
      />,
    );
    open3DSettings('Selection measurements');
    expect(screen.getByText(/total labeled:/i)).toHaveTextContent('2 vox');
    expect(screen.getByText(/incomplete acquired coverage/i)).toHaveTextContent('2 labeled boundary voxels');
  });
});
