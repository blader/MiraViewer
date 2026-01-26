import type { SequenceCombo } from '../types/api';

/** Format sequence label without plane (just weight + sequence). */
export function formatSequenceLabel(seq: Pick<SequenceCombo, 'weight' | 'sequence'>): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}
