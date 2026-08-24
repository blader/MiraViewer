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
