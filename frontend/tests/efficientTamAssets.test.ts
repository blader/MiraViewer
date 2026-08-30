import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../src/utils/segmentation/efficientTam/assetManifest.json';
import { verifyAssetFiles, verifyEfficientTamAssets } from '../scripts/verify-efficient-tam-assets.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories: string[] = [];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modelFiles = [...Object.values(manifest.graphs), ...Object.values(manifest.constants)];
const allFiles = [...modelFiles, ...Object.values(manifest.notices)];

function directory() {
  const value = mkdtempSync(path.join(tmpdir(), 'miraviewer-model-assets-'));
  directories.push(value);
  return value;
}

function syntheticAssets() {
  const root = directory();
  // Tiny synthetic bytes test the filesystem boundary; no checkpoint or MRI is loaded.
  const files = allFiles.map((entry) => {
    const data = Buffer.from(`synthetic asset: ${entry.path}`);
    writeFileSync(path.join(root, entry.path), data);
    return { path: entry.path, bytes: data.length, sha256: digest(data) };
  });
  return { root, files };
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('EfficientTAM public asset identity, not anatomical or runtime acceptance', () => {
  it('binds four graphs and two positional constants separately from the legacy tumor-class model', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.task).toBe('interactive-binary-2d-tracking');
    expect(manifest.input).toEqual({ dtype: 'float32', axes: 'NCHW', shape: [1, 3, 512, 512] });
    expect(manifest.output).toEqual({ kind: 'single-object-logits', selectedWhen: 'logit > 0' });
    expect(Object.keys(manifest.graphs).sort()).toEqual(['decoder', 'encoder', 'memoryAttention', 'memoryEncoder']);
    expect(Object.keys(manifest.constants).sort()).toEqual(['memoryPosition', 'temporalPositions']);
    expect(modelFiles).toHaveLength(6);
    expect(modelFiles.reduce((bytes, entry) => bytes + entry.bytes, 0)).toBe(manifest.totalModelBytes);
    expect(manifest.totalModelBytes).toBe(75_004_497);
    expect(manifest.constants.memoryPosition.shape).toEqual([1, 64, 32, 32]);
    expect(manifest.constants.temporalPositions.shape).toEqual([7, 1, 1, 64]);
    for (const tensor of Object.values(manifest.constants)) {
      expect(tensor.dtype).toBe('float32-le');
      expect(tensor.shape.reduce((size, dim) => size * dim, 4)).toBe(tensor.bytes);
    }
    expect(new Set(allFiles.map((entry) => entry.path)).size).toBe(8);
    for (const entry of allFiles) {
      expect(entry.path).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(entry.bytes) && entry.bytes > 0).toBe(true);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|segmentation-golden|patient|\.dcm|\.u8/);
  });

  it('ships hash-bound upstream license and attribution without needing the model binaries', () => {
    expect(manifest.upstream.license).toBe('Apache-2.0');
    expect(manifest.upstream.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.upstream.checkpoint.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.upstream.checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(manifest.notices).sort()).toEqual(['attribution', 'license']);
    for (const entry of Object.values(manifest.notices)) {
      const data = readFileSync(path.join(frontendRoot, 'public', manifest.directory, entry.path));
      expect(data.length).toBe(entry.bytes);
      expect(digest(data)).toBe(entry.sha256);
    }
    const notice = readFileSync(path.join(frontendRoot, 'public', manifest.directory, 'NOTICE'), 'utf8');
    expect(notice).toContain(manifest.upstream.revision);
    expect(notice).toContain(manifest.upstream.checkpoint.sha256);
  });

  it('verifies every allowlisted byte locally without changing files or fetching replacements', async () => {
    const { root, files } = syntheticAssets();
    const fetch = vi.fn(() => {
      throw new Error('No network permitted');
    });
    vi.stubGlobal('fetch', fetch);
    const before = files.map((entry) => readFileSync(path.join(root, entry.path)));
    await expect(verifyAssetFiles(root, files)).resolves.toEqual({
      files: 8,
      bytes: files.reduce((bytes, entry) => bytes + entry.bytes, 0),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(root).sort()).toEqual(files.map((entry) => entry.path).sort());
    files.forEach((entry, index) => expect(readFileSync(path.join(root, entry.path))).toEqual(before[index]));
  });

  it.each(['missing', 'size', 'hash'] as const)('fails closed on a %s asset', async (defect) => {
    const { root, files } = syntheticAssets();
    const target = path.join(root, files[0]!.path);
    if (defect === 'missing') rmSync(target);
    else if (defect === 'size') writeFileSync(target, Buffer.alloc(1));
    else writeFileSync(target, Buffer.alloc(files[0]!.bytes));
    await expect(verifyAssetFiles(root, files)).rejects.toThrow(
      defect === 'missing' ? /Missing model asset/ : defect === 'size' ? /byte count mismatch/ : /SHA-256 mismatch/,
    );
  });

  it.each(['prediction.f32', 'manifest.json', 'private-output'])('refuses unallowlisted %s content', async (name) => {
    const { root, files } = syntheticAssets();
    if (name === 'private-output') mkdirSync(path.join(root, name));
    else writeFileSync(path.join(root, name), 'synthetic content must not ship');
    await expect(verifyAssetFiles(root, files)).rejects.toThrow(/Unexpected file/);
  });

  it.each(['directory', 'symlink'] as const)('rejects an allowlisted filename that is a %s', async (kind) => {
    const { root, files } = syntheticAssets();
    const target = path.join(root, files[0]!.path);
    rmSync(target);
    if (kind === 'directory') mkdirSync(target);
    else symlinkSync(path.join(root, files[1]!.path), target);
    await expect(verifyAssetFiles(root, files)).rejects.toThrow(/regular file/);
  });

  it('refuses to verify a symlinked model directory', async () => {
    const { root, files } = syntheticAssets();
    const linked = path.join(directory(), 'linked');
    symlinkSync(root, linked, 'dir');
    await expect(verifyAssetFiles(linked, files)).rejects.toThrow(/real directory/);
  });

  it.each([
    '../encoder.onnx',
    '/encoder.onnx',
    'nested/encoder.onnx',
    'nested\\encoder.onnx',
    '%2e%2e',
    '.',
    '..',
    'https://model',
  ])('rejects unsafe manifest filenames: %s', async (filename) => {
    const { root, files } = syntheticAssets();
    await expect(verifyAssetFiles(root, [{ ...files[0], path: filename }])).rejects.toThrow(/safe relative filename/);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte count %s', async (bytes) => {
    const { root, files } = syntheticAssets();
    await expect(verifyAssetFiles(root, [{ ...files[0], bytes }])).rejects.toThrow(/Invalid byte count/);
  });

  it('rejects missing, malformed, and duplicate manifest pins before reading assets', async () => {
    const { root, files } = syntheticAssets();
    await expect(verifyAssetFiles(root, [])).rejects.toThrow(/must not be empty/);
    await expect(verifyAssetFiles(root, [...files, files[0]])).rejects.toThrow(/Duplicate/);
    for (const sha256 of [undefined, '0'.repeat(63), 'A'.repeat(64), [files[0]!.sha256]])
      await expect(verifyAssetFiles(root, [{ ...files[0], sha256 }])).rejects.toThrow(/Invalid byte count or SHA/);
  });

  it('uses only the application-pinned manifest and never treats a directory sidecar as authority', async () => {
    const { root, files } = syntheticAssets();
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ files }));
    await expect(verifyEfficientTamAssets(root)).rejects.toThrow(/Unexpected file.*manifest.json/);
    rmSync(path.join(root, 'manifest.json'));
    await expect(verifyEfficientTamAssets(root)).rejects.toThrow(/byte count mismatch/);
  });

  it('exits nonzero for an uninstalled model and does not create or download any assets', () => {
    const root = directory();
    const result = spawnSync(
      process.execPath,
      [path.join(frontendRoot, 'scripts/verify-efficient-tam-assets.mjs'), root],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing model asset: encoder.onnx.*No download was attempted/);
    expect(readdirSync(root)).toEqual([]);
  });
});
