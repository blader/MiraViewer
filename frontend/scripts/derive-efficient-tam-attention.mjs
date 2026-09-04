import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { onnx } = require(path.join(frontend, 'node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoded = (type, value) => Buffer.from(type.encode(value).finish());
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Exact query-row blocking: every row still attends to every original key and pointer. */
export const queryChunkingContract = Object.freeze({
  sourceSha256: 'e728f0c5c3e98739a4d4feecbdbac397ca95c691720e03bf5af05ac20e71642e',
  sourceBytes: 26272975,
  sha256: 'a9195ed61d2ddbd3b30cdab6f91a5253e30e2d8514fd76181a246ecece531dd7',
  bytes: 26333948,
  queryRows: 1024,
  queryChunkRows: 64,
  layers: 4,
  heads: 1,
  keyValueChannels: 256,
  // Additional operational allowance beside row-score workspace, not a separate projection-liveness guarantee.
  projectionBufferAllowance: 6,
});

/** Derive only the reviewed source graph, without model construction, inference, or changing weights. */
export function deriveEfficientTamAttention(sourceBytes) {
  assert(
    sourceBytes instanceof Uint8Array &&
      sourceBytes.byteLength === queryChunkingContract.sourceBytes &&
      sha256(sourceBytes) === queryChunkingContract.sourceSha256,
    'Source graph SHA-256/size mismatch.',
  );
  const model = onnx.ModelProto.decode(sourceBytes);
  assert(
    model.opsetImport.length === 1 && !model.opsetImport[0].domain && Number(model.opsetImport[0].version) === 17,
    'Unexpected graph opset.',
  );
  const graph = model.graph;
  const originalNodes = [...graph.node];
  const originalInitializers = new Map(
    graph.initializer.map((value) => [value.name, encoded(onnx.TensorProto, value)]),
  );
  const originalNodeBytes = new Map(originalNodes.map((value) => [value.name, encoded(onnx.NodeProto, value)]));
  const originalInputs = graph.input.map((value) => encoded(onnx.ValueInfoProto, value));
  const originalOutputs = graph.output.map((value) => encoded(onnx.ValueInfoProto, value));
  const byName = new Map(originalNodes.map((node) => [node.name, node]));
  assert(byName.size === originalNodes.length, 'Source node names must be unique.');
  const consumers = new Map();
  for (const node of originalNodes)
    for (const name of node.input) {
      const users = consumers.get(name) ?? [];
      users.push(node.name);
      consumers.set(name, users);
    }
  const queryRows = queryChunkingContract.queryRows;
  const chunkRows = queryChunkingContract.queryChunkRows;
  const queryAxis = 2;
  const prefix = 'miraviewer_exact_query64';
  const usedNames = new Set([
    ...originalNodes.flatMap((node) => [node.name, ...node.input, ...node.output]),
    ...originalInitializers.keys(),
  ]);
  const name = (suffix) => {
    const value = `${prefix}/${suffix}`;
    assert(!usedNames.has(value), `Derived name collision: ${value}`);
    usedNames.add(value);
    return value;
  };
  const integer = (suffix, value) => {
    const key = name(suffix);
    graph.initializer.push(onnx.TensorProto.create({ name: key, dims: [1], dataType: 7, int64Data: [value] }));
    return key;
  };
  const axis = integer('query_axis', queryAxis);
  const boundaries = Array.from({ length: queryRows / chunkRows + 1 }, (_, index) =>
    integer(`row_${index * chunkRows}`, index * chunkRows),
  );
  const replacement = new Map();
  const removed = new Set();
  const layers = [];
  for (let layer = 0; layer < 4; layer++) {
    const scope = `/attention/layers.${layer}/cross_attn_image`;
    const score = byName.get(`${scope}/MatMul`);
    const softmax = byName.get(`${scope}/Softmax`);
    const weighted = byName.get(`${scope}/MatMul_1`);
    assert(
      score?.opType === 'MatMul' && softmax?.opType === 'Softmax' && weighted?.opType === 'MatMul',
      `Unexpected attention triplet: ${scope}`,
    );
    assert(
      [score, softmax, weighted].every((node) => !node.domain && node.output.length === 1),
      'Expected standard-domain single-output attention nodes.',
    );
    assert(
      score.input.length === 2 && softmax.input.length === 1 && weighted.input.length === 2,
      'Unexpected attention input arity.',
    );
    assert(
      softmax.attribute.length === 1 && softmax.attribute[0].name === 'axis' && Number(softmax.attribute[0].i) === -1,
      'Softmax must normalize across every key.',
    );
    assert(score.attribute.length === 0 && weighted.attribute.length === 0, 'Unexpected MatMul attributes.');
    assert(softmax.input[0] === score.output[0] && weighted.input[0] === softmax.output[0], 'Attention edges changed.');
    assert(
      JSON.stringify(consumers.get(score.output[0])) === JSON.stringify([softmax.name]),
      'Scores have another consumer.',
    );
    assert(
      JSON.stringify(consumers.get(softmax.output[0])) === JSON.stringify([weighted.name]),
      'Softmax has another consumer.',
    );
    assert(
      !graph.output.some((output) => [score.output[0], softmax.output[0]].includes(output.name)),
      'Internal attention is externally exposed.',
    );
    const start = originalNodes.indexOf(score);
    assert(
      originalNodes[start + 1] === softmax && originalNodes[start + 2] === weighted,
      'Pinned triplet is not contiguous.',
    );
    const blocks = [];
    const blockOutputs = [];
    const ranges = [];
    for (let block = 0; block < queryRows / chunkRows; block++) {
      const scopeName = `layer_${layer}/block_${block}`;
      const slice = name(`${scopeName}/queries`);
      const logits = name(`${scopeName}/scores`);
      const probabilities = name(`${scopeName}/probabilities`);
      const output = name(`${scopeName}/output`);
      blocks.push(
        onnx.NodeProto.create({
          name: name(`${scopeName}/Slice`),
          opType: 'Slice',
          input: [score.input[0], boundaries[block], boundaries[block + 1], axis],
          output: [slice],
        }),
        onnx.NodeProto.create({
          name: name(`${scopeName}/MatMul_scores`),
          opType: 'MatMul',
          input: [slice, score.input[1]],
          output: [logits],
        }),
        onnx.NodeProto.create({
          name: name(`${scopeName}/Softmax`),
          opType: 'Softmax',
          input: [logits],
          output: [probabilities],
          attribute: softmax.attribute,
        }),
        onnx.NodeProto.create({
          name: name(`${scopeName}/MatMul_values`),
          opType: 'MatMul',
          input: [probabilities, weighted.input[1]],
          output: [output],
        }),
      );
      blockOutputs.push(output);
      ranges.push([block * chunkRows, (block + 1) * chunkRows]);
    }
    blocks.push(
      onnx.NodeProto.create({
        name: name(`layer_${layer}/Concat`),
        opType: 'Concat',
        input: blockOutputs,
        output: weighted.output,
        attribute: [onnx.AttributeProto.create({ name: 'axis', type: 2, i: queryAxis })],
      }),
    );
    replacement.set(score.name, blocks);
    for (const node of [score, softmax, weighted]) removed.add(node.name);
    layers.push({
      layer,
      sourceNodes: [score.name, softmax.name, weighted.name],
      unchangedScaledQueries: score.input[0],
      unchangedAllScaledKeys: score.input[1],
      unchangedAllValues: weighted.input[1],
      restoredOutput: weighted.output[0],
      queryAxis,
      queryRanges: ranges,
      softmaxAxis: -1,
      noKeyOrPointerFiltering: true,
    });
  }
  graph.node = originalNodes.flatMap((node) => replacement.get(node.name) ?? (removed.has(node.name) ? [] : [node]));
  const available = new Set([
    ...graph.input.map((value) => value.name),
    ...graph.initializer.map((value) => value.name),
  ]);
  for (const node of graph.node) {
    assert(
      node.input.every((input) => !input || available.has(input)),
      `Non-topological input in ${node.name}`,
    );
    for (const output of node.output) {
      assert(!available.has(output), `Duplicate output ${output}`);
      available.add(output);
    }
  }
  assert(
    graph.output.every((output) => available.has(output.name)),
    'Output was disconnected.',
  );
  const untouched = graph.node.filter((node) => originalNodeBytes.has(node.name));
  assert(untouched.length === originalNodes.length - 12, 'Only twelve original nodes may be replaced.');
  assert(
    untouched.every((node) => encoded(onnx.NodeProto, node).equals(originalNodeBytes.get(node.name))),
    'An untouched operation changed.',
  );
  assert(
    graph.initializer
      .filter((value) => originalInitializers.has(value.name))
      .every((value) => encoded(onnx.TensorProto, value).equals(originalInitializers.get(value.name))),
    'Original model parameters changed.',
  );
  assert(
    graph.input.every((value, index) => encoded(onnx.ValueInfoProto, value).equals(originalInputs[index])) &&
      graph.output.every((value, index) => encoded(onnx.ValueInfoProto, value).equals(originalOutputs[index])),
    'External graph IO changed.',
  );
  assert(onnx.ModelProto.verify(model) === null, 'Derived protobuf failed structural verification.');
  const candidateBytes = encoded(onnx.ModelProto, model);

  assert(
    candidateBytes.length === queryChunkingContract.bytes && sha256(candidateBytes) === queryChunkingContract.sha256,
    'Derived graph differs from the reviewed query-blocking contract.',
  );
  return {
    bytes: candidateBytes,
    proof: {
      ...queryChunkingContract,
      originalNodeCount: originalNodes.length,
      candidateNodeCount: graph.node.length,
      originalInitializers: originalInitializers.size,
      originalInitializersUnchanged: true,
      newIntegerIndexInitializers: graph.initializer.length - originalInitializers.size,
      untouchedNodeCount: untouched.length,
      untouchedNodesUnchanged: true,
      unchangedExternalIO: true,
      validTopologicalOrder: true,
      layers,
      // Static branches do not guarantee optimized buffer lifetimes. Runtime peak/parity need separate evidence.
      guaranteesStaticBranchLifetimes: false,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--contract') {
      console.log(JSON.stringify(queryChunkingContract));
    } else {
      assert(
        args.length === 2 && args.every((argument) => !argument.startsWith('-')),
        'Usage: node scripts/derive-efficient-tam-attention.mjs SOURCE OUTPUT',
      );
      const [source, output] = args.map((argument) => path.resolve(argument));
      let destination;
      try {
        destination = lstatSync(output);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      assert(!destination, 'Refusing to overwrite an existing output.');
      const info = lstatSync(source);
      assert(info.isFile() && !info.isSymbolicLink(), 'Expected a regular source graph, not a symlink.');
      const result = deriveEfficientTamAttention(
        readFileSync(source, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }),
      );
      writeFileSync(output, result.bytes, { flag: 'wx' });
      console.log(JSON.stringify(result.proof));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
