import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveEfficientTamAttention, queryChunkingContract } from '../scripts/derive-efficient-tam-attention.mjs';
import manifest from '../src/utils/segmentation/efficientTam/assetManifest.json';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(frontendRoot, 'scripts/derive-efficient-tam-attention.mjs');
const directories: string[] = [];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function directory() {
  const root = mkdtempSync(path.join(tmpdir(), 'miraviewer-attention-derivation-'));
  directories.push(root);
  return root;
}

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Integer = number | { toString(): string };
type Node = {
  name: string;
  opType: string;
  input: string[];
  output: string[];
  attribute: { name: string; i: Integer }[];
};
type Graph = {
  node: Node[];
  initializer: { name: string; dims: Integer[]; dataType: number; int64Data: Integer[]; rawData: Uint8Array }[];
};

function expectCompleteQueryTopology(bytes: Uint8Array) {
  // Decode the actual artifact, not the derivation's proof or an inference runtime.
  const { onnx } = createRequire(import.meta.url)(
    path.join(frontendRoot, 'node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js'),
  ) as { onnx: { ModelProto: { decode(bytes: Uint8Array): { graph: Graph } } } };
  const graph = onnx.ModelProto.decode(bytes).graph;
  const producers = new Map(graph.node.flatMap((node) => node.output.map((output) => [output, node] as const)));
  const initializers = new Map(graph.initializer.map((tensor) => [tensor.name, tensor]));
  const producer = (output: string, operation: string) => {
    const node = producers.get(output);
    expect(node?.opType).toBe(operation);
    return node!;
  };
  const index = (name: string) => {
    const tensor = initializers.get(name)!;
    expect(tensor.dataType).toBe(7);
    expect(tensor.dims.map(Number)).toEqual([1]);
    return tensor.rawData.length ? Number(Buffer.from(tensor.rawData).readBigInt64LE()) : Number(tensor.int64Data[0]);
  };
  const axis = (node: Node, expected: number) => {
    expect(node.attribute.map((attribute) => [attribute.name, Number(attribute.i)])).toEqual([['axis', expected]]);
  };
  expect(graph.node).toHaveLength(2861);
  expect(graph.initializer).toHaveLength(127);
  for (let layer = 0; layer < 4; layer++) {
    const scope = `/attention/layers.${layer}/cross_attn_image`;
    const concat = producer(`${scope}/MatMul_1_output_0`, 'Concat');
    axis(concat, 2);
    expect(concat.input).toHaveLength(16);
    const rows: number[] = [];
    for (const output of concat.input) {
      const values = producer(output, 'MatMul');
      expect(values.input[1]).toBe(`${scope}/Transpose_2_output_0`);
      const softmax = producer(values.input[0], 'Softmax');
      axis(softmax, -1);
      const scores = producer(softmax.input[0], 'MatMul');
      expect(scores.input[1]).toBe(`${scope}/Mul_13_output_0`);
      const slice = producer(scores.input[0], 'Slice');
      expect(slice.input).toHaveLength(4); // Omitted steps means one; only the query axis is sliced.
      expect(slice.input[0]).toBe(`${scope}/Mul_12_output_0`);
      const start = index(slice.input[1]);
      const end = index(slice.input[2]);
      expect(index(slice.input[3])).toBe(2);
      expect(end - start).toBe(64);
      for (let row = start; row < end; row++) rows.push(row);
    }
    expect(rows).toEqual(Array.from({ length: 1024 }, (_, row) => row));
    for (const name of ['MatMul', 'Softmax', 'MatMul_1'])
      expect(graph.node.some((node) => node.name === `${scope}/${name}`)).toBe(false);
  }
}

