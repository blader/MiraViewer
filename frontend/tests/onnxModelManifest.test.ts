import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUMOR_MODEL_MANIFEST_EXAMPLE, verifyTumorModelManifest } from '../src/utils/segmentation/onnx/modelManifest';

const model = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);

async function manifest(overrides: Record<string, unknown> = {}): Promise<Blob> {
  const digest = await webcrypto.subtle.digest('SHA-256', await model.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Blob([JSON.stringify({ ...TUMOR_MODEL_MANIFEST_EXAMPLE, modelSha256: hash, ...overrides })]);
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('verified ONNX tumor model contracts', () => {
  it('accepts a hash-bound MR model with explicit axis, normalization, and class semantics', async () => {
    await expect(verifyTumorModelManifest(model, await manifest())).resolves.toMatchObject({
      modality: 'MR',
      normalization: 'svr-normalized-0-1',
      input: { channels: 1, axes: 'NCZYX' },
    });
  });

  it('keeps legacy or unaccompanied models unverified instead of guessing semantics', async () => {
    await expect(verifyTumorModelManifest(model, null)).rejects.toThrow(/unverified/i);
  });

  it('rejects a manifest bound to another ONNX file', async () => {
    await expect(verifyTumorModelManifest(model, await manifest({ modelSha256: '0'.repeat(64) }))).rejects.toThrow(
      /does not match/i,
    );
  });

  it.each([
    [{ modality: 'CT' }, /MR source modality/i],
    [{ normalization: 'z-score' }, /preprocessing/i],
    [{ input: { channels: 4, axes: 'NCZYX' } }, /one input channel/i],
    [{ input: { channels: 1, axes: 'NXYZC' } }, /NCZYX/i],
    [
      {
        classes: TUMOR_MODEL_MANIFEST_EXAMPLE.classes.map((item) =>
          item.index === 3 ? { ...item, anatomy: 'healthy-tissue' } : item,
        ),
      },
      /semantic mapping/i,
    ],
  ])('rejects incompatible model semantics %#', async (override, expected) => {
    await expect(verifyTumorModelManifest(model, await manifest(override))).rejects.toThrow(expected);
  });
});
