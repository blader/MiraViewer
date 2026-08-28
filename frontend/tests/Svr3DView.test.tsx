import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonData } from '../src/types/api';
import type { SvrLabelVolume, SvrProgress, SvrResult, SvrVolume } from '../src/types/svr';
import { DEFAULT_SVR_PARAMS } from '../src/types/svr';
import { useSvrImaging } from '../src/components/svrImagingContext';
import type * as AcquisitionProvenance from '../src/utils/svr/acquisitionProvenance';
import type { EnhancementSourceLoader } from '../src/utils/svr/superResolutionRegion';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

const mocks = vi.hoisted(() => ({
  cacheInfo: vi.fn(),
  manifests: vi.fn(),
  sortedSopUids: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  reconstruct: vi.fn(),
  enhancementLoader: vi.fn(),
  hook: {
    status: 'idle' as 'idle' | 'running' | 'ready' | 'failed' | 'canceled' | 'canceling',
    isRunning: false,
    progress: null as SvrProgress | null,
    result: null as SvrResult | null,
    resultIdentity: null as string | null,
    error: null as string | null,
  },
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.manifests,
  getSortedSopInstanceUidsForSeries: mocks.sortedSopUids,
}));

vi.mock('../src/utils/svr/acquisitionProvenance', async (importOriginal) => ({
  ...(await importOriginal<typeof AcquisitionProvenance>()),
  // This component suite owns preflight/UI transitions. Real Blob hydration and
  // revision guards are exercised in acquisitionProvenance.test.ts.
  hydrateSvrAcquisitionMetadata: vi.fn(async (manifests) => manifests),
}));

vi.mock('../src/hooks/useSvrReconstruction', () => ({
  useSvrReconstruction: () => ({
    ...mocks.hook,
    run: mocks.run,
    cancel: mocks.cancel,
    clear: mocks.clear,
  }),
}));

vi.mock('../src/utils/svr/reconstructVolume', () => ({ reconstructVolumeMultiPlane: mocks.reconstruct }));

vi.mock('../src/components/SvrVolume3DViewer', () => ({
  SvrVolume3DViewer: function MockSvrViewer({
    volumeIdentity,
  }: {
    volumeIdentity: { patientKey?: string; studyUid?: string } | null;
  }) {
    const imaging = useSvrImaging();
    mocks.enhancementLoader(imaging.loadEnhancementSource);
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
  default: { loadImage: vi.fn(), imageCache: { getCacheInfo: mocks.cacheInfo } },
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
  const orientation = isCoronal
    ? '1\\\\0\\\\0\\\\0\\\\0\\\\1'
    : isSagittal
      ? '0\\\\1\\\\0\\\\0\\\\0\\\\1'
      : '1\\\\0\\\\0\\\\0\\\\1\\\\0';

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
      imagePositionPatient: isCoronal
        ? '0\\\\' + index + '\\\\0'
        : isSagittal
          ? index + '\\\\0\\\\0'
          : '0\\\\0\\\\' + index,
      imageOrientationPatient: orientation,
      pixelSpacing: '1\\\\1',
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
) {
  const base = manifest('axial-patient-a');
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const direction = [c, -s, 0, s, c, 0, 0, 0, 1] as const;
  const sourceManifest = {
    ...base,
    frames: Array.from({ length: 64 }, (_, index) => ({
      ...base.frames[0]!,
      rows: 64,
      columns: 64,
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
            rows: 64,
            columns: 64,
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

function nativeComparisonData() {
  const comparisonData = data('patient-a', 1);
  comparisonData.series_map[comparisonData.sequences[0]!.id]![EXAMINATION]!.instance_count = 64;
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
  mocks.run.mockResolvedValue({ result: null, error: null, durationMs: 0 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.cacheInfo.mockReturnValue({ cacheSizeInBytes: 0, maximumSizeInBytes: 256 * 1024 * 1024 });
  mocks.sortedSopUids.mockResolvedValue([]);
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

describe('SVR reconstruction workspace', () => {
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
    const loaded = acceptedResult();
    mocks.reconstruct.mockResolvedValue(loaded);
    render(<Svr3DView data={comparisonData} />);
    openSources();
    await waitFor(() => expect(screen.getByRole('button', { name: /open 3d volume/i })).toBeEnabled());
    const load = mocks.enhancementLoader.mock.lastCall![0] as EnhancementSourceLoader;
    const before = previous.volume.data.slice();
    const result = await load(labels, {});
    expect(result).toBe(loaded.volume);
    expect(mocks.reconstruct).toHaveBeenCalledOnce();
    const request = mocks.reconstruct.mock.lastCall![0];
    expect(request.acceptedProvenance).toBe(previous.volume.sourceProvenance);
    expect(request.svrParams.roi.mode).toBe('box');
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
    'counts decoded cache and retained annotation/worker bytes before %s native preparation',
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
      await expect(load(labels, { retainedBytes: 100 * 1024 * 1024 })).rejects.toThrow(/too large|memory budget/i);
      expect(mocks.reconstruct).not.toHaveBeenCalled();
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
    const [sources, settings, resultIdentity, transfer] = mocks.run.mock.calls[0]!;
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
    expect(mocks.run.mock.calls[0]?.[2]).toBe(identity(comparisonData));
  });

  it('automatically admits 702 acquired source frames at the nearest memory-safe effective voxel spacing', async () => {
    const comparisonData = data('patient-a', 3);
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
    expect(screen.getByText(/automatically adjusted to stay within the 512 mib memory budget/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reconstruct volume/i }));

    const effectiveParams = mocks.run.mock.calls[0]?.[1];
    // Admission includes the bounded native-plane cache and upload transients
    // alongside decoded frames, the solver, and incoming CPU/GPU labels.
    expect(effectiveParams.targetVoxelSizeMm).toBe(1.19);
    expect(mocks.run.mock.calls[0]?.[2]).toBe(identity(comparisonData));
  });

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
      expect(mocks.manifests).toHaveBeenCalledWith('axial-patient-b');
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
    expect(mocks.run.mock.calls[0]?.[1].targetVoxelSizeMm).toBeGreaterThan(1);
    expect(mocks.run.mock.calls[0]?.[1].maxVolumeDim).toBe(384);
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
