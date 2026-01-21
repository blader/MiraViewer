import type { SequenceCombo } from '../types/api';
import { lookupClinicalTooltip } from '../data/clinicalTooltips';

/** Format sequence label without plane (just weight + sequence) */
export function formatSequenceLabel(seq: SequenceCombo): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

/** Get tooltip for sequence/weight combination focused on tumor progression */
export function getSequenceTooltip(weight: string | null, sequence: string | null): string {
  const tooltip = lookupClinicalTooltip(weight, sequence);
  if (tooltip) return tooltip;

  return `${formatSequenceLabel({ weight, sequence } as SequenceCombo)}

MRI scan sequence for brain imaging. Different sequences highlight different tissue properties and are useful for various aspects of diagnosis and monitoring.`;
}
