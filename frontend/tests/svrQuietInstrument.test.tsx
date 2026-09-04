import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonData } from '../src/types/api';
import type { SvrResult } from '../src/types/svr';
import type * as AcquisitionProvenance from '../src/utils/svr/acquisitionProvenance';

const mocks = vi.hoisted(() => ({
  manifests: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  hook: {
    status: 'idle' as 'idle' | 'ready' | 'running',
    isRunning: false,
    progress: null,
    result: null as SvrResult | null,
    resultIdentity: null as string | null,
    error: null as string | null,
  },
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.manifests,
  getSortedSopInstanceUidsForSeries: vi.fn(async () => []),
  deleteVolumeSegmentation: vi.fn(async () => undefined),
  getVolumeSegmentationSnapshot: vi.fn(async () => ({
    record: null,
    revision: null,
    datasetToken: 'synthetic-dataset',
  })),
  saveVolumeSegmentation: vi.fn(async () => undefined),
}));

vi.mock('../src/utils/svr/acquisitionProvenance', async (importOriginal) => ({
  ...(await importOriginal<typeof AcquisitionProvenance>()),
  // This presentation fixture has no stored DICOM Blobs. Keep real source
  // classification; metadata hydration/ownership has its own database tests.
}));

vi.mock('../src/hooks/useSvrReconstruction', () => ({
  useSvrReconstruction: () => ({
    ...mocks.hook,
    run: mocks.run,
    cancel: mocks.cancel,
    clear: mocks.clear,
  }),
}));

vi.mock('../src/hooks/useOnnxTumorSession', () => ({
  useOnnxTumorSession: () => ({
    status: { cached: false, verified: false, savedAtMs: null, loading: false, sessionReady: false },
    preflight: null,
    segRunning: false,
    fileInputRef: { current: null },
    uploadClick: vi.fn(),
    handleSelectedFiles: vi.fn(),
    clearModel: vi.fn(),
    initSession: vi.fn(),
    runSegmentation: vi.fn(),
    cancelSegmentation: vi.fn(),
  }),
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadImage: vi.fn(),
    getEnabledElements: () => [],
    imageCache: {
      cachedImages: [],
      getCacheInfo: () => ({ cacheSizeInBytes: 0, numberOfImagesCached: 0, maximumSizeInBytes: 256 * 1024 * 1024 }),
    },
  },
}));

import { DicomRoiSlicePreview, Svr3DView } from '../src/components/Svr3DView';

const EXAMINATION = '2035-01-15T12:00:00';
const patient = 'quiet-instrument-patient';

function comparisonData(): ComparisonData {
  const sequences = ['Axial', 'Coronal'].map((plane) => ({
    id: plane.toLowerCase(),
    plane,
    weight: 'T2',
    sequence: 'FLAIR',
    label: `${plane} T2 FLAIR`,
    date_count: 1,
  }));

  return {
    planes: ['Axial', 'Coronal'],
    dates: [EXAMINATION],
    sequences,
    series_map: Object.fromEntries(
      sequences.map((sequence) => [
        sequence.id,
        {
          [EXAMINATION]: {
            study_id: 'quiet-instrument-study',
            study_uid: 'quiet-instrument-study',
            patient_key: patient,
            frame_of_reference_uid: 'quiet-instrument-frame',
            series_uid: sequence.id,
            instance_count: 3,
          },
        },
      ]),
    ),
    selected_patient_key: patient,
    dataset_revision: 7,
    patients: [{ key: patient, patient_id: patient, patient_name: 'Synthetic quiet instrument', study_count: 1 }],
  };
}

