import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  segmentSeededVolume,
  type SeededVolumeInput,
  type SeededVolumeResult,
} from '../src/utils/segmentation/seededVolume';
import { pixelFingerprint } from './helpers/interSliceCorpus';
import { rasterizeGoldenSection, type GoldenVolumeSection } from './helpers/segmentationGolden';
import {
  goldenScorerHash,
  readGoldenCorpusManifest,
  runGoldenCorpus,
  scoreGoldenVolumeMask,
  type GoldenCorpusManifest,
} from './helpers/segmentationGoldenCorpus';

const productionPath = resolve('src/utils/segmentation/seededVolume.ts');
const productionHash = pixelFingerprint(readFileSync(productionPath));
const ownedTemporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of ownedTemporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Analytic one-cell source, not MRI or a clinically labeled target. */
function fixture(withSupport = true) {
  const directory = mkdtempSync(join(tmpdir(), 'miraviewer-golden-harness-'));
  ownedTemporaryDirectories.push(directory);
  const dims: [number, number, number] = [9, 9, 9];
  const origin: [number, number, number] = [100, 200, 300];
  const spacingMm: [number, number, number] = [0.6, 1.1, 2];
  const center = (4 * 9 + 4) * 9 + 4;
  const volume = new Float32Array(9 ** 3).fill(0.4);
  volume[center] = 0.8;
  const sourceBytes = Buffer.alloc(volume.length * 4);
  volume.forEach((value, index) => sourceBytes.writeFloatLE(value, index * 4));
  const pin = (path: string, bytes: Uint8Array) => {
    writeFileSync(join(directory, path), bytes);
    return { path, sha256: pixelFingerprint(bytes) };
  };
  const reference = {
    schema: 1,
    classification: 'synthetic-reference' as const,
    split: 'development' as 'development' | 'holdout',
    status: 'frozen-analytic-unit-fixture-not-mri',
    boundaryUncertaintyMm: 0,
    sections: [
      {
        plane: 'axial',
        index: 304,
        polygons: [
          [
            [103.5, 203.5],
            [104.5, 203.5],
            [104.5, 204.5],
            [103.5, 204.5],
          ],
        ],
      },
    ],
  };
  const grid = { dims, origin, spacingMm, sourceGrid: 'analytic-native-grid' };
  const manifest: GoldenCorpusManifest = {
    version: 1,
    split: 'development',
    description: 'Analytic native-cell harness fixture; no medical source data.',
    cases: [
      {
        id: 'native-cell',
        ...grid,
        pixels: pin('source.f32', sourceBytes),
        support: withSupport ? pin('support.u8', new Uint8Array(volume.length).fill(1)) : undefined,
        foreground: [center],
        background: [center + 4],
        references: [
          {
            ...pin('reference.json', Buffer.from(JSON.stringify(reference))),
            grid,
            classification: 'synthetic-reference',
          },
        ],
      },
    ],
  };
  const path = join(directory, 'manifest.json');
  const save = () => writeFileSync(path, JSON.stringify(manifest));
  const saveReference = () => {
    Object.assign(manifest.cases[0]!.references[0]!, pin('reference.json', Buffer.from(JSON.stringify(reference))));
    save();
  };
  save();
  return { directory, path, volume, center, grid, reference, manifest, save, saveReference };
}

function fixedResult(indices: number[], input: SeededVolumeInput): SeededVolumeResult {
  return {
    indices: Uint32Array.from(indices),
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: input.dims[0] - 1, y: input.dims[1] - 1, z: input.dims[2] - 1 } },
    boundaryCount: 0,
    domainVoxels: input.volume.length,
  };
}

