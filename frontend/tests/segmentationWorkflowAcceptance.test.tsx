import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSvrSelection } from '../src/hooks/useSvrSelection';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { segmentSeededVolume, voxelIndex, voxelPoint } from './helpers/legacySeededVolume';
import type { SelectionProposer } from '../src/utils/segmentation/selectionProposal';
import { physicalBrushIndices, SLICE_AXES } from '../src/utils/segmentation/selectionEditing';
import { classifySvrAcquisitions } from '../src/utils/svr/acquisitionProvenance';
import { assembleNativeVolume, planNativeVolume, retainedSvrVolumeBytes } from '../src/utils/svr/nativeVolume';
import { resampleSelectionForRefinement, selectionFocusRoi } from '../src/utils/svr/refineRegion';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import { patientToVolumeVoxel, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

const sourceDims = [31, 27, 19] as const;
const storedSample = (column: number, row: number, slice: number) => {
  if (column === 2 && row === 2 && slice === 2) return -32768;
  const radius = Math.hypot((column - 15) / 8, (row - 13) / 7, (slice - 9) / 5);
  const fraction = Math.max(0, Math.min(1, (1.1 - radius) / 0.2));
  return Math.round(-400 + 180 * fraction + 12 * Math.sin(column * 0.7 + slice * 0.3) + 6 * Math.cos(row));
};

function nativeWorkflow() {
  const original: SeriesFrameManifest = {
    seriesUid: 'original-sagittal',
    studyUid: 'synthetic-study',
    patientKey: 'synthetic-patient',
    frameOfReferenceUid: 'synthetic-frame',
    ordering: 'physical',
    geometryReliable: true,
    frames: Array.from({ length: sourceDims[2] }, (_, slice) => ({
      sopInstanceUid: `original-${slice}`,
      seriesInstanceUid: 'original-sagittal',
      studyInstanceUid: 'synthetic-study',
      frameOfReferenceUid: 'synthetic-frame',
      instanceNumber: slice + 1,
      rows: sourceDims[1],
      columns: sourceDims[0],
      imageOrientationPatient: '0\\1\\0\\0\\0\\-1',
      imagePositionPatient: `${25 - slice * 1.3}\\-10\\30`,
      pixelSpacing: '0.8\\0.5',
      spacingBetweenSlices: 1.3,
      sliceThickness: 2.6,
      acquisitionMetadata: {
        version: 1 as const,
        imageType: ['ORIGINAL', 'PRIMARY'],
        mrAcquisitionType: '3D' as const,
        sourceSopInstanceUids: [],
        derivationSopInstanceUids: [],
      },
    }))
      .filter((_, slice) => slice !== 3)
      .reverse(),
  };
  const reformat: SeriesFrameManifest = {
    ...original,
    seriesUid: 'derived-first',
    frames: original.frames.map((frame) => ({
      ...frame,
      seriesInstanceUid: 'derived-first',
      sopInstanceUid: `derived-${frame.sopInstanceUid}`,
      acquisitionMetadata: {
        ...frame.acquisitionMetadata!,
        imageType: ['DERIVED', 'PRIMARY', 'REFORMATTED'],
        sourceSopInstanceUids: [frame.sopInstanceUid],
      },
    })),
  };
  const classification = classifySvrAcquisitions([reformat, original]);
  const source = classification.primaryOriginal3d ?? reformat;
  const cold = planNativeVolume(source, {}, { decodedCacheBytes: 0 });
  // Model other live owners without allocating them or changing the production memory budget.
  const constrained = planNativeVolume(
    source,
    {},
    {
      decodedCacheBytes: 0,
      retainedBytes: SVR_MEMORY_BUDGET_BYTES - cold.totalBytes + 1,
    },
  );
  const readFrame = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => {
    expect(frame.seriesInstanceUid).toBe(original.seriesUid);
    return {
      pixels: Int16Array.from({ length: frame.rows * frame.columns }, (_, index) =>
        storedSample(index % frame.columns, Math.floor(index / frame.columns), frame.instanceNumber - 1),
      ),
      slope: 2,
      intercept: 17,
      pixelPaddingValue: -32768,
      invert: true,
    };
  });
  return { original, reformat, classification, cold, constrained, readFrame };
}

