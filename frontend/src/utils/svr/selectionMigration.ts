import { DATASET_REVISION_STATE_KEY, getDB, SELECTED_PATIENT_STATE_KEY } from '../../db/db';
import { getPatientIdentityAliases, getPatientIdentityKeys } from '../../db/patientIdentity';
import { readStoredVolumeSegmentation, type VolumeSegmentationLookup } from '../../db/volumeSegmentations';
import type { VolumeSegmentationGeometry, VolumeSegmentationRow } from '../../db/schema';
import type { SvrLabelMeta, SvrLabelVolume, SvrVolume } from '../../types/svr';
import { IDENTITY_DIRECTION } from './volumeGeometry';
import { transferSelectionAnnotations } from './annotationTransfer';
import { isSelectionContextValid, isSelectionCoverageValid } from '../segmentation/selectionEditing';
import { nativeVolumeFingerprint } from './nativeVolume';

export type SavedSelectionIdentity = {
  patientKey?: string;
  studyUid?: string;
  seriesUids: readonly string[];
  frameOfReferenceUid?: string;
  datasetRevision?: number;
};

export type SavedSelectionCandidate = {
  /** Discovery never retains label buffers in UI state; explicit copy reads them on demand. */
  record: Pick<VolumeSegmentationRow, 'volumeKey' | 'updatedAt'>;
};

export type SavedSelectionMigration = {
  candidate: SavedSelectionCandidate | null;
  retainedCount: number;
  unavailableCount: number;
  message: string | null;
};

type RequiredIdentity = Required<SavedSelectionIdentity>;
type KeyGeometry = {
  version?: 2;
  patient?: string;
  study: string;
  series: string[];
  frame: string;
  revision?: number;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: NonNullable<SvrVolume['direction']>;
  reconstruction?: string;
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finiteArray = (value: unknown, size: number): value is number[] =>
  Array.isArray(value) && value.length === size && value.every(Number.isFinite);
const closeArray = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length && left.every((value, index) => Math.abs(value - right[index]!) <= 1e-6);
const sameArray = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const stringSet = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(nonempty) && new Set(value).size === value.length;
const sameSet = (left: readonly string[], right: readonly string[]) => {
  const values = new Set(right);
  return left.length === right.length && left.every((value) => values.has(value));
};

function orthonormal(value: unknown, proper = false): value is NonNullable<SvrVolume['direction']> {
  if (!finiteArray(value, 9)) return false;
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      const product = value[a]! * value[b]! + value[a + 3]! * value[b + 3]! + value[a + 6]! * value[b + 6]!;
      if (Math.abs(product - (a === b ? 1 : 0)) > 1e-4) return false;
    }
  const determinant =
    value[0]! * (value[4]! * value[8]! - value[5]! * value[7]!) -
    value[1]! * (value[3]! * value[8]! - value[5]! * value[6]!) +
    value[2]! * (value[3]! * value[7]! - value[4]! * value[6]!);
  return !proper || determinant > 0.999;
}

function validGeometry(geometry: VolumeSegmentationGeometry | undefined): geometry is VolumeSegmentationGeometry {
  const provenance = geometry?.sourceProvenance;
  return Boolean(
    geometry?.version === 1 &&
    finiteArray(geometry.originMm, 3) &&
    orthonormal(geometry.direction) &&
    nonempty(geometry.reconstructionFingerprint) &&
    provenance &&
    ['native-3d', 'independent-2d', 'source-stack'].includes(provenance.mode) &&
    nonempty(provenance.primarySeriesUid) &&
    Array.isArray(provenance.sources) &&
    provenance.sources.length > 0 &&
    new Set(provenance.sources.map((source) => source?.seriesUid)).size === provenance.sources.length &&
    provenance.sources.some((source) => source?.seriesUid === provenance.primarySeriesUid) &&
    provenance.sources.every(
      (source) =>
        source &&
        nonempty(source.seriesUid) &&
        ['original-3d', 'original-2d', 'derived', 'unknown'].includes(source.kind) &&
        orthonormal(source.transform?.rotation, true) &&
        finiteArray(source.transform?.translationMm, 3) &&
        stringSet(source.sopInstanceUids),
    ),
  );
}

