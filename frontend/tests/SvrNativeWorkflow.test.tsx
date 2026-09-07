import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrNativeSource, SvrVolume } from '../src/types/svr';
import { createSvrImagingOperations, SvrImagingContext } from '../src/components/svrImagingContext';
import { SvrVolume3DViewer } from '../src/components/SvrVolume3DViewer';
import { useSvrNativePlane } from '../src/hooks/useSvrNativePlane';
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
  useSvrNativePlane: vi.fn(
    ({ volume, sourceIndex, frameIndex }: { volume: SvrVolume | null; sourceIndex: number; frameIndex: number }) => {
      const source = volume?.sourceProvenance?.sources[sourceIndex];
      const frame = source?.frames[frameIndex];
      if (!volume || !source || !frame) return { plane: null, loading: false, error: null };
      return {
        plane: makeNativePlaneData(volume, source, frameIndex, {
          pixels: Float32Array.from({ length: 64 }, (_, index) => index + Math.min(0, volume.intensityRange?.[0] ?? 0)),
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
  ),
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

function renderVolume(volume = nativeVolume(), labels?: SvrLabelVolume) {
  return render(
    <SvrImagingContext.Provider value={{ volume, labels, operations: createSvrImagingOperations() }}>
      <SvrVolume3DViewer />
    </SvrImagingContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(6);
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(4);
    fireEvent.click(screen.getByRole('button', { name: 'Previous original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '2' } });
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('chooses accepted axial, coronal and sagittal sources while keeping one physical cursor', async () => {
    const volume = nativeVolume();
    const source = volume.sourceProvenance!.sources[0]!;
    const orthogonal: SvrNativeSource[] = (['coronal', 'sagittal'] as const).map((plane) => ({
      ...source,
      seriesUid: plane,
      label: `Scanner ${plane}`,
      kind: 'derived',
      frames: source.frames.map((frame, index) => ({
        ...frame,
        sopInstanceUid: `${plane}-${index}`,
        originMm: plane === 'coronal' ? [0, index, 0] : [index, 0, 0],
        columnDirection: plane === 'coronal' ? [1, 0, 0] : [0, 1, 0],
        rowDirection: [0, 0, 1],
      })),
    }));
    volume.sourceProvenance!.sources = [...volume.sourceProvenance!.sources, ...orthogonal];
    renderVolume(volume);
    const planeControls = within(screen.getByRole('group', { name: 'MRI slice plane' }));
    expect(useSvrNativePlane).toHaveBeenLastCalledWith({ volume, sourceIndex: 0, frameIndex: 4 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Original MRI slice' }), { target: { value: '6' } });
    fireEvent.click(planeControls.getByRole('button', { name: 'Coronal', exact: true }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    expect(useSvrNativePlane).toHaveBeenLastCalledWith({ volume, sourceIndex: 2, frameIndex: 4 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Original MRI slice' }), { target: { value: '3' } });
    fireEvent.click(planeControls.getByRole('button', { name: 'Sagittal', exact: true }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(5);
    expect(useSvrNativePlane).toHaveBeenLastCalledWith({ volume, sourceIndex: 3, frameIndex: 4 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Original MRI slice' }), { target: { value: '7' } });
    fireEvent.click(planeControls.getByRole('button', { name: 'Axial', exact: true }));
    // The primary acquisition wins over another accepted source in the same plane.
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(6);
    expect(useSvrNativePlane).toHaveBeenLastCalledWith({ volume, sourceIndex: 0, frameIndex: 5 });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(4);
    expect(screen.getByRole('spinbutton', { name: 'Coronal slice' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Sagittal slice' })).toHaveValue(7);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Axial slice' }), { target: { value: '2' } });
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    fireEvent.click(planeControls.getByRole('button', { name: 'Coronal', exact: true }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: 'Next original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Coronal slice' })).toHaveValue(4);
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'Sagittal slice' })).toHaveValue(7);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('labels resident fallbacks explicitly and preserves signed samples, support and hard marks while browsing', async () => {
    const volume = nativeVolume();
    volume.data = Float32Array.from({ length: volume.data.length }, (_, index) => index - 127);
    volume.data[10] = -0;
    volume.intensityRange = [-127, 128];
    volume.displayWindow = [-100, 100];
    volume.observedSupport![3] = 0;
    volume.supportedVoxelCount = volume.data.length - 1;
    const labels: SvrLabelVolume = {
      data: new Uint8Array(volume.data.length),
      dims: volume.dims,
      meta: [{ id: 1, name: 'Selected tissue', color: [103, 207, 193] }],
      seeds: {
        foreground: Uint32Array.of(164),
        background: Uint32Array.of(0),
        lastStroke: { plane: 'axial', slice: 2 },
      },
      reviewState: 'draft',
    };
    labels.data[164] = 1;
    const originalData = volume.data.slice();
    const originalSupport = volume.observedSupport!.slice();
    const originalLabels = {
      ...labels,
      data: labels.data.slice(),
      dims: [...labels.dims],
      meta: labels.meta.map((entry) => ({ ...entry, color: [...entry.color] })),
      seeds: {
        foreground: labels.seeds!.foreground.slice(),
        background: labels.seeds!.background.slice(),
        lastStroke: { ...labels.seeds!.lastStroke! },
      },
    };
    renderVolume(volume, labels);
    const planeControls = within(screen.getByRole('group', { name: 'MRI slice plane' }));
    fireEvent.click(planeControls.getByRole('button', { name: 'Coronal', exact: true }));
    expect(screen.getByText('Volume reformat', { selector: '.svr-native-source-note' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(5);
    expect(useSvrNativePlane).toHaveBeenLastCalledWith({ volume: null, sourceIndex: -1, frameIndex: 4 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Volume reformat slice' }), { target: { value: '3' } });
    fireEvent.click(planeControls.getByRole('button', { name: 'Sagittal', exact: true }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Volume reformat slice' }), { target: { value: '7' } });
    fireEvent.click(planeControls.getByRole('button', { name: 'Axial', exact: true }));
    expect(screen.queryByText('Volume reformat', { selector: '.svr-native-source-note' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next original MRI slice' }));
    expect(screen.getByRole('spinbutton', { name: 'Original MRI slice' })).toHaveValue(6);
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(4);
    expect(screen.getByRole('spinbutton', { name: 'Coronal slice' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Sagittal slice' })).toHaveValue(7);
    fireEvent.click(planeControls.getByRole('button', { name: 'Coronal', exact: true }));
    expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: 'Show display settings' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Contrast' }), { target: { value: '40' } });
    expect(volume.data).toEqual(originalData);
    expect(Object.is(volume.data[10], -0)).toBe(true);
    expect(volume.observedSupport).toEqual(originalSupport);
    expect(volume.displayWindow).toEqual([-100, 100]);
    expect(labels).toEqual(originalLabels);
    for (const result of vi.mocked(useSvrNativePlane).mock.results) {
      if (result.type !== 'return' || !result.value.plane) continue;
      expect(result.value.plane.image.pixels).toEqual(Float32Array.from({ length: 64 }, (_, index) => index - 127));
      expect(result.value.plane.image.validity).toEqual(new Float32Array(64).fill(1));
    }
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('withholds tumor-only clipping and tumor fitting until marks exist', async () => {
    renderVolume();
    expect(screen.getByRole('button', { name: 'MRI slice' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Tumor only' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show display settings' }));
    expect(screen.queryByRole('button', { name: 'Fit tumor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Face slice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MRI slice' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });

  it('offers volume reformat planes for a reconstructed grid without an original source', async () => {
    const volume = nativeVolume();
    delete volume.nativeVoxelSizeMm;
    delete volume.sourceProvenance;
    renderVolume(volume);
    expect(screen.getByRole('button', { name: 'MRI slice' })).toBeEnabled();
    const planeControls = within(screen.getByRole('group', { name: 'MRI slice plane' }));
    for (const plane of ['Axial', 'Coronal', 'Sagittal']) {
      fireEvent.click(planeControls.getByRole('button', { name: plane, exact: true }));
      expect(planeControls.getByRole('button', { name: plane, exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('spinbutton', { name: 'Volume reformat slice' })).toBeEnabled();
    }
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/webgl2/i));
  });
});
