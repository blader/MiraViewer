import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SeededVolumeInput, SeededVolumeResult } from '../../src/utils/segmentation/seededVolume';
import { pixelFingerprint } from './interSliceCorpus';
import { nativeMaskTopology } from './segmentationNativeCorpus';
import { requireAnatomicalReference, type SegmentationReferenceClassification } from './segmentationRegression';
import {
  evaluateGoldenSection,
  goldenCrossPlaneConflicts,
  goldenSectionFailures,
  rasterizeGoldenSection,
  type GoldenPolygon,
  type GoldenVolumeSection,
} from './segmentationGolden';

type Triple = [number, number, number];
type FilePin = { path: string; sha256: string };
type ReferenceGrid = { sourceGrid: string; dims: Triple; origin: Triple; spacingMm: Triple };
export type GoldenCorpusCase = {
  id: string;
  sourceGrid: string;
  /** Actual processing-grid origin in the reference's canonical source coordinates. */
  origin: Triple;
  dims: Triple;
  spacingMm: Triple;
  pixels: FilePin;
  support?: FilePin;
  foreground: number[];
  background: number[];
  bounds?: SeededVolumeInput['bounds'];
  references: Array<FilePin & { grid: ReferenceGrid; classification: SegmentationReferenceClassification }>;
};
export type GoldenCorpusManifest = {
  version: 1;
  split: 'development' | 'holdout';
  /** A geometry/source description, never a claim of clinician-annotated tumor truth. */
  description: string;
  cases: GoldenCorpusCase[];
};

type ReferenceFile = {
  schema: 1;
  split: GoldenCorpusManifest['split'];
  classification: SegmentationReferenceClassification;
  reviewEvidence?: FilePin;
  status: string;
  boundaryUncertaintyMm: number;
  sections: Array<{
    plane: 'axial' | 'coronal' | 'sagittal';
    index: number;
    polygons: GoldenPolygon[];
    holes?: GoldenPolygon[];
    uncertainPolygons?: GoldenPolygon[];
    auditBounds?: { min: readonly [number, number]; max: readonly [number, number] };
  }>;
};

const axes = { axial: [2, 0, 1], coronal: [1, 0, 2], sagittal: [0, 1, 2] } as const;
/** One revision covers the actual overlap, geometry, admission, and topology scoring authorities. */
export function goldenScorerHash() {
  return pixelFingerprint(
    Buffer.from(
      JSON.stringify(
        [
          'segmentationGolden.ts',
          'segmentationGoldenCorpus.ts',
          'segmentationNativeCorpus.ts',
          'segmentationRegression.ts',
        ].map((name) => [name, pixelFingerprint(readFileSync(new URL(name, import.meta.url)))]),
      ),
    ),
  );
}
const sourcePins = (root: string, file: FilePin) => {
  const bytes = readFileSync(resolve(root, file.path));
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || pixelFingerprint(bytes) !== file.sha256)
    throw new Error('A pinned benchmark source or annotation changed.');
  return bytes;
};
const validGrid = (grid: { dims: Triple; origin: Triple; spacingMm: Triple }) =>
  grid &&
  Array.isArray(grid.dims) &&
  Array.isArray(grid.origin) &&
  Array.isArray(grid.spacingMm) &&
  grid.dims.length === 3 &&
  grid.origin.length === 3 &&
  grid.spacingMm.length === 3 &&
  grid.dims.every((size) => Number.isSafeInteger(size) && size > 0) &&
  grid.origin.every(Number.isSafeInteger) &&
  grid.spacingMm.every((spacing) => Number.isFinite(spacing) && spacing > 0) &&
  Number.isSafeInteger(grid.dims.reduce((count, size) => count * size, 1));

