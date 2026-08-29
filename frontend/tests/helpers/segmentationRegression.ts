import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pixelFingerprint } from './interSliceCorpus';

export type SegmentationReferenceClassification =
  | 'user-approved-example'
  | 'output-transport-regression'
  | 'disputed-engineering-reference'
  | 'independently-reviewed-anatomy'
  | 'synthetic-reference';

/** A frozen file or a liked prediction is not, by itself, an anatomical accuracy oracle. */
export function requireAnatomicalReference(classification: unknown) {
  if (classification !== 'independently-reviewed-anatomy' && classification !== 'synthetic-reference')
    throw new Error(
      `Anatomical accuracy gate blocked: reference classification is ${String(classification ?? 'unclassified')}. ` +
        'User-approved examples permit scoped regression only; disputed engineering references are not anatomical truth.',
    );
}

export type RegressionFilePin = { path: string; sha256: string; bytes?: number };
export type RegressionGrid = { dims: [number, number, number]; origin: [number, number, number] };
type SavedMask = {
  receipt: RegressionFilePin;
  maskKey: string;
  dimsPath: string[];
  originPath: string[];
};
export type BinaryRegressionManifest = {
  schema: 1;
  description: string;
  /** Input must pin geometry, original prompts, and preprocessing. Additional artifacts bind their implementations. */
  bindings: Record<
    'input' | 'source' | 'support' | 'prompts' | 'preprocessing' | 'model' | 'version',
    RegressionFilePin
  > &
    Record<string, RegressionFilePin>;
  cases: Array<{
    id: string;
    classification: 'user-approved-example' | 'output-transport-regression';
    scope: RegressionGrid;
    reference: SavedMask;
    candidate: SavedMask;
    /** The evidence applies to this exact reference raster and scope, never to an enclosing propagated volume. */
    approval?: {
      evidence: RegressionFilePin;
      presentedImage: RegressionFilePin;
      scope: RegressionGrid;
      inputSha256: string;
      referenceMaskSha256: string;
    };
  }>;
};

export function readRegressionPin(directory: string, pin: RegressionFilePin): Buffer {
  if (!pin || typeof pin.path !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256))
    throw new Error('Regression artifacts require an exact path and SHA-256.');
  const bytes = readFileSync(resolve(directory, pin.path));
  if (pixelFingerprint(bytes) !== pin.sha256 || (pin.bytes !== undefined && bytes.length !== pin.bytes))
    throw new Error(`Pinned regression artifact changed: ${pin.path}`);
  return bytes;
}

function grid(value: RegressionGrid): RegressionGrid {
  if (
    !value ||
    !Array.isArray(value.dims) ||
    !Array.isArray(value.origin) ||
    value.dims.length !== 3 ||
    value.origin.length !== 3 ||
    !value.dims.every((size) => Number.isSafeInteger(size) && size > 0) ||
    !value.origin.every(Number.isSafeInteger) ||
    !Number.isSafeInteger(value.dims.reduce((count, size) => count * size, 1))
  )
    throw new Error('Regression needs exact native grid dimensions and integer origin.');
  return value;
}

const sameGrid = (first: RegressionGrid, second: RegressionGrid) =>
  first.dims.every((size, axis) => size === second.dims[axis]) &&
  first.origin.every((coordinate, axis) => coordinate === second.origin[axis]);

function field(value: unknown, path: string[]): unknown {
  if (!Array.isArray(path) || !path.length) throw new Error('Missing regression receipt field path.');
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw new Error('Missing pinned regression receipt field.');
    return (current as Record<string, unknown>)[key];
  }, value);
}

function scopedMask(mask: Uint8Array, source: RegressionGrid, scope: RegressionGrid) {
  grid(source);
  grid(scope);
  if (mask.length !== source.dims.reduce((count, size) => count * size, 1) || mask.some((value) => value > 1))
    throw new Error('Regression mask must be binary and cover its complete declared source grid.');
  const offset = scope.origin.map((coordinate, axis) => coordinate - source.origin[axis]!);
  if (offset.some((coordinate, axis) => coordinate < 0 || coordinate + scope.dims[axis]! > source.dims[axis]!))
    throw new Error('Regression scope is not covered by the saved mask.');
  const result = new Uint8Array(scope.dims.reduce((count, size) => count * size, 1));
  let index = 0;
  for (let z = 0; z < scope.dims[2]; z++)
    for (let y = 0; y < scope.dims[1]; y++)
      for (let x = 0; x < scope.dims[0]; x++)
        result[index++] = mask[((z + offset[2]!) * source.dims[1] + y + offset[1]!) * source.dims[0] + x + offset[0]!]!;
  return result;
}

