import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { segmentSeededVolume, voxelIndex } from '../src/utils/segmentation/seededVolume';
import { normalizeSvrIntensities } from '../src/utils/svr/intensityNormalization';
import { reconstructVolumeFromSlices } from '../src/utils/svr/reconstructionCore';
import { segmentationQuality as quality } from './helpers/segmentationQuality';

type TumorPhantom = {
  dims: [number, number, number];
  volume: Float32Array;
  observedSupport: Uint8Array;
  truth: Uint8Array;
  seed: { x: number; y: number; z: number };
};

type TumorContrast = 'heterogeneous' | 'weak-hyperintense' | 'hypointense' | 'cystic-hyperintense';

function heterogeneousTumorPhantom(): TumorPhantom {
  const dims: [number, number, number] = [64, 56, 40];
  const [width, height, depth] = dims;
  const volume = new Float32Array(width * height * depth);
  const observedSupport = new Uint8Array(volume.length).fill(1);
  const truth = new Uint8Array(volume.length);
  const seed = { x: 30, y: 28, z: 20 };

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (z * height + y) * width + x;
        const phase = x * 0.41 + y * 0.29 + z * 0.17;
        volume[index] = 0.52 + Math.sin(phase) * 0.018;

        const lesionRadius = ((x - seed.x) / 8) ** 2 + ((y - seed.y) / 7) ** 2 + ((z - seed.z) / 5) ** 2;
        if (lesionRadius <= 1) {
          truth[index] = 1;
          volume[index] = 0.73 + Math.sin(phase * 1.7) * 0.045 - Math.sqrt(lesionRadius) * 0.035;
        }

        const bridge = x >= 38 && x <= 45 && Math.abs(y - seed.y) <= 1 && Math.abs(z - seed.z) <= 1;
        const attachedHealthy = x >= 45 && x <= 56 && Math.abs(y - seed.y) <= 5 && Math.abs(z - seed.z) <= 4;
        if (bridge || attachedHealthy) volume[index] = 0.665 + Math.sin(phase) * 0.018;

        const detachedDistractor = ((x - 12) / 4) ** 2 + ((y - 13) / 4) ** 2 + ((z - 13) / 3) ** 2 <= 1;
        if (detachedDistractor) volume[index] = 0.89;

        if (x === 49 && Math.abs(y - seed.y) <= 5 && Math.abs(z - seed.z) <= 4) {
          observedSupport[index] = 0;
        }
      }
    }
  }

  return { dims, volume, observedSupport, truth, seed };
}

function contrastingTumorPhantom(contrast: TumorContrast): TumorPhantom {
  const phantom = heterogeneousTumorPhantom();
  if (contrast === 'heterogeneous') return phantom;

  const [width, height, depth] = phantom.dims;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (z * height + y) * width + x;
        const phase = x * 0.41 + y * 0.29 + z * 0.17;
        const radius =
          ((x - phantom.seed.x) / 8) ** 2 + ((y - phantom.seed.y) / 7) ** 2 + ((z - phantom.seed.z) / 5) ** 2;
        const bridge = x >= 38 && x <= 45 && Math.abs(y - phantom.seed.y) <= 1 && Math.abs(z - phantom.seed.z) <= 1;
        const attachedHealthy =
          x >= 45 && x <= 56 && Math.abs(y - phantom.seed.y) <= 5 && Math.abs(z - phantom.seed.z) <= 4;

        if (contrast === 'weak-hyperintense') {
          phantom.volume[index] = phantom.truth[index]
            ? 0.635 + Math.sin(phase * 1.7) * 0.019 - Math.sqrt(radius) * 0.014
            : 0.545 + Math.sin(phase) * 0.012;
          if (bridge || attachedHealthy) phantom.volume[index] = 0.588 + Math.sin(phase) * 0.009;
        } else if (contrast === 'hypointense') {
          phantom.volume[index] = phantom.truth[index]
            ? 0.325 + Math.sin(phase * 1.7) * 0.022 + Math.sqrt(radius) * 0.015
            : 0.525 + Math.sin(phase) * 0.012;
          if (bridge || attachedHealthy) phantom.volume[index] = 0.39 + Math.sin(phase) * 0.008;
        } else if (phantom.truth[index]) {
          phantom.volume[index] = radius < 0.13 ? 0.88 + Math.sin(phase) * 0.014 : phantom.volume[index]!;
        }
      }
    }
  }

  return phantom;
}

