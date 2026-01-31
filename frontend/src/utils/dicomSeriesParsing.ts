function tokenizeSeriesDescription(desc: string): string[] {
  // Split on runs of non-alphanumeric characters so things like "AX-2" and "AX_2"
  // still produce an "AX" token.
  return desc
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function hasTokenWithPrefix(tokens: string[], prefix: string): boolean {
  return tokens.some((t) => t === prefix || t.startsWith(prefix));
}

function hasTokenOrTokenWithNumericSuffix(tokens: string[], token: string): boolean {
  // Accept exact matches ("DWI") as well as common shorthand with numeric suffixes ("DWI2").
  return tokens.some((t) => t === token || (t.startsWith(token) && /^[0-9]+$/.test(t.slice(token.length))));
}

function hasWeightToken(tokens: string[], weight: 'T1' | 'T2'): boolean {
  // Be aggressive: accept the weight appearing anywhere in a token (e.g. "MPRAGET1").
  // Still avoid obvious false positives like "T10" / "T21" by rejecting numeric suffixes.
  return tokens.some((t) => {
    const idx = t.indexOf(weight);
    if (idx < 0) return false;

    const after = t[idx + weight.length];
    if (after && after >= '0' && after <= '9') return false;

    return true;
  });
}

export function parsePlaneFromSeriesDescription(desc: string): string | undefined {
  const d = desc.toUpperCase();

  // Keep the obvious long-form matches first.
  if (d.includes('AXIAL')) return 'Axial';
  if (d.includes('CORONAL')) return 'Coronal';
  if (d.includes('SAGITTAL')) return 'Sagittal';

  // Token-based matching (treat separators as boundaries).
  const tokens = tokenizeSeriesDescription(desc);

  // Axial is sometimes written as "TRA" / "TRANSVERSE".
  if (
    hasTokenWithPrefix(tokens, 'AX') ||
    tokens.some((t) => t === 'TRA' || t.startsWith('TRANS') || t.startsWith('TRV'))
  ) {
    return 'Axial';
  }

  if (hasTokenWithPrefix(tokens, 'COR')) return 'Coronal';
  if (hasTokenWithPrefix(tokens, 'SAG')) return 'Sagittal';

  // Final fallback: contains-anywhere on a compacted string.
  // This is intentionally aggressive to avoid "Unknown" planes, at the cost of some false positives.
  const compact = d.replace(/[^A-Z0-9]/g, '');
  if (compact.includes('SAG')) return 'Sagittal';
  if (compact.includes('COR')) return 'Coronal';
  if (compact.includes('AX') || compact.includes('TRA') || compact.includes('TRANS') || compact.includes('TRV')) {
    return 'Axial';
  }

  return undefined;
}

export function parseWeightFromSeriesDescription(desc: string): string | undefined {
  // Prefer token-based matching so separators don't matter.
  const tokens = tokenizeSeriesDescription(desc);
  if (hasWeightToken(tokens, 'T1')) return 'T1';
  if (hasWeightToken(tokens, 'T2')) return 'T2';

  return undefined;
}

export function parseSequenceTypeFromSeriesDescription(desc: string): string | undefined {
  const d = desc.toUpperCase();
  const tokens = tokenizeSeriesDescription(desc);

  // Compact form allows matching sequences written with separators, e.g. "SS-FSE" -> "SSFSE".
  // Keep digits so patterns like "3D" aren't accidentally collapsed away (if we ever add them).
  const compact = d.replace(/[^A-Z0-9]/g, '');

  // NOTE: Order matters when one token is a substring of another.
  const seqs = [
    'LOCALIZER',
    'MPRAGE',
    'FSPGR',
    'SPGR',
    'BRAVO',
    'TFE',
    'FLAIR',
    'SSFSE',
    'STIR',
    'TIRM',
    'TSE',
    'FSE',
    'SWAN',
    'SWI',
    'DWI',
    'DTI',
    'ASL',
    'ADC',
    'GRE',
    'SE',
  ];

  for (const s of seqs) {
    // Avoid very broad substring matches for short tokens (e.g. "SE" matching "SERIES").
    if (s.length <= 3) {
      if (tokens.includes(s) || hasTokenOrTokenWithNumericSuffix(tokens, s)) {
        return s === 'LOCALIZER' ? 'Localizer' : s;
      }
      continue;
    }

    // Prefer token/compact matching for longer patterns.
    if (tokens.includes(s) || hasTokenOrTokenWithNumericSuffix(tokens, s)) {
      return s === 'LOCALIZER' ? 'Localizer' : s;
    }

    if (compact.includes(s)) {
      return s === 'LOCALIZER' ? 'Localizer' : s;
    }
  }

  return undefined;
}

function inferWeightFromSequenceType(sequenceType: string | undefined): string | undefined {
  if (!sequenceType) return undefined;

  // Heuristic mapping: some sequence names are strongly associated with a weight.
  // We only apply this when we couldn't parse an explicit T1/T2 token.
  const s = sequenceType.toUpperCase();

  // Common T1-ish sequences
  if (['MPRAGE', 'BRAVO', 'SPGR', 'FSPGR', 'TFE'].includes(s)) return 'T1';

  // Common T2-ish sequences
  if (['FLAIR', 'SSFSE', 'STIR', 'TIRM', 'TSE', 'FSE', 'SWI', 'SWAN'].includes(s)) return 'T2';

  return undefined;
}

export function parseSeriesDescription(desc: string): {
  plane?: string;
  weight?: string;
  sequenceType?: string;
} {
  const plane = parsePlaneFromSeriesDescription(desc);
  const sequenceType = parseSequenceTypeFromSeriesDescription(desc);
  const weight = parseWeightFromSeriesDescription(desc) ?? inferWeightFromSequenceType(sequenceType);

  return {
    plane,
    weight,
    sequenceType,
  };
}
