import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrVolume3DViewer } from '../src/components/SvrVolume3DViewer';
import type { SvrVolume } from '../src/types/svr';
import { getVolumeSegmentation } from '../src/utils/localApi';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SvrVolume3DViewer evidence-aware interaction', () => {
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
});