/** Saving remains available for legacy volumes; missing provenance is never invented. */
export function captureSelectionGeometry(volume: SvrVolume): VolumeSegmentationGeometry | undefined {
  const provenance = volume.sourceProvenance;
  if (!provenance || provenance.fingerprint !== volume.reconstructionFingerprint) return undefined;
  const geometry: VolumeSegmentationGeometry = {
    version: 1,
    originMm: [...volume.originMm],
    direction: [...(volume.direction ?? IDENTITY_DIRECTION)],
    reconstructionFingerprint: provenance.fingerprint,
    sourceProvenance: {
      mode: provenance.mode,
      primarySeriesUid: provenance.primarySeriesUid,
      sources: provenance.sources.map((source) => ({
        seriesUid: source.seriesUid,
        kind: source.kind,
        transform: { rotation: [...source.transform.rotation], translationMm: [...source.transform.translationMm] },
        sopInstanceUids: source.frames.map((frame) => frame.sopInstanceUid),
      })),
    },
  };
  return validGeometry(geometry) ? geometry : undefined;
}

function parseKey(key: string): KeyGeometry | null {
  try {
    const parsed = JSON.parse(key) as KeyGeometry;
    const direction = parsed?.direction ?? IDENTITY_DIRECTION;
    if (
      !parsed ||
      (parsed.version !== undefined && parsed.version !== 2) ||
      (parsed.version === 2
        ? !nonempty(parsed.reconstruction)
        : !nonempty(parsed.patient) || !Number.isSafeInteger(parsed.revision) || parsed.revision! < 0) ||
      !nonempty(parsed.study) ||
      !nonempty(parsed.frame) ||
      !stringSet(parsed.series) ||
      !finiteArray(parsed.dims, 3) ||
      !parsed.dims.every((size) => Number.isSafeInteger(size) && size > 0) ||
      !Number.isSafeInteger(parsed.dims.reduce((product, size) => product * size, 1)) ||
      !finiteArray(parsed.spacing, 3) ||
      !parsed.spacing.every((spacing) => spacing > 0) ||
      !finiteArray(parsed.origin, 3) ||
      !orthonormal(direction)
    )
      return null;
    return { ...parsed, direction };
  } catch {
    return null;
  }
}

function completeIdentity(identity: SavedSelectionIdentity): identity is RequiredIdentity {
  return (
    nonempty(identity.patientKey) &&
    nonempty(identity.studyUid) &&
    nonempty(identity.frameOfReferenceUid) &&
    stringSet(identity.seriesUids) &&
    Number.isSafeInteger(identity.datasetRevision) &&
    identity.datasetRevision! >= 0
  );
}

function matchesScope(
  key: KeyGeometry,
  identity: RequiredIdentity,
  includeRevision = true,
  patientAliases: readonly string[] = [identity.patientKey],
): boolean {
  return (
    (key.version === 2 || patientAliases.includes(key.patient!)) &&
    key.study === identity.studyUid &&
    key.frame === identity.frameOfReferenceUid &&
    sameSet(key.series, identity.seriesUids) &&
    (!includeRevision || key.version === 2 || key.revision === identity.datasetRevision)
  );
}

function matchesVolume(volume: SvrVolume, identity: RequiredIdentity, key: KeyGeometry | null): boolean {
  const provenance = volume.sourceProvenance;
  const selectedSources = new Set(identity.seriesUids);
  return Boolean(
    key &&
    matchesScope(key, identity) &&
    closeArray(key.dims, volume.dims) &&
    closeArray(key.spacing, volume.voxelSizeMm) &&
    closeArray(key.origin, volume.originMm) &&
    closeArray(key.direction, volume.direction ?? IDENTITY_DIRECTION) &&
    key.reconstruction === volume.reconstructionFingerprint &&
    provenance &&
    provenance.fingerprint === volume.reconstructionFingerprint &&
    provenance.patientKey === identity.patientKey &&
    provenance.studyUid === identity.studyUid &&
    provenance.frameOfReferenceUid === identity.frameOfReferenceUid &&
    provenance.datasetRevision === identity.datasetRevision &&
    provenance.sources.every((source) => selectedSources.has(source.seriesUid)),
  );
}

