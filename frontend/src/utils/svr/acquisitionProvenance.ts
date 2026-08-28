import type { IDBPTransaction } from 'idb';
import { DATASET_REVISION_STATE_KEY, getDB, SELECTED_PATIENT_STATE_KEY } from '../../db/db';
import { getPatientIdentityKeys } from '../../db/patientIdentity';
import type { DicomAcquisitionMetadata, DicomInstance, MiraDB } from '../../db/schema';
import { readDicomAcquisitionMetadata } from '../../services/dicomAcquisitionMetadata';
import type { SeriesFrameManifest } from '../localApi';
import { INDEPENDENT_NORMAL_COSINE, parseImageOrientationPatient } from './dicomGeometry';
import { dot } from './vec3';

export type SvrAcquisitionSourceKind = 'original-3d' | 'original-2d' | 'derived' | 'unknown' | 'conflicting';
export type SvrAcquisitionClassification = {
  mode: 'native-3d' | 'independent-2d' | 'unknown' | 'conflicting';
  primaryOriginal3d: SeriesFrameManifest | null;
  eligibleIndependentSources: SeriesFrameManifest[];
  sources: Array<{ seriesUid: string; kind: SvrAcquisitionSourceKind }>;
  explanation: string;
  warnings: string[];
};

const references = (metadata: DicomAcquisitionMetadata) => [
  ...metadata.sourceSopInstanceUids,
  ...metadata.derivationSopInstanceUids,
];

function sourceKind(manifest: SeriesFrameManifest): SvrAcquisitionSourceKind {
  if (manifest.frames.length < 2 || !manifest.geometryReliable) return 'unknown';
  const kinds = new Set<SvrAcquisitionSourceKind>();
  for (const frame of manifest.frames) {
    const metadata = frame.acquisitionMetadata;
    if (!metadata || metadata.version !== 1 || metadata.unavailable) return 'unknown';
    const original = metadata.imageType[0] === 'ORIGINAL' && metadata.imageType[1] === 'PRIMARY';
    const derived =
      metadata.imageType.includes('DERIVED') ||
      metadata.imageType.includes('REFORMATTED') ||
      metadata.imageType.includes('MPR');
    if (original && (derived || references(metadata).length)) return 'conflicting';
    if (derived) kinds.add('derived');
    else if (original && metadata.mrAcquisitionType === '3D') kinds.add('original-3d');
    else if (original && metadata.mrAcquisitionType === '2D') kinds.add('original-2d');
    else return 'unknown';
  }
  return kinds.size === 1 ? [...kinds][0]! : 'conflicting';
}

function acquisitionEvidence(manifest: SeriesFrameManifest) {
  const metadata = manifest.frames.map((frame) => frame.acquisitionMetadata!);
  const contrast = metadata.map((entry) => {
    if (!entry.scanningSequence?.length || !entry.echoTimeMs || !entry.repetitionTimeMs) return null;
    return JSON.stringify([
      [...entry.scanningSequence].sort(),
      [...(entry.sequenceVariant ?? [])].sort(),
      entry.echoTimeMs,
      entry.repetitionTimeMs,
      entry.inversionTimeMs ?? null,
    ]);
  });
  const numbers = metadata.map((entry) => entry.acquisitionNumber);
  const times = metadata.map((entry) => entry.acquisitionDateTime?.match(/^(\d{14})(?:\.(\d{1,6}))?([+-]\d{4})?$/));
  const zones = new Set(times.map((match) => match?.[3] ?? ''));
  const orderedTimes =
    times.every(Boolean) && zones.size === 1
      ? times.map((match) => `${match![1]}.${(match![2] ?? '').padEnd(6, '0')}`).sort()
      : [];
  return {
    contrast: contrast[0] && contrast.every((key) => key === contrast[0]) ? contrast[0] : null,
    numbers: numbers.every((value) => Number.isSafeInteger(value)) ? new Set(numbers as number[]) : null,
    times: orderedTimes.length ? { first: orderedTimes[0]!, last: orderedTimes.at(-1)!, zone: [...zones][0] } : null,
    normal: parseImageOrientationPatient(manifest.frames[0]?.imageOrientationPatient)?.normalDir,
  };
}

