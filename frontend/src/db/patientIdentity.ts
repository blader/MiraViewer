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
  return getPatientIdentityKeys(studies).get(study.studyInstanceUid) ?? basePatientIdentity(study);
}

/** Resolve every conservative patient identity without rescanning the full study set per examination. */
export function getPatientIdentityKeys(studies: readonly DicomStudy[]): ReadonlyMap<string, string> {
  const namesByIdentity = new Map<string, string | null>();
  const identityByStudy = new Map<string, string>();

  for (const study of studies) {
    const identity = basePatientIdentity(study);
    identityByStudy.set(study.studyInstanceUid, identity);
    if (!study.patientId.trim()) continue;

    const normalizedName = study.patientName.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!normalizedName) continue;
    const existingName = namesByIdentity.get(identity);
    if (existingName === undefined) namesByIdentity.set(identity, normalizedName);
    else if (existingName !== normalizedName) namesByIdentity.set(identity, null);
  }

  for (const [studyUid, identity] of identityByStudy) {
    if (namesByIdentity.get(identity) === null) {
      identityByStudy.set(studyUid, `${identity}#${studyUid}`);
    }
  }

  return identityByStudy;
}