function offCenterTumorPhantom(contrast: 'hyperintense' | 'hypointense') {
  const dims: [number, number, number] = [47, 52, 52];
  const [width, height, depth] = dims;
  const volume = new Float32Array(width * height * depth);
  const observedSupport = new Uint8Array(volume.length).fill(1);
  const truth = new Uint8Array(volume.length);
  const healthySeed = { x: 23, y: 25, z: 25 };
  const lesionSeed = { x: 31, y: 31, z: 25 };

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (z * height + y) * width + x;
        const phase = (x - healthySeed.x) * 0.37 + (y - healthySeed.y) * 0.23 + (z - healthySeed.z) * 0.19;
        const radius = ((x - lesionSeed.x) / 6) ** 2 + ((y - lesionSeed.y) / 5) ** 2 + ((z - lesionSeed.z) / 4) ** 2;
        volume[index] = 0.575 + Math.sin(phase) * 0.012;
        if (radius <= 1) {
          truth[index] = 1;
          volume[index] = (contrast === 'hyperintense' ? 0.79 : 0.36) + Math.sin(phase * 1.7) * 0.016;
        }

        const distractingRegion = x >= 35 && x <= 40 && y >= 8 && y <= 14 && z >= 8 && z <= 14;
        if (distractingRegion) {
          const boundary = x === 35 || x === 40 || y === 8 || y === 14 || z === 8 || z === 14;
          if (boundary) observedSupport[index] = 0;
          else volume[index] = contrast === 'hyperintense' ? 0.94 : 0.14;
        }
      }
    }
  }

  return { dims, volume, observedSupport, truth, healthySeed, lesionSeed };
}

function heterogeneousAnatomicalTumorPhantom() {
  const phantom = offCenterTumorPhantom('hypointense');
  const [width, height, depth] = phantom.dims;
  phantom.truth.fill(0);
  phantom.observedSupport.fill(1);
  const lesionSeed = { x: 23, y: 22, z: 25 };

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (z * height + y) * width + x;
        const dx = x - phantom.healthySeed.x;
        const dy = y - phantom.healthySeed.y;
        const dz = z - phantom.healthySeed.z;
        const anatomy = 0.575 + Math.sin(dx * 0.025 + dy * 0.02 + dz * 0.04) * 0.19;
        phantom.volume[index] = anatomy + Math.sin(dx * 0.055 - dy * 0.038 + dz * 0.035) * 0.11;

        const leftCavity = ((x - 13) / 5) ** 2 + ((y - 38) / 7) ** 2 + ((z - 25) / 5) ** 2 <= 1;
        const rightCavity = ((x - 33) / 4) ** 2 + ((y - 38) / 6) ** 2 + ((z - 25) / 5) ** 2 <= 1;
        if (leftCavity || rightCavity) phantom.volume[index] = (leftCavity ? 0.18 : 0.22) + Math.sin(dx + dy) * 0.012;

        const lesion =
          ((x - lesionSeed.x) / 2) ** 2 + ((y - lesionSeed.y) / 2) ** 2 + ((z - lesionSeed.z) / 3) ** 2 <= 1;
        if (lesion) {
          phantom.truth[index] = 1;
          phantom.volume[index] = 0.388 + Math.sin(dx * 0.7 + dy * 0.4 + dz * 0.2) * 0.009;
        }
      }
    }
  }

  return { ...phantom, lesionSeed };
}

