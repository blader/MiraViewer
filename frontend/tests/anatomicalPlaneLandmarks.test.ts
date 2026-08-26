import { describe, expect, it } from 'vitest';
import {
  minimumBilateralAnatomicalRetention,
  prepareAnatomicalPlaneLandmarks,
  scoreAnatomicalPlaneLandmarks,
} from '../src/utils/svr/anatomicalPlaneLandmarks';

function anatomicalPhantom(size = 128, cavityRow = 0.32, cavityScale = 1): Float32Array {
  const pixels = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (column - size / 2) / (size * 0.42);
      const y = (row - size / 2) / (size * 0.44);
      if (x * x + y * y < 1) pixels[row * size + column] = 0.35 + 0.25 * Math.cos(x * 2) * Math.cos(y * 2);
      for (const center of [size * 0.35, size * 0.65]) {
        if (
          ((column - center) / (size * 0.075 * cavityScale)) ** 2 +
            ((row - size * cavityRow) / (size * 0.055 * cavityScale)) ** 2 <
          1
        ) {
          pixels[row * size + column] = 0;
        }
      }
    }
  }
  return pixels;
}

function depthSensitivePhantom(size = 128, depth = 0): Float32Array {
  const pixels = anatomicalPhantom(size, 0.31 + depth * 0.018);
  for (let row = 24; row < size - 16; row++) {
    for (let column = 24; column < size - 24; column++) {
      const index = row * size + column;
      if (!pixels[index]) continue;
      const arch = size * 0.39 + Math.abs(column - size / 2) * 0.16 + depth * 2;
      if (Math.abs(row - arch) < 2) pixels[index] = 0.07;
      if (row > size * 0.62 && Math.abs(column - size * 0.49 - depth * 2) < 3) pixels[index] = 0.12;
    }
  }
  return pixels;
}

function physicalBilateralAnatomy() {
  const rows = 128;
  const cols = 128;
  const pixels = anatomicalPhantom(rows, 0.23);
  const valid = new Uint8Array(pixels.length).fill(1);
  const prepared = prepareAnatomicalPlaneLandmarks({
    pixels,
    valid,
    rows,
    cols,
    ippMm: { x: 0, y: 0, z: 0 },
    rowDir: { x: 1, y: 0, z: 0 },
    colDir: { x: 0, y: 1, z: 0 },
    rowSpacingDsMm: 1,
    colSpacingDsMm: 1,
  });
  return { rows, cols, pixels, valid, prepared };
}

type AnatomicalReference = Parameters<typeof prepareAnatomicalPlaneLandmarks>[0];
type AnatomicalDepthContext = { previous?: AnatomicalReference; next?: AnatomicalReference };
const prepareDepthAwareLandmarks = prepareAnatomicalPlaneLandmarks as (
  reference: AnatomicalReference,
  exclusionMask?: Uint8Array,
  depthContext?: AnatomicalDepthContext,
) => ReturnType<typeof prepareAnatomicalPlaneLandmarks>;