describe('EfficientTAM pinned query derivation, not numerical or memory acceptance', () => {
  it('pins the source and candidate bytes together with the exact query-blocking geometry', () => {
    expect(queryChunkingContract).toMatchObject({
      sourceSha256: 'e728f0c5c3e98739a4d4feecbdbac397ca95c691720e03bf5af05ac20e71642e',
      sourceBytes: 26_272_975,
      sha256: 'a9195ed61d2ddbd3b30cdab6f91a5253e30e2d8514fd76181a246ecece531dd7',
      bytes: 26_333_948,
      queryRows: 1024,
      queryChunkRows: 64,
      layers: 4,
      heads: 1,
      keyValueChannels: 256,
      projectionBufferAllowance: 6,
    });
  });

  it('rejects malformed source bytes, including a correctly sized file with the wrong hash', () => {
    for (const bytes of [
      new Uint8Array(),
      Buffer.from('not an ONNX graph'),
      new Uint8Array(queryChunkingContract.sourceBytes),
    ])
      expect(() => deriveEfficientTamAttention(bytes)).toThrow(/Source graph SHA-256\/size mismatch/);
  });

  it('proves reproducibility before adoption or validates the current derived artifact after adoption, without skips', () => {
    const entry = manifest.graphs.memoryAttention;
    expect([queryChunkingContract.sourceSha256, queryChunkingContract.sha256]).toContain(entry.sha256);
    const assetPath = path.join(frontendRoot, 'public', manifest.directory, entry.path);
    // Exercise the Uint8Array API in the test realm; native fs Buffers belong to Node's realm, not jsdom's.
    const deployed = new Uint8Array(readFileSync(assetPath));
    expect(deployed.length).toBe(entry.bytes);
    expect(digest(deployed)).toBe(entry.sha256);
    let candidate: Uint8Array;
    if (entry.sha256 === queryChunkingContract.sourceSha256) {
      const first = deriveEfficientTamAttention(deployed);
      const second = deriveEfficientTamAttention(deployed);
      expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
      expect(first.proof).toEqual(second.proof);
      expect(digest(deployed)).toBe(queryChunkingContract.sourceSha256);
      candidate = first.bytes;
      const root = directory();
      const output = path.join(root, 'derived.onnx');
      const result = cli(root, assetPath, output);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(output).equals(Buffer.from(candidate))).toBe(true);
      expect(readdirSync(root)).toEqual(['derived.onnx']);
      expect(digest(readFileSync(assetPath))).toBe(queryChunkingContract.sourceSha256);
    } else {
      // The old source need not remain publicly deployed after the derived artifact is adopted.
      expect(entry.sha256).toBe(queryChunkingContract.sha256);
      expect(() => deriveEfficientTamAttention(deployed)).toThrow(/Source graph SHA-256\/size mismatch/);
      candidate = deployed;
    }
    expect(candidate.length).toBe(queryChunkingContract.bytes);
    expect(digest(candidate)).toBe(queryChunkingContract.sha256);
    expectCompleteQueryTopology(candidate);
  });

  it('requires CLI source and destination arguments without creating files', () => {
    const root = directory();
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['missing', 'directory', 'symlink'] as const)(
    'rejects a %s source without creating a destination',
    (kind) => {
      const root = directory();
      const source = path.join(root, 'source.onnx');
      const output = path.join(root, 'derived.onnx');
      if (kind === 'directory') mkdirSync(source);
      if (kind === 'symlink') {
        writeFileSync(path.join(root, 'target.onnx'), 'synthetic source');
        symlinkSync(path.join(root, 'target.onnx'), source);
      }
      const before = readdirSync(root);
      const result = cli(root, source, output);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/regular source graph|ENOENT/);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(root)).toEqual(before);
      if (kind === 'symlink') expect(readFileSync(source, 'utf8')).toBe('synthetic source');
    },
  );

  it.each(['file', 'directory', 'symlink', 'dangling symlink'] as const)(
    'never overwrites an existing output %s',
    (kind) => {
      const root = directory();
      const output = path.join(root, 'derived.onnx');
      const target = path.join(root, 'protected.onnx');
      const sentinel = Buffer.from('existing data must survive');
      writeFileSync(target, sentinel);
      if (kind === 'file') writeFileSync(output, sentinel);
      else if (kind === 'directory') {
        mkdirSync(output);
        writeFileSync(path.join(output, 'protected'), sentinel);
      } else symlinkSync(kind === 'symlink' ? target : path.join(root, 'absent.onnx'), output);
      const before = lstatSync(output);
      const entries = readdirSync(root);
      const link = before.isSymbolicLink() ? readlinkSync(output) : undefined;
      // Missing input proves the destination guard runs before parsing or allocating the graph.
      const result = cli(root, path.join(root, 'missing-source.onnx'), output);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Refusing to overwrite an existing output/);
      expect(readdirSync(root)).toEqual(entries);
      expect(lstatSync(output)).toMatchObject({ ino: before.ino, mode: before.mode, size: before.size });
      expect(readFileSync(target)).toEqual(sentinel);
      if (link !== undefined) expect(readlinkSync(output)).toBe(link);
      else expect(readFileSync(kind === 'directory' ? path.join(output, 'protected') : output)).toEqual(sentinel);
    },
  );

  it('does not publish partial output or modify an invalid regular source', () => {
    const root = directory();
    const source = path.join(root, 'source.onnx');
    const output = path.join(root, 'derived.onnx');
    const bytes = Buffer.from('small invalid graph');
    writeFileSync(source, bytes);
    const result = cli(root, source, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Source graph SHA-256\/size mismatch/);
    expect(readFileSync(source)).toEqual(bytes);
    expect(readdirSync(root)).toEqual(['source.onnx']);
  });
});
