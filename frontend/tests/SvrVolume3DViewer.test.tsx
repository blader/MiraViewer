import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer } from '../src/components/SvrVolume3DViewer';
import type { SvrVolume } from '../src/types/svr';
import { getVolumeSegmentation } from '../src/utils/localApi';
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

function createViewportRecorder(viewport: { width: number; height: number }) {
  const uniform1f = vi.fn<(location: unknown, value: number) => void>();
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
    getError: () => 0,
    isContextLost: () => false,
    uniform1f,
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
    uniform1f,
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
