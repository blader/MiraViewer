function validCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Pixel spacing follows DICOM's row-spacing, column-spacing ordering. */
export function segmentationAreaMm2(
  pixelCount: number,
  rowSpacingMm: number | undefined,
  columnSpacingMm: number | undefined,
): number | null {
  if (!validCount(pixelCount) || !rowSpacingMm || !columnSpacingMm) return null;
  if (!Number.isFinite(rowSpacingMm) || !Number.isFinite(columnSpacingMm)) return null;
  if (rowSpacingMm <= 0 || columnSpacingMm <= 0) return null;
  return pixelCount * rowSpacingMm * columnSpacingMm;
}

export function segmentationVolumeMm3(
  voxelCount: number,
  voxelSizeMm: readonly [number, number, number],
): number | null {
  if (!validCount(voxelCount) || voxelSizeMm.some((spacing) => !Number.isFinite(spacing) || spacing <= 0)) return null;
  return voxelCount * voxelSizeMm[0] * voxelSizeMm[1] * voxelSizeMm[2];
}