/** Complete accepted source geometry owns durable identity; incomplete historical volumes keep their old key. */
export function selectionVolumeKey(
  volume: SvrVolume | null | undefined,
  identity: SavedSelectionIdentity | null | undefined,
): string | null {
  if (!volume || !identity?.studyUid || !identity.seriesUids.length) return null;
  const grid = {
    study: identity.studyUid,
    series: [...identity.seriesUids].sort(),
    frame: identity.frameOfReferenceUid ?? null,
    dims: volume.dims,
    spacing: volume.voxelSizeMm,
    origin: volume.originMm,
    ...(volume.direction ? { direction: volume.direction } : {}),
  };
  const canonical = JSON.stringify({
    version: 2,
    ...grid,
    direction: volume.direction ?? IDENTITY_DIRECTION,
    reconstruction: volume.reconstructionFingerprint,
  });
  if (
    completeIdentity(identity) &&
    captureSelectionGeometry(volume) &&
    matchesVolume(volume, identity, parseKey(canonical))
  )
    return canonical;
  return JSON.stringify({
    patient: identity.patientKey ?? null,
    ...grid,
    revision: identity.datasetRevision ?? null,
    ...(volume.reconstructionFingerprint ? { reconstruction: volume.reconstructionFingerprint } : {}),
  });
}

function sameRegisteredSources(
  previous: VolumeSegmentationGeometry['sourceProvenance'],
  current: VolumeSegmentationGeometry['sourceProvenance'],
  coordinatesEqual = closeArray,
): boolean {
  return (
    previous.mode === current.mode &&
    previous.primarySeriesUid === current.primarySeriesUid &&
    previous.sources.length === current.sources.length &&
    previous.sources.every((source) => {
      const match = current.sources.find((candidate) => candidate.seriesUid === source.seriesUid);
      return Boolean(
        match &&
        source.kind === match.kind &&
        sameSet(source.sopInstanceUids, match.sopInstanceUids) &&
        coordinatesEqual(source.transform.rotation, match.transform.rotation) &&
        coordinatesEqual(source.transform.translationMm, match.transform.translationMm),
      );
    })
  );
}

/** Freeze source/grid metadata only. The storage snapshot verifies the live owner and epoch before projecting a row. */
export function exactSelectionLookup(
  volume: SvrVolume,
  identity: SavedSelectionIdentity,
): VolumeSegmentationLookup | undefined {
  const currentKey = selectionVolumeKey(volume, identity);
  const geometry = captureSelectionGeometry(volume);
  if (!completeIdentity(identity) || !geometry || !currentKey || parseKey(currentKey)?.version !== 2) return undefined;
  const scope = { ...identity, seriesUids: [...identity.seriesUids] };
  const grid = { dims: [...volume.dims], spacing: [...volume.voxelSizeMm] };
  const primary = volume.sourceProvenance!.sources.find(
    (source) => source.seriesUid === geometry.sourceProvenance.primarySeriesUid,
  )!;
  const contributing = [...primary.contributingSopInstanceUids];
  const nativeGrid = {
    dims: [...volume.dims] as SvrVolume['dims'],
    originMm: geometry.originMm,
    direction: geometry.direction,
    voxelSizeMm: [...volume.voxelSizeMm] as SvrVolume['voxelSizeMm'],
  };
  const primaryTransform = geometry.sourceProvenance.sources.find(
    (source) => source.seriesUid === primary.seriesUid,
  )!.transform;
  return {
    studyUid: scope.studyUid,
    patientKey: scope.patientKey,
    datasetRevision: scope.datasetRevision,
    matches(record, patientAliases) {
      const key = parseKey(record.volumeKey);
      const previous = record.geometry;
      if (
        !key ||
        !matchesScope(key, scope, false, patientAliases) ||
        !patientAliases.includes(record.patientKey ?? '') ||
        record.studyUid !== scope.studyUid ||
        record.frameOfReferenceUid !== scope.frameOfReferenceUid ||
        !stringSet(record.seriesUids) ||
        !sameSet(record.seriesUids, scope.seriesUids) ||
        !Number.isFinite(record.updatedAt) ||
        !validGeometry(previous) ||
        !finiteArray(record.dims, 3) ||
        !finiteArray(record.voxelSizeMm, 3) ||
        !sameArray(record.dims, grid.dims) ||
        !sameArray(key.dims, grid.dims) ||
        !sameArray(record.voxelSizeMm, grid.spacing) ||
        !sameArray(key.spacing, grid.spacing) ||
        !sameArray(previous.originMm, geometry.originMm) ||
        !sameArray(key.origin, geometry.originMm) ||
        !sameArray(previous.direction, geometry.direction) ||
        !sameArray(key.direction, geometry.direction) ||
        key.reconstruction !== previous.reconstructionFingerprint ||
        (key.version !== 2 && key.revision !== record.datasetRevision) ||
        !sameRegisteredSources(previous.sourceProvenance, geometry.sourceProvenance, sameArray) ||
        ('labels' in record && !validLabels(record))
      )
        return false;
      return (
        previous.reconstructionFingerprint === geometry.reconstructionFingerprint ||
        Boolean(
          previous.reconstructionFingerprint.startsWith('native-v1-') &&
          geometry.reconstructionFingerprint.startsWith('native-v2-') &&
          geometry.sourceProvenance.mode !== 'independent-2d' &&
          Number.isSafeInteger(record.datasetRevision) &&
          record.datasetRevision! >= 0 &&
          previous.reconstructionFingerprint ===
            nativeVolumeFingerprint(
              primary.seriesUid,
              contributing,
              nativeGrid,
              primaryTransform,
              record.datasetRevision,
            ),
        )
      );
    },
  };
}

