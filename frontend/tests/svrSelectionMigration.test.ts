import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATASET_REVISION_STATE_KEY, deleteAllStoredMriData, getDB, SELECTED_PATIENT_STATE_KEY } from '../src/db/db';
import type { VolumeSegmentationRow } from '../src/db/schema';
import type { SvrVolume } from '../src/types/svr';
import {
  captureSelectionGeometry,
  findTransferableSelection,
  transferSavedSelection,
  type SavedSelectionIdentity,
} from '../src/utils/svr/selectionMigration';
import { IDENTITY_DIRECTION, IDENTITY_PATIENT_TRANSFORM, physicalVolumeBounds } from '../src/utils/svr/volumeGeometry';
import * as scheduling from '../src/utils/svr/svrUtils';

const identity: Required<SavedSelectionIdentity> = {
  patientKey: 'patient',
  studyUid: 'study',
  frameOfReferenceUid: 'frame',
  seriesUids: ['source'],
  datasetRevision: 7,
};

function volume(overrides: Partial<SvrVolume> = {}): SvrVolume {
  const geometry = {
    dims: [3, 3, 3] as [number, number, number],
    voxelSizeMm: [2, 3, 4] as [number, number, number],
    originMm: [0, 0, 0] as [number, number, number],
    direction: IDENTITY_DIRECTION,
    ...overrides,
  };
  const count = geometry.dims.reduce((product, size) => product * size, 1);
  return {
    data: new Float32Array(count).fill(10),
    observedSupport: new Uint8Array(count).fill(1),
    boundsMm: physicalVolumeBounds(geometry),
    reconstructionFingerprint: 'saved-native',
    sourceProvenance: {
      mode: 'native-3d',
      datasetRevision: 7,
      patientKey: 'patient',
      studyUid: 'study',
      frameOfReferenceUid: 'frame',
      fingerprint: 'saved-native',
      primarySeriesUid: 'source',
      explanation: 'Original source',
      sources: [
        {
          seriesUid: 'source',
          label: 'Original source',
          kind: 'original-3d',
          transform: structuredClone(IDENTITY_PATIENT_TRANSFORM),
          contributingSopInstanceUids: ['frame-0', 'frame-1', 'frame-2'],
          frames: [0, 1, 2].map((z) => ({
            sopInstanceUid: `frame-${z}`,
            rows: 3,
            columns: 3,
            originMm: [0, 0, z * 4],
            columnDirection: [1, 0, 0],
            rowDirection: [0, 1, 0],
            pixelSpacingMm: [3, 2],
          })),
        },
      ],
    },
    ...geometry,
  };
}

function key(current: SvrVolume, scope: SavedSelectionIdentity = identity, legacy = false) {
  return JSON.stringify({
    patient: scope.patientKey,
    study: scope.studyUid,
    series: [...scope.seriesUids].sort(),
    frame: scope.frameOfReferenceUid,
    revision: scope.datasetRevision,
    dims: current.dims,
    spacing: current.voxelSizeMm,
    origin: current.originMm,
    ...(legacy ? {} : { direction: current.direction ?? IDENTITY_DIRECTION }),
    reconstruction: current.reconstructionFingerprint,
  });
}

function record(source = volume(), updatedAt = 100): VolumeSegmentationRow {
  const labels = new Uint8Array(source.data.length);
  labels[13] = 1;
  return {
    volumeKey: key(source),
    ...identity,
    seriesUids: [...identity.seriesUids],
    dims: source.dims,
    voxelSizeMm: source.voxelSizeMm,
    geometry: captureSelectionGeometry(source),
    labels,
    classMetadata: [
      { id: 0, name: 'Background', color: [0, 0, 0] },
      { id: 1, name: 'Region', color: [100, 200, 150] },
    ],
    seeds: { foreground: Uint32Array.of(13), background: Uint32Array.of(0) },
    reviewState: 'reviewed',
    updatedAt,
  };
}

function targetVolume() {
  const target = volume({ dims: [5, 5, 5], voxelSizeMm: [1, 1.5, 2], reconstructionFingerprint: 'target-native' });
  target.sourceProvenance!.fingerprint = target.reconstructionFingerprint!;
  return target;
}