/** Saved-output verification only: no solver, inference, anatomy labels, or writable source callbacks. */
export function runBinaryRegressionManifest(path: string, manifestSha256: string) {
  // Keep the filename dynamic so Vite does not rewrite a filesystem self-hash into a browser asset URL.
  const helperName = 'segmentationRegression.ts';
  const directory = dirname(resolve(path));
  const manifest = JSON.parse(
    readRegressionPin(directory, { path: resolve(path), sha256: manifestSha256 }).toString('utf8'),
  ) as BinaryRegressionManifest;
  if (manifest.schema !== 1 || !manifest.description || !Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error('Invalid binary regression manifest.');
  const requiredBindings = ['input', 'source', 'support', 'prompts', 'preprocessing', 'model', 'version'];
  if (!manifest.bindings || requiredBindings.some((role) => !manifest.bindings[role]))
    throw new Error('Regression must bind source, support, prompts, preprocessing, model, and version.');
  for (const pin of Object.values(manifest.bindings)) readRegressionPin(directory, pin);
  const inputHash = manifest.bindings.input.sha256;
  const load = (endpoint: SavedMask) => {
    const receipt = JSON.parse(readRegressionPin(directory, endpoint.receipt).toString('utf8'));
    if (receipt.input?.sha256 !== inputHash)
      throw new Error('Regression candidate input/geometry/prompts/preprocessing changed.');
    const receiptDirectory = dirname(resolve(directory, endpoint.receipt.path));
    readRegressionPin(receiptDirectory, receipt.input);
    const dims = field(receipt, endpoint.dimsPath) as number[];
    const origin = field(receipt, endpoint.originPath) as RegressionGrid['origin'];
    const nativeGrid = grid({ dims: (dims?.length === 2 ? [...dims, 1] : dims) as RegressionGrid['dims'], origin });
    const pin = receipt.outputs?.[endpoint.maskKey] as RegressionFilePin;
    return { mask: readRegressionPin(receiptDirectory, pin), grid: nativeGrid, maskHash: pin.sha256 };
  };
  const ids = new Set<string>();
  const cases = manifest.cases.map((entry) => {
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id))
      throw new Error('Regression case ids must be unique.');
    ids.add(entry.id);
    if (!['user-approved-example', 'output-transport-regression'].includes(entry.classification))
      throw new Error('Binary regression is not an anatomical accuracy gate; classify the reference explicitly.');
    grid(entry.scope);
    const reference = load(entry.reference),
      candidate = load(entry.candidate);
    if (entry.classification === 'user-approved-example') {
      const approval = entry.approval;
      if (
        !approval ||
        !entry.scope.dims.includes(1) ||
        !sameGrid(grid(approval.scope), entry.scope) ||
        !sameGrid(reference.grid, entry.scope) ||
        approval.referenceMaskSha256 !== reference.maskHash ||
        approval.inputSha256 !== inputHash
      )
        throw new Error(
          'User approval must bind the exact reviewed section, mask, and input; it cannot approve propagation.',
        );
      readRegressionPin(directory, approval.evidence);
      readRegressionPin(directory, approval.presentedImage);
    } else if (entry.approval) throw new Error('A transport regression cannot inherit user anatomical approval.');
    const expected = scopedMask(reference.mask, reference.grid, entry.scope);
    const actual = scopedMask(candidate.mask, candidate.grid, entry.scope);
    let changed = 0,
      added = 0,
      removed = 0,
      referenceSelected = 0,
      candidateSelected = 0;
    let firstChangedIndex: number | null = null;
    for (let index = 0; index < expected.length; index++) {
      referenceSelected += expected[index]!;
      candidateSelected += actual[index]!;
      if (expected[index] === actual[index]) continue;
      changed++;
      added += actual[index]!;
      removed += expected[index]!;
      firstChangedIndex ??= index;
    }
    return {
      id: entry.id,
      classification: entry.classification,
      scope: entry.scope,
      userApprovedScope: entry.classification === 'user-approved-example' ? entry.scope : null,
      comparison: 'exact-binary-regression' as const,
      anatomicalAccuracyEstablished: false,
      referenceReceiptSha256: entry.reference.receipt.sha256,
      candidateReceiptSha256: entry.candidate.receipt.sha256,
      referenceMaskSha256: pixelFingerprint(expected),
      candidateMaskSha256: pixelFingerprint(actual),
      comparedVoxels: expected.length,
      referenceSelected,
      candidateSelected,
      changed,
      added,
      removed,
      firstChangedIndex,
      byteIdentical: changed === 0,
    };
  });
  return {
    manifestSha256,
    helperSha256: pixelFingerprint(readFileSync(new URL(helperName, import.meta.url))),
    bindings: Object.fromEntries(Object.entries(manifest.bindings).map(([role, pin]) => [role, pin.sha256])),
    declaredArtifactHashesVerified: true,
    candidateExecutionReplayed: false,
    causalModelExecutionEstablished: false,
    interpretation:
      'Pinned saved-output regression, not anatomical accuracy, clinical validation, or new inference. Section approval does not approve propagated anatomy.',
    provenanceLimit:
      'Declared artifacts and receipt/input links are SHA-verified. A model/version file listed beside an output is not, by itself, proof that the model produced it; execution provenance remains the responsibility of the linked run receipts.',
    cases,
    failedCases: cases.filter((entry) => !entry.byteIdentical).map((entry) => entry.id),
  };
}