function validLabels(record: VolumeSegmentationRow): boolean {
  if (!isSelectionCoverageValid(record.clippedNativeVoxels) || !isSelectionContextValid(record.contextLimited))
    return false;
  if (!finiteArray(record.dims, 3) || !record.dims.every((size) => Number.isSafeInteger(size) && size > 0))
    return false;
  const count = record.dims.reduce((product, size) => product * size, 1);
  // IndexedDB and worker values may originate in another JS realm.
  if (
    !ArrayBuffer.isView(record.labels) ||
    Object.prototype.toString.call(record.labels) !== '[object Uint8Array]' ||
    record.labels.length !== count
  )
    return false;
  const seeds = record.seeds;
  if (!seeds) return true;
  if (
    [seeds.foreground, seeds.background].some(
      (value) => !ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint32Array]',
    )
  )
    return false;
  // The last editing action does not constrain earlier accumulated marks to the same section.
  const stroke = seeds.lastStroke;
  if (stroke !== undefined) {
    const axis = ['sagittal', 'coronal', 'axial'].indexOf(stroke?.plane);
    if (axis < 0 || !Number.isSafeInteger(stroke?.slice) || stroke.slice < 0 || stroke.slice >= record.dims[axis]!)
      return false;
  }
  return (
    seeds.foreground.every((index) => index < count && record.labels[index]! > 0) &&
    seeds.background.every((index) => index < count && record.labels[index] === 0)
  );
}

function transferable(
  record: VolumeSegmentationRow,
  target: VolumeSegmentationGeometry,
  identity: RequiredIdentity,
  patientAliases: readonly string[],
) {
  const key = parseKey(record.volumeKey);
  const geometry = record.geometry;
  if (
    !key ||
    !matchesScope(key, identity, true, patientAliases) ||
    !validGeometry(geometry) ||
    !validLabels(record) ||
    !finiteArray(record.dims, 3) ||
    !closeArray(key.dims, record.dims) ||
    !finiteArray(record.voxelSizeMm, 3) ||
    !closeArray(key.spacing, record.voxelSizeMm) ||
    !closeArray(key.origin, geometry.originMm) ||
    !closeArray(key.direction, geometry.direction) ||
    key.reconstruction !== geometry.reconstructionFingerprint ||
    record.datasetRevision !== identity.datasetRevision ||
    !patientAliases.includes(record.patientKey ?? '') ||
    record.studyUid !== identity.studyUid ||
    record.frameOfReferenceUid !== identity.frameOfReferenceUid ||
    !stringSet(record.seriesUids) ||
    !sameSet(record.seriesUids, identity.seriesUids) ||
    !Number.isFinite(record.updatedAt)
  )
    return false;
  return sameRegisteredSources(geometry.sourceProvenance, target.sourceProvenance);
}

