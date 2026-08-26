import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer } from '../src/components/SvrVolume3DViewer';
import type { SvrVolume } from '../src/types/svr';
import { getVolumeSegmentation } from '../src/utils/localApi';
import { RegionGrow3DWorkerController } from '../src/utils/segmentation/regionGrow3DWorker';
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

function createViewportRecorder(viewport: { width: number; height: number }, occupancyUploadError = false) {
  const uniform1f = vi.fn<(location: unknown, value: number) => void>();
  const uniform1i = vi.fn<(location: unknown, value: number) => void>();
  const uniform3f = vi.fn<(location: unknown, x: number, y: number, z: number) => void>();
  const texImage3D = vi.fn();
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
    uniform3f,
    texImage3D,
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
    uniform1f,
    latestInteger: (name: string) => uniform1i.mock.calls.filter(([location]) => location === name).at(-1)?.[1],
    latestVector: (name: string) =>
      uniform3f.mock.calls
        .filter(([location]) => location === name)
        .at(-1)
        ?.slice(1),
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

function drawInspectorTumorRegion(start = 20, end = 80): void {
  const canvas = screen.getByRole('img', { name: /axial reconstructed slice/i }) as HTMLCanvasElement;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 100,
    right: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(canvas, 'setPointerCapture', { configurable: true, value: vi.fn() });

  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, isPrimary: true, clientX: start, clientY: start });
  fireEvent.pointerMove(canvas, { pointerId: 1, isPrimary: true, clientX: end, clientY: end });
  fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, isPrimary: true, clientX: end, clientY: end });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SvrVolume3DViewer evidence-aware interaction', () => {
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

    const controls = screen.getByRole('group', { name: /tumor visualization/i });
    expect(within(controls).getByRole('button', { name: 'Anatomy' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toBeDisabled();
    expect(within(controls).getByRole('button', { name: 'Tumor only' })).toBeDisabled();
    expect(screen.getByText(/drag a box around the tumor to segment it in 3d/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
  });

  it('isolates supported tumor or restores anatomy without reallocating the accepted label texture', async () => {
    const recorder = createViewportRecorder({ width: 1440, height: 900 });
    render(
      <SvrVolume3DViewer
        volume={observedVolume}
        labels={{
          data: new Uint8Array([1, 0, 1, 0]),
          dims: observedVolume.dims,
          meta: [{ id: 1, name: 'Observed tumor', color: [192, 156, 106] }],
        }}
      />,
    );

    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(1));
    const controls = screen.getByRole('group', { name: /tumor visualization/i });
    expect(within(controls).getByRole('button', { name: 'Overlay' })).toHaveAttribute('aria-pressed', 'true');
    const initialTextureAllocations = recorder.texImage3D.mock.calls.length;

    fireEvent.click(within(controls).getByRole('button', { name: 'Tumor only' }));
    await waitFor(() => expect(recorder.latestInteger('u_tumorOnly')).toBe(1));
    expect(within(controls).getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(controls).getByRole('button', { name: 'Anatomy' }));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(0));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);

    fireEvent.click(within(controls).getByRole('button', { name: 'Overlay' }));
    await waitFor(() => expect(recorder.latestInteger('u_labelsEnabled')).toBe(1));
    expect(recorder.latestInteger('u_tumorOnly')).toBe(0);
    expect(recorder.texImage3D).toHaveBeenCalledTimes(initialTextureAllocations);
  });

  it('keeps tumor visualization controls reachable inside the actual portaled source inspector', async () => {
    const portal = document.createElement('div');
    document.body.appendChild(portal);

    try {
      render(<SvrVolume3DViewer volume={observedVolume} sliceInspectorPortalTarget={portal} />);
      const controls = within(portal).getByRole('group', { name: /tumor visualization/i });
      expect(within(controls).getByRole('button', { name: 'Anatomy' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(portal).getByText(/drag a box around the tumor/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
    } finally {
      portal.remove();
    }
  });

  it('automatically isolates newly segmented acquired tumor and exposes a truthful sensitivity control', async () => {
    const volume = syntheticVolume([1, 1, 1]);
    const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockImplementation(async ({ seed }) => ({
      indices: new Uint32Array([seed.z * volume.dims[0] * volume.dims[1] + seed.y * volume.dims[0] + seed.x]),
      count: 1,
      seedValue: 0.5,
      hitMaxVoxels: false,
    }));
    render(<SvrVolume3DViewer volume={volume} />);

    drawInspectorTumorRegion();

    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('slider', { name: /tumor sensitivity/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Anatomy' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Anatomy' }));
    fireEvent.change(screen.getByRole('slider', { name: /tumor sensitivity/i }), { target: { value: '0.16' } });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Anatomy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'false');
  });

  it.each([0.86, 0.2])(
    'automatically anchors to a coherent supported off-center lesion of either contrast polarity (%s)',
    async (lesionIntensity) => {
      const dims = [21, 21, 9] as const;
      const volume: SvrVolume = {
        ...syntheticVolume([1, 1, 1]),
        dims,
        data: new Float32Array(dims[0] * dims[1] * dims[2]).fill(0.575),
        observedSupport: new Uint8Array(dims[0] * dims[1] * dims[2]).fill(1),
      };
      const slice = 4;
      const at = (x: number, y: number, z = slice) => z * dims[0] * dims[1] + y * dims[0] + x;
      for (let z = slice - 1; z <= slice + 1; z++) {
        for (let y = 12; y <= 14; y++) {
          for (let x = 13; x <= 15; x++) volume.data[at(x, y, z)] = lesionIntensity;
        }
      }
      volume.data[at(5, 5)] = 1;
      for (let y = 14; y <= 16; y++) {
        for (let x = 6; x <= 8; x++) {
          volume.data[at(x, y)] = 1;
          volume.observedSupport![at(x, y)] = 0;
        }
      }

      const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockImplementation(async ({ seed }) => ({
        indices: new Uint32Array([at(seed.x, seed.y)]),
        count: 1,
        seedValue: lesionIntensity,
        hitMaxVoxels: false,
      }));
      render(<SvrVolume3DViewer volume={volume} />);

      drawInspectorTumorRegion();

      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const selectedSeed = run.mock.calls[0]![0].seed;
      expect(selectedSeed).toEqual({ x: 14, y: 13, z: slice });
      expect(volume.observedSupport![at(selectedSeed.x, selectedSeed.y)]).toBe(1);

      fireEvent.change(screen.getByRole('slider', { name: /tumor sensitivity/i }), { target: { value: '0.16' } });
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(run.mock.calls[1]![0].seed).toEqual(selectedSeed);
    },
  );

  it('anchors to the user-local coherent anomaly instead of distant bilateral anatomical cavities', async () => {
    const dims = [41, 41, 9] as const;
    const slice = 4;
    const at = (x: number, y: number, z = slice) => z * dims[0] * dims[1] + y * dims[0] + x;
    const volume: SvrVolume = {
      ...syntheticVolume([1, 1, 1]),
      dims,
      data: Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => {
        const x = index % dims[0];
        const y = Math.floor(index / dims[0]) % dims[1];
        return 0.56 + x * 0.005 + y * 0.001;
      }),
      observedSupport: new Uint8Array(dims[0] * dims[1] * dims[2]).fill(1),
    };
    for (let z = slice - 2; z <= slice + 2; z++) {
      for (let y = 27; y <= 32; y++) {
        for (const x of [8, 9, 10, 11, 12, 28, 29, 30, 31, 32]) volume.data[at(x, y, z)] = 0.15;
      }
    }
    for (let z = slice - 1; z <= slice + 1; z++) {
      for (let y = 16; y <= 18; y++) {
        for (let x = 19; x <= 21; x++) volume.data[at(x, y, z)] = 0.388;
      }
    }

    const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockImplementation(async ({ seed }) => ({
      indices: new Uint32Array([at(seed.x, seed.y, seed.z)]),
      count: 1,
      seedValue: volume.data[at(seed.x, seed.y, seed.z)]!,
      hitMaxVoxels: false,
    }));
    render(<SvrVolume3DViewer volume={volume} />);

    drawInspectorTumorRegion();

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run.mock.calls[0]![0].seed).toEqual({ x: 20, y: 17, z: slice });
  });

  it('refuses an indistinguishable selected region without isolating or publishing a box-shaped mask', async () => {
    vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockResolvedValue({
      indices: new Uint32Array(),
      count: 0,
      seedValue: 0.5,
      hitMaxVoxels: false,
    });
    render(<SvrVolume3DViewer volume={syntheticVolume([1, 1, 1])} />);

    drawInspectorTumorRegion();

    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').some((alert) => /no distinct tumor-like tissue/i.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Tumor only' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anatomy' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('frames the physical tumor center within its entire supported grow domain and restores the prior anatomy zoom', async () => {
    const volume = syntheticVolume([1, 1, 1]);
    const recorder = createViewportRecorder({ width: 1440, height: 900 });
    const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockImplementation(async ({ seed }) => ({
      indices: new Uint32Array([seed.z * volume.dims[0] * volume.dims[1] + seed.y * volume.dims[0] + seed.x]),
      count: 1,
      seedValue: 0.5,
      hitMaxVoxels: false,
    }));
    render(<SvrVolume3DViewer volume={volume} />);
    await waitFor(() => expect(recorder.latestZoom()).toBeDefined());

    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    fireEvent.keyDown(viewer, { key: '+' });
    await waitFor(() => expect(recorder.latestZoom()).toBeGreaterThan(0));
    const anatomicalZoom = recorder.latestZoom()!;

    drawInspectorTumorRegion(10, 40);

    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
      expect(recorder.latestInteger('u_focusEnabled')).toBe(1);
      expect(recorder.latestZoom()).toBeGreaterThanOrEqual(anatomicalZoom * 1.99);
    });
    const initialFocusedZoom = recorder.latestZoom()!;
    fireEvent.keyDown(viewer, { key: '+' });
    await waitFor(() => expect(recorder.latestZoom()).toBeGreaterThan(initialFocusedZoom * 1.14));

    const { min, max } = run.mock.calls[0]![0].roi;
    const expectedCenter = (['x', 'y', 'z'] as const).map(
      (axis, index) => (min[axis] + max[axis] + 1) / (2 * volume.dims[index]) - 0.5,
    );
    expect(recorder.latestVector('u_focusCenter')).toEqual(expectedCenter);
    expect(recorder.latestVector('u_focusMin')).toEqual([-0.5, -0.5, -0.5]);
    expect(recorder.latestVector('u_focusMax')).toEqual([0.5, 0.5, 0.5]);

    const focusedTextureAllocations = recorder.texImage3D.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Anatomy' }));

    await waitFor(() => {
      expect(recorder.latestInteger('u_focusEnabled')).toBe(0);
      expect(recorder.latestZoom()).toBeCloseTo(anatomicalZoom);
    });
    expect(recorder.latestVector('u_focusCenter')).toEqual([0, 0, 0]);
    expect(recorder.texImage3D).toHaveBeenCalledTimes(focusedTextureAllocations);
  });

  it('recovers the nearest physically supported seed when the drawn tumor center is unsupported', async () => {
    const volume = syntheticVolume([1, 1, 1]);
    volume.observedSupport![21] = 0;
    const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run').mockImplementation(async ({ seed }) => ({
      indices: new Uint32Array([seed.z * volume.dims[0] * volume.dims[1] + seed.y * volume.dims[0] + seed.x]),
      count: 1,
      seedValue: 0.5,
      hitMaxVoxels: false,
    }));
    render(<SvrVolume3DViewer volume={volume} />);

    drawInspectorTumorRegion();

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const seed = run.mock.calls[0]![0].seed;
    const index = seed.z * volume.dims[0] * volume.dims[1] + seed.y * volume.dims[0] + seed.x;
    expect(index).not.toBe(21);
    expect(volume.observedSupport![index]).toBe(1);
    expect(screen.getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never starts segmentation when the selected tumor region has no acquired MRI support', async () => {
    const volume = { ...syntheticVolume([1, 1, 1]), observedSupport: new Uint8Array(64) };
    const run = vi.spyOn(RegionGrow3DWorkerController.prototype, 'run');
    render(<SvrVolume3DViewer volume={volume} />);

    drawInspectorTumorRegion();

    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').some((alert) => /contains no acquired mri support/i.test(alert.textContent ?? '')),
      ).toBe(true),
    );
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Tumor only' })).toBeDisabled();
  });

  it('exposes an accessible keyboard-operable viewer and truthful acquired-support coverage', async () => {
    render(<SvrVolume3DViewer volume={observedVolume} />);

    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    expect(viewer).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/acquired support: 2 of 4 voxels/i)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /axial reconstructed slice/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: /segmentation/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/verified onnx model/i)).not.toBeInTheDocument();

    fireEvent.keyDown(viewer, { key: '2' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /plane/i })).toHaveValue('coronal'));
    expect(screen.getByRole('img', { name: /coronal reconstructed slice/i })).toBeInTheDocument();
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
    expect(screen.getByRole('img', { name: /axial reconstructed slice/i })).toBeInTheDocument();
    expect(screen.getByText(/acquired support: 2 of 4 voxels/i)).toBeInTheDocument();
  });

  it('discloses unsupported inspection coordinates in accepted patient millimeters and follows orthogonal slices', async () => {
    render(<SvrVolume3DViewer volume={{ ...observedVolume, originMm: [10, -4, 20], voxelSizeMm: [0.5, 2, 3] }} />);

    expect(screen.getByRole('status')).toHaveTextContent('No acquired support');
    expect(screen.getByRole('status')).toHaveTextContent('Patient position: (10.50, -2.00, 20.00) mm');

    const viewer = screen.getByRole('application', { name: /three-dimensional reconstructed mri volume/i });
    fireEvent.keyDown(viewer, { key: '3' });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Acquired support');
      expect(screen.getByRole('status')).toHaveTextContent('Patient position: (10.00, -2.00, 20.00) mm');
    });
  });

  it('keeps anisotropic geometry, source pixels, and unsupported anatomy consistent in every inspection plane', async () => {
    const volume: SvrVolume = {
      ...observedVolume,
      data: Float32Array.from({ length: 24 }, (_, index) => (index + 1) / 25),
      observedSupport: Uint8Array.from({ length: 24 }, (_, index) => (index === 8 ? 0 : 1)),
      dims: [2, 3, 4],
      voxelSizeMm: [0.5, 2, 3],
      originMm: [10, -4, 20],
    };
    const context = {
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: vi.fn(),
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((id: string) =>
      id === '2d' ? context : null) as typeof HTMLCanvasElement.prototype.getContext);
    render(<SvrVolume3DViewer volume={volume} />);

    for (const [plane, maxSlice, aspectRatio, position, firstPixel, unsupportedPixel, unsupportedColor] of [
      ['axial', 3, '1 / 6', '(10.50, -2.00, 23.00)', 71, 2, [108, 71, 27]],
      ['coronal', 2, '1 / 12', '(10.50, -2.00, 26.00)', 31, 2, [108, 71, 27]],
      ['sagittal', 1, '6 / 12', '(10.00, -2.00, 26.00)', 10, 4, [46, 34, 20]],
    ] as const) {
      fireEvent.change(screen.getByRole('combobox', { name: /plane/i }), { target: { value: plane } });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(position));
      expect(screen.getByRole('slider', { name: /slice/i })).toHaveAttribute('max', String(maxSlice));
      expect(screen.getByRole('img', { name: new RegExp(plane) })).toHaveStyle({ aspectRatio });

      const image = context.putImageData.mock.lastCall?.[0] as ImageData;
      expect(Array.from(image.data.slice(0, 4))).toEqual([firstPixel, firstPixel, firstPixel, 255]);
      const unsupported = image.data.slice(unsupportedPixel * 4, unsupportedPixel * 4 + 4);
      expect(Array.from(unsupported)).toEqual([...unsupportedColor, 255]);
    }
  });

  it('repaints each newly mounted slice canvas when its inspector moves between portal and inline controls', async () => {
    const portal = document.createElement('div');
    document.body.appendChild(portal);
    const contexts = new Map<HTMLCanvasElement, { putImageData: ReturnType<typeof vi.fn> }>();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (
      this: HTMLCanvasElement,
      contextId: string,
    ) {
      if (contextId !== '2d') return null;
      const context = {
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: vi.fn(),
      };
      contexts.set(this, context);
      return context as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext);

    try {
      const view = render(<SvrVolume3DViewer volume={observedVolume} sliceInspectorPortalTarget={portal} />);
      const firstPortalCanvas = portal.querySelector<HTMLCanvasElement>('canvas[role="img"]');
      expect(firstPortalCanvas).not.toBeNull();
      expect(contexts.get(firstPortalCanvas!)?.putImageData).toHaveBeenCalledOnce();

      view.rerender(<SvrVolume3DViewer volume={observedVolume} />);
      const inlineCanvas = screen.getByRole('img', { name: /axial reconstructed slice/i }) as HTMLCanvasElement;
      expect(inlineCanvas).not.toBe(firstPortalCanvas);
      expect(contexts.get(inlineCanvas)?.putImageData).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByRole('button', { name: /hide 3d control panels/i }));
      expect(screen.queryByRole('img', { name: /axial reconstructed slice/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /show 3d control panels/i }));

      const reopenedInlineCanvas = screen.getByRole('img', {
        name: /axial reconstructed slice/i,
      }) as HTMLCanvasElement;
      expect(reopenedInlineCanvas).not.toBe(inlineCanvas);
      expect(contexts.get(reopenedInlineCanvas)?.putImageData).toHaveBeenCalledOnce();

      view.rerender(<SvrVolume3DViewer volume={observedVolume} sliceInspectorPortalTarget={portal} />);
      const restoredPortalCanvas = portal.querySelector<HTMLCanvasElement>('canvas[role="img"]');
      expect(restoredPortalCanvas).not.toBeNull();
      expect(restoredPortalCanvas).not.toBe(reopenedInlineCanvas);
      expect(contexts.get(restoredPortalCanvas!)?.putImageData).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
    } finally {
      portal.remove();
    }
  });

  it('preserves acquired intensity and footprint support when large inspection planes are downsampled', () => {
    const observedSupport = Uint8Array.from({ length: 1024 }, (_, index) => (index % 2 === 0 ? 1 : 0));
    observedSupport[2] = 0;
    const context = {
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: vi.fn(),
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(((id: string) =>
      id === '2d' ? context : null) as typeof HTMLCanvasElement.prototype.getContext);

    render(
      <SvrVolume3DViewer
        volume={{
          ...observedVolume,
          data: new Float32Array(1024).fill(1),
          observedSupport,
          dims: [1024, 1, 1],
          voxelSizeMm: [1, 1, 1],
          boundsMm: { min: [0, 0, 0], max: [1024, 1, 1] },
        }}
      />,
    );

    const image = context.putImageData.mock.lastCall?.[0] as ImageData;
    expect(Array.from(image.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(image.data.slice(4, 8))).toEqual([108, 71, 27, 255]);
    expect(Array.from(image.data.slice(256 * 4, 256 * 4 + 4))).toEqual([255, 255, 255, 255]);
  });

  it('preserves observed zero-valued anatomy and applies larger coarse-pointer control targets', async () => {
    render(<SvrVolume3DViewer volume={{ ...observedVolume, observedSupport: new Uint8Array([1, 0, 1, 1]) }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Acquired support');
    expect(screen.getByRole('status')).not.toHaveTextContent('No acquired support');

    const toggle = screen.getByRole('button', { name: /hide 3d control panels/i });
    const layout = toggle.closest('.svr-volume-layout');
    expect(layout?.className).toContain('[@media(pointer:coarse)]:[&_button]:min-h-11');
    expect(layout?.className).toContain('[@media(pointer:coarse)]:[&_button]:min-w-11');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2 is not available/i));
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

  it('never includes unsupported external lesion labels in displayed volume measurements', async () => {
    render(
      <SvrVolume3DViewer
        volume={observedVolume}
        labels={{
          data: new Uint8Array([1, 1, 1, 1]),
          dims: [2, 2, 1],
          meta: [{ id: 1, name: 'Observed lesion', color: [255, 64, 64] }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /segmentation/i }));
    await waitFor(() => expect(screen.getByText(/total labeled:/i)).toHaveTextContent('2 vox'));
    expect(screen.getByText(/observed lesion/i).parentElement).toHaveTextContent('2 vox');
    expect(screen.getByText(/incomplete acquired coverage/i)).toHaveTextContent('2 labeled boundary voxels');
  });

  it('warns when an otherwise supported lesion reaches the reconstruction boundary', async () => {
    render(
      <SvrVolume3DViewer
        volume={{
          ...observedVolume,
          data: new Float32Array(27).fill(0.5),
          observedSupport: new Uint8Array(27).fill(1),
          dims: [3, 3, 3],
          voxelSizeMm: [1, 1, 1],
          boundsMm: { min: [0, 0, 0], max: [3, 3, 3] },
        }}
        labels={{
          data: Uint8Array.from({ length: 27 }, (_, index) => (index === 13 || index === 14 ? 1 : 0)),
          dims: [3, 3, 3],
          meta: [{ id: 1, name: 'Boundary lesion', color: [255, 64, 64] }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /segmentation/i }));
    await waitFor(() => expect(screen.getByText(/total labeled:/i)).toHaveTextContent('2 vox'));
    expect(screen.getByText(/incomplete acquired coverage/i)).toHaveTextContent('1 labeled boundary voxel');
    expect(screen.getByText(/incomplete acquired coverage/i)).toHaveTextContent(/reconstruction boundary/i);
  });
});
