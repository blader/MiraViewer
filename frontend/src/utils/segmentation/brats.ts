import type { SvrLabelMeta } from '../../types/svr';

/**
 * BraTS-style base label IDs.
 *
 * Common convention:
 * - 0: Background
 * - 1: Necrotic / non-enhancing tumor core (NCR/NET)
 * - 2: Peritumoral edema (ED)
 * - 4: Enhancing tumor (ET)
 */
export const BRATS_LABEL_ID = {
  BACKGROUND: 0,
  NCR_NET: 1,
  EDEMA: 2,
  ENHANCING: 4,
} as const;

export type BratsBaseLabelId = (typeof BRATS_LABEL_ID)[keyof typeof BRATS_LABEL_ID];

// Colors are arbitrary but chosen to be visually distinct on a dark background.
export const BRATS_BASE_LABEL_META: SvrLabelMeta[] = [
  { id: BRATS_LABEL_ID.BACKGROUND, name: 'Background', color: [0, 0, 0] },
  { id: BRATS_LABEL_ID.NCR_NET, name: 'Tumor core (NCR/NET)', color: [255, 176, 0] },
  { id: BRATS_LABEL_ID.EDEMA, name: 'Edema (ED)', color: [0, 170, 255] },
  { id: BRATS_LABEL_ID.ENHANCING, name: 'Enhancing tumor (ET)', color: [255, 0, 128] },
];