const STORES = ['volume_segmentations', 'volume_segmentation_chunks', 'app_state', 'studies', 'series'] as const;
const changed = () =>
  new Error('The saved selection or MRI dataset changed. Reopen the reconstruction before transferring it.');
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Selection transfer canceled.', 'AbortError');
};

async function inspectSavedSelections(
  identity: RequiredIdentity,
  inspect: (record: VolumeSegmentationRow, patientAliases: readonly string[]) => void,
  signal?: AbortSignal,
  key?: string,
) {
  abort(signal);
  const db = await getDB();
  const tx = db.transaction(STORES, 'readonly');
  const [revision, selected, studies, series] = await Promise.all([
    tx.objectStore('app_state').get(DATASET_REVISION_STATE_KEY),
    tx.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
    tx.objectStore('studies').getAll(),
    Promise.all(identity.seriesUids.map((uid) => tx.objectStore('series').get(uid))),
  ]);
  if (
    (revision?.value ?? 0) !== identity.datasetRevision ||
    selected?.value !== identity.patientKey ||
    getPatientIdentityKeys(studies).get(identity.studyUid) !== identity.patientKey ||
    series.some((source) => !source || source.studyInstanceUid !== identity.studyUid)
  )
    throw changed();
  const patientAliases = getPatientIdentityAliases(
    studies.find((study) => study.studyInstanceUid === identity.studyUid)!,
  );
  const store = tx.objectStore('volume_segmentations');
  if (key) {
    const record = await store.get(key);
    if (!record) throw changed();
    inspect(await readStoredVolumeSegmentation(record, tx.objectStore('volume_segmentation_chunks')), patientAliases);
  } else {
    // Indexed iteration retains no label buffers between rows.
    let cursor = await store.index('by-study').openCursor(identity.studyUid);
    while (cursor) {
      abort(signal);
      inspect(
        await readStoredVolumeSegmentation(cursor.value, tx.objectStore('volume_segmentation_chunks')),
        patientAliases,
      );
      cursor = await cursor.continue();
    }
  }
  await tx.done;
  abort(signal);
}

/** Discovery is read-only. Legacy keys prove grid location, not the old solver's source registration. */
export async function findTransferableSelection(
  volume: SvrVolume,
  identity: SavedSelectionIdentity,
  currentVolumeKey: string,
): Promise<SavedSelectionMigration> {
  const result: SavedSelectionMigration = { candidate: null, retainedCount: 0, unavailableCount: 0, message: null };
  if (!completeIdentity(identity)) return result;
  const target = matchesVolume(volume, identity, parseKey(currentVolumeKey))
    ? captureSelectionGeometry(volume)
    : undefined;
  await inspectSavedSelections(identity, (record, patientAliases) => {
    if (
      record.volumeKey === currentVolumeKey ||
      !patientAliases.includes(record.patientKey ?? '') ||
      record.studyUid !== identity.studyUid
    )
      return;
    const key = parseKey(record.volumeKey);
    if (
      record.frameOfReferenceUid !== identity.frameOfReferenceUid ||
      !stringSet(record.seriesUids) ||
      !sameSet(record.seriesUids, identity.seriesUids) ||
      (key && !matchesScope(key, identity, false, patientAliases))
    )
      return;
    result.retainedCount++;
    if (target && transferable(record, target, identity, patientAliases)) {
      if (!result.candidate || record.updatedAt > result.candidate.record.updatedAt)
        result.candidate = {
          record: { volumeKey: record.volumeKey, updatedAt: record.updatedAt },
        };
    } else result.unavailableCount++;
  });
  if (result.retainedCount)
    result.message = result.candidate
      ? 'A saved selection on another grid can be copied as a draft. The original stays saved; inspect the transferred boundaries before reviewing it.'
      : 'Saved selections on another grid are retained and have not been overwritten. Their source registration or dataset version cannot be verified for this reconstruction, so they cannot be transferred safely.';
  return result;
}

