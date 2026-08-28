import type { SvrVolume } from '../../../types/svr';
import { IDENTITY_DIRECTION } from '../../svr/volumeGeometry';
import { yieldToMain } from '../../svr/svrUtils';
import type { TumorModelManifest } from './modelManifest';

/** The legacy NCZYX contract used isotropic patient-LPS grids, not arbitrary native acquisition grids. */
export function assertTumorModelGrid(volume: SvrVolume, manifest: TumorModelManifest): void {
  const sourceGrid =
    Boolean(volume.nativeVoxelSizeMm) ||
    volume.voxelSizeMm.some((spacing) => Math.abs(spacing - volume.voxelSizeMm[0]) > 1e-5) ||
    volume.direction?.some((value, index) => Math.abs(value - IDENTITY_DIRECTION[index]!) > 1e-5);
  if (sourceGrid && manifest.input.spatialFrame !== 'source-grid')
    throw new Error(
      'This native volume uses its source grid and voxel pitch. The model manifest must explicitly accept input.spatialFrame "source-grid"; NCZYX alone does not establish compatibility. No automatic resampling was applied.',
    );
}

/** Display window/inversion are presentation controls and must never alter model evidence. */
export async function prepareTumorModelInput(
  volume: SvrVolume,
  isCurrent: () => boolean = () => true,
): Promise<Float32Array> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException('Model input preparation canceled.', 'AbortError');
  };
  assertCurrent();
  if (
    volume.dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    volume.dims.reduce((product, size) => product * size, 1) !== volume.data.length ||
    (volume.observedSupport && volume.observedSupport.length !== volume.data.length)
  )
    throw new Error('Model input requires matching volume dimensions and acquired-support evidence.');
  const [minimum, maximum] = volume.intensityRange ?? [0, 1];
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum)
    throw new Error('Model input requires a finite native intensity range. Reopen the source volume.');
  const scale = 1 / (maximum - minimum);
  let input = minimum === 0 && maximum === 1 ? volume.data : new Float32Array(volume.data.length);
  for (let index = 0; index < volume.data.length; index++) {
    if (index % 65_536 === 0) {
      assertCurrent();
      await yieldToMain();
      assertCurrent();
    }
    const supported = !volume.observedSupport || volume.observedSupport[index] !== 0;
    const raw = volume.data[index]!;
    if (supported && !Number.isFinite(raw)) throw new Error('Model input requires finite acquired intensities.');
    const normalized = supported ? Math.max(0, Math.min(1, (raw - minimum) * scale)) : 0;
    if (input === volume.data && normalized !== raw) input = new Float32Array(volume.data);
    if (input !== volume.data) input[index] = normalized;
  }
  assertCurrent();
  return input;
}