function manifest(seriesUid: string) {
  const coronal = seriesUid === 'coronal';
  return {
    seriesUid,
    studyUid: 'quiet-instrument-study',
    patientKey: patient,
    frameOfReferenceUid: 'quiet-instrument-frame',
    ordering: 'physical' as const,
    geometryReliable: true,
    sliceSpacingMm: 1,
    frames: Array.from({ length: 3 }, (_, index) => ({
      sopInstanceUid: `${seriesUid}-${index}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: 'quiet-instrument-study',
      instanceNumber: index + 1,
      rows: 8,
      columns: 8,
      dicomByteLength: 8 * 8 * 2,
      imagePositionPatient: coronal ? `0\\${index}\\0` : `0\\0\\${index}`,
      imageOrientationPatient: coronal ? '1\\0\\0\\0\\0\\1' : '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      frameOfReferenceUid: 'quiet-instrument-frame',
      physicalSlicePosition: index,
      acquisitionMetadata: {
        version: 1 as const,
        imageType: ['ORIGINAL', 'PRIMARY'],
        mrAcquisitionType: '2D' as const,
        acquisitionNumber: coronal ? 2 : 1,
        scanningSequence: ['SE'],
        echoTimeMs: 100,
        repetitionTimeMs: 5000,
        sourceSopInstanceUids: [],
        derivationSopInstanceUids: [],
      },
    })),
  };
}

function acceptedIdentity(): string {
  return JSON.stringify({
    patient,
    study: 'quiet-instrument-study',
    sequence: 'T2|||FLAIR',
    revision: 7,
    frame: 'quiet-instrument-frame',
    series: ['axial', 'coronal'],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.manifests.mockImplementation(async (seriesUid: string) => manifest(seriesUid));
  mocks.hook.status = 'idle';
  mocks.hook.isRunning = false;
  mocks.hook.result = null;
  mocks.hook.resultIdentity = null;
});

afterEach(() => vi.restoreAllMocks());

describe('Quiet Instrument reconstruction lightbox', () => {
  it('keeps cancellation available when the source panel is collapsed during reconstruction', async () => {
    mocks.hook.status = 'running';
    mocks.hook.isRunning = true;
    render(<Svr3DView data={comparisonData()} />);
    expect(screen.queryByRole('complementary', { name: /reconstruction sources and quality/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show reconstruction sources and controls/i }));
    fireEvent.click(await screen.findByText('Source details', { selector: 'summary' }));
    expect(await screen.findByText(/2 independent acquisitions/)).toHaveTextContent('6 source slices');
    fireEvent.click(screen.getByRole('button', { name: /hide reconstruction sources and controls/i }));
    expect(screen.queryByRole('complementary', { name: /reconstruction sources and quality/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reconstruction' }));
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });
  it('keeps patient identity, verified sources, a compact evidence rail, and exactly one primary action', async () => {
    render(<Svr3DView data={comparisonData()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeEnabled());

    expect(screen.getByLabelText('3D scan context for Synthetic quiet instrument')).not.toHaveClass('hidden');
    expect(screen.getByLabelText(/^Displayed examination/)).toHaveAttribute('dateTime', EXAMINATION);
    expect(screen.getByRole('heading', { name: 'Explore this MRI in 3D' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /reconstruction sources and quality/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /reconstruct volume/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /show reconstruction sources and controls/i }));
    const sourceRail = screen.getByRole('complementary', { name: /reconstruction sources and quality/i });
    expect(sourceRail.parentElement?.className).toContain('minmax(240px,304px)');
    fireEvent.click(within(sourceRail).getByText('Source details', { selector: 'summary' }));
    expect(within(sourceRail).getByText('Verified source geometry')).toHaveClass('text-[var(--evidence)]');
    expect(
      within(sourceRail).getByText('Focus region (optional)', { selector: 'summary' }).parentElement,
    ).not.toHaveAttribute('open');
    expect(
      within(sourceRail).getByText('Reconstruction settings', { selector: 'summary' }).parentElement,
    ).not.toHaveAttribute('open');
    expect(within(sourceRail).getByText(/2 independent acquisitions/)).toHaveTextContent('6 source slices');
    expect(screen.getAllByRole('button', { name: /reconstruct volume/i })).toHaveLength(1);
  });

  it('keeps the linked physical workbench independent of the source and appearance rails', async () => {
    mocks.hook.status = 'ready';
    mocks.hook.resultIdentity = acceptedIdentity();
    mocks.hook.result = {
      volume: {
        data: Float32Array.of(0.5, 0, 0.7, 0),
        observedSupport: Uint8Array.of(1, 0, 1, 0),
        supportedVoxelCount: 2,
        dims: [2, 2, 1],
        voxelSizeMm: [1, 1, 3],
        originMm: [0, 0, 0],
        boundsMm: { min: [0, 0, 0], max: [2, 2, 3] },
      },
    };

    const { container } = render(<Svr3DView data={comparisonData()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select tissue' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Region selection workspace' })).toHaveAttribute('data-editing', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    const planes = ['Axial', 'Coronal', 'Sagittal'].map((plane) =>
      screen.getByRole('application', { name: new RegExp(plane + ' reconstructed slice', 'i') }),
    );

    expect(container.querySelector('.svr-volume-layout')).toHaveAttribute('data-controls-open', 'false');
    expect(screen.queryByRole('complementary', { name: '3D settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Crosshair position' })).toHaveTextContent('No acquired support');

    fireEvent.click(screen.getByRole('button', { name: /show reconstruction sources and controls/i }));
    fireEvent.click(screen.getByRole('button', { name: /hide reconstruction sources and controls/i }));

    expect(
      screen.queryByRole('complementary', { name: /reconstruction sources and quality/i }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('.svr-volume-layout')).toHaveAttribute('data-controls-open', 'false');
    for (const canvas of planes) expect(canvas).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 3D settings' }));
    expect(screen.getByRole('complementary', { name: '3D settings' })).toBeInTheDocument();
    for (const canvas of planes) expect(canvas).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Crosshair position' })).toHaveTextContent('No acquired support');
  });

  it('marks a real selected focus boundary without tinting acquired image pixels', () => {
    const { container } = render(
      <DicomRoiSlicePreview
        slice={null}
        sourceSeriesUid={null}
        maxSize={512}
        roiRect={{ x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 }}
        setRoiRect={vi.fn()}
        roiDragRef={{ current: null }}
        onSliceDelta={vi.fn()}
        onRoiFinalized={vi.fn()}
      />,
    );

    const focusBoundary = container.querySelector<HTMLElement>('[style*="left: 10%"]');
    expect(focusBoundary).toHaveClass('border-[var(--signal-metal)]');
    expect(focusBoundary?.className).not.toMatch(/\bbg-/);
  });

  it('does not fabricate measured progress before the reconstruction reports its first completed unit', async () => {
    mocks.hook.status = 'running';
    mocks.hook.isRunning = true;
    render(<Svr3DView data={comparisonData()} />);

    fireEvent.click(screen.getByRole('button', { name: /show reconstruction sources and controls/i }));
    fireEvent.click(await screen.findByText('Source details', { selector: 'summary' }));
    await waitFor(() => expect(screen.getByText('Verified source geometry')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Building your 3D view' })).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