export function readGoldenCorpusManifest(path: string, solverHash: string, confirmedHoldoutSolverHash?: string) {
  if (!/^[a-f0-9]{64}$/.test(solverHash)) throw new Error('Benchmark execution requires an exact solver hash.');
  const bytes = readFileSync(path),
    manifest = JSON.parse(bytes.toString('utf8')) as GoldenCorpusManifest;
  if (
    manifest.version !== 1 ||
    !['development', 'holdout'].includes(manifest.split) ||
    !Array.isArray(manifest.cases) ||
    !manifest.cases.length ||
    !manifest.description
  )
    throw new Error('Invalid private golden corpus manifest.');
  if (manifest.split === 'holdout' && confirmedHoldoutSolverHash !== solverHash)
    throw new Error('Holdout evaluation requires explicit confirmation of the already frozen solver hash.');
  const ids = new Set<string>();
  for (const entry of manifest.cases) {
    if (
      typeof entry.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.id) ||
      ids.has(entry.id) ||
      !entry.sourceGrid ||
      !validGrid(entry) ||
      !Array.isArray(entry.references) ||
      !entry.references.length ||
      !Array.isArray(entry.foreground) ||
      !entry.foreground.length ||
      !Array.isArray(entry.background)
    )
      throw new Error('Each benchmark case needs unique identity, native geometry, independent marks, and references.');
    ids.add(entry.id);
    const count = entry.dims.reduce((total, size) => total * size, 1);
    if (
      [...entry.foreground, ...entry.background].some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= count,
      )
    )
      throw new Error('A benchmark mark is outside its native processing grid.');
    if (new Set([...entry.foreground, ...entry.background]).size !== entry.foreground.length + entry.background.length)
      throw new Error('Benchmark marks must be unique and their two classes must not overlap.');
    for (const reference of entry.references) {
      requireAnatomicalReference(reference.classification);
      if (
        reference.grid.sourceGrid !== entry.sourceGrid ||
        !validGrid(reference.grid) ||
        reference.grid.spacingMm.some((spacing, axis) => Math.abs(spacing - entry.spacingMm[axis]!) > 1e-6)
      )
        throw new Error(
          'Benchmark annotations and input must identify the same native source grid and sampling phase.',
        );
    }
  }
  return { manifest, hash: pixelFingerprint(bytes), directory: dirname(resolve(path)), solverHash };
}

function readReferences(
  directory: string,
  entry: GoldenCorpusCase,
  split: GoldenCorpusManifest['split'],
): GoldenVolumeSection[] {
  return entry.references.flatMap((pin) => {
    const reference = JSON.parse(sourcePins(directory, pin).toString('utf8')) as ReferenceFile;
    if (reference.schema !== 1 || !['development', 'holdout'].includes(reference.split) || reference.split !== split)
      throw new Error('Golden reference schema and split must match the admitted corpus.');
    requireAnatomicalReference(reference.classification);
    if (reference.classification !== pin.classification)
      throw new Error(
        'Reference classification must match the admitted corpus; frozen status does not establish anatomy.',
      );
    if (reference.classification === 'independently-reviewed-anatomy') {
      if (!reference.reviewEvidence) throw new Error('Independently reviewed anatomy requires pinned review evidence.');
      sourcePins(dirname(resolve(directory, pin.path)), reference.reviewEvidence);
    }
    if (
      typeof reference.status !== 'string' ||
      !reference.status.startsWith('frozen') ||
      !Array.isArray(reference.sections) ||
      !reference.sections.length
    )
      throw new Error('Source annotations must be visually reviewed and frozen before solver evaluation.');
    return reference.sections.map((section) => {
      const mapping = axes[section.plane];
      if (!mapping || !Number.isSafeInteger(section.index)) throw new Error('Invalid golden source section.');
      const [fixedAxis, acrossAxis, verticalAxis] = mapping,
        { grid } = pin;
      if (section.index < grid.origin[fixedAxis] || section.index >= grid.origin[fixedAxis] + grid.dims[fixedAxis])
        throw new Error('A golden section is outside its reviewed source grid.');
      return {
        id: `${section.plane}-${section.index}`,
        sourceGrid: grid.sourceGrid,
        fixedAxis,
        fixedIndex: section.index,
        acrossAxis,
        verticalAxis,
        golden: rasterizeGoldenSection({
          columns: grid.dims[acrossAxis],
          rows: grid.dims[verticalAxis],
          origin: [grid.origin[acrossAxis], grid.origin[verticalAxis]],
          spacingMm: [grid.spacingMm[acrossAxis], grid.spacingMm[verticalAxis]],
          polygons: section.polygons,
          holes: section.holes,
          uncertainPolygons: section.uncertainPolygons,
          auditBounds: section.auditBounds,
          boundaryUncertaintyMm: reference.boundaryUncertaintyMm,
          auditMarginMm: 10,
        }),
      };
    });
  });
}

