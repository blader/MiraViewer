import type { SequenceCombo } from '../types/api';

/** Display DICOM person-name components without changing the stored patient identity. */
export function formatPatientName(name: string | null | undefined): string {
  return (name ?? '')
    .split('=')
    .map((representation) =>
      representation
        .split('^')
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' / ');
}

/** Format sequence label without plane (just weight + sequence). */
export function formatSequenceLabel(seq: Pick<SequenceCombo, 'weight' | 'sequence'>): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}
