/** These solver comparisons target the retired diagnostic, not shipped learned-model acceptance. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOutputPlaneGrid, outputGridPixelToWorld } from '../src/utils/outputPlaneGrid';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { segmentSeededVolume, type SeededVolumeInput } from './helpers/legacySeededVolume';
import { physicalBrushIndices } from '../src/utils/segmentation/selectionEditing';
import {
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
  writeAlignmentComparisonSheet,
} from './helpers/alignmentRealCorpus';
import { cropCorpusPixels, pixelFingerprint } from './helpers/interSliceCorpus';
import {
  auditNativeAppearance,
  decodeSegmentationNativeFrame,
  evaluateOutsideBoundaryProbes,
  loadSegmentationNativeRegion,
  nativeAnchorRegressions,
  nativeMaskTopology,
  nativeOrthogonalSection,
  physicalAspectSection,
  segmentationDisplayWindow,
  type NativeSegmentationCrop,
  type OutsideBoundaryProbes,
} from './helpers/segmentationNativeCorpus';

const corpusRoot = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_DIR;
const runCandidate = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_CANDIDATE === '1';
const experimentalSolverPath = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_SOLVER_PATH;
const requireByteEquivalence = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_EQUIVALENT === '1';
const outputDirectory = resolve('tmp/segmentation-accuracy');
const examinations = (process.env.MIRAVIEWER_SEGMENTATION_NATIVE_EXAMS ?? '1').split(',').map(Number);
const axialLandmarks = new Map([
  [1, 100],
  [2, 98],
  [3, 96],
  [4, 96],
]);

type ApprovedNativeMarks = {
  examination: number;
  studyHash: string;
  seriesHash: string;
  baselineCoreHash: string;
  crop: NativeSegmentationCrop;
  radiusMm: number;
  insideStrokes: { slice: number; start: [number, number]; end: [number, number] }[];
  optionalOutside: { slice: number; points: [number, number][]; radiusMm?: number };
  withheldAnchors: { slices: number[]; inside: [number, number][]; outside: [number, number][]; radiusMm: number };
};

function paintContour(pixels: Float32Array, mask: Uint8Array, columns: number, rows: number, value: number) {
  for (let row = 1; row < rows - 1; row++)
    for (let column = 1; column < columns - 1; column++) {
      const at = row * columns + column;
      if (mask[at] && (!mask[at - 1] || !mask[at + 1] || !mask[at - columns] || !mask[at + columns]))
        pixels[at] = value;
    }
}

describe('native segmentation validation oracles', () => {
  it('rejects sparse inside loss and new outside leakage without substituting mask size for truth', () => {
    const inside = { slice: 2, kind: 'inside' as const, point: [3, 4], voxels: 3, selected: 2 };
    const outside = { slice: 2, kind: 'outside' as const, point: [5, 6], voxels: 3, selected: 1 };
    expect(
      nativeAnchorRegressions(
        [
          { ...inside, selected: 3 },
          { ...outside, selected: 0 },
        ],
        [inside, outside],
      ),
    ).toEqual([]);
    expect(
      nativeAnchorRegressions(
        [
          { ...inside, selected: 1 },
          { ...outside, selected: 2 },
        ],
        [inside, outside],
      ).map((failure) => failure.reason),
    ).toEqual(['lost previously retained inside tissue', 'new outside leakage']);
    expect(nativeAnchorRegressions([{ ...inside, voxels: 2 }], [inside])[0]?.reason).toBe(
      'changed frozen anchor coverage',
    );
    expect(nativeAnchorRegressions([], [inside])[0]?.reason).toBe('changed frozen anchor coverage');
  });

  it('distinguishes seeded six-connected tissue from an orphan and counts crop faces independently', () => {
    const mask = new Uint8Array(36);
    for (const index of [0, 17, 18]) mask[index] = 1;
    const before = pixelFingerprint(mask);
    const result = nativeMaskTopology(mask, [4, 3, 3], Uint32Array.of(17));
    expect(result.components).toEqual([
      { voxels: 2, markedForeground: 1 },
      { voxels: 1, markedForeground: 0 },
    ]);
    expect(result.orphanVoxels).toBe(1);
    expect(result.selectedBoundaryVoxels).toBe(1);
    expect(result.selectedBoundaryBandVoxels).toBe(3);
    expect(result.faces).toEqual({ xMin: 1, xMax: 0, yMin: 1, yMax: 0, zMin: 1, zMax: 0 });
    expect(result.selectedByDepth).toEqual([1, 2, 0]);
    expect(pixelFingerprint(mask)).toBe(before);
  });

  it('extracts raw source-grid sections without changing or aliasing source data', () => {
    const volume = {
      data: Float32Array.from({ length: 24 }, (_, index) => index + 0.25),
      dims: [4, 3, 2] as [number, number, number],
      voxelSizeMm: [0.5, 0.75, 2] as [number, number, number],
    };
    const mask = Uint8Array.from(volume.data, (value) => Math.floor(value) % 2);
    const before = [pixelFingerprint(volume.data), pixelFingerprint(mask)];
    const coronal = nativeOrthogonalSection(volume, mask, 'coronal', 1);
    const sagittal = nativeOrthogonalSection(volume, mask, 'sagittal', 2);
    expect([...coronal.pixels]).toEqual([4.25, 5.25, 6.25, 7.25, 16.25, 17.25, 18.25, 19.25]);
    expect([...coronal.labels]).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(coronal.spacing).toEqual([0.5, 2]);
    expect([...sagittal.pixels]).toEqual([2.25, 6.25, 10.25, 14.25, 18.25, 22.25]);
    expect(sagittal.spacing).toEqual([0.75, 2]);
    coronal.pixels.fill(-1);
    coronal.labels.fill(0);
    expect([pixelFingerprint(volume.data), pixelFingerprint(mask)]).toEqual(before);
    expect(() => nativeOrthogonalSection(volume, mask, 'coronal', 3)).toThrow(/outside/);
  });

  it('letterboxes anisotropic native cells without stretching, smoothing, or changing their signal', () => {
    const source = Float32Array.of(1, 2, 3, 4);
    const before = pixelFingerprint(source);
    const result = physicalAspectSection(source, 2, 2, [1, 2], -1);
    const sample = (x: number, y: number) => result[y * 512 + x];
    expect([sample(127, 0), sample(128, 0), sample(255, 0), sample(256, 0), sample(383, 0), sample(384, 0)]).toEqual([
      -1, 1, 1, 2, 2, -1,
    ]);
    expect([sample(128, 255), sample(128, 256), sample(383, 511)]).toEqual([1, 3, 4]);
    expect([...new Set(result)].sort((first, second) => first - second)).toEqual([-1, 1, 2, 3, 4]);
    expect(pixelFingerprint(source)).toBe(before);
  });
});

describe.skipIf(!requireByteEquivalence)('private baseline-preserving segmentation equivalence', () => {
  it('matches original outputs and invalid-input errors on 100 deterministic small-domain cases', async () => {
    const baselinePath = join(outputDirectory, 'baseline-seededVolume.ts');
    expect(pixelFingerprint(readFileSync(baselinePath))).toBe(
      '8cc742ba8be8fb5d298f94e6281894f292ea192ce4f22ea6fb6d58e740a2dd2a',
    );
    const solverPath = resolve('tests/helpers/legacySeededVolume.ts');
    const solverHash = pixelFingerprint(readFileSync(solverPath));
    expect(solverHash).toBe(process.env.MIRAVIEWER_SEGMENTATION_CANDIDATE_SHA);
    const original: typeof segmentSeededVolume = (await import(/* @vite-ignore */ pathToFileURL(baselinePath).href))
      .segmentSeededVolume;
    let randomState = 0x7b3b946d;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x100000000;
    };
    const shapes: [number, number, number][] = [
      [1, 1, 1],
      [1, 1, 7],
      [1, 5, 1],
      [7, 1, 1],
      [1, 5, 6],
      [6, 1, 5],
      [5, 6, 1],
      [5, 7, 6],
      [8, 7, 9],
      [7, 8, 10],
    ];
    const spacings: [number, number, number][] = [
      [1, 1, 1],
      [0.4, 0.7, 1.8],
      [3, 0.35, 2],
      [0.001, 2, 3],
    ];
    const cases: { name: string; input: SeededVolumeInput; valid: boolean }[] = [];
    for (let caseIndex = 0; caseIndex < 80; caseIndex++) {
      const dims = [...shapes[caseIndex % shapes.length]!] as [number, number, number];
      const [nx, ny, nz] = dims;
      const count = nx * ny * nz;
      const mode = Math.floor(caseIndex / shapes.length);
      const constant = caseIndex % 3 === 0;
      const input: SeededVolumeInput = {
        volume: Float32Array.from({ length: count }, (_, index) =>
          constant ? -4 : Math.fround((index % 7) * 0.7 + random() * 0.3 - 2),
        ),
        observedSupport: mode === 1 ? undefined : new Uint8Array(count).fill(1),
        dims,
        voxelSizeMm: [...spacings[caseIndex % spacings.length]!] as [number, number, number],
        foreground: new Uint32Array(),
        background: new Uint32Array(),
      };
      const minimum = dims.map((dimension) => (mode % 2 && dimension >= 5 ? 1 : 0));
      const maximum = dims.map((dimension, axis) => dimension - 1 - minimum[axis]!);
      if (mode % 2)
        input.bounds = {
          min: { x: minimum[0]!, y: minimum[1]!, z: minimum[2]! },
          max: { x: maximum[0]!, y: maximum[1]!, z: maximum[2]! },
        };
      const center = minimum.map((value, axis) => Math.floor((value + maximum[axis]!) / 2));
      const centerIndex = (center[2]! * ny + center[1]!) * nx + center[0]!;
      const cornerIndex = (minimum[2]! * ny + minimum[1]!) * nx + minimum[0]!;
      for (let index = 0; index < count; index++) {
        const x = index % nx,
          y = Math.floor(index / nx) % ny,
          z = Math.floor(index / (nx * ny));
        const shell =
          (nx > 1 && (x === 0 || x === nx - 1)) ||
          (ny > 1 && (y === 0 || y === ny - 1)) ||
          (nz > 1 && (z === 0 || z === nz - 1));
        if (
          input.observedSupport &&
          ((mode === 2 && shell) ||
            (mode === 3 && random() < 0.2) ||
            (mode === 6 && x === center[0] && z === minimum[2]))
        )
          input.observedSupport[index] = 0;
        if ((mode === 5 && shell) || (mode === 7 && random() < 0.15))
          input.volume[index] = index % 3 === 0 ? NaN : index % 3 === 1 ? Infinity : -Infinity;
      }
      const cavity = centerIndex + (nx > 2 ? 1 : ny > 2 ? nx : nx * ny);
      if (mode === 4 && cavity < count && cavity !== cornerIndex) input.observedSupport![cavity] = 0;
      input.foreground = caseIndex % 5 === 0 ? Uint32Array.of(centerIndex, centerIndex) : Uint32Array.of(centerIndex);
      if (mode % 2 && cornerIndex !== centerIndex) input.background = Uint32Array.of(cornerIndex);
      for (const index of [...input.foreground, ...input.background]) {
        input.volume[index] = constant ? -4 : 0.5;
        if (input.observedSupport) input.observedSupport[index] = 1;
      }
      cases.push({ name: `valid-${caseIndex}-mode${mode}-${dims.join('x')}`, input, valid: true });
    }
    const invalidate: ((input: SeededVolumeInput) => void)[] = [
      (input) => {
        input.dims[0] = 0;
      },
      (input) => {
        input.dims[0] = 5.5;
      },
      (input) => {
        input.volume = input.volume.slice(1);
      },
      (input) => {
        input.observedSupport = input.observedSupport!.slice(1);
      },
      (input) => {
        input.voxelSizeMm[0] = 0;
      },
      (input) => {
        input.voxelSizeMm[1] = NaN;
      },
      (input) => {
        input.voxelSizeMm[2] = Infinity;
      },
      (input) => {
        input.foreground = new Uint32Array();
      },
      (input) => {
        input.foreground = Uint32Array.of(125);
      },
      (input) => {
        input.observedSupport![62] = 0;
      },
      (input) => {
        input.volume[62] = NaN;
      },
      (input) => {
        input.background = Uint32Array.of(62);
      },
      (input) => {
        input.bounds!.min.x = -1;
      },
      (input) => {
        input.bounds!.max.x = 5;
      },
      (input) => {
        input.bounds!.min.x = 3;
        input.bounds!.max.x = 2;
      },
      (input) => {
        input.bounds!.min.x = 0.5;
      },
      (input) => {
        input.bounds!.max.x = 1;
      },
      (input) => {
        input.background = Uint32Array.of(125);
      },
      (input) => {
        input.background = Uint32Array.of(0);
        input.volume[0] = Infinity;
      },
      (input) => {
        input.background = Uint32Array.of(0);
        input.observedSupport![0] = 0;
      },
    ];
    for (const [index, change] of invalidate.entries()) {
      const input: SeededVolumeInput = {
        volume: new Float32Array(125).fill(1),
        observedSupport: new Uint8Array(125).fill(1),
        dims: [5, 5, 5],
        voxelSizeMm: [0.5, 1, 2],
        foreground: Uint32Array.of(62),
        background: new Uint32Array(),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
      };
      change(input);
      cases.push({ name: `invalid-${index}`, input, valid: false });
    }
    const receipts = [];
    for (const testCase of cases) {
      const { input } = testCase;
      const before = [
        pixelFingerprint(input.volume),
        input.observedSupport && pixelFingerprint(input.observedSupport),
        pixelFingerprint(input.foreground),
        pixelFingerprint(input.background),
        JSON.stringify([input.dims, input.voxelSizeMm, input.bounds]),
      ];
      const execute = async (solver: typeof segmentSeededVolume) => {
        try {
          const result = await solver(input);
          return {
            ok: true,
            indices: Array.from(result.indices),
            bounds: result.bounds,
            boundaryCount: result.boundaryCount,
            domainVoxels: result.domainVoxels,
          };
        } catch (error) {
          const failure = error as Error;
          return { ok: false, name: failure.name, message: failure.message };
        }
      };
      const expected = await execute(original);
      const actual = await execute(segmentSeededVolume);
      expect(actual, testCase.name).toEqual(expected);
      expect(actual.ok, testCase.name).toBe(testCase.valid);
      expect(
        [
          pixelFingerprint(input.volume),
          input.observedSupport && pixelFingerprint(input.observedSupport),
          pixelFingerprint(input.foreground),
          pixelFingerprint(input.background),
          JSON.stringify([input.dims, input.voxelSizeMm, input.bounds]),
        ],
        testCase.name,
      ).toEqual(before);
      receipts.push({
        name: testCase.name,
        valid: testCase.valid,
        dims: input.dims,
        spacing: input.voxelSizeMm,
        roi: input.bounds,
        outcome: actual.ok ? 'exact output equality' : 'exact error equality',
      });
    }
    expect(pixelFingerprint(readFileSync(solverPath))).toBe(solverHash);
    writeFileSync(
      join(outputDirectory, `equivalence-fuzz-${solverHash.slice(0, 8)}.json`),
      JSON.stringify(
        {
          solverHash,
          baselineHash: pixelFingerprint(readFileSync(baselinePath)),
          randomSeed: '0x7b3b946d',
          validCases: 80,
          invalidCases: 20,
          inputsUnchanged: true,
          receipts,
        },
        null,
        2,
      ),
    );
  }, 30_000);
});

