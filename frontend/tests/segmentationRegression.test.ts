import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pixelFingerprint } from './helpers/interSliceCorpus';
import {
  requireAnatomicalReference,
  runBinaryRegressionManifest,
  type BinaryRegressionManifest,
} from './helpers/segmentationRegression';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Artificial asymmetric bytes only; no scan, patient coordinates, prompts, or learned mask are public. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'segmentation-regression-'));
  temporary.push(directory);
  const pin = (name: string, value: unknown) => {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
    writeFileSync(join(directory, name), bytes);
    return { path: name, sha256: pixelFingerprint(bytes), bytes: bytes.length };
  };
  const input = pin('input.json', { source: 'analytic-fixture', prompts: [1], preprocessing: 'identity', version: 1 });
  const source = pin('source.f32', new Uint8Array(12 * 4));
  const support = pin('support.u8', new Uint8Array(12).fill(1));
  const implementation = pin('implementation.txt', 'synthetic version one');
  const evidence = pin('review.json', {
    note: 'Synthetic example of scoped review metadata, not actual user feedback.',
  });
  const presentedImage = pin('presentation.txt', 'synthetic review display');
  const scope: BinaryRegressionManifest['cases'][number]['scope'] = { dims: [2, 2, 1], origin: [7, 11, 24] };
  const volumeGrid = { dims: [2, 2, 3], origin: [7, 11, 23] };
  const sectionMask = pin('section.u8', Uint8Array.of(1, 0, 1, 0));
  const volume = Uint8Array.of(0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0);
  const fullMask = pin('reference.u8', volume);
  const candidateMask = pin('candidate.u8', volume);
  const sectionReceipt = {
    input,
    nativeDims: [2, 2],
    nativeOrigin: scope.origin,
    outputs: { mask: sectionMask },
  };
  const referenceReceipt = { input, grid: volumeGrid, outputs: { mask: fullMask } };
  const candidateReceipt = { input, grid: volumeGrid, outputs: { mask: candidateMask } };
  const reference = {
    receipt: pin('reference.json', referenceReceipt),
    maskKey: 'mask',
    dimsPath: ['grid', 'dims'],
    originPath: ['grid', 'origin'],
  };
  const candidate = { ...reference, receipt: pin('candidate.json', candidateReceipt) };
  const manifest: BinaryRegressionManifest = {
    schema: 1,
    description: 'Synthetic saved-output harness fixture; not MRI or an anatomical oracle.',
    bindings: {
      input,
      source,
      support,
      prompts: input,
      preprocessing: implementation,
      model: implementation,
      version: implementation,
    },
    cases: [
      {
        id: 'reviewed-section',
        classification: 'user-approved-example',
        scope,
        reference: {
          receipt: pin('section.json', sectionReceipt),
          maskKey: 'mask',
          dimsPath: ['nativeDims'],
          originPath: ['nativeOrigin'],
        },
        candidate,
        approval: {
          evidence,
          presentedImage,
          scope,
          inputSha256: input.sha256,
          referenceMaskSha256: sectionMask.sha256,
        },
      },
      {
        id: 'transport-volume',
        classification: 'output-transport-regression',
        scope: volumeGrid as typeof scope,
        reference,
        candidate,
      },
    ],
  };
  const path = join(directory, 'manifest.json');
  const save = () => pin('manifest.json', manifest).sha256;
  const saveCandidate = (mask = volume) => {
    candidateReceipt.outputs.mask = pin('candidate.u8', mask);
    candidate.receipt = pin('candidate.json', candidateReceipt);
    return save();
  };
  return { directory, path, manifest, pin, volume, candidateReceipt, saveCandidate, save };
}