function labelMetadata(record: VolumeSegmentationRow): SvrLabelMeta[] {
  if (
    !Array.isArray(record.classMetadata) ||
    !record.classMetadata.every(
      (entry) =>
        entry &&
        Number.isInteger(entry.id) &&
        entry.id >= 0 &&
        entry.id <= 255 &&
        typeof entry.name === 'string' &&
        finiteArray(entry.color, 3) &&
        entry.color.every((value: number) => value >= 0 && value <= 255),
    )
  )
    throw new Error('The saved selection label definitions are invalid. The original selection has been retained.');
  return record.classMetadata as SvrLabelMeta[];
}

function sameSavedWork(left: VolumeSegmentationRow, right: VolumeSegmentationRow): boolean {
  const equal = (a: Uint8Array | Uint32Array | undefined, b: Uint8Array | Uint32Array | undefined) =>
    a === b || Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));
  return (
    left.updatedAt === right.updatedAt &&
    equal(left.labels, right.labels) &&
    equal(left.seeds?.foreground, right.seeds?.foreground) &&
    equal(left.seeds?.background, right.seeds?.background) &&
    left.seeds?.lastStroke?.plane === right.seeds?.lastStroke?.plane &&
    left.seeds?.lastStroke?.slice === right.seeds?.lastStroke?.slice &&
    left.clippedNativeVoxels === right.clippedNativeVoxels &&
    left.contextLimited === right.contextLimited &&
    JSON.stringify(left.classMetadata) === JSON.stringify(right.classMetadata)
  );
}

/** Explicit categorical copy only: never writes/deletes saved work or treats a transferred mask as reviewed. */
export async function transferSavedSelection(
  candidate: SavedSelectionCandidate,
  volume: SvrVolume,
  identity: SavedSelectionIdentity,
  currentVolumeKey: string,
  signal?: AbortSignal,
): Promise<SvrLabelVolume> {
  abort(signal);
  if (!completeIdentity(identity) || !matchesVolume(volume, identity, parseKey(currentVolumeKey))) throw changed();
  const target = captureSelectionGeometry(volume);
  if (!target || candidate.record.volumeKey === currentVolumeKey) throw changed();
  let saved: VolumeSegmentationRow | undefined;
  await inspectSavedSelections(
    identity,
    (record, patientAliases) => {
      if (record.updatedAt !== candidate.record.updatedAt || !transferable(record, target, identity, patientAliases))
        throw changed();
      saved = record;
    },
    signal,
    candidate.record.volumeKey,
  );
  const record = saved!;
  const meta = labelMetadata(record);
  if (
    volume.data.length !== volume.dims.reduce((product, size) => product * size, 1) ||
    !volume.observedSupport ||
    volume.observedSupport.length !== volume.data.length
  )
    throw changed();
  const source = {
    dims: record.dims,
    originMm: record.geometry!.originMm,
    direction: record.geometry!.direction,
    voxelSizeMm: record.voxelSizeMm!,
  };
  const transferred = await transferSelectionAnnotations(
    source,
    {
      data: record.labels,
      dims: record.dims,
      meta,
      seeds: record.seeds,
      ...(record.clippedNativeVoxels !== undefined ? { clippedNativeVoxels: record.clippedNativeVoxels } : {}),
      ...(record.contextLimited !== undefined ? { contextLimited: record.contextLimited } : {}),
    },
    volume,
    {
      signal,
      targetSupported: (index) => Boolean(volume.observedSupport![index]) && Number.isFinite(volume.data[index]),
    },
  );
  await inspectSavedSelections(
    identity,
    (current, patientAliases) => {
      if (!sameSavedWork(current, record) || !transferable(current, target, identity, patientAliases)) throw changed();
    },
    signal,
    record.volumeKey,
  );
  if (!transferred.data.some(Boolean))
    throw new Error(
      'The saved selection does not intersect supported MRI data on this grid. The original selection has been retained.',
    );
  return transferred;
}
