import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import { SvrImagingContext } from '../src/components/svrImagingContext';
import { SvrVolume3DViewer } from '../src/components/SvrVolume3DViewer';
import { IDENTITY_PATIENT_TRANSFORM } from '../src/utils/svr/volumeGeometry';
import { makeNativePlaneData } from '../src/utils/svr/nativePlane';

vi.mock('../src/hooks/useOnnxTumorSession', () => ({
  useOnnxTumorSession: () => ({ status: {}, fileInputRef: { current: null } }),
}));
vi.mock('../src/utils/localApi', () => ({
  getVolumeSegmentation: vi.fn(async () => null),
  saveVolumeSegmentation: vi.fn(async () => undefined),
  deleteVolumeSegmentation: vi.fn(async () => undefined),
}));
vi.mock('../src/hooks/useSvrNativePlane', () => ({
  useSvrNativePlane: ({
    volume,
    sourceIndex,
    frameIndex,
  }: {
    volume: SvrVolume;
    sourceIndex: number;
    frameIndex: number;
  }) => {
    const source = volume?.sourceProvenance?.sources[sourceIndex];
    const frame = source?.frames[frameIndex];
    if (!source || !frame) return { plane: null, loading: false, error: null };
    return {
      plane: makeNativePlaneData(volume, source, frameIndex, {
        pixels: Float32Array.from({ length: 64 }, (_, index) => index),
        validity: new Float32Array(64).fill(1),
        rows: 8,
        cols: 8,
        imageId: `miradb:${frame.sopInstanceUid}`,
        sopInstanceUid: frame.sopInstanceUid,
        seriesUid: source.seriesUid,
        windowCenter: 32,
        windowWidth: 65,
      }),
      loading: false,
      error: null,
    };
  },
}));

function nativeVolume(): SvrVolume {
  return {
    data: Float32Array.from({ length: 256 }, (_, index) => index % 64),
    observedSupport: new Uint8Array(256).fill(1),
    supportedVoxelCount: 256,
    dims: [8, 8, 4],
    voxelSizeMm: [1, 1, 2],
    nativeVoxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [0, 0, 0], max: [8, 8, 8] },
    intensityRange: [0, 63],
    displayWindow: [0, 63],
    reconstructionFingerprint: 'synthetic-native',
    sourceProvenance: {
      mode: 'native-3d',
      datasetRevision: 1,
      patientKey: 'patient',
      studyUid: 'study',
      frameOfReferenceUid: 'frame',
      fingerprint: 'synthetic-native',
      primarySeriesUid: 'original',
      explanation: 'Synthetic original acquisition.',
      sources: ['original', 'derived'].map((seriesUid) => ({
        seriesUid,
        label: seriesUid === 'original' ? 'Original axial' : 'Derived view',
        kind: seriesUid === 'original' ? 'original-3d' : 'derived',
        transform: IDENTITY_PATIENT_TRANSFORM,
        contributingSopInstanceUids: [],
        frames: Array.from({ length: 7 }, (_, index) => ({
          sopInstanceUid: `${seriesUid}-${index}`,
          rows: 8,
          columns: 8,
          originMm: [0, 0, index],
          columnDirection: [1, 0, 0],
          rowDirection: [0, 1, 0],
          pixelSpacingMm: [1, 1],
        })),
      })),
    },
  };
}

function renderVolume(volume = nativeVolume()) {
  return render(
    <SvrImagingContext.Provider value={{ volume }}>
      <SvrVolume3DViewer />
    </SvrImagingContext.Provider>,
  );
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Native MRI workspace controls', () => {
  it('steps actual source planes without snapping to a coarser overview grid', async () => {
    const volume = nativeVolume();
    renderVolume(volume);
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    expect(screen.queryByRole('button', { name: 'Mark inside' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(6);
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(4);
    fireEvent.click(screen.getByRole('button', { name: 'Previous original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '2' } });
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('keeps source contrast independent of overview windowing and never alters MRI values', async () => {
    const volume = nativeVolume();
    const original = volume.data.slice();
    renderVolume(volume);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
    fireEvent.click(screen.getByText('Source image', { selector: 'summary' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Original MRI window width' }), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    expect(screen.getByRole('slider', { name: 'MRI window width' })).toHaveValue('63');
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window width' }), {
      target: { value: '20' },
    });
    expect(screen.getByRole('slider', { name: 'Original MRI window width' })).toHaveValue('16');
    fireEvent.click(screen.getByRole('button', { name: 'Reset source contrast' }));
    expect(screen.getByRole('slider', { name: 'Original MRI window width' })).toHaveValue('64');
    expect(volume.data).toEqual(original);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('labels scanner reformats honestly and withholds selection-only clipping until marks exist', async () => {
    renderVolume();
    expect(screen.getByRole('button', { name: 'MRI slice' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('combobox', { name: 'MRI plane source' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
    fireEvent.click(screen.getByText('Source image', { selector: 'summary' }));
    expect(screen.queryByRole('group', { name: 'MRI plane coverage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Selection only' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit selection' })).toBeDisabled();
    expect(screen.getByText('Original MRI', { selector: '.svr-source-kind' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane source' }), { target: { value: '1' } });
    expect(screen.getByText('Scanner reformat', { selector: '.svr-source-kind' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MRI slice' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Original MRI', { selector: '.svr-source-kind' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it.each([
    { source: 'overview', expected: '1.00 × 1.00 × 2.00 mm overview' },
    { source: 'native', expected: '1.00 mm stored samples' },
    { source: 'reconstructed', expected: '1.00 × 1.00 × 2.00 mm grid' },
  ])('discloses $source sampling without claiming new acquired resolution', async ({ source, expected }) => {
    const volume = nativeVolume();
    if (source === 'native') volume.voxelSizeMm = [1, 1, 1];
    if (source === 'reconstructed') {
      delete volume.nativeVoxelSizeMm;
      delete volume.sourceProvenance;
    }
    renderVolume(volume);
    expect(screen.queryByText('Volume details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
    fireEvent.click(screen.getByText('Volume details'));
    expect(screen.getByText(expected)).toBeInTheDocument();
    if (source === 'reconstructed') expect(screen.queryByRole('button', { name: 'MRI slice' })).not.toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'MRI slice' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });
});
