export type SliceDownsampleMode = 'fixed' | 'voxel-aware';

export function computeSvrDownsampleSize(params: {
  rows: number;
  cols: number;
  maxSize: number;
  mode: SliceDownsampleMode;
  rowSpacingMm: number;
  colSpacingMm: number;
  targetVoxelSizeMm: number;
}): { dsRows: number; dsCols: number; scale: number } {
  const { rows, cols, maxSize, mode, rowSpacingMm, colSpacingMm, targetVoxelSizeMm } = params;

  const maxDim = Math.max(rows, cols);

  let scale = 1;
  if (Number.isFinite(maxSize) && maxSize > 1 && maxDim > maxSize) {
    scale = maxSize / maxDim;
  }

  if (mode === 'voxel-aware') {
    const maxSpacingMm = Math.max(rowSpacingMm, colSpacingMm);
    const minScale = Math.min(1, Math.max(0, maxSpacingMm / Math.max(1e-6, targetVoxelSizeMm)));
    if (scale < minScale) scale = minScale;
  }

  const dsRows = Math.max(1, Math.round(rows * scale));
  const dsCols = Math.max(1, Math.round(cols * scale));

  return { dsRows, dsCols, scale };
}