/** Project only integer source cells; outside the actual processing domain stays unselected, not relabeled unknown. */
export function scoreGoldenVolumeMask(
  mask: Uint8Array,
  grid: Pick<GoldenCorpusCase, 'sourceGrid' | 'dims' | 'origin'>,
  references: readonly GoldenVolumeSection[],
  knownSource?: Uint8Array,
) {
  if (
    mask.length !== grid.dims.reduce((count, size) => count * size, 1) ||
    (knownSource && knownSource.length !== mask.length)
  )
    throw new Error('Wrong candidate volume shape.');
  return references.map((section) => {
    if (section.sourceGrid !== grid.sourceGrid) throw new Error('Cannot compare unrelated acquired grids.');
    const { columns, rows, origin } = section.golden.section;
    const slice = new Uint8Array(columns * rows);
    const valid = knownSource && (section.golden.section.valid?.slice() ?? new Uint8Array(slice.length).fill(1));
    let definiteInsideOutsideDomain = 0;
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const point = [0, 0, 0];
        point[section.fixedAxis] = section.fixedIndex;
        point[section.acrossAxis] = origin[0] + column;
        point[section.verticalAxis] = origin[1] + row;
        const local = point.map((coordinate, axis) => coordinate - grid.origin[axis]!);
        if (local.every((coordinate, axis) => coordinate >= 0 && coordinate < grid.dims[axis]!)) {
          const sourceIndex = (local[2]! * grid.dims[1] + local[1]!) * grid.dims[0] + local[0]!;
          slice[row * columns + column] = mask[sourceIndex]!;
          if (valid) valid[row * columns + column] &&= knownSource![sourceIndex]!;
        } else if (section.golden.confidence[row * columns + column] === 1) definiteInsideOutsideDomain++;
      }
    // Missing samples inside the input are unknown; reviewed anatomy beyond its domain remains unreachable, not unknown.
    const golden = valid ? rasterizeGoldenSection({ ...section.golden.section, valid }) : section.golden;
    const metrics = evaluateGoldenSection(golden, slice);
    const inside = metrics.full.truePositive + metrics.full.falseNegative;
    return {
      id: section.id,
      ...metrics,
      definiteInsideOutsideDomain,
      maximumPossibleRecallFromDomain: inside ? 1 - definiteInsideOutsideDomain / inside : null,
      failures: goldenSectionFailures(metrics),
    };
  });
}

