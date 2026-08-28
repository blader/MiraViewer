import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    render(
      <SvrImagingContext.Provider value={{ volume }}>
        <SvrVolume3DViewer />
      </SvrImagingContext.Provider>,
    );
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    fireEvent.click(screen.getByRole('button', { name: 'Next original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(6);
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(4);
    fireEvent.click(screen.getByRole('button', { name: 'Previous original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '2' } });
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('keeps source contrast independent of overview windowing and never alters MRI values', () => {
    const volume = nativeVolume();
    const original = volume.data.slice();
    render(
      <SvrImagingContext.Provider value={{ volume }}>
        <SvrVolume3DViewer />
      </SvrImagingContext.Provider>,
    );
    fireEvent.click(screen.getByText('Slice display'));
    fireEvent.change(screen.getByRole('slider', { name: 'Original MRI window width' }), { target: { value: '16' } });
    expect(screen.getByRole('slider', { name: 'MRI window width', hidden: true })).toHaveValue('63');
    fireEvent.change(screen.getByRole('slider', { name: 'MRI window width', hidden: true }), {
      target: { value: '20' },
    });
    expect(screen.getByRole('slider', { name: 'Original MRI window width' })).toHaveValue('16');
    fireEvent.click(screen.getByRole('button', { name: 'Reset source contrast' }));
    expect(screen.getByRole('slider', { name: 'Original MRI window width' })).toHaveValue('64');
    expect(volume.data).toEqual(original);
  });

  it('labels scanner reformats honestly and withholds selection-only clipping until marks exist', () => {
    render(
      <SvrImagingContext.Provider value={{ volume: nativeVolume() }}>
        <SvrVolume3DViewer />
      </SvrImagingContext.Provider>,
    );
    const coverage = screen.getByRole('group', { name: 'MRI plane coverage' });
    expect(within(coverage).getByRole('button', { name: 'Selection only' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fit selection' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'MRI plane source' }), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Scanner reformat' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Original MRI' })).not.toBeInTheDocument();
  });
});
