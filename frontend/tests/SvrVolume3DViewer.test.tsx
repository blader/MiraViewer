import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer as ContextViewer, type SvrVolume3DViewerProps } from '../src/components/SvrVolume3DViewer';
import { SvrImagingContext } from '../src/components/svrImagingContext';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { getVolumeSegmentation, saveVolumeSegmentation } from '../src/utils/localApi';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from '../src/utils/svr/glRaymarch';

vi.mock('../src/hooks/useOnnxTumorSession', () => ({
  useOnnxTumorSession: () => ({
    status: { cached: false, verified: false, savedAtMs: null, loading: false, sessionReady: false },
    preflight: null,
    segRunning: false,
    allowUnsafeFullRes: false,
    setAllowUnsafeFullRes: vi.fn(),
    fileInputRef: { current: null },
    uploadClick: vi.fn(),
    handleSelectedFiles: vi.fn(),
    clearModel: vi.fn(),
    initSession: vi.fn(),
    runSegmentation: vi.fn(),
    cancelSegmentation: vi.fn(),
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
  refineRegion,
  ...props
}: SvrVolume3DViewerProps & {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  initialSelection?: SvrLabelVolume;
  busy?: boolean;
  refineRegion?: (labels: SvrLabelVolume) => void;
}) {
  return (
    <SvrImagingContext.Provider value={{ volume, labels, initialSelection, busy, refineRegion }}>
      <ContextViewer {...props} />
    </SvrImagingContext.Provider>
  );
}

function createViewportRecorder(viewport: { width: number; height: number }, occupancyUploadError = false) {
  const uniform1f = vi.fn<(location: unknown, value: number) => void>();
  const uniform1i = vi.fn<(location: unknown, value: number) => void>();
  const texImage3D = vi.fn();
  const texSubImage3D = vi.fn();
  const getError = vi.fn(() => (occupancyUploadError && getError.mock.calls.length === 3 ? 1285 : 0));
  const methods = {
    NO_ERROR: 0,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => name,
    getError,
    isContextLost: () => false,
    uniform1f,
    uniform1i,
    texImage3D,
    texSubImage3D,
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
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((id: string) =>
    id === 'webgl2' ? gl : null) as typeof HTMLCanvasElement.prototype.getContext);

  return {
    getError,
    texImage3D,
    texSubImage3D,
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
function paint(x: number, y: number, kind: 'Add tissue' | 'Remove tissue' = 'Add tissue', cancel = false) {
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
  vi.mocked(getVolumeSegmentation).mockReset().mockResolvedValue(null);
  vi.mocked(saveVolumeSegmentation).mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SvrVolume3DViewer evidence-aware interaction', () => {
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept selection' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Accept selection' }));
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

    expect(screen.queryByText('3D Controls')).not.toBeInTheDocument();
    expect(screen.queryByText('Segmentation')).not.toBeInTheDocument();
    expect(screen.queryByText('ONNX tumor model')).not.toBeInTheDocument();
  });

  it('explains tumor isolation and keeps label-dependent views unavailable until observed tumor exists', async () => {
    render(<SvrVolume3DViewer volume={observedVolume} />);

    const controls = screen.getByRole('group', { name: /region visualization/i });
    expect(within(controls).getByRole('button', { name: 'Anatomy' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toBeDisabled();
    expect(within(controls).getByRole('button', { name: 'Selection only' })).toBeDisabled();
    expect(screen.getByText(/not automatic tumor detection/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
  });

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
    const recorder = createViewportRecorder({ width: 1440, height: 900 }, true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={observedVolume} />);

    await waitFor(() => expect(recorder.getError).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('alert')).toHaveTextContent(/gpu.*empty-space acceleration/i);
    expect(screen.getByRole('application', { name: /axial reconstructed slice/i })).toBeInTheDocument();
    expect(screen.getByText(/acquired support: 2 of 4 voxels/i)).toBeInTheDocument();
  });

  it('discloses measured directional source resolution and slice-profile provenance without clinical confidence', async () => {
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

    expect(screen.getByText(/2 source orientations/i)).toBeInTheDocument();
    expect(screen.getByText(/acquired resolution: 0\.45 × 0\.60 × 3\.25 mm/i)).toBeInTheDocument();
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
    const planes = ['Axial', 'Coronal', 'Sagittal'].map((plane) =>
      screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D control panels' }));
    expect(screen.getByText('Optional verified ONNX model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide 3D control panels' }));
    for (const canvas of planes) expect(canvas).toBeInTheDocument();
    fireEvent.keyDown(planes[0]!, { key: '2' });
    expect(planes[1]).toHaveFocus();
    fireEvent.keyDown(planes[1]!, { key: 'ArrowUp' });
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(8);
  });

  it('paints exact user marks, grows only on request, and restores mask plus marks through undo and redo', async () => {
    const volume = editingVolume();
    const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;
    const grown = [at(5, 6), at(6, 6), at(5, 7)];
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.from(grown),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
      boundaryCount: 0,
      domainVoxels: 1728,
    });
    const recorder = createViewportRecorder({ width: 400, height: 320 });
    render(<SvrVolume3DViewer volume={volume} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tissue' })).toBeEnabled());
    paint(5, 6);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Grow from marks' })).toBeDisabled();
    paint(9, 6, 'Remove tissue');
    expect(screen.getByRole('button', { name: 'Grow from marks' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Grow from marks' }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect([...run.mock.calls[0]![0].foreground]).toEqual([at(5, 6)]);
    expect([...run.mock.calls[0]![0].background]).toEqual([at(9, 6)]);
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
    expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
    paint(6, 6, 'Remove tissue');
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
    expect(run).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(1));
    expect([...vi.mocked(saveVolumeSegmentation).mock.lastCall![0].seeds!.background]).toEqual([at(9, 6)]);
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels[at(6, 6)]).toBe(0));
    fireEvent.click(screen.getByRole('button', { name: 'Accept selection' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
    expect(recorder.texSubImage3D.mock.calls.some((args) => args.slice(5, 8).every((value) => value === 1))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels.some(Boolean)).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    await waitFor(() => expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].reviewState).toBe('reviewed'));
  });

  it('does not commit canceled pointer strokes or paint unsupported anatomy', async () => {
    const volume = editingVolume();
    volume.observedSupport!.fill(0);
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    render(<SvrVolume3DViewer volume={volume} />);
    paint(5, 6);
    expect(screen.getByRole('button', { name: 'Accept selection' })).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
    cleanup();
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    paint(5, 6, 'Add tissue', true);
    expect(screen.getByRole('button', { name: 'Accept selection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeDisabled();
  });

  it.each(['slice', 'tool', 'escape'] as const)('discards an unfinished stroke after a %s change', (kind) => {
    render(<SvrVolume3DViewer volume={editingVolume()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add tissue' }));
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 160 };
    fireEvent.pointerDown(canvas, point);
    if (kind === 'slice')
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '8' } });
    else if (kind === 'tool') fireEvent.click(screen.getByRole('button', { name: 'Remove tissue' }));
    else fireEvent.keyDown(canvas, { key: 'Escape' });
    fireEvent.pointerUp(canvas, point);
    expect(screen.getByRole('button', { name: 'Accept selection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeDisabled();
  });

  it('keeps navigation available during reconstruction while preserving the frozen selection', () => {
    render(<SvrVolume3DViewer volume={editingVolume()} busy />);
    expect(screen.getByRole('button', { name: 'Add tissue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Navigate' })).toBeEnabled();
    expect(screen.getByText(/your current selection is preserved/i)).toBeInTheDocument();
  });

  it('reports exact patient-space crosshair coordinates without treating observed zero as missing data', () => {
    const volume = {
      ...observedVolume,
      originMm: [10, -4, 20] as [number, number, number],
      voxelSizeMm: [0.5, 2, 3] as [number, number, number],
    };
    const view = render(<SvrVolume3DViewer volume={volume} />);
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
    await waitFor(() =>
      expect(recorder.texImage3D.mock.calls.some((args) => args[9] instanceof Uint16Array)).toBe(true),
    );
    const oldBits = (
      recorder.texImage3D.mock.calls.find((args) => args[9] instanceof Uint16Array)![9] as Uint16Array
    )[0];
    recorder.texImage3D.mockClear();
    view.rerender(<SvrVolume3DViewer volume={{ ...original, data: new Float32Array(64).fill(0.9) }} />);
    await waitFor(() =>
      expect(recorder.texImage3D.mock.calls.some((args) => args[9] instanceof Uint16Array)).toBe(true),
    );
    for (const args of recorder.texImage3D.mock.calls)
      if (args[9] instanceof Uint16Array) expect(args[9][0]).not.toBe(oldBits);
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
    const { image } = read('axial');
    expect(image.width).toBe(1024);
    expect(image.data[0]).toBe(191);
    expect(image.data[4]).toBe(64);
    expect(image.data[1022 * 4]).toBe(191);
  });

  it('shares display window with the GPU and links the exact cutaway to the axial crosshair without changing MRI data', async () => {
    const volume = editingVolume();
    const source = volume.data.slice();
    const recorder = createViewportRecorder({ width: 400, height: 320 });
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestZoom()).toBeDefined());
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window width' }), { target: { value: '0.5' } });
    await waitFor(() =>
      expect(recorder.uniform1f.mock.calls.filter(([key]) => key === 'u_windowWidth').at(-1)?.[1]).toBe(0.5),
    );
    fireEvent.click(screen.getByRole('button', { name: '3D cutaway' }));
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry loading' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add tissue' })).toBeDisabled();
    expect(saveVolumeSegmentation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument());
    expect(vi.mocked(saveVolumeSegmentation).mock.lastCall?.[0].labels).toBe(labels);
  });

  it('preserves edits through a failed save and retries the same selection', async () => {
    vi.mocked(saveVolumeSegmentation).mockRejectedValueOnce(new Error('quota'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SvrVolume3DViewer volume={editingVolume()} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tissue' })).toBeEnabled());
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
    await waitFor(() => expect(getVolumeSegmentation).toHaveBeenCalledOnce());
    view.rerender(<SvrVolume3DViewer volume={second} volumeIdentity={identity} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept selection' })).toBeEnabled());
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tissue' })).toBeEnabled());
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Grow from marks' })).toBeEnabled());
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
    expect(screen.getByRole('button', { name: 'Add tissue' })).toBeDisabled();
    expect(screen.getByText(/Draft · review/)).toBeInTheDocument();
    expect(screen.queryByText(/Reviewed selection ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D control panels' }));
    expect(screen.getByText(/review and accept the selection/i)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D control panels' }));
    expect(screen.getByText(/total labeled:/i)).toHaveTextContent('2 vox');
    expect(screen.getByText(/incomplete acquired coverage/i)).toHaveTextContent('2 labeled boundary voxels');
  });
});
