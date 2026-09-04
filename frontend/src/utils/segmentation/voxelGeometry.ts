export type VoxelPoint = { x: number; y: number; z: number };
export type VoxelBounds = { min: VoxelPoint; max: VoxelPoint };

export function voxelPoint(index: number, dims: readonly number[]): VoxelPoint {
  const [nx, ny] = dims;
  return { x: index % nx!, y: Math.floor(index / nx!) % ny!, z: Math.floor(index / (nx! * ny!)) };
}

export function voxelIndex(point: VoxelPoint, dims: readonly number[]): number {
  return (point.z * dims[1]! + point.y) * dims[0]! + point.x;
}

/** Use the widest physical context that fits the worker budget, not a guessed tumor radius. */
