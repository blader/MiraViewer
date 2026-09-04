import type { SeededVolumeInput } from './legacySeededVolume';

/** Generic enclosed tissue: its gray interior deliberately shares the common exterior's signal. */
export function segmentationEnclosedPhantom(brightBrushRadiusMm = 4) {
  const dims: [number, number, number] = [49, 45, 37];
  const volume = new Float32Array(dims[0] * dims[1] * dims[2]);
  const truth = new Uint8Array(volume.length);
  const outerEnvelope = new Uint8Array(volume.length);
  const grayInterior = new Uint8Array(volume.length);
  const indexAt = (x: number, y: number, z: number) => (z * dims[1] + y) * dims[0] + x;
  const foreground: number[] = [];
  const cos = Math.cos(0.31),
    sin = Math.sin(0.31);
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const index = indexAt(x, y, z);
        const dx = x - 24,
          dy = y - 22,
          dz = z - 18;
        const u = cos * dx + sin * dy,
          v = -sin * dx + cos * dy;
        const signedDistanceMm = (Math.hypot(u / 10, v / 8, dz / 7) - 1) * 7;
        const inside = signedDistanceMm <= 0;
        const texture =
          0.004 * Math.sin(x * 0.87 + y * 0.51 - z * 0.67) + 0.002 * Math.cos(x * 1.73 - y * 0.29 + z * 0.93);
        const brightFraction = Math.max(0, Math.min(1, (dz - 0.5) / 1.5));
        truth[index] = inside ? 1 : 0;
        outerEnvelope[index] = signedDistanceMm < 1.15 ? 1 : 0;
        grayInterior[index] = inside && dz <= 0 ? 1 : 0;
        // The thin external rim is a spatial boundary, not a second foreground class.
        volume[index] = (inside ? 0.5 + brightFraction * 0.3 : signedDistanceMm < 1.15 ? 0.25 : 0.5) + texture;
        if (inside && z === 21 && Math.hypot(dx, dy) <= brightBrushRadiusMm) foreground.push(index);
      }
  const grayMark = indexAt(24, 22, 15);
  foreground.push(grayMark);
  const input: SeededVolumeInput = {
    dims,
    voxelSizeMm: [1, 1, 1],
    volume,
    observedSupport: new Uint8Array(volume.length).fill(1),
    foreground: Uint32Array.from(foreground),
    background: new Uint32Array(),
  };
  return {
    input,
    truth,
    outerEnvelope,
    grayInterior,
    grayMark,
    outsideMarks: Uint32Array.of(indexAt(10, 22, 18), indexAt(38, 22, 18)),
  };
}