describe('portable, source-pinned segmentation golden corpus', () => {
  it.each([undefined, 'disputed-engineering-reference', 'user-approved-example', 'output-transport-regression'])(
    'fails closed before inference for an anatomical manifest classified %s',
    (classification) => {
      const source = fixture();
      Object.assign(source.manifest.cases[0]!.references[0]!, { classification });
      source.save();
      expect(() => readGoldenCorpusManifest(source.path, productionHash)).toThrow(/Anatomical accuracy gate blocked/);
    },
  );

  it('does not let a suitable manifest classification override a disputed reference file', async () => {
    const source = fixture(),
      seen = vi.fn(segmentSeededVolume);
    Object.assign(source.reference, { classification: 'disputed-engineering-reference' });
    source.saveReference();
    await expect(
      runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, { solverHash: productionHash }),
    ).rejects.toThrow(/Anatomical accuracy gate blocked/);
    expect(seen).not.toHaveBeenCalled();
  });

  it('requires a review evidence pin before admitting independently reviewed anatomy', async () => {
    const source = fixture(),
      seen = vi.fn(segmentSeededVolume);
    source.manifest.cases[0]!.references[0]!.classification = 'independently-reviewed-anatomy';
    Object.assign(source.reference, { classification: 'independently-reviewed-anatomy' });
    source.saveReference();
    await expect(
      runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, { solverHash: productionHash }),
    ).rejects.toThrow(/pinned review evidence/);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'exercises the actual production solver without exposing annotations, support=%s',
    async (support) => {
      const source = fixture(support),
        seen = vi.fn(segmentSeededVolume);
      const report = await runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, {
        solverHash: productionHash,
        // Artifact consumers cannot rewrite the mask whose integrity is being reported.
        onCase: (_id, mask) => {
          mask.fill(1);
        },
      });
      expect(report.failedCases).toEqual([]);
      expect(report.scorerHash).toBe(goldenScorerHash());
      expect(report.scorerHash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.cases[0]!.selected).toBe(1);
      expect(report.cases[0]!.scores[0]!.full.dice).toBe(1);
      expect(report.cases[0]!.scores[0]!.boundaryMm.maximum).toBeCloseTo(0, 12);
      expect(report.cases[0]!.invariants).toEqual({
        sourceAndMarksUnchanged: true,
        missingForeground: 0,
        selectedBackground: 0,
        unsupportedSelected: 0,
      });
      const mask = new Uint8Array(source.volume.length);
      mask[source.center] = 1;
      expect(report.cases[0]!.maskHash).toBe(pixelFingerprint(mask));
      expect(Object.keys(seen.mock.calls[0]![0]).sort()).toEqual([
        'background',
        'bounds',
        'dims',
        'foreground',
        'observedSupport',
        'volume',
        'voxelSizeMm',
      ]);
      expect([...seen.mock.calls[0]![0].volume]).toEqual([...source.volume]);
    },
  );

  it.each(['source.f32', 'support.u8', 'reference.json'])(
    'fails a changed %s before invoking the solver',
    async (name) => {
      const source = fixture(),
        seen = vi.fn(segmentSeededVolume);
      writeFileSync(join(source.directory, name), Buffer.from('changed'));
      await expect(
        runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, { solverHash: productionHash }),
      ).rejects.toThrow(/pinned benchmark/);
      expect(seen).not.toHaveBeenCalled();
    },
  );

  it('keeps holdout admission tied to an explicitly confirmed frozen solver', async () => {
    const source = fixture();
    source.manifest.split = 'holdout';
    source.save();
    expect(() => readGoldenCorpusManifest(source.path, productionHash)).toThrow(/explicit confirmation/);
    expect(() => readGoldenCorpusManifest(source.path, '')).toThrow(/exact solver hash/);
    expect(() => readGoldenCorpusManifest(source.path, productionHash, '0'.repeat(64))).toThrow(
      /explicit confirmation/,
    );
    const admitted = readGoldenCorpusManifest(source.path, productionHash, productionHash);
    expect(admitted.manifest.split).toBe('holdout');
    const seen = vi.fn(segmentSeededVolume);
    await expect(runGoldenCorpus(admitted, seen, { solverHash: '0'.repeat(64) })).rejects.toThrow(
      /changed after corpus admission/,
    );
    expect(seen).not.toHaveBeenCalled();
  });

  it('rejects draft and mutually contradictory source labels before any inference', async () => {
    const source = fixture(),
      seen = vi.fn(segmentSeededVolume);
    source.reference.status = 'draft';
    source.saveReference();
    await expect(
      runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, { solverHash: productionHash }),
    ).rejects.toThrow(/reviewed and frozen/);
    source.reference.status = 'frozen-analytic-unit-fixture-not-mri';
    source.reference.sections.push({
      plane: 'coronal',
      index: 204,
      polygons: [
        [
          [100.5, 300.5],
          [101.5, 300.5],
          [101.5, 301.5],
          [100.5, 301.5],
        ],
      ],
    });
    source.saveReference();
    await expect(
      runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, { solverHash: productionHash }),
    ).rejects.toThrow(/contradict one another/);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each([
    'holdout-as-development',
    'development-as-holdout',
    'missing-schema',
    'unknown-schema',
    'missing-split',
    'unknown-split',
  ])('rejects reference provenance %s before the candidate is called', async (kind) => {
    const source = fixture();
    const reference = source.reference as Record<string, unknown>;
    if (kind === 'holdout-as-development') reference.split = 'holdout';
    else if (kind === 'development-as-holdout') source.manifest.split = 'holdout';
    else if (kind === 'missing-schema') delete reference.schema;
    else if (kind === 'unknown-schema') reference.schema = 2;
    else if (kind === 'missing-split') delete reference.split;
    else reference.split = 'training';
    source.saveReference();
    const seen = vi.fn(segmentSeededVolume);
    await expect(
      runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash, productionHash), seen, {
        solverHash: productionHash,
      }),
    ).rejects.toThrow(/schema|split/i);
    expect(seen).not.toHaveBeenCalled();
  });

  it.each(['support', 'nonfinite'] as const)(
    'propagates acquired %s holes into scoring without inventing boundaries',
    async (missing) => {
      const source = fixture();
      const entry = source.manifest.cases[0]!;
      source.reference.sections[0]!.polygons = [
        [
          [102.5, 202.5],
          [105.5, 202.5],
          [105.5, 205.5],
          [102.5, 205.5],
        ],
      ];
      entry.foreground = [source.center + 1];
      const path = join(source.directory, missing === 'support' ? 'support.u8' : 'source.f32');
      const bytes = readFileSync(path);
      if (missing === 'support') bytes[source.center] = 0;
      else bytes.writeFloatLE(NaN, source.center * 4);
      writeFileSync(path, bytes);
      (missing === 'support' ? entry.support! : entry.pixels).sha256 = pixelFingerprint(bytes);
      source.saveReference();
      const selected: number[] = [];
      for (let y = 3; y <= 5; y++)
        for (let x = 3; x <= 5; x++) {
          const index = (4 * 9 + y) * 9 + x;
          if (index !== source.center) selected.push(index);
        }
      const report = await runGoldenCorpus(
        readGoldenCorpusManifest(source.path, productionHash),
        async (input) => fixedResult(selected, input),
        { solverHash: productionHash },
      );
      expect(report.failedCases).toEqual([]);
      expect(report.cases[0]!.scores[0]!.excluded.unsupported).toBe(1);
      expect(report.cases[0]!.scores[0]!.full.recall).toBe(1);
      expect(report.cases[0]!.scores[0]!.boundaryMm.maximum).toBeCloseTo(0, 12);
    },
  );

  it.each(['grid', 'spacing', 'phase', 'outside-mark', 'overlapping-marks', 'unsafe-id'])(
    'rejects invalid %s authority',
    (kind) => {
      const source = fixture(),
        entry = source.manifest.cases[0]!;
      if (kind === 'grid') entry.references[0]!.grid.sourceGrid = 'unrelated-source';
      if (kind === 'spacing') entry.references[0]!.grid.spacingMm = [1, 1, 1];
      if (kind === 'phase') entry.origin = [100.5, 200, 300];
      if (kind === 'outside-mark') entry.foreground = [9 ** 3];
      if (kind === 'overlapping-marks') entry.background = [...entry.foreground];
      if (kind === 'unsafe-id') entry.id = '../outside-artifacts';
      source.save();
      expect(() => readGoldenCorpusManifest(source.path, productionHash)).toThrow();
    },
  );

  it('reports hard-mark, unsupported-selection, mutation, and disconnected-island failures explicitly', async () => {
    const source = fixture(),
      entry = source.manifest.cases[0]!;
    const support = new Uint8Array(source.volume.length).fill(1);
    support[0] = 0;
    writeFileSync(join(source.directory, 'support.u8'), support);
    entry.support!.sha256 = pixelFingerprint(support);
    source.save();
    const report = await runGoldenCorpus(
      readGoldenCorpusManifest(source.path, productionHash),
      async (input) => {
        input.volume[1] = 42;
        return fixedResult([0, source.center + 4], input);
      },
      { solverHash: productionHash },
    );
    expect(report.failedCases).toEqual(['native-cell']);
    expect(report.cases[0]!.invariants).toEqual({
      sourceAndMarksUnchanged: false,
      missingForeground: 1,
      selectedBackground: 1,
      unsupportedSelected: 1,
    });
    expect(report.cases[0]!.topology.orphanVoxels).toBe(2);
    expect(report.cases[0]!.failures.some((failure) => failure.section === 'volume')).toBe(true);
  });

  it.each(['duplicate', 'invalid'])('rejects %s solver indices', async (kind) => {
    const source = fixture();
    await expect(
      runGoldenCorpus(
        readGoldenCorpusManifest(source.path, productionHash),
        async (input) => fixedResult(kind === 'duplicate' ? [source.center, source.center] : [9 ** 3], input),
        { solverHash: productionHash },
      ),
    ).rejects.toThrow(/source indices/);
  });

  it('counts definite anatomy outside the actual processing domain as unreachable, not unknown', () => {
    const reference: GoldenVolumeSection = {
      id: 'axial-304',
      sourceGrid: 'source',
      fixedAxis: 2,
      fixedIndex: 304,
      acrossAxis: 0,
      verticalAxis: 1,
      golden: rasterizeGoldenSection({
        columns: 9,
        rows: 9,
        origin: [100, 200],
        spacingMm: [1, 1],
        polygons: [
          [
            [103.5, 203.5],
            [104.5, 203.5],
            [104.5, 204.5],
            [103.5, 204.5],
          ],
        ],
        boundaryUncertaintyMm: 0,
        auditMarginMm: 2,
      }),
    };
    const scores = scoreGoldenVolumeMask(
      new Uint8Array(9),
      {
        sourceGrid: 'source',
        dims: [3, 3, 1],
        origin: [103, 203, 303],
      },
      [reference],
    );
    expect(scores[0]!.definiteInsideOutsideDomain).toBe(1);
    expect(scores[0]!.maximumPossibleRecallFromDomain).toBe(0);
    expect(scores[0]!.full.recall).toBe(0);
    expect(scores[0]!.failures).toContain('definite-inside recall');
  });

  it('records a solver failure and still evaluates the remaining independent cases', async () => {
    const source = fixture();
    source.manifest.cases.push({ ...source.manifest.cases[0]!, id: 'next-case' });
    source.save();
    const seen = vi.fn(segmentSeededVolume).mockRejectedValueOnce(new Error('deliberate solver budget failure'));
    const report = await runGoldenCorpus(readGoldenCorpusManifest(source.path, productionHash), seen, {
      solverHash: productionHash,
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(report.totalCases).toBe(2);
    expect(report.failedCases).toEqual(['native-cell']);
    expect(report.solverFailures[0]!.error).toBe('deliberate solver budget failure');
    expect(report.cases[0]!.id).toBe('next-case');
    expect(report.cases[0]!.failures).toEqual([]);
  });
});

