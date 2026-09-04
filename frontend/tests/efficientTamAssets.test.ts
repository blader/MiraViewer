import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../src/utils/segmentation/efficientTam/assetManifest.json';
import { verifyAssetFiles, verifyEfficientTamAssets } from '../scripts/verify-efficient-tam-assets.mjs';
import { queryChunkingContract } from '../scripts/derive-efficient-tam-attention.mjs';

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
    expect(manifest.totalModelBytes).toBe(
      manifest.graphs.memoryAttention.sha256 === queryChunkingContract.sourceSha256 ? 75_004_497 : 75_065_470,
    );
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

  it('binds the source or derived attention pin to its own bundle identity and graph-local contract', () => {
    const attention = manifest.graphs.memoryAttention;
    if (attention.sha256 === queryChunkingContract.sourceSha256) {
      expect(manifest.id).toBe('efficienttam-tiny512-onnx-v1');
      expect(manifest.directory).toBe('models/efficienttam-tiny512-v1');
      expect(attention.bytes).toBe(queryChunkingContract.sourceBytes);
      expect(attention).not.toHaveProperty('queryChunking');
    } else {
      // Unknown pins fail here; adoption does not silently skip the derived contract.
      expect(attention.sha256).toBe(queryChunkingContract.sha256);
      expect(manifest.id).toBe('efficienttam-tiny512-onnx-v2');
      expect(manifest.directory).toBe('models/efficienttam-tiny512-v2');
      expect(attention.bytes).toBe(queryChunkingContract.bytes);
      expect(attention).toMatchObject({
        queryChunking: {
          sourceSha256: queryChunkingContract.sourceSha256,
          sourceBytes: queryChunkingContract.sourceBytes,
          queryRows: 1024,
          queryChunkRows: 64,
          layers: 4,
          heads: 1,
          keyValueChannels: 256,
          projectionBufferAllowance: 6,
        },
      });
      expect(manifest.notices.attribution.sha256).not.toBe(
        'af5320b2f11b90f642b82d3ae49be3304f188d4bb5c73fa3a4199c84df790485',
      );
    }
    expect(manifest).not.toHaveProperty('queryChunking');
  });

  it('keeps the original pins for the other five model assets and upstream license', () => {
    const otherGraphs = Object.fromEntries(
      Object.entries(manifest.graphs).filter(([name]) => name !== 'memoryAttention'),
    );
    const unchanged = { ...otherGraphs, ...manifest.constants, license: manifest.notices.license };
    expect(
      Object.fromEntries(Object.entries(unchanged).map(([name, entry]) => [name, [entry.bytes, entry.sha256]])),
    ).toEqual({
      encoder: [25_073_825, '2d3e01fb7aff950b3486053b2145449e15b663f0e4fb2d8ac702df4e2342cce1'],
      decoder: [17_824_943, 'fe243fef4a2f7e6f17199a1fc172f05a110c2ea2e8e7ddb554435c2a5affbbbd'],
      memoryEncoder: [5_568_818, 'b909e69d2b6c3b7f979ac4b37db5b084635740544436cc53647c15ae2aede455'],
      memoryPosition: [262_144, 'b76af0bb1f640cf38714797b4fb9024c3451f797679912fa59b517799ee7ef1d'],
      temporalPositions: [1_792, 'a11e3f5d6b3b3b0912992761ce9e6618d80a3f5cb94dfc185b4b1bd682f962a9'],
      license: [11_357, 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'],
    });
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

  it('explains how to hydrate an unresolved Git LFS pointer without downloading implicitly', async () => {
    const { root, files } = syntheticAssets();
    writeFileSync(
      path.join(root, files[0]!.path),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${files[0]!.sha256}\nsize ${files[0]!.bytes}\n`,
    );
    await expect(verifyAssetFiles(root, files)).rejects.toThrow(/Git LFS pointer.*git lfs pull/);
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