/**
 * The sources that may share the primary native volume's accepted pose.
 * A common frame of reference is not motion registration. A reformat needs
 * direct primary-source lineage or strongly coherent same-acquisition tags;
 * another original acquisition or an unknown source never inherits identity.
 */
export function nativeReferenceSources(
  manifests: readonly SeriesFrameManifest[],
  primary: SeriesFrameManifest,
): SeriesFrameManifest[] {
  const owned = (manifest: SeriesFrameManifest) =>
    manifest.geometryReliable &&
    manifest.frames.length > 0 &&
    Boolean(primary.frameOfReferenceUid) &&
    manifest.patientKey === primary.patientKey &&
    manifest.studyUid === primary.studyUid &&
    manifest.frameOfReferenceUid === primary.frameOfReferenceUid &&
    manifest.frames.every(
      (frame) =>
        frame.seriesInstanceUid === manifest.seriesUid &&
        frame.studyInstanceUid === primary.studyUid &&
        frame.frameOfReferenceUid === primary.frameOfReferenceUid,
    );
  const canonical = manifests.find((manifest) => manifest.seriesUid === primary.seriesUid);
  if (!canonical || !owned(canonical)) return [];
  if (sourceKind(canonical) !== 'original-3d') return [canonical];
  const primarySops = new Set(canonical.frames.map((frame) => frame.sopInstanceUid));
  // Protocol identity deliberately excludes reformatted display dimensions,
  // pixel spacing, slice thickness and normals: those are not acquisition IDs.
  const protocol = (metadata: DicomAcquisitionMetadata) => {
    const matrix = metadata.acquisitionMatrix;
    if (
      metadata.mrAcquisitionType !== '3D' ||
      !matrix ||
      matrix.length !== 4 ||
      !matrix.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      matrix.filter((value) => value > 0).length !== 2 ||
      !Number.isFinite(metadata.reconstructionDiameterMm) ||
      metadata.reconstructionDiameterMm! <= 0 ||
      !Number.isFinite(metadata.echoTimeMs) ||
      metadata.echoTimeMs! <= 0 ||
      !Number.isFinite(metadata.repetitionTimeMs) ||
      metadata.repetitionTimeMs! <= 0
    )
      return null;
    return JSON.stringify([
      metadata.mrAcquisitionType,
      matrix,
      metadata.reconstructionDiameterMm,
      metadata.echoTimeMs,
      metadata.repetitionTimeMs,
      metadata.inversionTimeMs ?? null,
      [...(metadata.scanningSequence ?? [])].sort(),
      [...(metadata.sequenceVariant ?? [])].sort(),
      metadata.percentSampling ?? null,
      metadata.percentPhaseFieldOfView ?? null,
    ]);
  };
  const acquisition = (metadata: DicomAcquisitionMetadata) => {
    const match = metadata.acquisitionDateTime?.match(/^(\d{14})(?:\.(\d{1,6}))?([+-]\d{4})?$/);
    if (!Number.isSafeInteger(metadata.acquisitionNumber) || metadata.acquisitionNumber! < 0 || !match) return null;
    return `${metadata.acquisitionNumber}|${match[1]}.${(match[2] ?? '').padEnd(6, '0')}|${match[3] ?? ''}`;
  };
  const primaryMetadata = canonical.frames.map((frame) => frame.acquisitionMetadata!);
  const primaryProtocols = new Set(primaryMetadata.map(protocol));
  const primaryAcquisitions = new Set(primaryMetadata.map(acquisition));
  const coherent = primaryProtocols.size === 1 && !primaryProtocols.has(null) && !primaryAcquisitions.has(null);
  const primaryProtocol = [...primaryProtocols][0];
  // Reused scanner tags do not resolve which of two original volumes supplied
  // a reformat; in that case require explicit source-image references.
  const ambiguous = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.seriesUid === canonical.seriesUid || !owned(manifest) || sourceKind(manifest) !== 'original-3d')
      continue;
    for (const frame of manifest.frames) {
      const metadata = frame.acquisitionMetadata!;
      const key = acquisition(metadata);
      if (protocol(metadata) === primaryProtocol && key) ambiguous.add(key);
    }
  }
  return manifests.filter((manifest) => {
    if (manifest === canonical) return true;
    if (
      !owned(manifest) ||
      sourceKind(manifest) !== 'derived' ||
      manifest.frames.some((frame) => primarySops.has(frame.sopInstanceUid))
    )
      return false;
    return manifest.frames.every((frame) => {
      const metadata = frame.acquisitionMetadata!;
      if (!metadata.imageType.some((value) => value === 'REFORMATTED' || value === 'MPR')) return false;
      const lineage = references(metadata);
      if (lineage.length) return lineage.every((uid) => primarySops.has(uid));
      const key = acquisition(metadata);
      return (
        coherent &&
        protocol(metadata) === primaryProtocol &&
        key !== null &&
        primaryAcquisitions.has(key) &&
        !ambiguous.has(key)
      );
    });
  });
}

