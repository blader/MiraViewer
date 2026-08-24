import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonData } from '../src/types/api';
import type { SvrResult } from '../src/types/svr';

const mocks = vi.hoisted(() => ({
  manifests: vi.fn(),
  sortedSopUids: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  hook: {
    status: 'idle' as 'idle' | 'running' | 'ready' | 'failed' | 'canceled' | 'canceling',
    isRunning: false,
    progress: null,
    result: null as SvrResult | null,
    resultIdentity: null as string | null,
    error: null as string | null,
  },
}));

vi.mock('../src/utils/localApi', () => ({
  getSeriesFrameManifest: mocks.manifests,
  getSortedSopInstanceUidsForSeries: mocks.sortedSopUids,
}));

vi.mock('../src/hooks/useSvrReconstruction', () => ({
  useSvrReconstruction: () => ({
    ...mocks.hook,
    run: mocks.run,
    cancel: mocks.cancel,
    clear: mocks.clear,
  }),
}));

vi.mock('../src/components/SvrVolume3DViewer', () => ({
  SvrVolume3DViewer: ({ volumeIdentity }: { volumeIdentity: { patientKey?: string; studyUid?: string } | null }) => (
    <div data-testid="accepted-svr-volume">
      {volumeIdentity?.patientKey} / {volumeIdentity?.studyUid}
    </div>
  ),
}));

vi.mock('cornerstone-core', () => ({
  default: { loadImage: vi.fn() },
}));

import { Svr3DView } from '../src/components/Svr3DView';

const EXAMINATION = '2035-01-15T12:00:00';

function data(patient = 'patient-a', orientationCount = 2, unclassified = false): ComparisonData {
  const sourcePlanes = orientationCount === 1 ? ['Axial'] : ['Axial', 'Coronal'];
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
  const orientation = isCoronal ? '1\\\\0\\\\0\\\\0\\\\0\\\\1' : '1\\\\0\\\\0\\\\0\\\\1\\\\0';

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
      imagePositionPatient: isCoronal ? '0\\\\' + index + '\\\\0' : '0\\\\0\\\\' + index,
      imageOrientationPatient: orientation,
      pixelSpacing: '1\\\\1',
      frameOfReferenceUid: frame,
      physicalSlicePosition: index,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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
  it('explains one-orientation ineligibility without exposing premature 3D or segmentation controls', async () => {
    render(<Svr3DView data={data('patient-a', 1)} />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /one acquired orientation/i })).toBeInTheDocument();
    });

    expect(
      screen.getAllByText(/a second independent acquisition orientation is required for multiplane reconstruction/i),
    ).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(screen.queryByTestId('accepted-svr-volume')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /reconstruction sources and quality/i })).toBeInTheDocument();
  });

  it('keeps unclassified but physically valid acquired sequences visible', async () => {
    render(<Svr3DView data={data('patient-a', 1, true)} />);

    await waitFor(() => {
      expect(screen.getAllByText('Unclassified').length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('heading', { name: /one acquired orientation/i })).toBeInTheDocument();
  });

  it('rejects labels that describe different planes when their acquired normals are parallel', async () => {
    mocks.manifests.mockImplementation(async (seriesUid: string) => manifest(seriesUid, 'patient-a', true));
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(
        screen.getAllByText(/a second independent acquisition orientation is required for multiplane reconstruction/i),
      ).not.toHaveLength(0);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
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

  it('discloses and rejects output quality beyond the canonical browser-memory budget', async () => {
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

    fireEvent.change(screen.getByLabelText(/max volume dim/i), { target: { value: '384' } });

    await waitFor(() => {
      expect(screen.getAllByText(/exceeds the safe browser-memory budget/i).length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not reject a physically small scan solely because its maximum dimension is high', async () => {
    render(<Svr3DView data={data('patient-a')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText(/max volume dim/i), { target: { value: '384' } });

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /reconstruct volume/i })[0]).toBeEnabled();
    });
    expect(screen.queryByText(/exceeds the safe browser-memory budget/i)).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /reconstruct volume/i })).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
