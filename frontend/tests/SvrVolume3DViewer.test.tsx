import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer as ContextViewer, type SvrVolume3DViewerProps } from '../src/components/SvrVolume3DViewer';
import { SvrImagingContext } from '../src/components/svrImagingContext';
import { useSvrNativePlane } from '../src/hooks/useSvrNativePlane';
import type { SvrLabelVolume, SvrNativeSource, SvrVolume } from '../src/types/svr';
import type { DecodedFrame } from '../src/utils/decodedFrame';
import { deleteVolumeSegmentation, getVolumeSegmentation, saveVolumeSegmentation } from '../src/utils/localApi';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from '../src/utils/svr/glRaymarch';
import { makeNativePlaneData, nativeDisplayWindow } from '../src/utils/svr/nativePlane';
import { runSuperResolution } from '../src/utils/svr/superResolutionWorker';
import type { SvrEnhancedVolume } from '../src/utils/svr/superResolutionTypes';
import { volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import type * as SelectionMigration from '../src/utils/svr/selectionMigration';
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
  run: vi.fn(),
  init: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../src/hooks/useOnnxTumorSession', () => ({
  useOnnxTumorSession: () => ({
    status: {
      cached: modelSession.cached,
      verified: modelSession.verified,
      savedAtMs: null,
      loading: modelSession.loading,
      sessionReady: false,
    },
    preflight: modelSession.memoryBlocked
      ? { blockedByDefault: true, estimatedPeakBytes: 600 * 1024 ** 2, budgetBytes: 512 * 1024 ** 2 }
      : null,
    segRunning: modelSession.running,
    allowUnsafeFullRes: false,
    setAllowUnsafeFullRes: vi.fn(),
    fileInputRef: { current: null },
    uploadClick: vi.fn(),
    handleSelectedFiles: vi.fn(),
    clearModel: vi.fn(),
    initSession: modelSession.init,
    runSegmentation: modelSession.run,
    cancelSegmentation: modelSession.cancel,
  }),
}));

