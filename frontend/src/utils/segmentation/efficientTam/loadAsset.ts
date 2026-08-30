import manifest from './assetManifest.json';
import { getModelBlob, putModelBlobs } from '../onnx/modelCache';

const assets = { ...manifest.graphs, ...manifest.constants };
export type TrackingAssetName = keyof typeof assets;

/** App-pinned public weights only. MRI, marks and predictions never enter this cache or request. */
export async function loadTrackingAsset(
  name: TrackingAssetName,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Object.hasOwn(assets, name)) throw new Error('Unknown interactive selection model asset.');
  const asset = assets[name];
  const key = `${manifest.id}:${asset.sha256}`;
  const verified = async (bytes: Uint8Array<ArrayBuffer>) => {
    signal?.throwIfAborted();
    if (bytes.byteLength !== asset.bytes) return false;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    signal?.throwIfAborted();
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('') === asset.sha256;
  };
  signal?.throwIfAborted();
  const cached = await getModelBlob(key);
  signal?.throwIfAborted();
  if (cached?.size === asset.bytes) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await verified(bytes)) return bytes;
  }

  // A bad cached object is never model authority. Replace it only after a verified same-origin fetch.
  const response = await fetch(`/${manifest.directory}/${asset.path}`, { signal, cache: 'no-cache' });
  signal?.throwIfAborted();
  if (!response.ok || !response.body)
    throw new Error(`Interactive selection model is unavailable (${asset.path}, HTTP ${response.status}).`);
  const bytes = new Uint8Array(asset.bytes);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > bytes.byteLength)
        throw new Error(`Interactive selection model exceeds its pinned size (${asset.path}).`);
      bytes.set(value, received);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (received !== asset.bytes || !(await verified(bytes)))
    throw new Error(`Interactive selection model failed its integrity check (${asset.path}).`);
  await putModelBlobs([{ key, blob: new Blob([bytes]) }], { signal });
  signal?.throwIfAborted();
  return bytes;
}