describe('independent explicitly seeded tumor-shape phantoms', () => {
  it.each(['heterogeneous', 'weak-hyperintense', 'hypointense', 'cystic-hyperintense'] as const)(
    'retains %s anatomy without swallowing the attached distractor',
    async (contrast) => {
      const phantom = contrastingTumorPhantom(contrast);
      const { seed, dims } = phantom;
      const foreground = Uint32Array.from([seed, { ...seed, x: seed.x + 4 }].map((point) => voxelIndex(point, dims)));
      const background = Uint32Array.from(
        [
          { ...seed, x: 44 },
          { ...seed, x: seed.x - 10 },
          { ...seed, y: seed.y - 9 },
          { ...seed, y: seed.y + 9 },
        ].map((point) => voxelIndex(point, dims)),
      );
      const result = await segmentSeededVolume({ ...phantom, voxelSizeMm: [1, 1, 1], foreground, background });
      const metrics = quality(phantom.truth, result.indices);
      console.info('[independent-segmentation-phantom]', { contrast, ...metrics });
      expect(metrics.dice).toBeGreaterThanOrEqual(0.93);
      expect(metrics.precision).toBeGreaterThanOrEqual(0.97);
      expect(metrics.recall).toBeGreaterThanOrEqual(0.9);
      expect([...result.indices].every((index) => phantom.observedSupport[index])).toBe(true);
      for (const index of foreground) expect(result.indices).toContain(index);
      for (const index of background) expect(result.indices).not.toContain(index);
    },
  );

  it.each([
    { contrast: 'hyperintense', outsideMarks: true },
    { contrast: 'hypointense', outsideMarks: true },
    { contrast: 'hyperintense', outsideMarks: false },
    { contrast: 'hypointense', outsideMarks: false },
  ] as const)(
    'follows an explicit off-center $contrast mark with explicit outside marks: $outsideMarks',
    async ({ contrast, outsideMarks }) => {
      const phantom = offCenterTumorPhantom(contrast);
      const result = await segmentSeededVolume({
        ...phantom,
        voxelSizeMm: [1, 1, 1],
        foreground: Uint32Array.of(voxelIndex(phantom.lesionSeed, phantom.dims)),
        background: outsideMarks ? Uint32Array.of(voxelIndex(phantom.healthySeed, phantom.dims)) : new Uint32Array(),
      });
      const metrics = quality(phantom.truth, result.indices);
      expect(metrics.dice).toBeGreaterThan(0.97);
      expect(metrics.precision).toBeGreaterThan(0.97);
    },
  );

  it('isolates a small marked dark region while explicit background excludes larger bilateral cavities', async () => {
    const phantom = heterogeneousAnatomicalTumorPhantom();
    const result = await segmentSeededVolume({
      ...phantom,
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(voxelIndex(phantom.lesionSeed, phantom.dims)),
      background: Uint32Array.from(
        [phantom.healthySeed, { x: 13, y: 38, z: 25 }, { x: 33, y: 38, z: 25 }].map((point) =>
          voxelIndex(point, phantom.dims),
        ),
      ),
    });
    expect(quality(phantom.truth, result.indices).dice).toBeGreaterThan(0.93);
  });

  it.each([1, -1])(
    'does not use the inside of a 32 mm lesion with polarity %i as an automatic outside boundary',
    async (polarity) => {
      const dims: [number, number, number] = [61, 61, 61];
      const volume = new Float32Array(61 ** 3).fill(0.5);
      const truth = new Uint8Array(volume.length);
      for (let z = 0; z < 61; z++)
        for (let y = 0; y < 61; y++)
          for (let x = 0; x < 61; x++) {
            if ((x - 30) ** 2 + (y - 30) ** 2 + (z - 30) ** 2 > 16 ** 2) continue;
            const index = (z * 61 + y) * 61 + x;
            truth[index] = 1;
            volume[index] = 0.5 + polarity * 0.25;
          }
      const input = {
        volume,
        dims,
        voxelSizeMm: [1, 1, 1] as [number, number, number],
        foreground: Uint32Array.of((30 * 61 + 30) * 61 + 30),
        background: new Uint32Array(),
      };
      const automatic = await segmentSeededVolume(input);
      const fullContext = await segmentSeededVolume({
        ...input,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 60, z: 60 } },
      });
      const automaticQuality = quality(truth, automatic.indices);
      const fullContextQuality = quality(truth, fullContext.indices);
      console.info('[large-lesion-search-context]', {
        polarity,
        truthVoxels: truth.reduce((sum, value) => sum + value, 0),
        automatic: { ...automaticQuality, selectedVoxels: automatic.indices.length, bounds: automatic.bounds },
        fullContext: { ...fullContextQuality, selectedVoxels: fullContext.indices.length, bounds: fullContext.bounds },
      });
      expect(automatic.indices).toContain(input.foreground[0]);
      expect(fullContext.indices).toContain(input.foreground[0]);
      expect(fullContextQuality.dice).toBeGreaterThan(0.97);
      expect(fullContextQuality.recall).toBeGreaterThan(0.97);
      expect(automaticQuality.dice).toBeGreaterThan(0.93);
      expect(automaticQuality.recall).toBeGreaterThan(0.9);
    },
  );

  it('discovers preamble-verified extensionless MRI only when explicitly enabled', async () => {
    const { inspectAlignmentCorpus } = await import('./helpers/alignmentRealCorpus');
    const { createSyntheticSvrDicomFiles } = await import('./svrSyntheticDicom');
    const root = await mkdtemp(join(tmpdir(), 'miraviewer-extensionless-mri-'));
    const examination = join(root, 'synthetic-examination');

    try {
      await mkdir(examination);
      const files = createSyntheticSvrDicomFiles({ imageSize: 8, slicesPerOrientation: 2, orientations: 3 });
      for (const [position, sourceIndex] of [0, 2, 4].entries()) {
        await writeFile(join(examination, `acquired${position}`), Buffer.from(await files[sourceIndex]!.arrayBuffer()));
      }
      await writeFile(join(examination, 'existing.dcm'), Buffer.from(await files[1]!.arrayBuffer()));
      await writeFile(join(examination, 'notDicom'), 'Not a medical image');

      const original = inspectAlignmentCorpus(root);
      expect(original.map((source) => source.plane)).toEqual(['AX']);
      expect(original[0]!.frames).toHaveLength(1);

      const optedIn = inspectAlignmentCorpus(root, {
        studyOrdinals: [1],
        includeExtensionlessDicom: true,
      });
      expect(optedIn.map((source) => source.plane)).toEqual(['AX', 'COR', 'SAG']);
      expect(optedIn.reduce((count, source) => count + source.frames.length, 0)).toBe(4);
      expect(optedIn.every((source) => source.examinationOrdinal === 1)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const privateMriRoot = process.env.MIRAVIEWER_TUMOR_SEGMENTATION_MRI_ROOT?.trim();
const runPrivateCorpus = privateMriRoot ? it : it.skip;

describe('optional private unlabeled MRI support and workflow', () => {
  runPrivateCorpus(
    'preserves support and marks with or without explicit outside marks across a same-study three-orientation reconstruction',
    async () => {
      const { decodeAlignmentRegistrationSlice, inspectAlignmentCorpus, loadAlignmentLosslessCodec } =
        await import('./helpers/alignmentRealCorpus');
      const examination = Number(process.env.MIRAVIEWER_TUMOR_SEGMENTATION_EXAMINATION ?? 1);
      const reviewedExamination = Number(process.env.MIRAVIEWER_TUMOR_SEGMENTATION_REVIEWED_EXAMINATION ?? examination);
      const reviewed = new Map([
        [1, { AX: 100, COR: 110, SAG: 150 }],
        [9, { AX: 97, COR: 109, SAG: 136 }],
        [15, { AX: 91, COR: 103, SAG: 134 }],
        // Visually reviewed latest source-only context: displayed AX 95/221,
        // COR 111/221, and SAG 138/274. These are not clinical tumor labels.
        [18, { AX: 94, COR: 110, SAG: 137 }],
      ]).get(reviewedExamination);
      expect(reviewed).toBeDefined();

      const indexedAt = performance.now();
      const candidates = inspectAlignmentCorpus(privateMriRoot!, {
        studyOrdinals: [examination],
        includeExtensionlessDicom: process.env.MIRAVIEWER_TUMOR_SEGMENTATION_INCLUDE_EXTENSIONLESS === '1',
      }).filter((entry) => entry.examinationOrdinal === examination && /flair/i.test(entry.contrast));
      const axial = candidates
        .filter((entry) => entry.plane === 'AX' && entry.frames.length > reviewed!.AX)
        .sort((left, right) => right.frames.length - left.frames.length)[0];
      expect(axial).toBeDefined();

      const selected = (['AX', 'COR', 'SAG'] as const).map(
        (plane) =>
          candidates
            .filter(
              (entry) =>
                entry.plane === plane &&
                entry.patientKey === axial!.patientKey &&
                entry.studyUid === axial!.studyUid &&
                entry.frameOfReferenceUid === axial!.frameOfReferenceUid &&
                entry.contrast === axial!.contrast &&
                entry.frames.length > reviewed![plane],
            )
            .sort((left, right) => right.frames.length - left.frames.length)[0],
      );
      expect(selected.every(Boolean)).toBe(true);

      const codec = loadAlignmentLosslessCodec();
      const allSlices = [];
      for (const source of selected) {
        const center = reviewed![source!.plane];
        const stack = [];
        for (let index = center - 5; index <= center + 5; index++) {
          stack.push(await decodeAlignmentRegistrationSlice(source!, index, codec, 96));
        }
        allSlices.push(...stack);
      }
      normalizeSvrIntensities(
        allSlices,
        allSlices.flatMap((slice) =>
          [...slice.pixels]
            .filter((_, index) => !slice.valid || slice.valid[index])
            .filter((_, index) => index % 97 === 0),
        ),
      );

      const reference = allSlices[5]!;
      const centerMm = {
        x:
          reference.ippMm.x +
          reference.colDir.x * ((reference.dsRows - 1) * 0.5 * reference.rowSpacingDsMm) +
          reference.rowDir.x * ((reference.dsCols - 1) * 0.5 * reference.colSpacingDsMm),
        y:
          reference.ippMm.y +
          reference.colDir.y * ((reference.dsRows - 1) * 0.5 * reference.rowSpacingDsMm) +
          reference.rowDir.y * ((reference.dsCols - 1) * 0.5 * reference.colSpacingDsMm),
        z:
          reference.ippMm.z +
          reference.colDir.z * ((reference.dsRows - 1) * 0.5 * reference.rowSpacingDsMm) +
          reference.rowDir.z * ((reference.dsCols - 1) * 0.5 * reference.colSpacingDsMm),
      };
      const dims: [number, number, number] = [48, 48, 48];
      const voxelSizeMm = 2;
      const observedSupport = new Uint8Array(dims[0] * dims[1] * dims[2]);
      const reconstructionStarted = performance.now();
      const volume = await reconstructVolumeFromSlices({
        slices: allSlices,
        grid: {
          dims: { nx: dims[0], ny: dims[1], nz: dims[2] },
          originMm: {
            x: centerMm.x - 24 * voxelSizeMm,
            y: centerMm.y - 24 * voxelSizeMm,
            z: centerMm.z - 24 * voxelSizeMm,
          },
          voxelSizeMm,
        },
        occupancy: observedSupport,
        options: {
          iterations: 0,
          stepSize: 0,
          clampOutput: true,
          psfMode: 'box',
          robustLoss: 'none',
          robustDelta: 0.1,
          laplacianWeight: 0,
        },
      });
      const reconstructionMs = performance.now() - reconstructionStarted;

      // Geometric workflow marks, not tumor labels or an intensity-outlier oracle.
      const closestSupported = (point: { x: number; y: number; z: number }, unavailable = new Set<number>()) => {
        let chosen = -1,
          distance = Infinity;
        for (let z = 15; z <= 33; z++)
          for (let y = 15; y <= 33; y++)
            for (let x = 15; x <= 33; x++) {
              const index = voxelIndex({ x, y, z }, dims);
              const next = (x - point.x) ** 2 + (y - point.y) ** 2 + (z - point.z) ** 2;
              if (
                observedSupport[index] &&
                Number.isFinite(volume[index]) &&
                !unavailable.has(index) &&
                next < distance
              ) {
                chosen = index;
                distance = next;
              }
            }
        expect(chosen).toBeGreaterThanOrEqual(0);
        return chosen;
      };
      const seedIndex = closestSupported({ x: 24, y: 24, z: 24 });
      const foreground = Uint32Array.of(seedIndex);
      const background = Uint32Array.from(
        [
          { x: 18, y: 24, z: 24 },
          { x: 30, y: 24, z: 24 },
          { x: 24, y: 18, z: 24 },
          { x: 24, y: 30, z: 24 },
        ].map((point) => closestSupported(point, new Set(foreground))),
      );
      const input = {
        volume,
        observedSupport,
        dims,
        voxelSizeMm: [2, 2, 2] as [number, number, number],
        foreground,
        background,
        bounds: { min: { x: 15, y: 15, z: 15 }, max: { x: 33, y: 33, z: 33 } },
      };
      for (const outsideMarks of [true, false]) {
        const segmentationInput = { ...input, background: outsideMarks ? background : new Uint32Array() };
        const segmentationStarted = performance.now();
        const segmentation = await segmentSeededVolume(segmentationInput);
        const segmentationMs = performance.now() - segmentationStarted;
        const repeated = await segmentSeededVolume(segmentationInput);
        expect(repeated.indices).toEqual(segmentation.indices);
        expect(segmentation.indices).toContain(seedIndex);
        for (const index of segmentationInput.background) expect(segmentation.indices).not.toContain(index);
        const unsupported = [...segmentation.indices].filter((index) => !observedSupport[index]).length;
        const outsideUserRegion = [...segmentation.indices].filter((index) => {
          const x = index % dims[0],
            y = Math.floor(index / dims[0]) % dims[1],
            z = Math.floor(index / (dims[0] * dims[1]));
          return x < 15 || x > 33 || y < 15 || y > 33 || z < 15 || z > 33;
        }).length;

        console.log(
          JSON.stringify({
            stage: 'unlabeled-mri-selection-support-workflow',
            examination: reviewedExamination,
            selectedRootStudyOrdinal: examination,
            reviewedAcquiredDisplayIndices: {
              AX: reviewed!.AX + 1,
              COR: reviewed!.COR + 1,
              SAG: reviewed!.SAG + 1,
            },
            clinicallyLabeledTumorMask: false,
            explicitOutsideMarks: outsideMarks,
            orientations: selected.map((source) => source!.plane),
            samePatient: true,
            sameStudy: true,
            sameFrameOfReference: true,
            sameContrast: true,
            acquiredSlices: allSlices.length,
            reconstructedVoxels: volume.length,
            supportedVoxels: observedSupport.reduce((total, supported) => total + supported, 0),
            selectedVoxels: segmentation.indices.length,
            unsupported,
            outsideUserRegion,
            domainVoxels: segmentation.domainVoxels,
            indexingDecodingMs: Number((reconstructionStarted - indexedAt).toFixed(2)),
            reconstructionMs: Number(reconstructionMs.toFixed(2)),
            segmentationMs: Number(segmentationMs.toFixed(2)),
          }),
        );

        expect(segmentation.indices.length).toBeGreaterThan(0);
        expect(unsupported).toBe(0);
        expect(outsideUserRegion).toBe(0);
      }
    },
    90_000,
  );
});