function selectionWorkflow(volume: SvrVolume, automatic = true) {
  // A deterministic diagnostic proposal exercises grid/editing ownership here.
  // This is not acceptance evidence for the learned model or its worker.
  const run = vi.fn<SelectionProposer>(async ({ volume: source, seeds, signal, onProgress }) => {
    const result = await segmentSeededVolume(
      {
        volume: source.data,
        observedSupport: source.observedSupport,
        dims: source.dims,
        voxelSizeMm: source.voxelSizeMm,
        ...seeds,
      },
      { signal, onProgress: (processed, total) => onProgress(processed / total), yieldFn: () => Promise.resolve() },
    );
    const data = new Uint8Array(source.data.length);
    for (const index of result.indices) data[index] = 1;
    return {
      data,
      boundaryCount: result.boundaryCount,
      contextLimited: (['x', 'y', 'z'] as const).some(
        (axis, i) => result.bounds.min[axis] > 0 || result.bounds.max[axis] < source.dims[i]! - 1,
      ),
    };
  });
  const hook = renderHook(
    ({ automatic }) => {
      const [source, setSource] = useState(volume);
      const [labels, setLabels] = useState<SvrLabelVolume | null>(null);
      return {
        source,
        setSource,
        labels,
        setLabels,
        selection: useSvrSelection(source, labels, setLabels, automatic, run),
      };
    },
    { initialProps: { automatic } },
  );
  return { ...hook, run };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native Add → Auto-fill workflow invariants, not an anatomy accuracy oracle', () => {
  it('selects original acquisition evidence and keeps cold/constrained grids on exact stored sample centers', async () => {
    const fixture = nativeWorkflow();
    expect(fixture.classification.mode).toBe('native-3d');
    expect(fixture.classification.primaryOriginal3d).toBe(fixture.original);
    const derivedOnly = classifySvrAcquisitions([fixture.reformat]);
    expect(derivedOnly.mode).toBe('unknown');
    expect(derivedOnly.primaryOriginal3d).toBeNull();
    expect(fixture.cold.overview).toBe(false);
    expect(fixture.constrained.overview).toBe(true);
    for (const plan of [fixture.cold, fixture.constrained]) {
      expect(plan.budgetBytes).toBe(SVR_MEMORY_BUDGET_BYTES);
      expect(plan.totalBytes).toBeLessThanOrEqual(plan.budgetBytes);
      const volume = await assembleNativeVolume(plan, fixture.readFrame);
      expect(volume.nativeVoxelSizeMm).toEqual([1.3, 0.5, 0.8]);
      expect(volume.displayInvert).toBe(true);
      const expected = new Float32Array(volume.data.length);
      const supported = new Uint8Array(volume.data.length);
      let maximumGridError = 0;
      for (let index = 0; index < expected.length; index++) {
        const { x, y, z } = voxelPoint(index, volume.dims);
        const patient = volumeVoxelToPatient(volume, [x, y, z]);
        const source = [(patient[1] + 10) / 0.5, (30 - patient[2]) / 0.8, (25 - patient[0]) / 1.3];
        maximumGridError = Math.max(maximumGridError, ...source.map((value) => Math.abs(value - Math.round(value))));
        const [column, row, slice] = source.map(Math.round) as [number, number, number];
        const value = storedSample(column, row, slice);
        if (slice !== 3 && value !== -32768) {
          expected[index] = value * 2 + 17;
          supported[index] = 1;
        }
      }
      expect(maximumGridError).toBeLessThan(1e-10);
      expect(volume.data).toEqual(expected);
      expect(volume.observedSupport).toEqual(supported);
      expect(supported.some((value) => !value)).toBe(true);
    }
  });

  it.each(['axial', 'coronal', 'sagittal'] as const)(
    'paints a physical disc on one %s plane, not a 3D sphere',
    async (plane) => {
      const fixture = nativeWorkflow();
      const volume = await assembleNativeVolume(fixture.constrained, fixture.readFrame);
      const center = { x: 9, y: 8, z: 13 };
      const indices = physicalBrushIndices(volume, plane, center, center, 2);
      const axes = SLICE_AXES[plane];
      const spacing = { x: volume.voxelSizeMm[0], y: volume.voxelSizeMm[1], z: volume.voxelSizeMm[2] };
      expect(indices.length).toBeGreaterThan(1);
      for (const index of indices) {
        const point = voxelPoint(index, volume.dims);
        expect(point[axes.slice]).toBe(center[axes.slice]);
        expect(
          Math.hypot(
            (point[axes.column] - center[axes.column]) * spacing[axes.column],
            (point[axes.row] - center[axes.row]) * spacing[axes.row],
          ),
        ).toBeLessThanOrEqual(2);
        expect(volume.observedSupport![index]).toBe(1);
      }
    },
  );

  it.each(['cold', 'constrained'] as const)(
    'auto-fills %s source samples and preserves hard corrections and full-grid history',
    async (profile) => {
      const fixture = nativeWorkflow();
      const volume = await assembleNativeVolume(fixture[profile], fixture.readFrame);
      const originalData = volume.data.slice(),
        originalSupport = volume.observedSupport!.slice();
      const { result, run } = selectionWorkflow(volume);
      vi.useFakeTimers();
      const center = { x: 9, y: Math.floor(volume.dims[1] / 2), z: 13 };
      const marks = physicalBrushIndices(volume, 'axial', center, center, 2);
      act(() => result.current.selection.stroke(marks, 'include'));
      expect(result.current.selection.status.running).toBe(true);
      expect(run).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(run).toHaveBeenCalledOnce();
      const input = run.mock.calls[0]![0];
      expect(input.volume).toBe(volume);
      expect(input.volume.data).toBe(volume.data);
      expect(input.volume.observedSupport).toBe(volume.observedSupport);
      expect(result.current.labels!.dims).toEqual(volume.dims);
      expect(result.current.labels!.data).toHaveLength(volume.data.length);
      expect(result.current.labels!.reviewState).toBe('draft');
      expect(marks.every((index) => result.current.labels!.data[index] === 1)).toBe(true);
      expect(
        result.current.labels!.data.every((value, index) => !value || Boolean(volume.observedSupport![index])),
      ).toBe(true);
      const remove = Uint32Array.of(voxelIndex(center, volume.dims));
      act(() => result.current.selection.stroke(remove, 'exclude'));
      await act(async () => vi.advanceTimersByTimeAsync(350));
      const corrected = result.current.labels!;
      expect(corrected.data[remove[0]!]).toBe(0);
      expect(corrected.seeds!.background).toEqual(remove);
      expect(corrected.seeds!.foreground.every((index) => corrected.data[index] === 1)).toBe(true);
      act(() => result.current.selection.stroke(remove, 'include'));
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(result.current.labels!.data[remove[0]!]).toBe(1);
      expect(result.current.labels!.seeds!.background).toHaveLength(0);
      act(() => result.current.selection.travel('undo'));
      expect(result.current.labels!.data).toEqual(corrected.data);
      expect(result.current.labels!.seeds).toEqual(corrected.seeds);
      act(() => result.current.selection.travel('redo'));
      expect(result.current.labels!.data[remove[0]!]).toBe(1);
      expect(run).toHaveBeenCalledTimes(3);
      expect(volume.data).toEqual(originalData);
      expect(volume.observedSupport).toEqual(originalSupport);
    },
  );

  it('transfers overview marks in physical space as a draft and then solves only the original-detail grid', async () => {
    const fixture = nativeWorkflow();
    const overview = await assembleNativeVolume(fixture.constrained, fixture.readFrame);
    const { result, run, rerender } = selectionWorkflow(overview, false);
    const center = { x: 9, y: 8, z: 13 };
    act(() => result.current.selection.stroke(physicalBrushIndices(overview, 'axial', center, center, 1), 'include'));
    act(() =>
      result.current.selection.stroke(Uint32Array.of(voxelIndex({ ...center, y: 11 }, overview.dims)), 'exclude'),
    );
    act(() => result.current.selection.accept());
    const saved = result.current.labels!;
    expect(saved.reviewState).toBe('reviewed');
    const roi = selectionFocusRoi(overview, saved, fixture.original.seriesUid);
    const plan = planNativeVolume(
      fixture.original,
      { roi },
      { decodedCacheBytes: 0, retainedBytes: retainedSvrVolumeBytes(overview) },
    );
    expect(plan.overview).toBe(false);
    expect(plan.sourceStrides).toEqual([1, 1, 1]);
    const detail = await assembleNativeVolume(plan, fixture.readFrame);
    const draft = await resampleSelectionForRefinement(overview, saved, detail);
    expect(draft.reviewState).toBe('draft');
    expect(draft.dims).toEqual(detail.dims);
    for (const kind of ['foreground', 'background'] as const) {
      for (const from of saved.seeds![kind]) {
        const p = voxelPoint(from, overview.dims);
        const target = patientToVolumeVoxel(detail, volumeVoxelToPatient(overview, [p.x, p.y, p.z])).map(Math.round);
        const index = voxelIndex({ x: target[0]!, y: target[1]!, z: target[2]! }, detail.dims);
        expect(draft.seeds![kind]).toContain(index);
        expect(draft.data[index]).toBe(kind === 'foreground' ? 1 : 0);
      }
    }
    act(() => {
      result.current.setSource(detail);
      result.current.setLabels(draft);
    });
    vi.useFakeTimers();
    rerender({ automatic: true });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(run).not.toHaveBeenCalled();
    await act(async () => result.current.selection.grow());
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].volume).toBe(detail);
    expect(run.mock.calls[0]![0].volume.observedSupport).toBe(detail.observedSupport);
    expect(result.current.labels!.reviewState).toBe('draft');
    expect(draft.seeds!.foreground.every((index) => result.current.labels!.data[index] === 1)).toBe(true);
    expect(draft.seeds!.background.every((index) => result.current.labels!.data[index] === 0)).toBe(true);
    expect(saved.reviewState).toBe('reviewed');
  });
});