/** Display orientation and distinct SOP identifiers are not evidence of independent measurements. */
export function classifySvrAcquisitions(manifests: readonly SeriesFrameManifest[]): SvrAcquisitionClassification {
  const sources = manifests.map((manifest) => ({ seriesUid: manifest.seriesUid, kind: sourceKind(manifest) }));
  const warnings: string[] = [];
  const result = (
    mode: SvrAcquisitionClassification['mode'],
    explanation: string,
    primaryOriginal3d: SeriesFrameManifest | null = null,
    eligibleIndependentSources: SeriesFrameManifest[] = [],
  ): SvrAcquisitionClassification => ({
    mode,
    explanation,
    primaryOriginal3d,
    eligibleIndependentSources,
    sources,
    warnings,
  });
  const first = manifests[0];
  if (!first) return result('unknown', 'No source acquisition is available.');
  const owners = new Map<string, string>();
  let scopeConflict = false;
  for (const manifest of manifests) {
    if (
      manifest.patientKey !== first.patientKey ||
      manifest.studyUid !== first.studyUid ||
      !manifest.frameOfReferenceUid ||
      manifest.frameOfReferenceUid !== first.frameOfReferenceUid
    )
      scopeConflict = true;
    for (const frame of manifest.frames) {
      if (
        frame.seriesInstanceUid !== manifest.seriesUid ||
        frame.studyInstanceUid !== manifest.studyUid ||
        frame.frameOfReferenceUid !== manifest.frameOfReferenceUid ||
        owners.has(frame.sopInstanceUid)
      )
        scopeConflict = true;
      owners.set(frame.sopInstanceUid, manifest.seriesUid);
    }
  }
  const lineage = new Map(
    manifests.map((manifest) => [
      manifest.seriesUid,
      new Set(
        manifest.frames.flatMap((frame) =>
          frame.acquisitionMetadata
            ? references(frame.acquisitionMetadata).flatMap((uid) => owners.get(uid) ?? [])
            : [],
        ),
      ),
    ]),
  );
  for (const source of sources) {
    const pending = [...(lineage.get(source.seriesUid) ?? [])];
    const seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === source.seriesUid) {
        source.kind = 'conflicting';
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(lineage.get(next) ?? []));
    }
  }
  if (scopeConflict || sources.some((source) => source.kind === 'conflicting'))
    return result(
      'conflicting',
      'Source acquisition identities or derivation lineage conflict. Refresh the examination; these sources cannot be fused safely.',
    );
  if (sources.some((source) => source.kind === 'derived'))
    warnings.push('Derived or reformatted images are retained for browsing, not counted as independent acquisitions.');
  if (sources.some((source) => source.kind === 'unknown'))
    warnings.push(
      'Some source acquisition metadata is incomplete. Different viewing planes alone do not establish independent detail.',
    );
  const originals = manifests.filter((_, index) => sources[index]!.kind === 'original-3d');
  if (originals.length) {
    if (originals.length > 1)
      warnings.push(
        'Multiple original 3D series are available; only one native source is used, without averaging acquisitions.',
      );
    return result(
      'native-3d',
      'Using the original 3D MRI acquisition directly. Reconstructed viewing planes do not add independent measurements.',
      originals[0]!,
    );
  }
  const original2d = manifests.filter((_, index) => sources[index]!.kind === 'original-2d');
  const evidence = new Map(original2d.map((manifest) => [manifest, acquisitionEvidence(manifest)]));
  const independent = (left: SeriesFrameManifest, right: SeriesFrameManifest) => {
    const a = evidence.get(left)!,
      b = evidence.get(right)!;
    if (!a.contrast || a.contrast !== b.contrast) return false;
    const distinctNumbers = a.numbers && b.numbers && [...a.numbers].every((value) => !b.numbers!.has(value));
    const distinctTimes =
      a.times &&
      b.times &&
      a.times.zone === b.times.zone &&
      (a.times.last < b.times.first || b.times.last < a.times.first);
    return Boolean(distinctNumbers || distinctTimes);
  };
  let eligible: SeriesFrameManifest[] = [];
  for (const anchor of original2d) {
    const group = [anchor];
    for (const candidate of original2d)
      if (candidate !== anchor && group.every((prior) => independent(prior, candidate))) group.push(candidate);
    const normal = evidence.get(anchor)!.normal;
    if (
      normal &&
      group.some((candidate) => {
        const other = evidence.get(candidate)!.normal;
        return other && Math.abs(dot(normal, other)) < INDEPENDENT_NORMAL_COSINE;
      }) &&
      group.length > eligible.length
    )
      eligible = group;
  }
  if (eligible.length > 1)
    return result(
      'independent-2d',
      'Original 2D acquisitions have distinct acquisition identities, matching contrast metadata, and complementary directions.',
      null,
      eligible,
    );
  return result(
    'unknown',
    'Independent acquisitions could not be established. Browse a source stack without claiming super-resolution.',
  );
}