async function put(saved: VolumeSegmentationRow) {
  await (await getDB()).put('volume_segmentations', saved);
}

beforeEach(async () => {
  await deleteAllStoredMriData();
  const db = await getDB();
  await db.put('studies', {
    studyInstanceUid: 'study',
    studyDate: '20260101',
    studyDescription: 'Synthetic',
    patientName: 'Test',
    patientId: 'patient',
    modality: 'MR',
  });
  await db.put('series', {
    seriesInstanceUid: 'source',
    studyInstanceUid: 'study',
    seriesDescription: 'Synthetic original',
    seriesNumber: 1,
    modality: 'MR',
  });
  await db.put('app_state', { key: SELECTED_PATIENT_STATE_KEY, value: 'patient' });
  await db.put('app_state', { key: DATASET_REVISION_STATE_KEY, value: 7 });
});

afterEach(() => vi.restoreAllMocks());

describe('saved selection discovery and explicit draft transfer', () => {
  it('captures accepted metadata without MRI pixels and without changing the volume', () => {
    const current = volume();
    const geometry = captureSelectionGeometry(current)!;
    expect(geometry.sourceProvenance.sources[0]!.sopInstanceUids).toEqual(['frame-0', 'frame-1', 'frame-2']);
    expect(JSON.stringify(geometry)).not.toMatch(/pixels|observedSupport|contributingSopInstanceUids/);
    geometry.originMm[0] = 80;
    geometry.sourceProvenance.sources[0]!.sopInstanceUids.pop();
    expect(current.originMm[0]).toBe(0);
    expect(current.sourceProvenance!.sources[0]!.frames).toHaveLength(3);
    expect(captureSelectionGeometry({ ...current, sourceProvenance: undefined })).toBeUndefined();
  });

  it('offers the most recent compatible saved grid, not a newer unverifiable legacy selection or current key', async () => {
    const target = targetVolume();
    const older = record();
    const newerVolume = volume({ originMm: [1, 0, 0] });
    const newer = record(newerVolume, 200);
    const legacy = { ...record(volume({ originMm: [0, 1, 0] }), 300), geometry: undefined };
    for (const saved of [older, newer, legacy, record(target, 400)]) await put(saved);
    const result = await findTransferableSelection(target, identity, key(target));
    expect(result.candidate?.record.volumeKey).toBe(newer.volumeKey);
    expect(Object.keys(result.candidate!.record).sort()).toEqual(['updatedAt', 'volumeKey']);
    expect(result.retainedCount).toBe(3);
    expect(result.unavailableCount).toBe(1);
    expect(result.message).toMatch(/draft.*original stays saved/);
    expect(await (await getDB()).count('volume_segmentations')).toBe(4);
  });

  it('retains and explains legacy geometry without assuming its missing source registration was identity', async () => {
    const previous = volume();
    const legacy = { ...record(previous), volumeKey: key(previous, identity, true), geometry: undefined };
    await put(legacy);
    const target = targetVolume();
    const result = await findTransferableSelection(target, identity, key(target));
    expect(result).toMatchObject({ candidate: null, retainedCount: 1, unavailableCount: 1 });
    expect(result.message).toMatch(/retained.*not been overwritten.*cannot be verified/);
    expect(JSON.stringify(await (await getDB()).get('volume_segmentations', legacy.volumeKey))).toBe(
      JSON.stringify(legacy),
    );
  });

  it('never offers other patients, examinations, frames, source sets, or dataset revisions', async () => {
    const source = volume();
    const scopes = [
      { ...identity, patientKey: 'other' },
      { ...identity, studyUid: 'other' },
      { ...identity, frameOfReferenceUid: 'other' },
      { ...identity, seriesUids: ['other'] },
      { ...identity, datasetRevision: 6 },
    ];
    for (const scope of scopes)
      await put({ ...record(source), ...scope, seriesUids: [...scope.seriesUids], volumeKey: key(source, scope) });
    const target = targetVolume();
    const result = await findTransferableSelection(target, identity, key(target));
    expect(result).toMatchObject({ candidate: null, retainedCount: 1, unavailableCount: 1 });
  });

  it.each(['pose', 'source-identity', 'mode', 'matrix', 'spacing', 'malformed-key', 'hard-marks'])(
    'keeps incompatible %s evidence visible as retained work but does not offer transfer',
    async (kind) => {
      const saved = record();
      if (kind === 'pose') saved.geometry!.sourceProvenance.sources[0]!.transform.translationMm = [1, 0, 0];
      if (kind === 'source-identity')
        saved.geometry!.sourceProvenance.sources[0]!.sopInstanceUids[0] = 'replaced-frame';
      if (kind === 'mode') saved.geometry!.sourceProvenance.mode = 'independent-2d';
      if (kind === 'matrix') saved.geometry!.direction = [1, 1, 0, 0, 1, 0, 0, 0, 1];
      if (kind === 'spacing') saved.voxelSizeMm = [0, 3, 4];
      if (kind === 'malformed-key') saved.volumeKey = '{broken';
      if (kind === 'hard-marks') saved.seeds!.foreground[0] = 14;
      await put(saved);
      const target = targetVolume();
      expect(await findTransferableSelection(target, identity, key(target))).toMatchObject({
        candidate: null,
        retainedCount: 1,
        unavailableCount: 1,
      });
    },
  );

  it.each([undefined, false, true])(
    'copies supported labels, marks and context %s as a draft while preserving the original record',
    async (contextLimited) => {
      const saved = record();
      saved.clippedNativeVoxels = 152;
      if (contextLimited !== undefined) saved.contextLimited = contextLimited;
      await put(saved);
      const target = targetVolume();
      target.observedSupport![31] = 0;
      target.data[32] = NaN;
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      const transferred = await transferSavedSelection(candidate!, target, identity, key(target));
      expect([...transferred.data].filter(Boolean)).toHaveLength(6);
      expect(transferred.data[31]).toBe(0);
      expect(transferred.data[32]).toBe(0);
      expect(transferred.seeds!.foreground).toHaveLength(6);
      expect([...transferred.seeds!.background]).toEqual([0]);
      expect(transferred.seeds).not.toHaveProperty('lastStroke');
      expect(transferred.reviewState).toBe('draft');
      expect(transferred.clippedNativeVoxels).toBe(152);
      expect(transferred.contextLimited).toBe(contextLimited);
      if (contextLimited === undefined) expect(transferred).not.toHaveProperty('contextLimited');
      expect(JSON.stringify(await (await getDB()).get('volume_segmentations', saved.volumeKey))).toBe(
        JSON.stringify(saved),
      );
      expect(await (await getDB()).get('volume_segmentations', key(target))).toBeUndefined();
    },
  );

  it.each([
    ...[null, '152', -1, 0.5, Infinity].map((value) => ({ field: 'clippedNativeVoxels' as const, value })),
    ...[null, 'false', 0, 1, {}].map((value) => ({ field: 'contextLimited' as const, value })),
  ])('retains but does not transfer malformed $field ($value)', async ({ field, value }) => {
    const saved = Object.assign(record(), { [field]: value }) as VolumeSegmentationRow;
    await put(saved);
    const target = targetVolume();
    expect(await findTransferableSelection(target, identity, key(target))).toMatchObject({
      candidate: null,
      retainedCount: 1,
      unavailableCount: 1,
    });
    expect((await (await getDB()).get('volume_segmentations', saved.volumeKey))?.[field]).toEqual(value);
  });

  it.each(['clippedNativeVoxels', 'contextLimited'] as const)(
    'rejects a %s-only saved-record change during transfer, even when its timestamp and mask are unchanged',
    async (field) => {
      const saved = { ...record(), clippedNativeVoxels: 152, contextLimited: true };
      await put(saved);
      const target = targetVolume();
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      const changed =
        field === 'contextLimited' ? { ...saved, contextLimited: false } : { ...saved, clippedNativeVoxels: 153 };
      vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(() => put(changed));
      await expect(transferSavedSelection(candidate!, target, identity, key(target))).rejects.toThrow(/changed/);
      expect((await (await getDB()).get('volume_segmentations', saved.volumeKey))?.[field]).toBe(changed[field]);
      expect(await (await getDB()).get('volume_segmentations', key(target))).toBeUndefined();
    },
  );

  it.each(['axial', 'coronal', 'sagittal'] as const)(
    'transfers a valid saved last %s stroke even when earlier marks occupy other sections',
    async (plane) => {
      const saved = record();
      saved.labels[26] = 1;
      saved.seeds!.foreground = Uint32Array.of(13, 26);
      saved.seeds!.lastStroke = { plane, slice: 1 };
      await put(saved);
      const target = targetVolume();
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      expect(candidate).toBeDefined();
      const transferred = await transferSavedSelection(candidate!, target, identity, key(target));
      expect(transferred.seeds!.lastStroke).toEqual({ plane, slice: 2 });
      expect(transferred.seeds!.foreground).toContain(62);
      expect(transferred.seeds!.foreground).toContain(124);
      expect([...transferred.seeds!.background]).toEqual([0]);
      expect(transferred.reviewState).toBe('draft');
      expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(structuredClone(saved));
      expect(await (await getDB()).get('volume_segmentations', key(target))).toBeUndefined();
    },
  );

  it.each([
    null,
    {},
    { plane: 'unknown', slice: 1 },
    { plane: 'axial' },
    { plane: 'axial', slice: -1 },
    { plane: 'axial', slice: 0.5 },
    { plane: 'axial', slice: NaN },
    { plane: 'axial', slice: Infinity },
    { plane: 'axial', slice: 3 },
    { plane: 'coronal', slice: 3 },
    { plane: 'sagittal', slice: 3 },
  ])('retains but does not migrate saved work with invalid stroke metadata %j', async (lastStroke) => {
    const saved = record();
    Object.assign(saved.seeds!, { lastStroke });
    await put(saved);
    const target = targetVolume();
    const status = await findTransferableSelection(target, identity, key(target));
    expect(status.candidate).toBeNull();
    expect(status.retainedCount).toBe(1);
    expect(status.unavailableCount).toBe(1);
    expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(structuredClone(saved));
  });

  it('transfers in patient millimeters across rotated grids without a half-voxel shift', async () => {
    const source = volume({ voxelSizeMm: [2, 2, 2], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] });
    const saved = record(source);
    saved.labels.fill(0);
    saved.labels[10] = 1;
    saved.seeds!.foreground[0] = 10;
    await put(saved);
    const target = volume({
      voxelSizeMm: [2, 2, 2],
      originMm: [-4, 0, 0],
      reconstructionFingerprint: 'rotated-target',
    });
    target.sourceProvenance!.fingerprint = target.reconstructionFingerprint!;
    const { candidate } = await findTransferableSelection(target, identity, key(target));
    const transferred = await transferSavedSelection(candidate!, target, identity, key(target));
    expect([...transferred.data].flatMap((label, index) => (label ? [index] : []))).toEqual([14]);
    expect([...transferred.seeds!.foreground]).toEqual([14]);
  });

  it.each(['patient', 'revision', 'saved-work', 'cancel'])(
    'rejects %s changes during transfer without replacing saved work',
    async (kind) => {
      const saved = record();
      await put(saved);
      const target = targetVolume();
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      const controller = new AbortController();
      vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(async () => {
        const db = await getDB();
        if (kind === 'patient') await db.put('app_state', { key: SELECTED_PATIENT_STATE_KEY, value: 'other' });
        if (kind === 'revision') await db.put('app_state', { key: DATASET_REVISION_STATE_KEY, value: 8 });
        if (kind === 'saved-work') {
          const changed = structuredClone(saved);
          changed.labels[12] = 1; // Same millisecond: updatedAt alone does not establish unchanged work.
          await put(changed);
        }
        if (kind === 'cancel') controller.abort();
      });
      await expect(
        transferSavedSelection(candidate!, target, identity, key(target), controller.signal),
      ).rejects.toThrow(/changed|canceled/);
      expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toBeDefined();
      expect(await (await getDB()).get('volume_segmentations', key(target))).toBeUndefined();
    },
  );

  it.each(['added', 'removed', 'plane', 'slice'] as const)(
    'rejects a last-stroke change (%s) during transfer even when timestamp, labels and marks are unchanged',
    async (kind) => {
      const saved = record();
      if (kind !== 'added') saved.seeds!.lastStroke = { plane: 'axial', slice: 1 };
      await put(saved);
      const target = targetVolume();
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      const changed = structuredClone(saved);
      if (kind === 'removed') delete changed.seeds!.lastStroke;
      else
        changed.seeds!.lastStroke = { plane: kind === 'plane' ? 'coronal' : 'axial', slice: kind === 'slice' ? 2 : 1 };
      vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(() => put(changed));
      await expect(transferSavedSelection(candidate!, target, identity, key(target))).rejects.toThrow(/changed/);
      expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(changed);
      expect(await (await getDB()).get('volume_segmentations', key(target))).toBeUndefined();
    },
  );

  it('compares saved stroke metadata by meaning rather than object property order', async () => {
    const saved = record();
    saved.seeds!.lastStroke = { plane: 'axial', slice: 1 };
    await put(saved);
    const target = targetVolume();
    const { candidate } = await findTransferableSelection(target, identity, key(target));
    const unchanged = structuredClone(saved);
    unchanged.seeds!.lastStroke = { slice: 1, plane: 'axial' };
    vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(() => put(unchanged));
    const result = await transferSavedSelection(candidate!, target, identity, key(target));
    expect(result.seeds!.lastStroke).toEqual({ plane: 'axial', slice: 2 });
    expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(unchanged);
  });

  it('does not publish an empty transfer when the saved selection has no supported target intersection', async () => {
    const saved = record();
    delete saved.seeds;
    await put(saved);
    const target = targetVolume();
    target.observedSupport!.fill(0);
    const { candidate } = await findTransferableSelection(target, identity, key(target));
    await expect(transferSavedSelection(candidate!, target, identity, key(target))).rejects.toThrow(
      /does not intersect supported MRI data/,
    );
  });

  it('preserves a thin inside mark missed by reverse sampling on a coarser grid', async () => {
    const saved = record(volume({ voxelSizeMm: [1, 1, 1] }));
    saved.seeds!.lastStroke = { plane: 'axial', slice: 1 };
    await put(saved);
    const target = volume({ dims: [2, 2, 2], voxelSizeMm: [2, 2, 2], reconstructionFingerprint: 'coarse' });
    target.sourceProvenance!.fingerprint = target.reconstructionFingerprint!;
    const { candidate } = await findTransferableSelection(target, identity, key(target));
    const transferred = await transferSavedSelection(candidate!, target, identity, key(target));
    expect([...transferred.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...transferred.seeds!.foreground]).toEqual([7]);
    expect([...transferred.seeds!.background]).toEqual([0]);
    expect(transferred.seeds).not.toHaveProperty('lastStroke');
  });

  it.each(['inside-outside-collision', 'outside-region', 'missing-support'])(
    'rejects %s rather than silently changing hard marks',
    async (kind) => {
      const saved = record(volume({ voxelSizeMm: [1, 1, 1] }));
      if (kind === 'inside-outside-collision') saved.seeds!.background = Uint32Array.of(14);
      await put(saved);
      const target = volume({
        dims: [2, 2, 2],
        voxelSizeMm: [2, 2, 2],
        originMm: kind === 'outside-region' ? [10, 10, 10] : [0, 0, 0],
        reconstructionFingerprint: 'coarse',
      });
      target.sourceProvenance!.fingerprint = target.reconstructionFingerprint!;
      if (kind === 'missing-support') target.observedSupport![7] = 0;
      const { candidate } = await findTransferableSelection(target, identity, key(target));
      await expect(transferSavedSelection(candidate!, target, identity, key(target))).rejects.toThrow(
        /same cell|outside this region|supported MRI sample/,
      );
      expect(JSON.stringify(await (await getDB()).get('volume_segmentations', saved.volumeKey))).toBe(
        JSON.stringify(saved),
      );
    },
  );
});
