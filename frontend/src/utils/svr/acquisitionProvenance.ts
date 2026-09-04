import type { DicomAcquisitionMetadata } from '../../db/schema';
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