const privateManifest = process.env.MIRAVIEWER_GOLDEN_CORPUS_MANIFEST;
describe.skipIf(!privateManifest)('opt-in private native-grid segmentation benchmark', () => {
  it('scores every frozen cross-section and preserves source data and hard marks', async () => {
    const override = process.env.MIRAVIEWER_GOLDEN_SOLVER;
    const solverPath = override ? resolve(override) : productionPath;
    const solverHash = pixelFingerprint(readFileSync(solverPath));
    if (override && solverHash !== process.env.MIRAVIEWER_GOLDEN_SOLVER_SHA)
      throw new Error('An experimental solver requires its explicit frozen SHA256.');
    const loaded = readGoldenCorpusManifest(
      privateManifest!,
      solverHash,
      process.env.MIRAVIEWER_GOLDEN_HOLDOUT_SOLVER_SHA,
    );
    const solver: typeof segmentSeededVolume = override
      ? (await import(/* @vite-ignore */ pathToFileURL(solverPath).href)).segmentSeededVolume
      : segmentSeededVolume;
    const scorerHash = goldenScorerHash();
    const destination = resolve(
      'tmp/segmentation-golden/portable',
      scorerHash.slice(0, 12),
      solverHash.slice(0, 8),
      loaded.hash.slice(0, 8),
    );
    mkdirSync(destination, { recursive: true });
    const report = await runGoldenCorpus(loaded, solver, {
      solverHash,
      onCase: (id, mask) => {
        writeFileSync(join(destination, `${id}.mask.u8`), mask);
      },
    });
    writeFileSync(join(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
    expect(pixelFingerprint(readFileSync(solverPath))).toBe(solverHash);
    expect(report.scorerHash).toBe(scorerHash);
    expect(goldenScorerHash()).toBe(scorerHash);
    console.info(`[native-golden] ${report.totalCases} cases, ${report.failedCases.length} fail; ${destination}`);
    expect(report.failedCases).toEqual([]);
  }, 240_000);
});
