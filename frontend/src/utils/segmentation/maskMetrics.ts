export type MaskMetrics = {
  tp: number;
  fp: number;
  fn: number;
  tn: number;

  precision: number;
  recall: number;
  dice: number;
  iou: number;

  /** F-beta with beta=2 (weights recall higher than precision). */
  f2: number;
};

function safeDiv(num: number, den: number) {
  return den > 0 ? num / den : 0;
}

export function computeMaskMetrics(pred: Uint8Array, gt: Uint8Array): MaskMetrics {
  if (pred.length !== gt.length) {
    throw new Error('Mask sizes do not match');
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (let i = 0; i < pred.length; i++) {
    const p = pred[i] ? 1 : 0;
    const g = gt[i] ? 1 : 0;

    if (p && g) tp++;
    else if (p && !g) fp++;
    else if (!p && g) fn++;
    else tn++;
  }

  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);

  const dice = safeDiv(2 * tp, 2 * tp + fp + fn);
  const iou = safeDiv(tp, tp + fp + fn);

  // F2 emphasizes recall.
  const beta2 = 4;
  const f2 = safeDiv((1 + beta2) * precision * recall, beta2 * precision + recall);

  return { tp, fp, fn, tn, precision, recall, dice, iou, f2 };
}