describe.skipIf(!corpusRoot)('private native MRI segmentation validation (no clinical tumor truth)', () => {
  it.skipIf(!process.env.MIRAVIEWER_SEGMENTATION_NATIVE_APPEARANCE_HASH).each(examinations)(
    'audits frozen native E%i marked appearance without running a solver',
    async (examination) => {
      const hash = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_APPEARANCE_HASH!;
      expect(hash).toBe('fc6cd4ad9886a50b331353a689fe304c0a89baa9a138d4d140c1fe324f3cc6f7');
      const prefix = `e${examination}-candidate-${hash.slice(0, 8)}`;
      const receipt = JSON.parse(readFileSync(join(outputDirectory, `${prefix}.json`), 'utf8'));
      expect(receipt.solverHash).toBe(hash);
      const marksBytes = readFileSync(join(outputDirectory, `e${examination}-approved-marks.json`));
      const marks = JSON.parse(marksBytes.toString()) as ApprovedNativeMarks;
      expect(pixelFingerprint(marksBytes)).toBe(receipt.approvedMarksHash);
      const source = inspectAlignmentCorpus(corpusRoot!, {
        studyOrdinals: [examination],
        includeExtensionlessDicom: true,
      }).find((candidate) => pixelFingerprint(Buffer.from(candidate.seriesUid)) === marks.seriesHash)!;
      expect(pixelFingerprint(Buffer.from(source.studyUid))).toBe(marks.studyHash);
      const native = await loadSegmentationNativeRegion(source, marks.crop, loadAlignmentLosslessCodec());
      expect(native.dataHash).toBe(receipt.nativeDataHash);
      expect(native.supportHash).toBe(receipt.nativeSupportHash);
      expect(native.sourceHashes).toEqual(receipt.sourceHashes);
      const primary = receipt.receipts.find((item: { variant: string }) => item.variant === 'two-inside');
      const mask = new Uint8Array(readFileSync(join(outputDirectory, `${prefix}-two-inside.mask.u8`)));
      expect(pixelFingerprint(mask)).toBe(primary.maskHash);
      const point = ([x, y]: readonly number[], slice: number) => ({
        x: x! - marks.crop.left,
        y: y! - marks.crop.top,
        z: slice - marks.crop.firstSlice,
      });
      const disk = (coordinates: readonly number[], slice: number, radius: number) => {
        const center = point(coordinates, slice);
        return physicalBrushIndices(native.volume, 'axial', center, center, radius);
      };
      const strokes = marks.insideStrokes.map((stroke) =>
        physicalBrushIndices(
          native.volume,
          'axial',
          point(stroke.start, stroke.slice),
          point(stroke.end, stroke.slice),
          marks.radiusMm,
        ),
      );
      const joined = (groups: readonly Uint32Array[]) =>
        Uint32Array.from(new Set(groups.flatMap((group) => [...group])));
      const foreground = joined(strokes);
      const background = joined(
        marks.optionalOutside.points.map((coordinates) =>
          disk(coordinates, marks.optionalOutside.slice, marks.optionalOutside.radiusMm ?? marks.radiusMm),
        ),
      );
      expect(foreground).toHaveLength(primary.foreground);
      const anchors = marks.withheldAnchors.slices.flatMap((slice) =>
        marks.withheldAnchors.inside.map((coordinates) => ({
          label: `inside-z${slice}-x${coordinates[0]}-y${coordinates[1]}`,
          indices: disk(coordinates, slice, marks.withheldAnchors.radiusMm),
        })),
      );
      const allInside = joined(anchors.map((anchor) => anchor.indices));
      const groups = [
        ...strokes.map((indices, index) => ({ label: `foreground-stroke-${index + 1}`, indices })),
        { label: 'held-inside-preserved', indices: allInside.filter((index) => Boolean(mask[index])) },
        { label: 'held-inside-omitted', indices: allInside.filter((index) => !mask[index]) },
        ...anchors.flatMap((anchor) => [
          { label: `${anchor.label}-preserved`, indices: anchor.indices.filter((index) => Boolean(mask[index])) },
          { label: `${anchor.label}-omitted`, indices: anchor.indices.filter((index) => !mask[index]) },
        ]),
      ];
      const diagnostic = auditNativeAppearance(native.volume, foreground, background, groups);
      expect(pixelFingerprint(native.volume.data)).toBe(native.dataHash);
      expect(pixelFingerprint(native.volume.observedSupport!)).toBe(native.supportHash);
      expect(pixelFingerprint(mask)).toBe(primary.maskHash);
      const result = {
        examination: `E${examination}`,
        modelHash: hash,
        solverRerun: false,
        clinicallyLabeledTumorMask: false,
        interpretation:
          'Diagnostic only. Context is unmarked, not labeled normal tissue; model affinities are not clinical probabilities. Frozen original values and labels are unchanged.',
        approvedMarksHash: pixelFingerprint(marksBytes),
        nativeDataHash: native.dataHash,
        nativeSupportHash: native.supportHash,
        maskHash: primary.maskHash,
        ...diagnostic,
      };
      writeFileSync(
        join(outputDirectory, `e${examination}-${hash.slice(0, 8)}-appearance.json`),
        JSON.stringify(result, null, 2),
      );
      console.info(
        '[native-appearance-diagnostic]',
        JSON.stringify({
          examination,
          normalization: diagnostic.normalization,
          foreground: diagnostic.foreground,
          heldInside: diagnostic.groups.filter((group) => group.label.startsWith('held-inside')),
        }),
      );
    },
    30_000,
  );

  it.skipIf(!process.env.MIRAVIEWER_SEGMENTATION_NATIVE_FOCUS_HASH)(
    'reviews the saved native E1 superior focus without rerunning either solver',
    async () => {
      const hash = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_FOCUS_HASH!;
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      const prefix = `e1-candidate-${hash.slice(0, 8)}`;
      const receipt = JSON.parse(readFileSync(join(outputDirectory, `${prefix}.json`), 'utf8'));
      const baseline = JSON.parse(readFileSync(join(outputDirectory, 'e1-baseline.json'), 'utf8'));
      expect(receipt.solverHash).toBe(hash);
      expect(receipt.nativeDataHash).toBe(baseline.nativeDataHash);
      const marks = JSON.parse(
        readFileSync(join(outputDirectory, 'e1-approved-marks.json'), 'utf8'),
      ) as ApprovedNativeMarks;
      const source = inspectAlignmentCorpus(corpusRoot!, {
        studyOrdinals: [1],
        includeExtensionlessDicom: true,
      }).find((candidate) => pixelFingerprint(Buffer.from(candidate.seriesUid)) === marks.seriesHash)!;
      expect(pixelFingerprint(Buffer.from(source.studyUid))).toBe(marks.studyHash);
      const savedMask = (name: string, saved: typeof receipt) => {
        const mask = new Uint8Array(readFileSync(join(outputDirectory, `${name}-two-inside.mask.u8`)));
        expect(pixelFingerprint(mask)).toBe(
          saved.receipts.find((item: { variant: string }) => item.variant === 'two-inside').maskHash,
        );
        expect(mask).toHaveLength(
          marks.crop.width * marks.crop.height * (marks.crop.lastSlice - marks.crop.firstSlice + 1),
        );
        return mask;
      };
      const masks = [savedMask('e1-baseline', baseline), savedMask(prefix, receipt)];
      const indices = [88, 90, 92];
      const codec = loadAlignmentLosslessCodec();
      const decoded = [];
      for (const index of indices) decoded.push(await decodeSegmentationNativeFrame(source.frames[index]!, codec));
      const { width, height, firstSlice } = marks.crop;
      const window = receipt.displayWindow as { lower: number; upper: number; center: number; width: number };
      const tiles = (['SRC', 'EDGE0', 'EDGE1', 'REGION'] as const).flatMap((kind) =>
        decoded.map((frame, offset) => {
          const slice = indices[offset]!;
          const mask = masks[kind === 'EDGE0' ? 0 : 1]!.subarray(
            (slice - firstSlice) * width * height,
            (slice - firstSlice + 1) * width * height,
          );
          const pixels =
            kind === 'REGION'
              ? Float32Array.from(mask)
              : cropCorpusPixels(frame.pixels, source.columns, marks.crop, frame.invert);
          if (kind === 'EDGE0' || kind === 'EDGE1')
            paintContour(pixels, mask, width, height, frame.invert ? -window.lower : window.upper);
          return {
            label: `E1 AX ${slice} ${kind}`,
            pixels,
            columns: width,
            rows: height,
            windowCenter: kind === 'REGION' ? 0.5 : frame.invert ? -window.center : window.center,
            windowWidth: kind === 'REGION' ? 1 : window.width,
          };
        }),
      );
      const image = writeAlignmentComparisonSheet(outputDirectory, `${prefix}-superior-focus`, tiles, 3);
      const sourceHashes = decoded.map((frame, offset) => {
        const index = indices[offset]!;
        const expected = receipt.sourceHashes.find((item: { index: number }) => item.index === index);
        expect({ index, file: frame.fileHash, pixels: frame.pixelHash, support: frame.supportHash }).toEqual(expected);
        expect(pixelFingerprint(frame.pixels)).toBe(frame.pixelHash);
        expect(pixelFingerprint(readFileSync(source.frames[index]!.path))).toBe(frame.fileHash);
        return expected;
      });
      writeFileSync(
        join(outputDirectory, `${prefix}-superior-focus.json`),
        JSON.stringify(
          {
            solverHash: hash,
            solverRerun: false,
            purpose: 'Review a source-visible additional bright focus; no new inference marks or clinical annotation.',
            sourceHashes,
            sourceIndices: indices,
            crop: marks.crop,
            comparisonImage: basename(image),
            maskHashes: masks.map(pixelFingerprint),
            originalSourcesUnchanged: true,
            clinicallyLabeledTumorMask: false,
          },
          null,
          2,
        ),
      );
    },
    30_000,
  );

  it.each(examinations)(
    'captures anonymous E%i source context before approving any marks',
    async (examination) => {
      if (!axialLandmarks.has(examination)) throw new Error('Use a resident anonymous examination 1–4.');
      const sources = inspectAlignmentCorpus(corpusRoot!, {
        studyOrdinals: [examination],
        includeExtensionlessDicom: true,
      });
      const source = sources
        .filter((candidate) => candidate.plane === 'AX' && /flair/i.test(candidate.contrast))
        .sort((first, second) => second.frames.length - first.frames.length)[0];
      if (!source) throw new Error('The resident axial FLAIR source is missing.');
      const center = axialLandmarks.get(examination)!;
      const indices = [-2, 0, 2].map((offset) => center + offset);
      const codec = loadAlignmentLosslessCodec();
      const decoded = [];
      for (const index of indices) decoded.push(await decodeSegmentationNativeFrame(source.frames[index]!, codec));
      const geometry = getSliceGeometryFromInstance(source.frames[center]!);
      const width = Math.min(source.columns, Math.ceil(80 / geometry.colSpacingMm));
      const height = Math.min(source.rows, Math.ceil(80 / geometry.rowSpacingMm));
      const region = {
        left: Math.max(0, Math.min(source.columns - width, Math.round((source.columns - 1) * 0.503 - width / 2))),
        top: Math.max(0, Math.min(source.rows - height, Math.round((source.rows - 1) * 0.453 - height / 2))),
        width,
        height,
      };
      const displayWindow = segmentationDisplayWindow(
        decoded.map((frame, index) => ({ ...frame, positionMm: source.frames[indices[index]!]!.positionMm })),
        examination !== 1,
      );
      const tile = (frame: (typeof decoded)[number], index: number, cropped: boolean, grid: boolean) => {
        const crop = cropped ? region : { left: 0, top: 0, width: source.columns, height: source.rows };
        const pixels = cropCorpusPixels(frame.pixels, source.columns, crop, frame.invert);
        if (grid)
          for (let row = 0; row < crop.height; row++)
            for (let column = 0; column < crop.width; column++) {
              if ((row + crop.top) % 20 !== 0 && (column + crop.left) % 20 !== 0) continue;
              const at = row * crop.width + column;
              pixels[at] = pixels[at]! * 0.75 + (frame.invert ? -displayWindow.lower : displayWindow.upper) * 0.25;
            }
        return {
          label: `E${examination} AX ${indices[index]} ${grid ? 'GRID20' : cropped ? 'ROI80' : 'SCAN'}`,
          pixels,
          rows: crop.height,
          columns: crop.width,
          windowCenter: frame.invert ? -displayWindow.center : displayWindow.center,
          windowWidth: displayWindow.width,
        };
      };
      const images = [
        ['source', false, false],
        ['roi80mm', true, false],
        ['roi80mm-grid', true, true],
      ].map(([suffix, cropped, grid]) =>
        basename(
          writeAlignmentComparisonSheet(
            outputDirectory,
            `e${examination}-ax-${suffix}`,
            decoded.map((frame, index) => tile(frame, index, Boolean(cropped), Boolean(grid))),
            3,
          ),
        ),
      );
      for (const [offset, frame] of decoded.entries()) {
        expect(frame.pixels).toHaveLength(source.rows * source.columns);
        expect(pixelFingerprint(frame.pixels)).toBe(frame.pixelHash);
        expect(pixelFingerprint(frame.valid)).toBe(frame.supportHash);
        expect(pixelFingerprint(readFileSync(source.frames[indices[offset]!]!.path))).toBe(frame.fileHash);
      }
      const receipt = {
        stage: 'source-context-only',
        clinicallyLabeledTumorMask: false,
        marksApproved: false,
        examination: `E${examination}`,
        plane: 'AX',
        sourceIndices: indices,
        studyHash: pixelFingerprint(Buffer.from(source.studyUid)),
        seriesHash: pixelFingerprint(Buffer.from(source.seriesUid)),
        dateHash: decoded[0]!.studyDateHash,
        sourceKind: decoded[0]!.sourceKind,
        nativeRows: source.rows,
        nativeColumns: source.columns,
        rowSpacingMm: geometry.rowSpacingMm,
        columnSpacingMm: geometry.colSpacingMm,
        centerSpacingMm: source.frames[center + 1]!.positionMm - source.frames[center]!.positionMm,
        region,
        physicalRegionMm: [width * geometry.colSpacingMm, height * geometry.rowSpacingMm],
        provisionalContextCenter: outputGridPixelToWorld(
          buildOutputPlaneGrid(source.frames[center]!),
          (source.rows - 1) * 0.453,
          (source.columns - 1) * 0.503,
        ),
        gridGuide:
          'Grid lines are absolute native row/column multiples of 20; crop left/top are native coordinates. No seed or predicted mask is painted. Tiles are uniformly enlarged for viewing only.',
        displayWindow,
        sourceHashes: decoded.map((frame, offset) => ({
          index: indices[offset],
          file: frame.fileHash,
          pixels: frame.pixelHash,
          support: frame.supportHash,
        })),
        originalSourcesUnchanged: true,
        images,
      };
      writeFileSync(join(outputDirectory, `e${examination}-source-context.json`), JSON.stringify(receipt, null, 2));
      console.info('[segmentation-source-context]', JSON.stringify(receipt));
    },
    30_000,
  );

  it.skipIf(process.env.MIRAVIEWER_SEGMENTATION_NATIVE_BASELINE !== '1' && !runCandidate).each(examinations)(
    'records source-preserving proposals for root-approved E%i native strokes',
    async (examination) => {
      const marksPath = join(outputDirectory, `e${examination}-approved-marks.json`);
      const marksBytes = readFileSync(marksPath);
      const marks = JSON.parse(marksBytes.toString()) as ApprovedNativeMarks;
      const baselinePath = join(outputDirectory, 'baseline-seededVolume.ts');
      expect(pixelFingerprint(readFileSync(baselinePath))).toBe(marks.baselineCoreHash);
      const solverPath = runCandidate
        ? resolve(experimentalSolverPath ?? 'tests/helpers/legacySeededVolume.ts')
        : baselinePath;
      if (experimentalSolverPath) {
        expect(runCandidate).toBe(true);
        expect(solverPath.startsWith(outputDirectory + sep)).toBe(true);
        expect(solverPath.endsWith('.ts')).toBe(true);
      }
      const solverHash = pixelFingerprint(readFileSync(solverPath));
      if (runCandidate) {
        expect(
          process.env.MIRAVIEWER_SEGMENTATION_CANDIDATE_SHA,
          'Pin the parent-approved candidate before real-data evaluation',
        ).toBe(solverHash);
      }
      const segment: typeof segmentSeededVolume =
        runCandidate && !experimentalSolverPath
          ? segmentSeededVolume
          : (await import(/* @vite-ignore */ pathToFileURL(solverPath).href)).segmentSeededVolume;
      const resultPrefix = `e${examination}-${runCandidate ? `candidate-${solverHash.slice(0, 8)}` : 'baseline'}`;
      const baselineReceipt = runCandidate
        ? JSON.parse(readFileSync(join(outputDirectory, `e${examination}-baseline.json`), 'utf8'))
        : undefined;
      const evaluationPath = join(outputDirectory, `e${examination}-near-boundary-evaluation.json`);
      const evaluationBytes = existsSync(evaluationPath) ? readFileSync(evaluationPath) : undefined;
      const evaluation = evaluationBytes
        ? (JSON.parse(evaluationBytes.toString()) as OutsideBoundaryProbes)
        : undefined;
      const source = inspectAlignmentCorpus(corpusRoot!, {
        studyOrdinals: [marks.examination],
        includeExtensionlessDicom: true,
      }).find((candidate) => pixelFingerprint(Buffer.from(candidate.seriesUid)) === marks.seriesHash);
      expect(source).toBeDefined();
      expect(marks.examination).toBe(examination);
      expect(pixelFingerprint(Buffer.from(source!.studyUid))).toBe(marks.studyHash);
      const decodedAt = performance.now();
      const native = await loadSegmentationNativeRegion(source!, marks.crop, loadAlignmentLosslessCodec());
      const decodingMs = performance.now() - decodedAt;
      const { volume } = native;
      if (baselineReceipt) {
        expect(native.dataHash).toBe(baselineReceipt.nativeDataHash);
        expect(native.supportHash).toBe(baselineReceipt.nativeSupportHash);
        expect(pixelFingerprint(marksBytes)).toBe(baselineReceipt.approvedMarksHash);
      }
      const planeSize = volume.dims[0] * volume.dims[1];
      const locate = ([x, y]: readonly number[], slice: number, shift = 0) => ({
        x: x! - marks.crop.left + shift,
        y: y! - marks.crop.top,
        z: slice - marks.crop.firstSlice,
      });
      const stroke = (item: ApprovedNativeMarks['insideStrokes'][number], shift = 0) =>
        physicalBrushIndices(
          volume,
          'axial',
          locate(item.start, item.slice, shift),
          locate(item.end, item.slice, shift),
          marks.radiusMm,
        );
      const disk = (point: readonly number[], slice: number, radius = marks.radiusMm) =>
        physicalBrushIndices(volume, 'axial', locate(point, slice), locate(point, slice), radius);
      const joined = (arrays: Uint32Array[]) => Uint32Array.from(new Set(arrays.flatMap((array) => [...array])));
      const foreground = joined(marks.insideStrokes.map((item) => stroke(item)));
      const background = joined(
        marks.optionalOutside.points.map((point) =>
          disk(point, marks.optionalOutside.slice, marks.optionalOutside.radiusMm ?? marks.radiusMm),
        ),
      );
      const anchors = marks.withheldAnchors.slices.flatMap((slice) =>
        (['inside', 'outside'] as const).flatMap((kind) =>
          marks.withheldAnchors[kind].map((point) => ({
            slice,
            kind,
            point,
            indices: disk(point, slice, marks.withheldAnchors.radiusMm),
          })),
        ),
      );
      const originalMarks = new Set([...foreground, ...background]);
      expect(anchors.every((anchor) => [...anchor.indices].every((index) => !originalMarks.has(index)))).toBe(true);
      const availableVariants = [
        { name: 'two-inside', foreground, background: new Uint32Array() },
        { name: 'corrected', foreground, background },
        { name: 'upper-only', foreground: stroke(marks.insideStrokes[0]!), background: new Uint32Array() },
        {
          name: 'inside-shift-one-pixel',
          foreground: joined(marks.insideStrokes.map((item) => stroke(item, 1))),
          background: new Uint32Array(),
        },
      ];
      const requestedVariants = process.env.MIRAVIEWER_SEGMENTATION_NATIVE_VARIANTS?.split(',');
      if (requestedVariants) {
        expect(requestedVariants).toContain('two-inside');
        expect(requestedVariants.every((name) => availableVariants.some((variant) => variant.name === name))).toBe(
          true,
        );
        expect(new Set(requestedVariants).size).toBe(requestedVariants.length);
      }
      const variants = requestedVariants
        ? availableVariants.filter((variant) => requestedVariants.includes(variant.name))
        : availableVariants;
      const sourceIndices = [-2, 0, 2].map((offset) => marks.insideStrokes[0]!.slice + offset);
      const sourceFrames = sourceIndices.map((slice) => ({
        positionMm: slice,
        pixels: volume.data.slice(
          (slice - marks.crop.firstSlice) * planeSize,
          (slice - marks.crop.firstSlice + 1) * planeSize,
        ),
      }));
      const displayWindow = segmentationDisplayWindow(sourceFrames, examination !== 1);
      const receipts = [];
      let primary: Uint8Array | undefined;
      for (const variant of variants) {
        const input = {
          volume: volume.data,
          observedSupport: volume.observedSupport,
          dims: volume.dims,
          voxelSizeMm: volume.voxelSizeMm,
          foreground: variant.foreground,
          background: variant.background,
        };
        const before = [pixelFingerprint(input.foreground), pixelFingerprint(input.background)];
        const started = performance.now();
        const result = await segment(input);
        const durationMs = performance.now() - started;
        const mask = new Uint8Array(volume.data.length);
        expect(result.indices.every((index) => index >= 0 && index < mask.length)).toBe(true);
        for (const index of result.indices) mask[index] = 1;
        const missingForeground = variant.foreground.reduce((sum, index) => sum + Number(!mask[index]), 0);
        const selectedBackground = variant.background.reduce((sum, index) => sum + Number(Boolean(mask[index])), 0);
        const unsupported = result.indices.reduce((sum, index) => sum + Number(!volume.observedSupport![index]), 0);
        expect(missingForeground).toBe(0);
        expect(selectedBackground).toBe(0);
        expect(unsupported).toBe(0);
        expect([pixelFingerprint(input.foreground), pixelFingerprint(input.background)]).toEqual(before);
        const expected = anchors.map((anchor) => ({
          slice: anchor.slice,
          kind: anchor.kind,
          point: anchor.point,
          voxels: anchor.indices.length,
          selected: anchor.indices.reduce((sum, index) => sum + Number(Boolean(mask[index])), 0),
        }));
        let intersection = 0,
          union = 0;
        if (primary)
          for (let index = 0; index < mask.length; index++) {
            if (primary[index] || mask[index]) union++;
            if (primary[index] && mask[index]) intersection++;
          }
        else primary = mask;
        const referenceMask = runCandidate
          ? new Uint8Array(readFileSync(join(outputDirectory, `e${examination}-baseline-${variant.name}.mask.u8`)))
          : undefined;
        let byteMismatches: number | undefined;
        if (referenceMask) {
          expect(referenceMask).toHaveLength(mask.length);
          byteMismatches = 0;
          for (let index = 0; index < mask.length; index++) if (mask[index] !== referenceMask[index]) byteMismatches++;
        }
        const topology = nativeMaskTopology(mask, volume.dims, variant.foreground);
        expect(topology.components.reduce((sum, component) => sum + component.voxels, 0)).toBe(result.indices.length);
        expect(topology.components.reduce((sum, component) => sum + component.markedForeground, 0)).toBe(
          variant.foreground.length,
        );
        expect(topology.selectedBoundaryBandVoxels).toBe(result.boundaryCount);
        if (runCandidate) expect(topology.orphanVoxels).toBe(0);
        const rows = runCandidate
          ? (['source', 'reference', 'contour', 'mask'] as const)
          : (['source', 'contour', 'mask'] as const);
        const tiles = rows.flatMap((kind) =>
          sourceFrames.map((frame, offset) => {
            const slice = sourceIndices[offset]!;
            const labels = (kind === 'reference' ? referenceMask! : mask).subarray(
              (slice - marks.crop.firstSlice) * planeSize,
              (slice - marks.crop.firstSlice + 1) * planeSize,
            );
            const pixels = kind === 'mask' ? Float32Array.from(labels) : frame.pixels.slice();
            if (kind === 'contour' || kind === 'reference')
              paintContour(pixels, labels, volume.dims[0], volume.dims[1], displayWindow.upper);
            return {
              label: `E${examination} AX ${slice} ${{ source: 'SRC', reference: 'EDGE0', contour: 'EDGE1', mask: 'REGION' }[kind]}`,
              pixels,
              rows: volume.dims[1],
              columns: volume.dims[0],
              windowCenter: kind === 'mask' ? 0.5 : displayWindow.center,
              windowWidth: kind === 'mask' ? 1 : displayWindow.width,
            };
          }),
        );
        const image = writeAlignmentComparisonSheet(outputDirectory, `${resultPrefix}-${variant.name}`, tiles, 3);
        const orthogonalTargets = [
          ...marks.insideStrokes.map((item) => ({
            axis: 'coronal' as const,
            nativeIndex: Math.round((item.start[1] + item.end[1]) / 2),
          })),
          {
            axis: 'sagittal' as const,
            nativeIndex: Math.round(
              marks.insideStrokes.reduce((sum, item) => sum + item.start[0] + item.end[0], 0) /
                (marks.insideStrokes.length * 2),
            ),
          },
        ];
        const orthogonalTiles = rows.flatMap((kind) =>
          orthogonalTargets.map(({ axis, nativeIndex }) => {
            const index = nativeIndex - (axis === 'coronal' ? marks.crop.top : marks.crop.left);
            const section = nativeOrthogonalSection(volume, kind === 'reference' ? referenceMask! : mask, axis, index);
            const pixels = kind === 'mask' ? Float32Array.from(section.labels) : section.pixels;
            if (kind === 'contour' || kind === 'reference')
              paintContour(pixels, section.labels, section.columns, section.rows, displayWindow.upper);
            return {
              label: `E${examination} ${axis === 'coronal' ? 'COR' : 'SAG'} ${nativeIndex} ${{ source: 'SRC', reference: 'EDGE0', contour: 'EDGE1', mask: 'REGION' }[kind]}`,
              pixels: physicalAspectSection(
                pixels,
                section.columns,
                section.rows,
                section.spacing,
                kind === 'mask' ? 0 : displayWindow.lower,
              ),
              rows: 512,
              columns: 512,
              windowCenter: kind === 'mask' ? 0.5 : displayWindow.center,
              windowWidth: kind === 'mask' ? 1 : displayWindow.width,
            };
          }),
        );
        const orthogonalImage = writeAlignmentComparisonSheet(
          outputDirectory,
          `${resultPrefix}-${variant.name}-orthogonal`,
          orthogonalTiles,
          orthogonalTargets.length,
        );
        writeFileSync(join(outputDirectory, `${resultPrefix}-${variant.name}.mask.u8`), mask);
        const receipt = {
          variant: variant.name,
          durationMs,
          selectedVoxels: result.indices.length,
          volumeMl:
            (result.indices.length * volume.voxelSizeMm.reduce((product, spacing) => product * spacing, 1)) / 1000,
          foreground: variant.foreground.length,
          background: variant.background.length,
          missingForeground,
          selectedBackground,
          unsupported,
          domainVoxels: result.domainVoxels,
          boundaryCount: result.boundaryCount,
          heldOutAnchors: expected,
          primaryMaskJaccard: union ? intersection / union : 1,
          nearBoundaryOutsideProbes: evaluation
            ? evaluateOutsideBoundaryProbes(mask, marks.crop, volume.voxelSizeMm, evaluation)
            : undefined,
          maskHash: pixelFingerprint(mask),
          baselineByteMismatches: byteMismatches,
          comparisonImage: basename(image),
          topology,
          baselineTopology: referenceMask
            ? nativeMaskTopology(referenceMask, volume.dims, variant.foreground)
            : undefined,
          orthogonalComparison: {
            image: basename(orthogonalImage),
            sourceGridSections: orthogonalTargets,
            depthSourceIndices: [marks.crop.firstSlice, marks.crop.lastSlice],
            display:
              'Direct source-grid sections with nearest-cell physical-aspect display and letterboxing. These are not independent acquisitions, a full-tumor volume, or GUI/GPU evidence.',
          },
        };
        receipts.push(receipt);
        console.info(`[native-segmentation-${runCandidate ? 'candidate' : 'baseline'}]`, JSON.stringify(receipt));
      }
      expect(pixelFingerprint(volume.data)).toBe(native.dataHash);
      expect(pixelFingerprint(volume.observedSupport!)).toBe(native.supportHash);
      for (const frame of native.sourceHashes)
        expect(pixelFingerprint(readFileSync(source!.frames[frame.index]!.path))).toBe(frame.file);
      const anchorRegressions = baselineReceipt
        ? receipts.flatMap((receipt) =>
            nativeAnchorRegressions(
              receipt.heldOutAnchors,
              baselineReceipt.receipts.find((baseline: { variant: string }) => baseline.variant === receipt.variant)
                .heldOutAnchors,
            ).map((regression) => ({ variant: receipt.variant, ...regression })),
          )
        : [];
      const receipt = {
        stage: experimentalSolverPath
          ? 'hash-pinned-private-experiment'
          : runCandidate
            ? 'hash-pinned-production-candidate'
            : 'frozen-geodesic-baseline',
        clinicallyLabeledTumorMask: false,
        interpretation:
          'Root-approved sparse engineering marks; held-out anchor coverage and mask overlap are not clinical accuracy or dense tumor Dice.',
        baselineCoreHash: marks.baselineCoreHash,
        solverHash,
        approvedMarksHash: pixelFingerprint(marksBytes),
        evaluationHash: evaluationBytes ? pixelFingerprint(evaluationBytes) : undefined,
        sourceIndices,
        sourceStudyHash: marks.studyHash,
        sourceSeriesHash: marks.seriesHash,
        crop: marks.crop,
        dims: volume.dims,
        voxelSizeMm: volume.voxelSizeMm,
        originMm: volume.originMm,
        direction: volume.direction,
        nativeDataHash: native.dataHash,
        nativeSupportHash: native.supportHash,
        originalSourceFilesAndBuffersUnchanged: true,
        sourceHashes: native.sourceHashes,
        decodingMs,
        displayWindow,
        evaluatedVariants: variants.map((variant) => variant.name),
        defaultVariantCoverage: variants.length === availableVariants.length,
        requireByteEquivalence,
        sparseAnchorGuard: {
          regressions: anchorRegressions,
          interpretation:
            'No loss of previously retained frozen inside anchors or new outside-anchor leakage. Passing is not dense-boundary or clinical validation.',
        },
        receipts,
      };
      expect(pixelFingerprint(readFileSync(solverPath))).toBe(solverHash);
      writeFileSync(join(outputDirectory, `${resultPrefix}.json`), JSON.stringify(receipt, null, 2));
      if (requireByteEquivalence) {
        expect(runCandidate).toBe(true);
        expect(receipts.map((item) => ({ variant: item.variant, mismatches: item.baselineByteMismatches }))).toEqual(
          receipts.map((item) => ({ variant: item.variant, mismatches: 0 })),
        );
      }
      expect(
        anchorRegressions,
        'Frozen native anchor regressions; complete images/receipts were saved before this check. Sparse guards do not prove dense boundaries.',
      ).toEqual([]);
    },
    90_000,
  );
});
