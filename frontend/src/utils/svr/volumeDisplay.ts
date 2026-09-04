import type { SvrVolume } from '../../types/svr';

/** Window and data are in modality units; only the GPU representation is normalized. */
export function volumeDisplayRange(volume: SvrVolume): [number, number] {
  return volume.intensityRange ?? [0, 1];
}

/** Direct native stacks retain source modality units; independent reconstructions do not. */
export function hasNativeIntensityDomain(volume: SvrVolume): boolean {
  const mode = volume.sourceProvenance?.mode;
  return mode === 'native-3d' || mode === 'source-stack';
}

/** Honor the source VOI, including width-one thresholds, before measured fallback. */
export function defaultVolumeWindow(volume: SvrVolume): [number, number] {
  const voi = volume.displayWindow;
  if (voi?.every(Number.isFinite) && voi[1] >= voi[0]) return voi;
  const range = volume.intensityRange;
  return range?.every(Number.isFinite) && range[1] > range[0] ? range : [0, 1];
}

export function normalizedVolumeWindow(volume: SvrVolume, window: readonly [number, number]): [number, number] {
  const [low, high] = volumeDisplayRange(volume);
  const range = Math.max(Number.EPSILON, high - low);
  return volume.displayInvert
    ? [1 - (window[1] - low) / range, 1 - (window[0] - low) / range]
    : [(window[0] - low) / range, (window[1] - low) / range];
}

export function hasNativeDetail(volume: SvrVolume): boolean {
  return Boolean(
    volume.nativeVoxelSizeMm &&
    volume.voxelSizeMm.every((spacing, axis) => spacing <= volume.nativeVoxelSizeMm![axis]! * 1.00001),
  );
}

export function volumeSamplingLabel(volume: SvrVolume): string {
  const spacing = volume.voxelSizeMm.map((value) => value.toFixed(2));
  const pitch = spacing.every((value) => value === spacing[0]) ? spacing[0] : spacing.join(' × ');
  return `${pitch} mm ${hasNativeDetail(volume) ? 'stored samples' : volume.nativeVoxelSizeMm ? 'overview' : 'grid'}`;
}