describe('physical enclosed anatomical plane landmarks', () => {
  it('prefers preserved paired enclosed anatomy while excluding a biologically changed lesion', () => {
    const rows = 128;
    const cols = 128;
    const valid = new Uint8Array(rows * cols).fill(1);
    const pixels = anatomicalPhantom();
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 58; row < 79; row++) exclusion.fill(1, row * cols + 54, row * cols + 75);
    const prepared = prepareAnatomicalPlaneLandmarks({ pixels, valid, rows, cols }, exclusion);
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const preserved = Float32Array.from(pixels);
    const missingCavity = Float32Array.from(pixels);
    for (let index = 0; index < exclusion.length; index++) {
      if (exclusion[index]) preserved[index] = 25;
    }
    for (let row = 32; row < 52; row++) {
      for (let column = 34; column < 53; column++) {
        if (missingCavity[row * cols + column] === 0) missingCavity[row * cols + column] = 0.55;
      }
    }

    const correct = scoreAnatomicalPlaneLandmarks(prepared, { pixels: preserved, valid, rows, cols });
    const wrong = scoreAnatomicalPlaneLandmarks(prepared, { pixels: missingCavity, valid, rows, cols });
    expect(correct).toBeGreaterThan(0.95);
    expect(correct).toBeGreaterThan(wrong + 0.1);
  });

  it('prioritizes supported anatomy beside an excluded region without reading the region or discarding distant anatomy', () => {
    const rows = 128;
    const cols = 128;
    const pixels = anatomicalPhantom(rows, 0.23);
    const valid = new Uint8Array(pixels.length).fill(1);
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 56; row < 76; row++) exclusion.fill(1, row * cols + 54, row * cols + 75);
    const near = { firstRow: 77, firstColumn: 62 };
    const far = { firstRow: 77, firstColumn: 30 };
    for (const feature of [near, far]) {
      for (let row = feature.firstRow; row < feature.firstRow + 9; row++) {
        for (let column = feature.firstColumn; column < feature.firstColumn + 9; column++) {
          pixels[row * cols + column] = (row - feature.firstRow + column - feature.firstColumn) % 3 === 0 ? 0.8 : 0.2;
        }
      }
    }
    const prepared = prepareAnatomicalPlaneLandmarks(
      {
        pixels,
        valid,
        rows,
        cols,
        ippMm: { x: 0, y: 0, z: 0 },
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: 1, z: 0 },
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
      },
      exclusion,
    );
    expect(prepared?.bilateral).toBeDefined();
    if (!prepared) return;

    const eraseFeature = (feature: typeof near) => {
      const candidate = Float32Array.from(pixels);
      for (let row = feature.firstRow; row < feature.firstRow + 9; row++) {
        candidate.fill(0.5, row * cols + feature.firstColumn, row * cols + feature.firstColumn + 9);
      }
      return candidate;
    };
    const missingNear = scoreAnatomicalPlaneLandmarks(prepared, {
      pixels: eraseFeature(near),
      valid,
      rows,
      cols,
    });
    const missingFar = scoreAnatomicalPlaneLandmarks(prepared, { pixels: eraseFeature(far), valid, rows, cols });
    expect(missingFar).toBeGreaterThan(missingNear + 0.03);
    expect(
      Array.from(
        { length: 9 },
        (_, offset) => prepared.weights[(far.firstRow + 1) * cols + far.firstColumn + offset]!,
      ).some((weight) => weight > 0),
    ).toBe(true);
    expect(prepared.weights.some((weight, index) => exclusion[index] && weight > 0)).toBe(false);

    const changedLesion = Float32Array.from(pixels);
    for (let index = 0; index < exclusion.length; index++) {
      if (exclusion[index]) changedLesion[index] = 25;
    }
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels: changedLesion, valid, rows, cols })).toBeCloseTo(
      scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid, rows, cols }),
      8,
    );
  });

  it('measures distance from the excluded anatomy in physical millimeters and keeps a global support floor', () => {
    const size = 128;
    const pixels = anatomicalPhantom(size, 0.23);
    const valid = new Uint8Array(pixels.length).fill(1);
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 56; row < 76; row++) exclusion.fill(1, row * size + 56, row * size + 76);
    const below = { firstRow: 85, firstColumn: 61 };
    const right = { firstRow: 61, firstColumn: 85 };
    for (const feature of [below, right]) {
      for (let row = feature.firstRow; row < feature.firstRow + 7; row++) {
        for (let column = feature.firstColumn; column < feature.firstColumn + 7; column++) {
          pixels[row * size + column] = (row - feature.firstRow + column - feature.firstColumn) % 3 === 0 ? 0.8 : 0.2;
        }
      }
    }
    const reference = {
      pixels,
      valid,
      rows: size,
      cols: size,
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
    };
    const tallPixels = prepareAnatomicalPlaneLandmarks(
      { ...reference, rowSpacingDsMm: 2, colSpacingDsMm: 0.5 },
      exclusion,
    );
    const widePixels = prepareAnatomicalPlaneLandmarks(
      { ...reference, rowSpacingDsMm: 0.5, colSpacingDsMm: 2 },
      exclusion,
    );
    expect(tallPixels?.bilateral).toBeDefined();
    expect(widePixels?.bilateral).toBeDefined();
    if (!tallPixels || !widePixels) return;
    const featureWeight = (weights: Float32Array, feature: typeof below) => {
      let total = 0;
      for (let row = feature.firstRow; row < feature.firstRow + 7; row++) {
        for (let column = feature.firstColumn; column < feature.firstColumn + 7; column++) {
          total += weights[row * size + column]!;
        }
      }
      return total;
    };
    expect(featureWeight(tallPixels.weights, below)).toBeLessThan(featureWeight(widePixels.weights, below) * 0.7);
    expect(featureWeight(widePixels.weights, right)).toBeLessThan(featureWeight(tallPixels.weights, right) * 0.7);
    expect(featureWeight(tallPixels.weights, below)).toBeGreaterThan(0);
    expect(featureWeight(widePixels.weights, right)).toBeGreaterThan(0);

    const withoutExclusion = prepareAnatomicalPlaneLandmarks({
      ...reference,
      rowSpacingDsMm: 2,
      colSpacingDsMm: 0.5,
    });
    const emptyExclusion = prepareAnatomicalPlaneLandmarks(
      { ...reference, rowSpacingDsMm: 2, colSpacingDsMm: 0.5 },
      new Uint8Array(pixels.length),
    );
    expect(withoutExclusion?.weights).toEqual(emptyExclusion?.weights);
  });

  it('preserves established global bilateral matching for a broad anatomical exclusion', () => {
    const { rows, cols, pixels, valid } = physicalBilateralAnatomy();
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 43; row < 85; row++) exclusion.fill(1, row * cols + 46, row * cols + 82);
    const reference = {
      pixels,
      valid,
      rows,
      cols,
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      frameOfReferenceUid: 'reference-frame',
    };
    const original = prepareAnatomicalPlaneLandmarks(reference, exclusion);
    const withAdjacentPlanes = prepareAnatomicalPlaneLandmarks(reference, exclusion, {
      previous: { ...reference, pixels: anatomicalPhantom(rows, 0.22), ippMm: { x: 0, y: 0, z: -1 } },
      next: { ...reference, pixels: anatomicalPhantom(rows, 0.24), ippMm: { x: 0, y: 0, z: 1 } },
    });

    expect(original?.bilateral?.reliable).toBe(true);
    expect(original?.localizedAnatomy).toBeUndefined();
    expect(withAdjacentPlanes?.weights).toEqual(original?.weights);
    expect(withAdjacentPlanes?.totalWeight).toBe(original?.totalWeight);
  });

  it('declines an image without supported enclosed anatomy', () => {
    const rows = 48;
    const cols = 48;
    const pixels = Float32Array.from({ length: rows * cols }, (_, index) =>
      index % cols > 5 && index % cols < 42 && Math.floor(index / cols) > 5 && Math.floor(index / cols) < 42 ? 0.5 : 0,
    );
    expect(prepareAnatomicalPlaneLandmarks({ pixels, rows, cols })).toBeNull();
  });

  it('matches physically anterior bilateral cavity morphology and rejects absent or oversized anatomy', () => {
    const { rows, cols, pixels, valid, prepared } = physicalBilateralAnatomy();
    expect(prepared?.bilateral).toBeDefined();
    if (!prepared) return;

    const correct = scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid, rows, cols });
    const oversized = scoreAnatomicalPlaneLandmarks(prepared, {
      pixels: anatomicalPhantom(rows, 0.23, 1.65),
      valid,
      rows,
      cols,
    });
    const structurallyWrong = Float32Array.from(pixels);
    for (let index = 0; index < structurallyWrong.length; index++) {
      if (prepared.weights[index] && structurallyWrong[index]! > 0.12) {
        structurallyWrong[index] = 0.95 - structurallyWrong[index]!;
      }
    }
    const matchedShapeWithWrongStructure = scoreAnatomicalPlaneLandmarks(prepared, {
      pixels: structurallyWrong,
      valid,
      rows,
      cols,
    });
    const missing = Float32Array.from(pixels);
    for (let row = 17; row < 42; row++) {
      for (let column = 34; column < 56; column++) {
        if (missing[row * cols + column] === 0) missing[row * cols + column] = 0.55;
      }
    }

    expect(correct).toBeGreaterThan(0.95);
    expect(correct).toBeGreaterThan(oversized + 0.25);
    expect(correct).toBeGreaterThan(matchedShapeWithWrongStructure + 0.1);
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels: missing, valid, rows, cols })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('does not let physically tiny distant bilateral remnants veto acquired anatomy near the selected region', () => {
    const size = 128;
    const pixels = anatomicalPhantom(size, 0.23, 0.28);
    const valid = new Uint8Array(pixels.length).fill(1);
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 52; row < 64; row++) exclusion.fill(1, row * size + 57, row * size + 72);
    const reference = {
      pixels,
      valid,
      rows: size,
      cols: size,
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      rowSpacingDsMm: 1.71875,
      colSpacingDsMm: 1.71875,
      frameOfReferenceUid: 'reference-frame',
    };
    const prepared = prepareAnatomicalPlaneLandmarks(reference, exclusion, {
      previous: { ...reference, ippMm: { x: 0, y: 0, z: -1 } },
      next: { ...reference, ippMm: { x: 0, y: 0, z: 1 } },
    });
    expect(prepared?.bilateral).toBeDefined();
    if (!prepared?.bilateral) return;
    expect(prepared.bilateral.reliable).toBe(false);
    expect(prepared.localizedAnatomy).toBe(true);
    const [left, right] = prepared.bilateral.components;
    const equivalentDiameterMm = 2 * Math.sqrt((Math.sqrt(left.area * right.area) * 1.71875 * 1.71875) / Math.PI);
    expect(equivalentDiameterMm).toBeLessThan(9);

    const withoutDistantRemnants = Float32Array.from(pixels);
    for (let row = 15; row < 45; row++) {
      for (let column = 25; column < 103; column++) {
        const index = row * size + column;
        if (withoutDistantRemnants[index] === 0) withoutDistantRemnants[index] = 0.5;
      }
    }
    const candidate = { pixels: withoutDistantRemnants, valid, rows: size, cols: size };
    expect(scoreAnatomicalPlaneLandmarks(prepared, candidate)).toBeGreaterThan(0.8);
    expect(minimumBilateralAnatomicalRetention(prepared, candidate)).toBe(Number.NEGATIVE_INFINITY);

    const broadExclusion = new Uint8Array(pixels.length);
    for (let row = 48; row < 88; row++) broadExclusion.fill(1, row * size + 45, row * size + 85);
    const broad = prepareAnatomicalPlaneLandmarks(reference, broadExclusion);
    expect(broad?.bilateral?.reliable).toBe(false);
    expect(broad?.localizedAnatomy).toBeUndefined();
    expect(scoreAnatomicalPlaneLandmarks(broad!, candidate)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('follows DICOM patient-space anatomy through image flips and a 90-degree acquisition rotation', () => {
    const size = 128;
    const pixels = anatomicalPhantom(size, 0.23);
    const valid = new Uint8Array(pixels.length).fill(1);
    const arrangements = [
      {
        pixels,
        ippMm: { x: 0, y: 0, z: 0 },
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: 1, z: 0 },
      },
      {
        pixels: Float32Array.from(pixels, (_value, index) => {
          const row = Math.floor(index / size);
          return pixels[(size - row - 1) * size + (index % size)]!;
        }),
        ippMm: { x: 0, y: size - 1, z: 0 },
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: -1, z: 0 },
      },
      {
        pixels: Float32Array.from(pixels, (_value, index) => {
          const row = Math.floor(index / size);
          return pixels[row * size + (size - (index % size) - 1)]!;
        }),
        ippMm: { x: size - 1, y: 0, z: 0 },
        rowDir: { x: -1, y: 0, z: 0 },
        colDir: { x: 0, y: 1, z: 0 },
      },
      {
        pixels: Float32Array.from(pixels, (_value, index) => {
          const row = Math.floor(index / size);
          const column = index % size;
          return pixels[(size - column - 1) * size + row]!;
        }),
        ippMm: { x: 0, y: size - 1, z: 0 },
        rowDir: { x: 0, y: -1, z: 0 },
        colDir: { x: 1, y: 0, z: 0 },
      },
    ];

    for (const arrangement of arrangements) {
      const prepared = prepareAnatomicalPlaneLandmarks({
        ...arrangement,
        valid,
        rows: size,
        cols: size,
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
      });
      expect(prepared?.bilateral).toBeDefined();
      if (!prepared) continue;
      expect(
        scoreAnatomicalPlaneLandmarks(prepared, { pixels: arrangement.pixels, valid, rows: size, cols: size }),
      ).toBeGreaterThan(0.95);
    }
  });

  it('exposes matched bilateral acquired-component retention even when a collapsed cavity still has finite overlap', () => {
    const { rows: size, pixels, valid, prepared } = physicalBilateralAnatomy();
    if (!prepared?.bilateral) throw new Error('Expected independently acquired bilateral reference cavities');
    const collapsed = anatomicalPhantom(size, 0.23, 0.52);

    expect(minimumBilateralAnatomicalRetention(prepared, { pixels, valid, rows: size, cols: size })).toBeCloseTo(1);
    expect(
      scoreAnatomicalPlaneLandmarks(prepared, { pixels: collapsed, valid, rows: size, cols: size }),
    ).toBeGreaterThan(0);
    expect(
      minimumBilateralAnatomicalRetention(prepared, { pixels: collapsed, valid, rows: size, cols: size }),
    ).toBeLessThan(0.35);
  });

  it('preserves stable intracranial depth landmarks in physically coronal and sagittal acquired planes', () => {
    const rows = 128;
    const cols = 128;
    const pixels = depthSensitivePhantom(rows);
    const valid = new Uint8Array(pixels.length).fill(1);
    const obliqueCoronalNormal = { x: 0.07832963233792313, y: 0.9943753077623679, z: 0.07128966271698724 };
    const coronalInPlaneLength = Math.hypot(obliqueCoronalNormal.x, obliqueCoronalNormal.z);
    const orientations = [
      {
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: -1, z: 0 },
      },
      {
        rowDir: { x: 0, y: 1, z: 0 },
        colDir: { x: 0, y: 0, z: 1 },
        normal: { x: 1, y: 0, z: 0 },
      },
      {
        rowDir: {
          x: obliqueCoronalNormal.z / coronalInPlaneLength,
          y: 0,
          z: -obliqueCoronalNormal.x / coronalInPlaneLength,
        },
        colDir: {
          x: (-obliqueCoronalNormal.y * obliqueCoronalNormal.x) / coronalInPlaneLength,
          y: coronalInPlaneLength,
          z: (-obliqueCoronalNormal.y * obliqueCoronalNormal.z) / coronalInPlaneLength,
        },
        normal: obliqueCoronalNormal,
      },
    ];

    for (const { rowDir, colDir, normal } of orientations) {
      const reference = {
        pixels,
        valid,
        rows,
        cols,
        ippMm: { x: 0, y: 0, z: 0 },
        rowDir,
        colDir,
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
      };
      const prepared = prepareDepthAwareLandmarks(reference, undefined, {
        previous: {
          ...reference,
          pixels: depthSensitivePhantom(rows, -1),
          ippMm: { x: -normal.x, y: -normal.y, z: -normal.z },
        },
        next: {
          ...reference,
          pixels: depthSensitivePhantom(rows, 1),
          ippMm: normal,
        },
      });
      expect(prepared).not.toBeNull();
      expect(prepared?.bilateral).toBeUndefined();
      if (!prepared) continue;
      const correct = scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid, rows, cols });
      const wrong = scoreAnatomicalPlaneLandmarks(prepared, {
        pixels: depthSensitivePhantom(rows, 2),
        valid,
        rows,
        cols,
      });
      const evolvingLesion = Float32Array.from(pixels);
      for (let row = 57; row < 68; row++) evolvingLesion.fill(20, row * cols + 57, row * cols + 68);
      const stableAnatomyWithChangedLesion = scoreAnatomicalPlaneLandmarks(prepared, {
        pixels: evolvingLesion,
        valid,
        rows,
        cols,
      });
      expect(correct).toBeGreaterThan(0.9);
      expect(correct).toBeGreaterThan(wrong + 0.08);
      expect(stableAnatomyWithChangedLesion).toBeGreaterThan(wrong + 0.05);
    }
  });

  it('keeps through-plane evidence acquired, geometrically coherent, and independent of an excluded lesion', () => {
    const rows = 128;
    const cols = 128;
    const pixels = depthSensitivePhantom(rows);
    const valid = new Uint8Array(pixels.length).fill(1);
    const exclusion = new Uint8Array(pixels.length);
    for (let row = 50; row < 76; row++) exclusion.fill(1, row * cols + 50, row * cols + 77);
    const reference = {
      pixels,
      valid,
      rows,
      cols,
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 0, z: 1 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      frameOfReferenceUid: 'reference-frame',
    };
    const previous = { ...reference, pixels: depthSensitivePhantom(rows, -1), ippMm: { x: 0, y: 1, z: 0 } };
    const next = { ...reference, pixels: depthSensitivePhantom(rows, 1), ippMm: { x: 0, y: -1, z: 0 } };
    const prepared = prepareDepthAwareLandmarks(reference, exclusion, { previous, next });
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const changedLesion = Float32Array.from(pixels);
    for (let index = 0; index < exclusion.length; index++) {
      if (exclusion[index]) changedLesion[index] = 25;
    }
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels: changedLesion, valid, rows, cols })).toBeGreaterThan(0.9);
    expect(
      scoreAnatomicalPlaneLandmarks(prepared, {
        pixels,
        valid: new Uint8Array(valid.length),
        rows,
        cols,
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
    expect(
      prepareDepthAwareLandmarks(reference, exclusion, {
        previous: { ...previous, valid: new Uint8Array(valid.length) },
        next: { ...next, valid: new Uint8Array(valid.length) },
      }),
    ).toBeNull();
    expect(
      prepareDepthAwareLandmarks(reference, exclusion, {
        previous,
        next: { ...next, rowDir: { x: 0, y: 1, z: 0 } },
      }),
    ).toBeNull();
    expect(
      prepareDepthAwareLandmarks(reference, exclusion, {
        previous,
        next: { ...next, frameOfReferenceUid: 'different-frame' },
      }),
    ).toBeNull();
  });

  it('trusts matched bilateral morphology when the reference already has physically symmetric orbits', () => {
    const { rows, cols, pixels, valid, prepared } = physicalBilateralAnatomy();
    if (!prepared?.bilateral) throw new Error('The physical orbital reference must be supported');
    const [left, right] = prepared.bilateral.components;
    expect(Math.min(left.area, right.area) / Math.max(left.area, right.area)).toBeGreaterThan(0.8);
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid, rows, cols })).toBeGreaterThan(0.95);
    const shifted = scoreAnatomicalPlaneLandmarks(prepared, {
      pixels: anatomicalPhantom(rows, 0.2),
      valid,
      rows,
      cols,
    });
    expect(shifted).toBeGreaterThan(0.16);
    expect(shifted).toBeLessThan(0.2);
  });

  it('penalizes a supported remnant that does not preserve the displayed orbital component', () => {
    const { rows, cols, pixels, valid, prepared } = physicalBilateralAnatomy();
    if (!prepared?.bilateral) throw new Error('The physical orbital reference must be supported');
    const remnant = Float32Array.from(pixels);
    for (let row = 18; row < 40; row++) {
      for (let column = 32; column < 57; column++) {
        const index = row * cols + column;
        if (remnant[index] === 0 && (row < 26 || row > 30 || column < 43 || column > 47)) remnant[index] = 0.55;
      }
    }
    const score = scoreAnatomicalPlaneLandmarks(prepared, { pixels: remnant, valid, rows, cols });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.009);
  });

  it('retains paired landmarks from anisotropic high-resolution acquisitions without inventing unsupported tissue', () => {
    const rows = 512;
    const cols = 1024;
    const reference = anatomicalPhantom(128, 0.23);
    const pixels = Float32Array.from({ length: rows * cols }, (_value, index) => {
      const row = Math.floor(index / cols);
      const column = index % cols;
      return reference[Math.floor((row * 128) / rows) * 128 + Math.floor((column * 128) / cols)]!;
    });
    const valid = new Uint8Array(pixels.length).fill(1);
    const geometry = {
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      rowSpacingDsMm: 0.5,
      colSpacingDsMm: 0.25,
    };
    const prepared = prepareAnatomicalPlaneLandmarks({ pixels, valid, rows, cols, ...geometry });
    expect(prepared?.bilateral).toBeDefined();
    if (!prepared) return;
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid, rows, cols })).toBeGreaterThan(0.95);

    const unsupportedSide = Uint8Array.from(valid);
    for (let row = 0; row < Math.floor(rows * 0.4); row++) {
      unsupportedSide.fill(0, row * cols, row * cols + Math.floor(cols / 2));
    }
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid: unsupportedSide, rows, cols })).toBe(
      Number.NEGATIVE_INFINITY,
    );

    const excludedSide = new Uint8Array(pixels.length);
    for (let row = Math.floor(rows * 0.15); row < Math.ceil(rows * 0.31); row++) {
      excludedSide.fill(1, row * cols + Math.floor(cols * 0.25), row * cols + Math.ceil(cols * 0.48));
    }
    expect(prepareAnatomicalPlaneLandmarks({ pixels, valid, rows, cols, ...geometry }, excludedSide)).toBeNull();
  });

  it('fails safely for incomplete, degenerate, and non-finite physical geometry', () => {
    const rows = 128;
    const cols = 128;
    const pixels = anatomicalPhantom(rows, 0.23);
    const valid = new Uint8Array(pixels.length).fill(1);
    const geometry = {
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
    };

    for (const invalid of [
      { ...geometry, colDir: undefined },
      { ...geometry, rowSpacingDsMm: 0 },
      { ...geometry, colSpacingDsMm: Number.POSITIVE_INFINITY },
      { ...geometry, ippMm: { x: Number.NaN, y: 0, z: 0 } },
      { ...geometry, colDir: { x: 1, y: 0, z: 0 } },
    ]) {
      expect(prepareAnatomicalPlaneLandmarks({ pixels, valid, rows, cols, ...invalid })).toBeNull();
    }
  });

  it('never accepts an unsupported, constant, malformed, or invented anatomical landmark', () => {
    const rows = 128;
    const cols = 128;
    const pixels = anatomicalPhantom();
    const valid = new Uint8Array(pixels.length).fill(1);
    const prepared = prepareAnatomicalPlaneLandmarks({ pixels, valid, rows, cols });
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const unsupported = Uint8Array.from(valid, (_value, index) => Number(prepared.weights[index] === 0));
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid: unsupported, rows, cols })).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(
      scoreAnatomicalPlaneLandmarks(prepared, {
        pixels: new Float32Array(pixels.length).fill(3),
        valid,
        rows,
        cols,
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreAnatomicalPlaneLandmarks(prepared, { pixels, valid: new Uint8Array(3), rows, cols })).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(prepareAnatomicalPlaneLandmarks({ pixels: new Float32Array(4), rows: 128, cols: 128 })).toBeNull();
    expect(prepareAnatomicalPlaneLandmarks({ pixels, rows, cols }, new Uint8Array(3))).toBeNull();
  });
});
