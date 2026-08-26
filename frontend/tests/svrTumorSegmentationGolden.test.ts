import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { regionGrow3D_v2 } from '../src/utils/segmentation/regionGrow3D_v2';
import { reconstructVolumeFromSlices } from '../src/utils/svr/reconstructionCore';

type TumorPhantom = {
  dims: [number, number, number];
  volume: Float32Array;
  observedSupport: Uint8Array;
  truth: Uint8Array;
  seed: { x: number; y: number; z: number };
};

type TumorContrast = 'heterogeneous' | 'weak-hyperintense' | 'hypointense' | 'cystic-hyperintense';

const guideRegion = {
  mode: 'guide' as const,
  min: { x: 19, y: 15, z: 10 },
  max: { x: 45, y: 41, z: 30 },
  outsideToleranceScale: 0.65,
};

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
  const region = {
    mode: 'guide' as const,
    min: { x: 6, y: 6, z: 6 },
    max: { x: 40, y: 45, z: 45 },
    outsideToleranceScale: 0.6,
  };

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

  return { dims, volume, observedSupport, truth, healthySeed, lesionSeed, region };
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

async function evaluateTumorPhantom(contrast: TumorContrast) {
  const phantom = contrastingTumorPhantom(contrast);
  const band =
    contrast === 'hypointense'
      ? { min: 0.22, max: 0.45 }
      : contrast === 'weak-hyperintense'
        ? { min: 0.52, max: 0.73 }
        : contrast === 'cystic-hyperintense'
          ? { min: 0.64, max: 0.98 }
          : { min: 0.61, max: 0.85 };
  const started = performance.now();
  const result = await regionGrow3D_v2({
    volume: phantom.volume,
    observedSupport: phantom.observedSupport,
    dims: phantom.dims,
    seed: phantom.seed,
    ...band,
    roi: guideRegion,
    opts: { connectivity: 6, maxVoxels: 20_000, yieldEvery: 0 },
  });

  let truePositive = 0;
  let unsupported = 0;
  for (let position = 0; position < result.count; position++) {
    const index = result.indices[position]!;
    truePositive += phantom.truth[index]!;
    unsupported += phantom.observedSupport[index] === 0 ? 1 : 0;
  }
  const expected = phantom.truth.reduce((total, entry) => total + entry, 0);
  const precision = truePositive / Math.max(1, result.count);
  const recall = truePositive / Math.max(1, expected);
  const dice = (2 * truePositive) / Math.max(1, result.count + expected);
  const metrics = {
    stage: 'tumor-segmentation-phantom',
    contrast,
    volumeVoxels: phantom.volume.length,
    lesionVoxels: expected,
    selectedVoxels: result.count,
    truePositive,
    falsePositive: result.count - truePositive,
    falseNegative: expected - truePositive,
    unsupported,
    precision: Number(precision.toFixed(5)),
    recall: Number(recall.toFixed(5)),
    dice: Number(dice.toFixed(5)),
    elapsedMs: Number((performance.now() - started).toFixed(2)),
  };
  console.log(JSON.stringify(metrics));
  return { phantom, result, metrics, precision, recall, dice };
}