describe('scoped saved-mask regression, separate from anatomical accuracy', () => {
  it('checks the reviewed plane and complete transport bytes without extending user approval', () => {
    const f = fixture();
    const result = runBinaryRegressionManifest(f.path, f.save());
    expect(result.failedCases).toEqual([]);
    expect(result.cases.map((entry) => entry.comparedVoxels)).toEqual([4, 12]);
    expect(result.cases.map((entry) => entry.candidateSelected)).toEqual([2, 4]);
    expect(result.cases[0]!.userApprovedScope).toEqual(f.manifest.cases[0]!.scope);
    expect(result.cases[1]!.userApprovedScope).toBeNull();
    expect(result.cases.every((entry) => !entry.anatomicalAccuracyEstablished)).toBe(true);
    expect(result.helperSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.declaredArtifactHashesVerified).toBe(true);
    expect(result.causalModelExecutionEstablished).toBe(false);
  });

  it('compares grid coordinates semantically, independent of object key order or descriptive extras', () => {
    const f = fixture(),
      scope = f.manifest.cases[0]!.scope;
    f.manifest.cases[0]!.approval!.scope = Object.assign(
      { origin: scope.origin, dims: scope.dims },
      { description: 'same native cells' },
    );
    expect(runBinaryRegressionManifest(f.path, f.save()).failedCases).toEqual([]);
  });

  it('catches a changed propagated voxel even when the reviewed section is unchanged', () => {
    const f = fixture(),
      changed = f.volume.slice();
    changed[11] = 1;
    const result = runBinaryRegressionManifest(f.path, f.saveCandidate(changed));
    expect(result.failedCases).toEqual(['transport-volume']);
    expect(result.cases[1]).toMatchObject({ changed: 1, added: 1, removed: 0, firstChangedIndex: 11 });
  });

  it('reports a removed reviewed voxel as a regression, not an anatomical false negative', () => {
    const f = fixture(),
      changed = f.volume.slice();
    changed[4] = 0;
    const result = runBinaryRegressionManifest(f.path, f.saveCandidate(changed));
    expect(result.failedCases).toEqual(['reviewed-section', 'transport-volume']);
    expect(result.cases[0]).toMatchObject({ changed: 1, added: 0, removed: 1, firstChangedIndex: 0 });
    expect(result.cases[0]).not.toHaveProperty('recall');
  });

  it.each([
    'input.json',
    'source.f32',
    'support.u8',
    'implementation.txt',
    'review.json',
    'presentation.txt',
    'candidate.u8',
  ])('fails a changed %s without accepting an unchanged reported mask hash', (name) => {
    const f = fixture(),
      hash = f.save();
    writeFileSync(join(f.directory, name), 'changed');
    expect(() => runBinaryRegressionManifest(f.path, hash)).toThrow(/Pinned regression artifact changed/);
  });

  it('requires the caller to pin the manifest itself', () => {
    const f = fixture();
    f.save();
    expect(() => runBinaryRegressionManifest(f.path, '0'.repeat(64))).toThrow(/Pinned regression artifact changed/);
  });

  it('rejects new source/prompts/preprocessing even when candidate binary output happens to match', () => {
    const f = fixture();
    f.candidateReceipt.input = f.pin('different-input.json', { prompts: [2], preprocessing: 'changed' });
    expect(() => runBinaryRegressionManifest(f.path, f.saveCandidate())).toThrow(
      /input\/geometry\/prompts\/preprocessing changed/,
    );
  });

  it.each(['scope', 'mask', 'input', 'missing', 'full-volume'])(
    'rejects unbound or expanded user approval: %s',
    (kind) => {
      const f = fixture(),
        entry = f.manifest.cases[0]!;
      if (kind === 'scope') entry.approval!.scope = { dims: [2, 2, 1], origin: [7, 11, 25] };
      if (kind === 'mask') entry.approval!.referenceMaskSha256 = '0'.repeat(64);
      if (kind === 'input') entry.approval!.inputSha256 = '0'.repeat(64);
      if (kind === 'missing') delete entry.approval;
      if (kind === 'full-volume') {
        entry.scope = f.manifest.cases[1]!.scope;
        entry.reference = f.manifest.cases[1]!.reference;
        entry.approval!.scope = entry.scope;
      }
      expect(() => runBinaryRegressionManifest(f.path, f.save())).toThrow(/exact reviewed section/);
    },
  );

  it('does not allow the transport case to carry user approval', () => {
    const f = fixture();
    f.manifest.cases[1]!.approval = f.manifest.cases[0]!.approval;
    expect(() => runBinaryRegressionManifest(f.path, f.save())).toThrow(/cannot inherit/);
  });

  it.each(['nonbinary', 'truncated', 'phase', 'dimensions'])('rejects malformed %s transport', (kind) => {
    const f = fixture(),
      mask = f.volume.slice();
    if (kind === 'nonbinary') mask[0] = 255;
    if (kind === 'phase') f.candidateReceipt.grid.origin = [7, 11, 24];
    if (kind === 'dimensions') f.candidateReceipt.grid.dims = [2, 2, 0];
    expect(() =>
      runBinaryRegressionManifest(f.path, f.saveCandidate(kind === 'truncated' ? mask.slice(1) : mask)),
    ).toThrow(/binary|grid|scope/);
  });

  it.each(['disputed-engineering-reference', 'independently-reviewed-anatomy', 'unclassified'])(
    'does not silently use %s as a user-approved binary example',
    (classification) => {
      const f = fixture();
      Object.assign(f.manifest.cases[0]!, { classification });
      expect(() => runBinaryRegressionManifest(f.path, f.save())).toThrow(/not an anatomical accuracy gate/);
    },
  );

  it.each([undefined, 'disputed-engineering-reference', 'user-approved-example', 'output-transport-regression'])(
    'blocks anatomical accuracy interpretation for %s',
    (classification) => {
      expect(() => requireAnatomicalReference(classification)).toThrow(/Anatomical accuracy gate blocked/);
    },
  );
  it.each(['synthetic-reference', 'independently-reviewed-anatomy'])(
    'requires an explicit suitable reference category: %s',
    (classification) => {
      expect(() => requireAnatomicalReference(classification)).not.toThrow();
    },
  );
});

const manifest = process.env.MIRAVIEWER_SEGMENTATION_REGRESSION_MANIFEST;
const manifestSha = process.env.MIRAVIEWER_SEGMENTATION_REGRESSION_SHA;
describe.skipIf(!manifest && !manifestSha)('explicit private saved-output binary regression', () => {
  it('verifies pinned source/review scope and all candidate bytes; does not infer or grade anatomy', () => {
    if (!manifest || !manifestSha) throw new Error('Both regression manifest path and exact SHA-256 are required.');
    const before = pixelFingerprint(readFileSync(manifest));
    const result = runBinaryRegressionManifest(manifest, manifestSha);
    if (process.env.MIRAVIEWER_SEGMENTATION_REGRESSION_OUTPUT)
      writeFileSync(process.env.MIRAVIEWER_SEGMENTATION_REGRESSION_OUTPUT, `${JSON.stringify(result, null, 2)}\n`, {
        flag: 'wx',
      });
    expect(pixelFingerprint(readFileSync(manifest))).toBe(before);
    console.info(
      '[saved-binary-regression]',
      result.cases.map(({ id, classification, comparedVoxels, changed }) => ({
        id,
        classification,
        comparedVoxels,
        changed,
      })),
    );
    expect(result.failedCases).toEqual([]);
  });
});