vi.mock('../src/utils/localApi', () => ({
  deleteVolumeSegmentation: vi.fn(async () => undefined),
  getVolumeSegmentation: vi.fn(async () => null),
  saveVolumeSegmentation: vi.fn(async () => undefined),
}));

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
  ...props
}: SvrVolume3DViewerProps & {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  initialSelection?: SvrLabelVolume;
  busy?: boolean;
}) {
  return (
    <SvrImagingContext.Provider value={{ volume, labels, initialSelection, busy }}>
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
  const axesContext = new Proxy(
    { fillText: axisText, strokeText: axisOutline },
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
    createProgram: () => ({}),
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
    drawArrays,
    uniformMatrix3fv: (name: string, _transpose: boolean, value: Float32Array) => matrices.set(name, [...value]),
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
    getError,
    texImage3D,
    volumeUploads,
    texSubImage3D,
    texImage2D,
    drawArrays,
    axisText,
    axisOutline,
    latestMatrix: (name: string) => matrices.get(name),
    uniform1f,
    latestInteger: (name: string) => uniform1i.mock.calls.filter(([location]) => location === name).at(-1)?.[1],
    latestZoom: () => uniform1f.mock.calls.filter(([location]) => location === 'u_zoom').at(-1)?.[1],
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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
function nativeViewerFixture() {
  const volume = editingVolume(4);
  const source: SvrNativeSource = {
    seriesUid: 'native-source',
    label: 'Original sagittal source',
    kind: 'original-3d',
    transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translationMm: [0, 0, 0] },
    contributingSopInstanceUids: ['native-0', 'native-1', 'native-2', 'native-3'],
    frames: [0, 1, 2, 3].map((slice) => ({
      sopInstanceUid: `native-${slice}`,
      rows: 4,
      columns: 4,
      originMm: [slice, 0, 3],
      columnDirection: [0, 1, 0],
      rowDirection: [0, 0, -1],
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
function paint(x: number, y: number, kind: 'Mark inside' | 'Mark outside' = 'Mark inside', cancel = false) {
  fireEvent.click(screen.getByRole('button', { name: kind }));
  fireEvent.change(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' }), {
    target: { value: '0.5' },
  });
  const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
  const point = {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 40 + ((x + 0.5) * 320) / 12,
    clientY: ((y + 0.5) * 320) / 12,
  };
  fireEvent.pointerDown(canvas, point);
  if (cancel) fireEvent.pointerCancel(canvas, point);
  else fireEvent.pointerUp(canvas, point);
}
function openSelectionEditor() {
  fireEvent.click(screen.getByRole('button', { name: /^(Select tissue|Edit selection|View slices)$/ }));
}
function open3DSettings(section?: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
  if (section) fireEvent.click(within(screen.getByRole('complementary', { name: '3D settings' })).getByText(section));
}
function recordSlices() {
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
            createImageData: (width: number, height: number) =>
              ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
            putImageData: vi.fn(),
            drawImage: vi.fn(),
          },
          { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
        ),
      );
    return contexts.get(this);
  } as typeof HTMLCanvasElement.prototype.getContext);
  return (plane: string) => {
    const canvas = screen.getByRole('application', {
      name: new RegExp(plane + ' reconstructed slice', 'i'),
    }) as HTMLCanvasElement;
    const draw = contexts.get(canvas)?.drawImage.mock.lastCall;
    const image = contexts.get(draw?.[0])?.putImageData.mock.lastCall?.[0] as ImageData;
    return { canvas, image, width: draw?.[3] as number, height: draw?.[4] as number };
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(modelSession, { cached: false, verified: false, loading: false, running: false, memoryBlocked: false });
  vi.mocked(useSvrNativePlane).mockReset().mockReturnValue({ plane: null, loading: false, error: null });
  vi.mocked(getVolumeSegmentation).mockReset().mockResolvedValue(null);
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
      geometry: {
        version: 1,
        originMm: [0, 0, 0],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        reconstructionFingerprint: 'previous-native-grid',
        sourceProvenance: { mode: 'native-3d', primarySeriesUid: 'source', sources: [] },
      },
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
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled();
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
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
      const zoom = recorder.latestZoom()!;
      const nearestDepth = SVR3D_CAMERA_Z - boxScale[2] / 2;
      const projectedWidth = (boxScale[0] * SVR3D_FOCAL_Z * zoom) / (2 * nearestDepth * (width / height));
      const projectedHeight = (boxScale[1] * SVR3D_FOCAL_Z * zoom) / (2 * nearestDepth);

      expect(projectedWidth).toBeLessThanOrEqual(0.9 + Number.EPSILON);
      expect(projectedHeight).toBeLessThanOrEqual(0.9 + Number.EPSILON);
      expect(Math.max(projectedWidth, projectedHeight)).toBeCloseTo(0.9);
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
    const visibleHalfX = (24 / dims[0]) * (dims[0] / dims[2]);
    const visibleHalfY = (20 / dims[1]) * (dims[1] / dims[2]);
    const nearestVisibleDepth = SVR3D_CAMERA_Z - (84 / dims[2] - 0.5);

    for (const [width, height] of [
      [1472, 972],
      [500, 900],
    ] as const) {
      viewport.width = width;
      viewport.height = height;
      recorder.uniform1f.mockClear();
      view.rerender(<SvrVolume3DViewer volume={createPaddedVolume()} />);
      await waitFor(() => expect(recorder.latestZoom()).toBeDefined());

      const zoom = recorder.latestZoom()!;
      const projectedWidth = (visibleHalfX * SVR3D_FOCAL_Z * zoom) / (nearestVisibleDepth * (width / height));
      const projectedHeight = (visibleHalfY * SVR3D_FOCAL_Z * zoom) / nearestVisibleDepth;

      expect(projectedWidth).toBeLessThanOrEqual(0.9 + Number.EPSILON);
      expect(projectedHeight).toBeLessThanOrEqual(0.9 + Number.EPSILON);
      expect(Math.max(projectedWidth, projectedHeight)).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('keeps later user zoom relative to the physically fitted diagnostic view', async () => {
    const recorder = createViewportRecorder({ width: 1440, height: 900 });
    render(<SvrVolume3DViewer volume={syntheticVolume([1, 0.75, 0.5])} />);
    await waitFor(() => expect(recorder.latestZoom()).toBeDefined());
    const fittedZoom = recorder.latestZoom()!;
    expect(fittedZoom).toBeGreaterThan(2);

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
    expect(screen.queryByRole('button', { name: 'Mark inside' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    expect(screen.queryByText('Slice settings', { selector: 'summary' })).not.toBeInTheDocument();
    openSelectionEditor();
    expect(screen.getByText(/Mark inside, then suggest a boundary. Outside marks are optional./i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark inside' }));
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

  it('suggests with a verified local model without a separate initialization step', async () => {
    modelSession.cached = true;
    modelSession.verified = true;
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    expect(screen.queryByRole('button', { name: 'Suggest with model' })).not.toBeInTheDocument();
    open3DSettings('Custom model');
    expect(screen.queryByRole('button', { name: /init/i })).not.toBeInTheDocument();
    const suggest = screen.getByRole('button', { name: 'Suggest with model' });
    expect(suggest).toBeEnabled();
    fireEvent.click(suggest);
    expect(modelSession.run).toHaveBeenCalledOnce();
    expect(modelSession.init).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it.each(['unverified', 'loading', 'model running', 'reconstructing', 'memory'] as const)(
    'keeps model suggestions unavailable while %s',
    async (blocked) => {
      modelSession.cached = true;
      modelSession.verified = blocked !== 'unverified';
      modelSession.loading = blocked === 'loading';
      modelSession.running = blocked === 'model running';
      modelSession.memoryBlocked = blocked === 'memory';
      render(<SvrVolume3DViewer volume={editingVolume()} busy={blocked === 'reconstructing'} />);
      open3DSettings('Custom model');
      const suggest = screen.getByRole('button', { name: 'Suggest with model' });
      expect(suggest).toBeDisabled();
      fireEvent.click(suggest);
      expect(modelSession.run).not.toHaveBeenCalled();
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

  it('fits the selection without box-clipping anatomy, and isolates native context by labels only on request', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture();
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    const data = new Uint8Array(volume.data.length);
    data[42] = 1;
    render(<SvrVolume3DViewer volume={volume} labels={{ data, dims: volume.dims, meta: SELECTION_LABEL_META }} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    const controls = screen.getByRole('group', { name: /region visualization/i });
    open3DSettings('Source image');
    const coverage = screen.getByRole('group', { name: 'MRI plane coverage' });
    fireEvent.click(screen.getByRole('button', { name: 'Fit selection' }));
    await waitFor(() => expect(recorder.latestInteger('u_focusEnabled')).toBe(0));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
    fireEvent.click(within(coverage).getByRole('button', { name: 'Within selection' }));
    await waitFor(() => expect(recorder.latestInteger('u_tumorOnly')).toBe(1));
    expect(recorder.latestInteger('u_focusEnabled')).toBe(1);
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(coverage).getByRole('button', { name: 'Whole slice' }));
    await waitFor(() => expect(recorder.latestInteger('u_tumorOnly')).toBe(0));
    expect(recorder.latestInteger('u_focusEnabled')).toBe(0);
    expect(data[42]).toBe(1);
  });

  it('resets to a readable native slice rather than turning a sagittal source edge-on', async () => {
    const recorder = createViewportRecorder({ width: 800, height: 600 });
    const { volume, plane } = nativeViewerFixture();
    vi.mocked(useSvrNativePlane).mockReturnValue({ plane, loading: false, error: null });
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestInteger('u_nativeEnabled')).toBe(1));
    const facing = recorder.latestMatrix('u_invRot');
    expect(facing).not.toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    await waitFor(() => expect(recorder.latestMatrix('u_invRot')).not.toEqual(facing));
    fireEvent.keyDown(viewer, { key: '0' });
    await waitFor(() => expect(recorder.latestMatrix('u_invRot')).toEqual(facing));
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
      // Renderer coordinates scale during interaction; use the readout's
      // known viewport position to compare its CSS-space clearance.
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
    'paints exact user marks, suggests only on request, and restores edits with outside marks: %s',
    async (withOutside) => {
      const volume = editingVolume();
      const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
      const grown = [at(5, 6), at(6, 6), at(5, 7)];
      const background = withOutside ? [at(9, 6)] : [];
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
        indices: Uint32Array.from(grown),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
        boundaryCount: 0,
        domainVoxels: 1728,
      });
      const recorder = createViewportRecorder({ width: 400, height: 320 });
      render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
      openSelectionEditor();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled());
      const planes = ['Axial', 'Coronal', 'Sagittal'].map((plane) =>
        screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
      );
      expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
      if (withOutside) {
        paint(9, 6, 'Mark outside');
        expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
        expect(run).not.toHaveBeenCalled();
      }
      paint(5, 6);
      expect(run).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect([...run.mock.calls[0]![0].foreground]).toEqual([at(5, 6)]);
      expect([...run.mock.calls[0]![0].background]).toEqual(background);
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels[at(5, 6)]).toBe(1);
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.foreground]).toEqual([at(5, 6)]);
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.background]).toEqual(background);
      expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
      paint(6, 6, 'Mark outside');
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
      expect(run).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
      expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.background]).toEqual(background);
      fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
      expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute(
        'data-editing',
        'false',
      );
      expect(screen.queryByRole('button', { name: 'Mark inside' })).not.toBeInTheDocument();
      expect(screen.queryByText('Slice settings', { selector: 'summary' })).not.toBeInTheDocument();
      for (const plane of planes) expect(plane).toBeInTheDocument();
      expect(recorder.texSubImage3D.mock.calls.some((args) => args.slice(5, 8).every((value) => value === 1))).toBe(
        true,
      );
      openSelectionEditor();
      expect(screen.getByRole('button', { name: 'Navigate' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
      await waitFor(() =>
        expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels.some(Boolean)).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
      await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
    },
  );

  it('does not commit canceled pointer strokes or paint unsupported anatomy', async () => {
    const volume = editingVolume();
    volume.observedSupport!.fill(0);
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    paint(5, 6);
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    cleanup();
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    openSelectionEditor();
    paint(5, 6, 'Mark inside', true);
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
  });

  it.each(['finish', 'cancel'] as const)(
    'blocks enhancement while a boundary suggestion runs and resumes after %s',
    async (completion) => {
      const volume = editingVolume();
      const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
      const suggestion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(suggestion.promise);
      modelSession.cached = true;
      modelSession.verified = true;
      createViewportRecorder({ width: 400, height: 320 });
      render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
      openSelectionEditor();
      open3DSettings('Custom model');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled());
      paint(5, 6);
      await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Cancel suggestion' }));
        expect(run.mock.calls[0]![1]?.signal?.aborted).toBe(true);
        await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      }
      await act(async () =>
        suggestion.resolve({
          indices: Uint32Array.of(at(5, 6), at(6, 6)),
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
          boundaryCount: 0,
          domainVoxels: volume.data.length,
        }),
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /Enhance selection/ })).toBeEnabled());
      expect(screen.getByRole('button', { name: 'Suggest with model' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Cancel suggestion' })).not.toBeInTheDocument();
      expect(runSuperResolution).not.toHaveBeenCalled();
      expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels[at(6, 6)]).toBe(
        completion === 'finish' ? 1 : 0,
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
    const suggestion = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled());
    paint(5, 6);
    paint(8, 6, 'Mark outside');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
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
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark outside' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
    expect(suggestion).not.toHaveBeenCalled();
    unchanged();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel enhancement' }));
    expect(firstCall[1]!.signal!.aborted).toBe(true);
    expect(screen.getByText('Enhancement canceled. Original data is unchanged.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled();
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

  it.each(['slice', 'tool', 'escape'] as const)('discards an unfinished stroke after a %s change', (kind) => {
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    openSelectionEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mark inside' }));
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 160 };
    fireEvent.pointerDown(canvas, point);
    if (kind === 'slice')
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '8' } });
    else if (kind === 'tool') fireEvent.click(screen.getByRole('button', { name: 'Mark outside' }));
    else fireEvent.keyDown(canvas, { key: 'Escape' });
    fireEvent.pointerUp(canvas, point);
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo selection edit' })).not.toBeInTheDocument();
  });

  it('keeps navigation available during reconstruction while preserving the frozen selection', () => {
    const volume = editingVolume();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    const view = render(<SvrVolume3DViewer volume={volume} />);
    openSelectionEditor();
    paint(5, 6);
    expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeEnabled();
    view.rerender(<SvrVolume3DViewer volume={volume} busy />);
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark outside' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Navigate' })).toBeEnabled();
    expect(screen.getByText(/your current selection is preserved/i)).toBeInTheDocument();
    view.rerender(<SvrVolume3DViewer volume={volume} />);
    expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled();
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
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels).toBe(labels);
  });

  it('preserves edits through a failed save and retries the same selection', async () => {
    vi.mocked(saveVolumeSegmentation).mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled());
    paint(5, 6);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry saving' })).toBeInTheDocument());
    const unsaved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels;
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).not.toBeInTheDocument());
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels).toBe(unsaved);
  });

  it('hydrates a new same-key volume before any write and ignores late hydration from another volume', async () => {
    const first = editingVolume(),
      second = editingVolume();
    let resolveFirst: (value: Awaited<ReturnType<typeof getVolumeSegmentation>>) => void = () => {};
    const labels = new Uint8Array(second.data.length);
    labels[32] = 1;
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    vi.mocked(getVolumeSegmentation)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
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
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Navigate' })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    view.rerender(<SvrVolume3DViewer volume={second} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled());
    await act(async () =>
      resolveFirst({ volumeKey: 'old', dims: first.dims, labels: new Uint8Array(first.data.length), updatedAt: 0 }),
    );
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels).toBe(labels);
  });

  it('finishes a submitted save after navigation without silently dropping the last edit', async () => {
    let finish: () => void = () => {};
    vi.mocked(saveVolumeSegmentation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    openSelectionEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark inside' })).toBeEnabled());
    paint(5, 6);
    await waitFor(() => expect(saveVolumeSegmentation).toHaveBeenCalledOnce());
    const saved = vi.mocked(saveVolumeSegmentation).mock.lastCall![0];
    view.unmount();
    await act(async () => finish());
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeEnabled());
    expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
    view.unmount();
    const saved = data.slice();
    saved[31] = 0;
    saved[36] = 1;
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
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall![0].labels).toBe(saved);
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
    expect(screen.getByRole('button', { name: 'Mark inside' })).toBeDisabled();
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