describe('tumor-only SVR segmentation fidelity', () => {
  it('isolates a heterogeneous acquired lesion from connected anatomy and brighter distractors', async () => {
    const { result, metrics, precision, recall, dice } = await evaluateTumorPhantom('heterogeneous');
    expect(metrics.unsupported).toBe(0);
    expect(result.hitMaxVoxels).toBe(false);
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(dice).toBeGreaterThanOrEqual(0.93);
  });

  it.each(['weak-hyperintense', 'hypointense', 'cystic-hyperintense'] as const)(
    'segments %s lesion tissue without using the user ROI as a tumor mask',
    async (contrast) => {
      const { metrics, precision, recall, dice } = await evaluateTumorPhantom(contrast);
      expect(metrics.unsupported).toBe(0);
      expect(precision).toBeGreaterThanOrEqual(0.97);
      expect(recall).toBeGreaterThanOrEqual(0.9);
      expect(dice).toBeGreaterThanOrEqual(0.93);
    },
  );

  it.each(['hyperintense', 'hypointense'] as const)(
    'rejects a healthy rectangle-center seed but accurately segments an off-center %s lesion',
    async (contrast) => {
      const phantom = offCenterTumorPhantom(contrast);
      const shared = {
        volume: phantom.volume,
        observedSupport: phantom.observedSupport,
        dims: phantom.dims,
        roi: phantom.region,
        opts: { connectivity: 6 as const, maxVoxels: 224_000, yieldEvery: 0 },
      };
      const ambiguous = await regionGrow3D_v2({
        ...shared,
        seed: phantom.healthySeed,
        min: 0.455,
        max: 0.695,
      });
      const [width, height] = phantom.dims;
      const lesionIndex = (phantom.lesionSeed.z * height + phantom.lesionSeed.y) * width + phantom.lesionSeed.x;
      const lesionIntensity = phantom.volume[lesionIndex]!;
      const localized = await regionGrow3D_v2({
        ...shared,
        seed: phantom.lesionSeed,
        min: lesionIntensity - 0.12,
        max: lesionIntensity + 0.12,
      });

      let truePositive = 0;
      let unsupported = 0;
      for (const index of localized.indices) {
        truePositive += phantom.truth[index]!;
        unsupported += phantom.observedSupport[index] === 0 ? 1 : 0;
      }
      const lesionVoxels = phantom.truth.reduce((total, value) => total + value, 0);
      const precision = truePositive / Math.max(1, localized.count);
      const recall = truePositive / Math.max(1, lesionVoxels);
      const dice = (2 * truePositive) / Math.max(1, localized.count + lesionVoxels);
      console.log(
        JSON.stringify({
          stage: 'automatic-center-seed-tumor-segmentation',
          contrast,
          regionVoxels: 56_000,
          healthySeedIntensity: Number(ambiguous.seedValue.toFixed(3)),
          ambiguousVoxels: ambiguous.count,
          ambiguousRegionFraction: Number((ambiguous.count / 56_000).toFixed(5)),
          lesionSeedIntensity: Number(lesionIntensity.toFixed(3)),
          lesionVoxels,
          localizedVoxels: localized.count,
          unsupported,
          precision: Number(precision.toFixed(5)),
          recall: Number(recall.toFixed(5)),
          dice: Number(dice.toFixed(5)),
        }),
      );

      expect(ambiguous.seedValue).toBeCloseTo(0.575, 5);
      expect(ambiguous.count).toBe(0);
      expect(unsupported).toBe(0);
      expect(precision).toBeGreaterThanOrEqual(0.97);
      expect(recall).toBeGreaterThanOrEqual(0.9);
      expect(dice).toBeGreaterThanOrEqual(0.93);
    },
  );

  it('isolates a near-center dark lesion from heterogeneous anatomy and larger bilateral cavities', async () => {
    const phantom = heterogeneousAnatomicalTumorPhantom();
    const options = {
      volume: phantom.volume,
      observedSupport: phantom.observedSupport,
      dims: phantom.dims,
      roi: phantom.region,
      opts: { connectivity: 6 as const, maxVoxels: 224_000, yieldEvery: 0 },
    };
    const ambiguous = await regionGrow3D_v2({
      ...options,
      seed: phantom.healthySeed,
      min: 0.455,
      max: 0.695,
    });
    const result = await regionGrow3D_v2({
      ...options,
      seed: phantom.lesionSeed,
      min: 0.268,
      max: 0.508,
    });

    const expected = phantom.truth.reduce((total, value) => total + value, 0);
    let truePositive = 0;
    for (const index of result.indices) truePositive += phantom.truth[index]!;
    const precision = truePositive / Math.max(1, result.count);
    const recall = truePositive / Math.max(1, expected);
    const dice = (2 * truePositive) / Math.max(1, result.count + expected);
    console.log(
      JSON.stringify({
        stage: 'anatomical-bilateral-cavity-tumor-segmentation',
        regionVoxels: 56_000,
        healthySeedIntensity: Number(ambiguous.seedValue.toFixed(3)),
        healthySeedAcceptedVoxels: ambiguous.count,
        lesionSeedIntensity: Number(result.seedValue.toFixed(3)),
        lesionVoxels: expected,
        selectedVoxels: result.count,
        falsePositive: result.count - truePositive,
        precision: Number(precision.toFixed(5)),
        recall: Number(recall.toFixed(5)),
        dice: Number(dice.toFixed(5)),
      }),
    );

    expect(ambiguous.count).toBe(0);
    expect(precision).toBeGreaterThanOrEqual(0.97);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(dice).toBeGreaterThanOrEqual(0.93);
  });

  it('never crosses an unsupported bridge even when disconnected tissue has the same intensity', async () => {
    const dims: [number, number, number] = [11, 3, 3];
    const volume = new Float32Array(99).fill(0.71);
    const observedSupport = new Uint8Array(99).fill(1);
    for (let index = 0; index < observedSupport.length; index++) {
      if (index % dims[0] === 5) observedSupport[index] = 0;
    }

    const result = await regionGrow3D_v2({
      volume,
      observedSupport,
      dims,
      seed: { x: 2, y: 1, z: 1 },
      min: 0.55,
      max: 0.85,
      opts: { connectivity: 26, yieldEvery: 0 },
    });

    expect(result.count).toBeGreaterThan(0);
    expect([...result.indices].every((index) => observedSupport[index] === 1 && index % dims[0] < 5)).toBe(true);
  });

  it('keeps hard ROI limits and configured voxel caps categorical', async () => {
    const phantom = heterogeneousTumorPhantom();
    const result = await regionGrow3D_v2({
      volume: phantom.volume,
      observedSupport: phantom.observedSupport,
      dims: phantom.dims,
      seed: phantom.seed,
      min: 0.61,
      max: 0.85,
      roi: { mode: 'hard', min: { x: 28, y: 26, z: 18 }, max: { x: 32, y: 30, z: 22 } },
      opts: { maxVoxels: 20, yieldEvery: 0 },
    });

    expect(result.count).toBe(20);
    expect(result.hitMaxVoxels).toBe(true);
    expect(
      [...result.indices].every((index) => {
        const x = index % phantom.dims[0];
        const y = Math.floor(index / phantom.dims[0]) % phantom.dims[1];
        const z = Math.floor(index / (phantom.dims[0] * phantom.dims[1]));
        return x >= 28 && x <= 32 && y >= 26 && y <= 30 && z >= 18 && z <= 22;
      }),
    ).toBe(true);
  });

  it('honors cancellation before any acquired voxel is accepted', async () => {
    const phantom = heterogeneousTumorPhantom();
    const controller = new AbortController();
    controller.abort();

    const result = await regionGrow3D_v2({
      volume: phantom.volume,
      observedSupport: phantom.observedSupport,
      dims: phantom.dims,
      seed: phantom.seed,
      min: 0.61,
      max: 0.85,
      roi: guideRegion,
      opts: { signal: controller.signal, yieldEvery: 0 },
    });

    expect(result.count).toBe(0);
    expect(result.hitMaxVoxels).toBe(false);
  });

  it('honors multiple explicit supported seeds without traversing unsupported tissue', async () => {
    const observedSupport = new Uint8Array([1, 1, 1, 0, 1, 1, 1]);
    const result = await regionGrow3D_v2({
      volume: new Float32Array(7).fill(0.71),
      observedSupport,
      dims: [7, 1, 1],
      seed: { x: 1, y: 0, z: 0 },
      seedIndices: new Uint32Array([1, 5]),
      min: 0.55,
      max: 0.85,
      opts: { connectivity: 6, yieldEvery: 0 },
    });

    expect([...result.indices].sort((left, right) => left - right)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(result.indices).not.toContain(3);
  });

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

describe('optional private real-MRI tumor segmentation', () => {
  runPrivateCorpus(
    'segments an acquired-support-preserving, same-study three-orientation reconstructed lesion',
    async () => {
      const { decodeAlignmentRegistrationSlice, inspectAlignmentCorpus, loadAlignmentLosslessCodec } =
        await import('./helpers/alignmentRealCorpus');
      const examination = Number(process.env.MIRAVIEWER_TUMOR_SEGMENTATION_EXAMINATION ?? 1);
      const reviewedExamination = Number(process.env.MIRAVIEWER_TUMOR_SEGMENTATION_REVIEWED_EXAMINATION ?? examination);
      const reviewed = new Map([
        [1, { AX: 100, COR: 110, SAG: 150 }],
        [9, { AX: 97, COR: 109, SAG: 136 }],
        [15, { AX: 91, COR: 103, SAG: 134 }],
        // Visually reviewed August source-only context: displayed AX 95/221,
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
        const values = stack.flatMap((slice) => [...slice.pixels]).sort((left, right) => left - right);
        const low = values[Math.floor(values.length * 0.02)]!;
        const high = values[Math.floor(values.length * 0.98)]!;
        for (const slice of stack) {
          for (let index = 0; index < slice.pixels.length; index++) {
            slice.pixels[index] = Math.max(0, Math.min(1, (slice.pixels[index]! - low) / Math.max(1e-6, high - low)));
          }
          allSlices.push(slice);
        }
      }

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

      let seedIndex = -1;
      let seedScore = Number.NEGATIVE_INFINITY;
      for (let z = 20; z <= 28; z++) {
        for (let y = 20; y <= 28; y++) {
          for (let x = 20; x <= 28; x++) {
            const index = (z * dims[1] + y) * dims[0] + x;
            if (!observedSupport[index]) continue;
            const distance = Math.hypot(x - 24, y - 24, z - 24);
            const score = volume[index]! - distance * 0.025;
            if (score > seedScore) {
              seedScore = score;
              seedIndex = index;
            }
          }
        }
      }
      expect(seedIndex).toBeGreaterThanOrEqual(0);
      const seed = {
        x: seedIndex % dims[0],
        y: Math.floor(seedIndex / dims[0]) % dims[1],
        z: Math.floor(seedIndex / (dims[0] * dims[1])),
      };
      const segmentationStarted = performance.now();
      const segmentation = await regionGrow3D_v2({
        volume,
        observedSupport,
        dims,
        seed,
        min: Math.max(0, volume[seedIndex]! - 0.12),
        max: Math.min(1, volume[seedIndex]! + 0.12),
        roi: { mode: 'guide', min: { x: 15, y: 15, z: 15 }, max: { x: 33, y: 33, z: 33 }, outsideToleranceScale: 0.5 },
        opts: { connectivity: 6, maxVoxels: 10_000, yieldEvery: 0 },
      });
      const segmentationMs = performance.now() - segmentationStarted;
      const unsupported = [...segmentation.indices].filter((index) => observedSupport[index] !== 1).length;
      const outsideUserRegion = [...segmentation.indices].filter((index) => {
        const x = index % dims[0];
        const y = Math.floor(index / dims[0]) % dims[1];
        const z = Math.floor(index / (dims[0] * dims[1]));
        return x < 15 || x > 33 || y < 15 || y > 33 || z < 15 || z > 33;
      }).length;

      console.log(
        JSON.stringify({
          stage: 'real-mri-tumor-segmentation',
          examination: reviewedExamination,
          selectedRootStudyOrdinal: examination,
          reviewedAcquiredDisplayIndices: {
            AX: reviewed!.AX + 1,
            COR: reviewed!.COR + 1,
            SAG: reviewed!.SAG + 1,
          },
          clinicallyLabeledTumorMask: false,
          orientations: selected.map((source) => source!.plane),
          samePatient: true,
          sameStudy: true,
          sameFrameOfReference: true,
          sameContrast: true,
          acquiredSlices: allSlices.length,
          reconstructedVoxels: volume.length,
          supportedVoxels: observedSupport.reduce((total, supported) => total + supported, 0),
          seedIntensity: Number(volume[seedIndex]!.toFixed(5)),
          segmentedVoxels: segmentation.count,
          segmentedVolumeMl: Number(((segmentation.count * voxelSizeMm ** 3) / 1000).toFixed(3)),
          unsupported,
          outsideUserRegion,
          hitMaxVoxels: segmentation.hitMaxVoxels,
          indexingDecodingMs: Number((reconstructionStarted - indexedAt).toFixed(2)),
          reconstructionMs: Number(reconstructionMs.toFixed(2)),
          segmentationMs: Number(segmentationMs.toFixed(2)),
        }),
      );

      expect(segmentation.count).toBeGreaterThan(0);
      expect(segmentation.hitMaxVoxels).toBe(false);
      expect(unsupported).toBe(0);
      expect(outsideUserRegion / segmentation.count).toBeLessThan(0.15);
    },
    90_000,
  );
});