type MetadataTransaction = IDBPTransaction<
  MiraDB,
  ['instances', 'app_state', 'studies', 'series'],
  'readonly' | 'readwrite'
>;
const METADATA_STORES = ['instances', 'app_state', 'studies', 'series'] as const;
type HydrationOptions = { signal?: AbortSignal; datasetRevision?: number; selectedPatientKey?: string | null };
const frameIdentity = (frame: Omit<DicomInstance, 'fileBlob'>) =>
  JSON.stringify([
    frame.sopInstanceUid,
    frame.seriesInstanceUid,
    frame.studyInstanceUid,
    frame.frameOfReferenceUid,
    frame.rows,
    frame.columns,
    frame.imagePositionPatient,
    frame.imageOrientationPatient,
    frame.pixelSpacing,
    frame.sliceThickness,
    frame.spacingBetweenSlices,
    frame.numberOfFrames,
  ]);

/** Enrich legacy rows from their own immutable Blob; no image replacement, reimport, or dataset revision change. */
export async function hydrateSvrAcquisitionMetadata(
  manifests: readonly SeriesFrameManifest[],
  options: HydrationOptions = {},
): Promise<SeriesFrameManifest[]> {
  const abort = () => {
    if (options.signal?.aborted) throw new DOMException('Acquisition metadata loading canceled.', 'AbortError');
  };
  abort();
  if (!manifests.length) return [];
  if (
    manifests.some(
      (manifest) => manifest.patientKey !== manifests[0]!.patientKey || manifest.studyUid !== manifests[0]!.studyUid,
    )
  )
    throw new Error('Acquisition metadata must belong to one patient and examination.');
  const db = await getDB();
  let expectedRevision = options.datasetRevision;
  let expectedPatient = options.selectedPatientKey;
  const assertScope = async (transaction: MetadataTransaction) => {
    abort();
    const [revisionRow, patientRow, studies, series] = await Promise.all([
      transaction.objectStore('app_state').get(DATASET_REVISION_STATE_KEY),
      transaction.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
      transaction.objectStore('studies').getAll(),
      Promise.all(manifests.map((manifest) => transaction.objectStore('series').get(manifest.seriesUid))),
    ]);
    const revision = typeof revisionRow?.value === 'number' ? revisionRow.value : 0;
    const patient = typeof patientRow?.value === 'string' ? patientRow.value : null;
    expectedRevision ??= revision;
    if (expectedPatient === undefined) expectedPatient = patient;
    const patientKeys = getPatientIdentityKeys(studies);
    if (
      revision !== expectedRevision ||
      patient !== expectedPatient ||
      manifests.some(
        (manifest, index) =>
          !series[index] ||
          series[index]!.studyInstanceUid !== manifest.studyUid ||
          patientKeys.get(manifest.studyUid) !== manifest.patientKey ||
          (patient !== null && patient !== manifest.patientKey),
      )
    )
      throw new Error(
        'The selected patient or MRI dataset changed while loading acquisition metadata. Refresh the examination.',
      );
    abort();
  };
  const readScope = db.transaction(METADATA_STORES, 'readonly');
  await assertScope(readScope);
  await readScope.done;
  const missing = manifests.flatMap((manifest) =>
    manifest.frames.filter((frame) => frame.acquisitionMetadata?.version !== 1),
  );
  const updates = new Map<string, DicomAcquisitionMetadata>();
  for (let offset = 0; offset < missing.length; offset += 32) {
    abort();
    const batch = missing.slice(offset, offset + 32);
    const transaction = db.transaction(METADATA_STORES, 'readonly');
    await assertScope(transaction);
    const stored = await Promise.all(
      batch.map((frame) => transaction.objectStore('instances').get(frame.sopInstanceUid)),
    );
    await transaction.done;
    const instances = stored.map((instance, index) => {
      if (!instance || frameIdentity(instance) !== frameIdentity(batch[index]!))
        throw new Error('The stored MRI source changed while loading acquisition metadata. Refresh the examination.');
      return instance;
    });
    const metadata: DicomAcquisitionMetadata[] = [];
    for (let start = 0; start < instances.length; start += 4)
      metadata.push(
        ...(await Promise.all(
          instances
            .slice(start, start + 4)
            .map((instance) =>
              instance.acquisitionMetadata?.version === 1
                ? instance.acquisitionMetadata
                : readDicomAcquisitionMetadata(instance, options.signal),
            ),
        )),
      );
    const write = db.transaction(METADATA_STORES, 'readwrite');
    try {
      await assertScope(write);
      const current = await Promise.all(
        instances.map((instance) => write.objectStore('instances').get(instance.sopInstanceUid)),
      );
      for (let index = 0; index < instances.length; index++) {
        abort();
        const before = instances[index]!,
          row = current[index];
        if (
          !row ||
          frameIdentity(row) !== frameIdentity(before) ||
          row.fileBlob.size !== before.fileBlob.size ||
          row.fileBlob.type !== before.fileBlob.type
        )
          throw new Error('The stored MRI source changed while loading acquisition metadata. Refresh the examination.');
        const acquisitionMetadata = row.acquisitionMetadata?.version === 1 ? row.acquisitionMetadata : metadata[index]!;
        if (row.acquisitionMetadata?.version !== 1)
          await write.objectStore('instances').put({ ...row, acquisitionMetadata });
        updates.set(row.sopInstanceUid, acquisitionMetadata);
      }
      await write.done;
    } catch (error) {
      try {
        write.abort();
      } catch {
        /* Already completed or aborted. */
      }
      await write.done.catch(() => {});
      throw error;
    }
  }
  const finalScope = db.transaction(METADATA_STORES, 'readonly');
  await assertScope(finalScope);
  await finalScope.done;
  abort();
  return manifests.map((manifest) => ({
    ...manifest,
    frames: manifest.frames.map((frame) =>
      updates.has(frame.sopInstanceUid) ? { ...frame, acquisitionMetadata: updates.get(frame.sopInstanceUid)! } : frame,
    ),
  }));
}
