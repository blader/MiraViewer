export function parsePlaneFromSeriesDescription(desc: string): string | undefined {
  const d = desc.toUpperCase();
  if (d.includes(' AX ') || d.startsWith('AX ') || d.includes('_AX_') || d.includes('AXIAL')) return 'Axial';
  if (d.includes(' COR ') || d.startsWith('COR ') || d.includes('_COR_') || d.includes('CORONAL')) return 'Coronal';
  if (d.includes(' SAG ') || d.startsWith('SAG ') || d.includes('_SAG_') || d.includes('SAGITTAL')) return 'Sagittal';
  return undefined;
}

export function parseWeightFromSeriesDescription(desc: string): string | undefined {
  const d = desc.toUpperCase();
  if (d.includes('T1_') || d.includes('T1 ') || d.includes('_T1') || d.endsWith('T1')) return 'T1';
  if (d.includes('T2_') || d.includes('T2 ') || d.includes('_T2') || d.endsWith('T2')) return 'T2';
  return undefined;
}

export function parseSequenceTypeFromSeriesDescription(desc: string): string | undefined {
  const d = desc.toUpperCase();
  const seqs = ['FLAIR', 'SSFSE', 'SWI', 'SWAN', 'DWI', 'DTI', 'ASL', 'ADC', 'GRE', 'SE', 'LOCALIZER'];
  for (const s of seqs) {
    if (d.includes(s)) return s === 'LOCALIZER' ? 'Localizer' : s;
  }
  return undefined;
}

export function parseSeriesDescription(desc: string): {
  plane?: string;
  weight?: string;
  sequenceType?: string;
} {
  return {
    plane: parsePlaneFromSeriesDescription(desc),
    weight: parseWeightFromSeriesDescription(desc),
    sequenceType: parseSequenceTypeFromSeriesDescription(desc),
  };
}
