import type { SvrReconstructionSlice } from '../../src/utils/svr/reconstructionCore';

// Synthetic asymmetric physical phantom shared by unit and actual-worker probes.
export function signalAt(x: number, y: number, z: number): number {
  const central = Math.exp(-(x * x + y * y + z * z) / 80);
  const landmark = 0.4 * Math.exp(-((x - 4) ** 2 + (y + 3) ** 2 + (z - 2) ** 2) / 9);
  return 0.1 + central + landmark;
}

export function makeStack(
  params: {
    angleDeg?: number;
    frameUid?: string;
    offset?: { x: number; y: number; z: number };
    rowSpacingMm?: number;
    colSpacingMm?: number;
  } = {},
): SvrReconstructionSlice[] {
  const rows = 19;
  const cols = 19;
  const count = 19;
  const angle = ((params.angleDeg ?? 0) * Math.PI) / 180;
  const rowDir = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
  const colDir = { x: 0, y: 1, z: 0 };
  const normalDir = { x: -Math.sin(angle), y: 0, z: Math.cos(angle) };
  const rowSpacingDsMm = params.rowSpacingMm ?? 1;
  const colSpacingDsMm = params.colSpacingMm ?? 1;
  const offset = params.offset ?? { x: 0, y: 0, z: 0 };

  return Array.from({ length: count }, (_, index) => {
    const depth = index - (count - 1) / 2;
    const physicalOrigin = {
      x: normalDir.x * depth - rowDir.x * ((cols - 1) / 2) * colSpacingDsMm,
      y: normalDir.y * depth - colDir.y * ((rows - 1) / 2) * rowSpacingDsMm,
      z: normalDir.z * depth - rowDir.z * ((cols - 1) / 2) * colSpacingDsMm,
    };
    const pixels = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = physicalOrigin.x + colDir.x * r * rowSpacingDsMm + rowDir.x * c * colSpacingDsMm;
        const y = physicalOrigin.y + colDir.y * r * rowSpacingDsMm + rowDir.y * c * colSpacingDsMm;
        const z = physicalOrigin.z + colDir.z * r * rowSpacingDsMm + rowDir.z * c * colSpacingDsMm;
        pixels[r * cols + c] = signalAt(x, y, z);
      }
    }

    return {
      pixels,
      dsRows: rows,
      dsCols: cols,
      ippMm: {
        x: physicalOrigin.x + offset.x,
        y: physicalOrigin.y + offset.y,
        z: physicalOrigin.z + offset.z,
      },
      rowDir,
      colDir,
      normalDir,
      rowSpacingDsMm,
      colSpacingDsMm,
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
      frameOfReferenceUid: params.frameUid,
    };
  });
}
