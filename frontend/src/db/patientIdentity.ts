import type { DicomStudy } from './schema';

function basePatientIdentity(study: DicomStudy): string {
  const patientId = study.patientId.trim();
  if (!patientId) return `unknown:${study.studyInstanceUid}`;
  const issuer = study.patientIdIssuer?.trim();
  return issuer ? `${issuer}::${patientId}` : patientId;
}

/**
 * Missing identifiers are never shared. Reused IDs with conflicting nonempty
 * patient names are conservatively isolated by examination rather than merged.
 */
export function getPatientIdentityKey(study: DicomStudy, studies: readonly DicomStudy[]): string {
  const base = basePatientIdentity(study);
  if (!study.patientId.trim()) return base;

  const names = new Set<string>();
  for (const candidate of studies) {
    if (basePatientIdentity(candidate) !== base) continue;
    const name = candidate.patientName.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (name) names.add(name);
    if (names.size > 1) return `${base}#${study.studyInstanceUid}`;
  }
  return base;
}

/** Resolve every conservative patient identity without rescanning the full study set per examination. */
export function getPatientIdentityKeys(studies: readonly DicomStudy[]): ReadonlyMap<string, string> {
  const namesByIdentity = new Map<string, Set<string>>();
  const identityByStudy = new Map<string, string>();

  for (const study of studies) {
    const identity = basePatientIdentity(study);
    identityByStudy.set(study.studyInstanceUid, identity);
    if (!study.patientId.trim()) continue;

    const normalizedName = study.patientName.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!normalizedName) continue;
    let names = namesByIdentity.get(identity);
    if (!names) {
      names = new Set<string>();
      namesByIdentity.set(identity, names);
    }
    names.add(normalizedName);
  }

  for (const study of studies) {
    const identity = identityByStudy.get(study.studyInstanceUid)!;
    if ((namesByIdentity.get(identity)?.size ?? 0) > 1) {
      identityByStudy.set(study.studyInstanceUid, `${identity}#${study.studyInstanceUid}`);
    }
  }

  return identityByStudy;
}