/** Portable opt-in runner. Source/annotation files stay private; only pixels and independent gestures reach the solver. */
export async function runGoldenCorpus(
  loaded: ReturnType<typeof readGoldenCorpusManifest>,
  solver: (input: SeededVolumeInput) => Promise<SeededVolumeResult>,
  options: { solverHash: string; onCase?: (caseId: string, mask: Uint8Array) => void | Promise<void> },
) {
  if (loaded.solverHash !== options.solverHash) throw new Error('The solver changed after corpus admission.');
  const scorerHash = goldenScorerHash();
  // Check every reference before running any case: a contradictory label is a benchmark failure, not a solver error.
  const prepared = loaded.manifest.cases.map((entry) => ({
    entry,
    references: readReferences(loaded.directory, entry, loaded.manifest.split),
  }));
  if (goldenCrossPlaneConflicts(prepared.flatMap(({ references }) => references)).length)
    throw new Error('Source-only golden annotations contradict one another at a shared native voxel.');
  const cases = [],
    solverFailures = [];
  for (const { entry, references } of prepared) {
    const bytes = sourcePins(loaded.directory, entry.pixels),
      count = entry.dims.reduce((total, size) => total * size, 1);
    if (bytes.length !== count * 4) throw new Error('The pinned native Float32 source shape changed.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const volume = Float32Array.from({ length: count }, (_, index) => view.getFloat32(index * 4, true));
    const observedSupport = entry.support ? new Uint8Array(sourcePins(loaded.directory, entry.support)) : undefined;
    if (observedSupport && observedSupport.length !== count)
      throw new Error('The pinned acquired-support shape changed.');
    const knownSource = Uint8Array.from(volume, (value, index) =>
      Number(Number.isFinite(value) && (!observedSupport || Boolean(observedSupport[index]))),
    );
    const input: SeededVolumeInput = {
      volume,
      observedSupport,
      dims: [...entry.dims],
      voxelSizeMm: [...entry.spacingMm],
      foreground: Uint32Array.from(entry.foreground),
      background: Uint32Array.from(entry.background),
      bounds: entry.bounds && { min: { ...entry.bounds.min }, max: { ...entry.bounds.max } },
    };
    const before = [volume, observedSupport, input.foreground, input.background].map(
      (array) => array && pixelFingerprint(array),
    );
    const geometryBefore = JSON.stringify([input.dims, input.voxelSizeMm, input.bounds]);
    const started = performance.now();
    let result: SeededVolumeResult;
    try {
      result = await solver(input);
    } catch (error) {
      // Keep the failed case visible while collecting independent evidence from the remaining cases.
      solverFailures.push({
        id: entry.id,
        sourceHash: entry.pixels.sha256,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const durationMs = performance.now() - started,
      mask = new Uint8Array(count);
    for (const index of result.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= count)
        throw new Error('The solver returned invalid source indices.');
      if (mask[index]) throw new Error('The solver returned duplicate source indices.');
      mask[index] = 1;
    }
    const after = [input.volume, input.observedSupport, input.foreground, input.background].map(
      (array) => array && pixelFingerprint(array),
    );
    const invariants = {
      sourceAndMarksUnchanged:
        before.every((hash, index) => hash === after[index]) &&
        geometryBefore === JSON.stringify([input.dims, input.voxelSizeMm, input.bounds]),
      missingForeground: entry.foreground.reduce((sum, index) => sum + Number(!mask[index]), 0),
      selectedBackground: entry.background.reduce((sum, index) => sum + Number(Boolean(mask[index])), 0),
      unsupportedSelected: result.indices.reduce(
        (sum, index) =>
          sum + Number(!Number.isFinite(volume[index]) || Boolean(observedSupport && !observedSupport[index])),
        0,
      ),
    };
    const topology = nativeMaskTopology(mask, entry.dims, Uint32Array.from(entry.foreground));
    const scores = scoreGoldenVolumeMask(mask, entry, references, knownSource);
    const failures = scores.flatMap((score) => score.failures.map((reason) => ({ section: score.id, reason })));
    if (
      !invariants.sourceAndMarksUnchanged ||
      invariants.missingForeground ||
      invariants.selectedBackground ||
      invariants.unsupportedSelected ||
      topology.orphanVoxels
    )
      failures.push({ section: 'volume', reason: 'source, hard-mark, support, or seeded-connectivity invariant' });
    await options.onCase?.(entry.id, mask.slice());
    cases.push({
      id: entry.id,
      sourceGrid: entry.sourceGrid,
      sourceHash: entry.pixels.sha256,
      referenceHashes: entry.references.map((reference) => reference.sha256),
      referenceClassifications: entry.references.map((reference) => reference.classification),
      durationMs,
      maskHash: pixelFingerprint(mask),
      selected: result.indices.length,
      invariants,
      topology,
      scores,
      failures,
    });
  }
  return {
    manifestHash: loaded.hash,
    scorerHash,
    solverHash: options.solverHash,
    split: loaded.manifest.split,
    description: loaded.manifest.description,
    interpretation:
      'Accuracy comparisons require explicit synthetic or independently reviewed anatomy authority. No user-approved example or disputed engineering reference is admitted; cross-sections are not dense clinical 3D truth.',
    totalCases: loaded.manifest.cases.length,
    cases,
    solverFailures,
    failedCases: [
      ...cases.filter((entry) => entry.failures.length).map((entry) => entry.id),
      ...solverFailures.map((entry) => entry.id),
    ],
  };
}
