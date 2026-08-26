import { describe, expect, test } from 'vitest';
import { computeMindDescriptor2D, scoreMindDescriptorAgreement } from '../src/utils/mindDescriptor';
import {
  choosePerceptualWinner,
  normalizePerceptualSource,
  preparePerceptualReference,
  rankFixedCandidateSet,
  scoreAlignedCandidate,
  type PerceptualScaleComponents,
} from '../src/utils/perceptualSliceSimilarity';
import {
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  makeTissueLabelPhantom,
  relocateInternalStructures,
  remapForeground,
  renderTissueContrast,
} from './helpers/alignmentSynthetic';

function makePattern(size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 6; y < size - 6; y++) {
    for (let x = 7; x < size - 7; x++) {
      const ellipse = ((x - size / 2) / 9) ** 2 + ((y - size / 2) / 11) ** 2;
      if (ellipse <= 1) out[y * size + x] = 0.25 + 0.5 * (x / size);
    }
  }
  for (let y = 11; y < 18; y++) {
    for (let x = 10; x < 14; x++) out[y * size + x] = 0.95;
  }
  return out;
}

function tissueReference(size: number): Float32Array {
  return normalizePerceptualSource(renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST), size);
}

function translate(input: Float32Array, size: number, dx: number): Float32Array {
  const out = new Float32Array(input.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const targetX = x + dx;
      if (targetX >= 0 && targetX < size) out[y * size + targetX] = input[y * size + x] ?? 0;
    }
  }
  return out;
}

function flipHorizontally(input: Float32Array, size: number): Float32Array {
  const output = new Float32Array(input.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) output[y * size + (size - 1 - x)] = input[y * size + x] ?? 0;
  }
  return output;
}

function rankScale(
  overrides: Partial<PerceptualScaleComponents> & Pick<PerceptualScaleComponents, 'size'>,
): PerceptualScaleComponents {
  return {
    mind: 0.5,
    contrastStructure: 0.5,
    lncc: 0.5,
    ngf: 0.5,
    lowerQuartile: 0.5,
    ...overrides,
  };
}

function makeTenCandidateRankSet(structuralPositions: readonly number[], appearancePositions: readonly number[]) {
  return structuralPositions.map((structuralPosition, index) => {
    const structuralScore = structuralPosition / 9;
    const appearanceScore = (appearancePositions[index] ?? 0) / 9;
    return {
      index,
      components: {
        coverage: 1,
        perScale: [
          rankScale({
            size: 64,
            mind: structuralScore,
            ngf: structuralScore,
            contrastStructure: appearanceScore,
            lncc: appearanceScore,
          }),
        ],
      },
    };
  });
}

describe('perceptual slice scoring', () => {
  test('retains anatomical contrast after a signed modality intercept shifts every pixel below zero', () => {
    const size = 32;
    const labels = makeTissueLabelPhantom(size);
    const positive = renderTissueContrast(labels, REFERENCE_CONTRAST);
    const signed = Float32Array.from(positive, (value) => value * 500 - 1024);

    const normalizedPositive = normalizePerceptualSource(positive, size);
    const normalizedSigned = normalizePerceptualSource(signed, size);

    expect(normalizedSigned.some((value) => value > 0)).toBe(true);
    let maximumDifference = 0;
    for (let index = 0; index < normalizedSigned.length; index++) {
      maximumDifference = Math.max(maximumDifference, Math.abs(normalizedSigned[index] - normalizedPositive[index]));
    }
    expect(maximumDifference).toBeLessThan(1e-6);
  });

  test('preserves anatomical support and normalized values under positive and negative modality intercepts', () => {
    const original = Float32Array.from([0, 0, 0, 0, 0, 50, 100, 0, 0, 150, 200, 0, 0, 0, 0, 0]);
    const normalized = normalizePerceptualSource(original, 4);

    for (const intercept of [-1000, 1000]) {
      const shifted = normalizePerceptualSource(
        Float32Array.from(original, (value) => value + intercept),
        4,
      );
      expect(Array.from(shifted, (value) => value > 0)).toEqual(Array.from(normalized, (value) => value > 0));
      for (let index = 0; index < normalized.length; index++) {
        expect(shifted[index]).toBeCloseTo(normalized[index]!, 5);
      }
    }
  });

  test('does not allow explicitly invalid pixels to determine foreground or robust intensity percentiles', () => {
    const validity = Float32Array.from([0, 1, 1, 1]);
    const baseline = normalizePerceptualSource(Float32Array.from([0, 100, 150, 200]), 2, { validity });
    const changedPadding = normalizePerceptualSource(Float32Array.from([-2000, 100, 150, 200]), 2, { validity });

    expect(baseline[0]).toBe(0);
    expect(changedPadding[0]).toBe(0);
    for (let index = 1; index < baseline.length; index++) {
      expect(changedPadding[index]).toBeCloseTo(baseline[index]!, 5);
    }
  });

  test('omits invalid reference footprints from structural descriptors and fixed-domain coverage', () => {
    const size = 64;
    const validity = new Float32Array(size * size).fill(1);
    for (let y = 28; y < 36; y++) {
      for (let x = 28; x < 36; x++) validity[y * size + x] = 0;
    }
    const reference = normalizePerceptualSource(
      renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
      size,
      { validity },
    );
    const prepared = preparePerceptualReference(reference, size, { scales: [64, 32], validity });

    expect(prepared.scales[0]!.weights[32 * size + 32]).toBe(0);
    expect(prepared.scales[0]!.weights[27 * size + 32]).toBe(0);
    expect(prepared.scales.every((scale) => scale.totalWeight > 0)).toBe(true);

    const premultipliedCandidate = Float32Array.from(reference, (value, index) => value * validity[index]!);
    const score = scoreAlignedCandidate(prepared, premultipliedCandidate, validity, size);
    expect(score.coverage).toBeGreaterThan(0.99);
  });

  test.each([
    ['nonfunctional LUT', (labels: Uint8Array) => renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST)],
    [
      'gamma remap',
      (labels: Uint8Array) =>
        remapForeground(renderTissueContrast(labels, REFERENCE_CONTRAST), (value) => value ** 2.2),
    ],
    [
      'sigmoid remap',
      (labels: Uint8Array) =>
        remapForeground(
          renderTissueContrast(labels, REFERENCE_CONTRAST),
          (value) => 1 / (1 + Math.exp(-10 * (value - 0.5))),
        ),
    ],
  ])('MIND preserves matching local structure under %s', (_name, renderCandidate) => {
    const size = 64;
    const labels = makeTissueLabelPhantom(size);
    const reference = normalizePerceptualSource(renderTissueContrast(labels, REFERENCE_CONTRAST), size);
    const matching = normalizePerceptualSource(renderCandidate(labels), size);
    const wrong = normalizePerceptualSource(
      renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST),
      size,
    );
    const validity = new Float32Array(size * size).fill(1);
    const prepared = preparePerceptualReference(reference, size, {
      scales: [64, 32],
    });

    const matchScore = scoreAlignedCandidate(prepared, matching, validity, size);
    const wrongScore = scoreAlignedCandidate(prepared, wrong, validity, size);

    expect(matchScore.perScale.map((scale) => scale.size)).toEqual([64, 32]);
    expect(
      matchScore.perScale.every((scale) => Number.isFinite(scale.mind) && Number.isFinite(scale.rawMindDistance)),
    ).toBe(true);
    expect(matchScore.perScale.every((scale, index) => scale.mind > (wrongScore.perScale[index]?.mind ?? 1))).toBe(
      true,
    );
  });

  test('matches direct MIND descriptor agreement at one scale', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const candidate = flipHorizontally(reference, size);
    const validity = new Float32Array(reference.length).fill(1);
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });

    const score = scoreAlignedCandidate(prepared, candidate, validity, size);
    const preparedScale = prepared.scales[0];
    const direct = scoreMindDescriptorAgreement(
      preparedScale.mind,
      computeMindDescriptor2D(candidate, size),
      preparedScale.weights,
      validity,
    );

    expect(score.perScale[0].mind).toBeCloseTo(direct.score, 10);
    expect(score.perScale[0].rawMindDistance).toBeCloseTo(direct.meanDistance, 10);
  });

  test('excluded high-contrast pathology cannot change the source-space normalization basis', () => {
    const size = 32;
    const exclusionRect = { x: 0.35, y: 0.35, width: 0.25, height: 0.25 };
    const baseline = makePattern(size);
    const withBrightExclusion = Float32Array.from(baseline);
    const validity = Float32Array.from(baseline, (_value, index) => Number(index !== 13 * size + 13));
    const options = { exclusionRect, validity };
    for (let y = 12; y < 19; y++) {
      for (let x = 12; x < 19; x++) withBrightExclusion[y * size + x] = 100;
    }

    const normalizedBaseline = normalizePerceptualSource(baseline, size, options);
    const normalizedChanged = normalizePerceptualSource(withBrightExclusion, size, options);
    const preserved = normalizePerceptualSource(withBrightExclusion, size, {
      ...options,
      preserveExcludedIntensity: true,
    });

    expect(normalizedChanged[12 * size + 12]).toBe(1);
    expect(preserved[12 * size + 12]).toBeGreaterThan(1);
    expect(preserved[13 * size + 13]).toBe(0);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const excluded = x >= 11 && x < 20 && y >= 11 && y < 20;
        if (!excluded) {
          expect(normalizedChanged[y * size + x]).toBeCloseTo(normalizedBaseline[y * size + x], 6);
          expect(preserved[y * size + x]).toBe(normalizedChanged[y * size + x]);
        }
      }
    }
  });

  test('does not fall back to excluded pixels when no normalization foreground remains outside them', () => {
    const size = 16;
    const excludedOnly = new Float32Array(size * size);
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) excludedOnly[y * size + x] = 100;
    }

    for (const preserveExcludedIntensity of [false, true]) {
      const normalized = normalizePerceptualSource(excludedOnly, size, {
        exclusionRect: { x: 5 / size, y: 5 / size, width: 6 / size, height: 6 / size },
        preserveExcludedIntensity,
      });

      expect(Array.from(normalized).every((value) => value === 0)).toBe(true);
    }
  });

  test('keeps the same structure strong under foreground brightness and contrast remapping', () => {
    const size = 32;
    const referenceSource = makePattern(size);
    const remappedSource = Float32Array.from(referenceSource, (value) => (value > 0 ? 0.15 + value * 0.65 : 0));
    const reference = normalizePerceptualSource(referenceSource, size);
    const remapped = normalizePerceptualSource(remappedSource, size);
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const score = scoreAlignedCandidate(prepared, remapped, validity, size);
    const exact = scoreAlignedCandidate(prepared, reference, validity, size);

    expect(score.coverage).toBeGreaterThan(0.99);
    expect(score.perScale[0].contrastStructure).toBeGreaterThan(0.95);
    expect(score.perScale[0].lncc).toBeGreaterThan(0.95);
    expect(score.perScale[0].ngf).toBeCloseTo(exact.perScale[0].ngf, 2);
  });

  test('penalizes missing candidate support against the fixed reference denominator', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const fullValidity = new Float32Array(reference.length).fill(1);
    const croppedValidity = new Float32Array(reference.length).fill(1);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) croppedValidity[y * size + x] = 0;
    }

    const full = scoreAlignedCandidate(prepared, reference, fullValidity, size);
    const cropped = scoreAlignedCandidate(prepared, reference, croppedValidity, size);

    expect(full.coverage).toBeGreaterThan(0.99);
    expect(cropped.coverage).toBeLessThan(0.7);
    expect(cropped.perScale[0].contrastStructure).toBeLessThan(full.perScale[0].contrastStructure - 0.2);
    expect(cropped.perScale[0].lncc).toBeLessThan(full.perScale[0].lncc - 0.2);
    expect(cropped.perScale[0].mind).toBeLessThan(full.perScale[0].mind - 0.2);
  });

  test('uses fractional validity once rather than treating premultiplied boundary pixels as darker anatomy', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const premultiplied = Float32Array.from(reference, (value) => value * 0.5);
    const validity = new Float32Array(reference.length).fill(0.5);
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });

    const score = scoreAlignedCandidate(prepared, premultiplied, validity, size);

    expect(score.coverage).toBeCloseTo(0.5, 6);
    expect(score.perScale[0].contrastStructure).toBeCloseTo(0.5, 2);
    expect(score.perScale[0].lncc).toBeCloseTo(0.5, 2);
    expect(score.perScale[0].mind).toBeCloseTo(0.5, 2);
  });

  test('does not let shared black background outweigh displaced anatomy', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const displaced = scoreAlignedCandidate(prepared, translate(reference, size, 5), validity, size);

    expect(exact.perScale[0].contrastStructure).toBeGreaterThan(displaced.perScale[0].contrastStructure);
    expect(exact.perScale[0].ngf).toBeGreaterThan(displaced.perScale[0].ngf);
  });

  test('keeps outer canvas outside the reference anatomical domain', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const targetOnlyCanvasStructure = Float32Array.from(reference);
    for (let y = 4; y < size - 4; y++) {
      for (let x = 4; x < size - 4; x++) {
        const ellipseDistance = ((x - size / 2) / 9) ** 2 + ((y - size / 2) / 11) ** 2;
        if (ellipseDistance > 2.4) {
          targetOnlyCanvasStructure[y * size + x] = (x + y) % 2 === 0 ? 1 : 0.2;
        }
      }
    }
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const canvasChanged = scoreAlignedCandidate(prepared, targetOnlyCanvasStructure, validity, size);

    expect(canvasChanged.perScale[0].contrastStructure).toBeCloseTo(exact.perScale[0].contrastStructure, 6);
    expect(canvasChanged.perScale[0].lncc).toBeCloseTo(exact.perScale[0].lncc, 6);
    expect(canvasChanged.perScale[0].ngf).toBeCloseTo(exact.perScale[0].ngf, 6);
  });

  test('rejects wrong local structure even when the candidate has exactly the same histogram', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const histogramMatchedWrongSlice = flipHorizontally(reference, size);
    expect(Array.from(histogramMatchedWrongSlice).sort()).toEqual(Array.from(reference).sort());
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const wrong = scoreAlignedCandidate(prepared, histogramMatchedWrongSlice, validity, size);

    expect(wrong.perScale[0].contrastStructure).toBeLessThan(exact.perScale[0].contrastStructure);
    expect(wrong.perScale[0].ngf).toBeLessThan(exact.perScale[0].ngf);
  });

  test('keeps missing anatomy in the denominator even when geometric validity is full', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const missing = Float32Array.from(reference);
    for (let y = 11; y < 18; y++) {
      for (let x = 10; x < 14; x++) missing[y * size + x] = 0;
    }
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const score = scoreAlignedCandidate(prepared, missing, validity, size);

    expect(score.coverage).toBeCloseTo(1, 6);
    expect(score.perScale[0].contrastStructure).toBeLessThan(exact.perScale[0].contrastStructure);
    expect(score.perScale[0].ngf).toBeLessThan(exact.perScale[0].ngf);
  });

  test('penalizes a target-only boundary inside the reference anatomical domain', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const addedBoundary = Float32Array.from(reference);
    for (let y = 12; y < 21; y++) addedBoundary[y * size + 20] = 1;
    const prepared = preparePerceptualReference(reference, size, { scales: [32] });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const score = scoreAlignedCandidate(prepared, addedBoundary, validity, size);

    expect(score.perScale[0].ngf).toBeLessThan(exact.perScale[0].ngf);
  });

  test('gives supported healthy anatomy near an excluded lesion more influence without discarding distant anatomy', () => {
    const size = 96;
    const reference = tissueReference(size);
    const exclusionRect = { x: 42 / size, y: 42 / size, width: 12 / size, height: 12 / size };
    const original = preparePerceptualReference(reference, size, { scales: [size] }).scales[0]!;
    const focused = preparePerceptualReference(reference, size, { scales: [size], exclusionRect }).scales[0]!;
    const near = 48 * size + 62;
    const distant = 48 * size + 17;

    expect(original.weights[near]).toBeGreaterThan(0);
    expect(original.weights[distant]).toBeGreaterThan(0);
    expect(focused.weights[near]! / original.weights[near]!).toBeGreaterThan(
      (focused.weights[distant]! / original.weights[distant]!) * 1.5,
    );
    expect(focused.weights[distant]).toBeGreaterThan(0);

    for (let row = 42; row < 54; row++) {
      for (let column = 42; column < 54; column++) {
        expect(focused.weights[row * size + column]).toBe(0);
      }
    }
  });

  test('retains lesion-focused anatomical weighting after expanding its safety exclusion margin', () => {
    const size = 96;
    const reference = tissueReference(size);
    const focusRect = { x: 42 / size, y: 42 / size, width: 12 / size, height: 12 / size };
    const exclusionRect = { x: 0.32, y: 0.32, width: 0.36, height: 0.36 };
    const unfocused = preparePerceptualReference(reference, size, { scales: [size], exclusionRect }).scales[0]!;
    const focused = preparePerceptualReference(reference, size, {
      scales: [size],
      exclusionRect,
      focusRect,
    }).scales[0]!;
    const near = 48 * size + 71;
    const distant = 48 * size + 17;

    expect(unfocused.weights[near]).toBeGreaterThan(0);
    expect(unfocused.weights[distant]).toBeGreaterThan(0);
    expect(focused.weights[near]! / unfocused.weights[near]!).toBeGreaterThan(
      (focused.weights[distant]! / unfocused.weights[distant]!) * 1.25,
    );
    expect(focused.weights[distant]).toBeGreaterThan(0);
    expect(focused.weights[48 * size + 62]).toBe(0);
  });

  test('prefers matching healthy anatomy near the lesion when more distant structures disagree', () => {
    const size = 96;
    const reference = tissueReference(size);
    const exclusionRect = { x: 42 / size, y: 42 / size, width: 12 / size, height: 12 / size };
    const nearbyMatches = Float32Array.from(reference);
    const distantMatches = Float32Array.from(reference);
    for (let row = 26; row < 70; row++) {
      for (let column = 12; column < 27; column++) {
        const index = row * size + column;
        if (nearbyMatches[index]) nearbyMatches[index] = 1.05 - nearbyMatches[index]!;
      }
    }
    for (let row = 34; row < 65; row++) {
      for (let column = 60; column < 76; column++) {
        const index = row * size + column;
        if (distantMatches[index]) distantMatches[index] = 1.05 - distantMatches[index]!;
      }
    }

    const validity = new Float32Array(reference.length).fill(1);
    const unfocused = preparePerceptualReference(reference, size, { scales: [size] });
    const focused = preparePerceptualReference(reference, size, { scales: [size], exclusionRect });
    const rank = (prepared: ReturnType<typeof preparePerceptualReference>) =>
      rankFixedCandidateSet(
        [
          { index: 0, components: scoreAlignedCandidate(prepared, nearbyMatches, validity, size) },
          { index: 1, components: scoreAlignedCandidate(prepared, distantMatches, validity, size) },
        ],
        1,
      );

    expect(choosePerceptualWinner(rank(unfocused), 1).index).toBe(1);
    expect(choosePerceptualWinner(rank(focused), 1).index).toBe(0);
  });

  test('preserves global healthy-anatomy weighting when the selected exclusion is broad', () => {
    const size = 96;
    const reference = tissueReference(size);
    const global = preparePerceptualReference(reference, size, { scales: [size] }).scales[0]!;
    const excluded = preparePerceptualReference(reference, size, {
      scales: [size],
      exclusionRect: { x: 0.32, y: 0.31, width: 0.36, height: 0.34 },
    }).scales[0]!;

    expect(excluded.totalWeight).toBeLessThan(global.totalWeight);
    expect(excluded.weights.every((weight, index) => weight === 0 || weight === global.weights[index])).toBe(true);
  });

  test('dilates the exclusion so a high-contrast change cannot leak into local windows or gradients', () => {
    const size = 32;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const changed = Float32Array.from(reference);
    for (let y = 12; y < 17; y++) {
      for (let x = 12; x < 17; x++) changed[y * size + x] = (x + y) % 2;
    }
    const prepared = preparePerceptualReference(reference, size, {
      scales: [32],
      exclusionRect: { x: 12 / size, y: 12 / size, width: 5 / size, height: 5 / size },
    });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const changedScore = scoreAlignedCandidate(prepared, changed, validity, size);

    expect(changedScore.perScale[0].contrastStructure).toBeCloseTo(exact.perScale[0].contrastStructure, 6);
    expect(changedScore.perScale[0].lncc).toBeCloseTo(exact.perScale[0].lncc, 6);
    expect(changedScore.perScale[0].ngf).toBeCloseTo(exact.perScale[0].ngf, 6);
  });

  test('preserves 64 px local-window and gradient scores outside the dilated exclusion', () => {
    const size = 64;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const changed = Float32Array.from(reference);
    for (let y = 28; y < 35; y++) {
      for (let x = 28; x < 35; x++) changed[y * size + x] = (x + y) % 2;
    }
    const prepared = preparePerceptualReference(reference, size, {
      scales: [64],
      exclusionRect: {
        x: 28 / size,
        y: 28 / size,
        width: 7 / size,
        height: 7 / size,
      },
    });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const changedScore = scoreAlignedCandidate(prepared, changed, validity, size);

    expect(changedScore.perScale[0].contrastStructure).toBeCloseTo(exact.perScale[0].contrastStructure, 6);
    expect(changedScore.perScale[0].lncc).toBeCloseTo(exact.perScale[0].lncc, 6);
    expect(changedScore.perScale[0].ngf).toBeCloseTo(exact.perScale[0].ngf, 6);
  });

  test('dilates the exclusion beyond the MIND descriptor footprint', () => {
    const size = 64;
    const reference = normalizePerceptualSource(makePattern(size), size);
    const changed = Float32Array.from(reference);
    for (let y = 28; y < 35; y++) {
      for (let x = 28; x < 35; x++) changed[y * size + x] = (x + y) % 2;
    }
    const prepared = preparePerceptualReference(reference, size, {
      scales: [64],
      exclusionRect: {
        x: 28 / size,
        y: 28 / size,
        width: 7 / size,
        height: 7 / size,
      },
    });
    const validity = new Float32Array(reference.length).fill(1);

    const exact = scoreAlignedCandidate(prepared, reference, validity, size);
    const changedScore = scoreAlignedCandidate(prepared, changed, validity, size);

    expect(changedScore.perScale[0].mind).toBeCloseTo(exact.perScale[0].mind, 6);
  });
});

describe('rankFixedCandidateSet', () => {
  test('assigns deterministic midranks when only some raw component values are tied', () => {
    const ranked = rankFixedCandidateSet(
      [
        {
          index: 0,
          components: {
            coverage: 1,
            perScale: [rankScale({ size: 32, contrastStructure: 0.2 })],
          },
        },
        {
          index: 1,
          components: {
            coverage: 1,
            perScale: [rankScale({ size: 32, contrastStructure: 0.2 })],
          },
        },
        {
          index: 2,
          components: {
            coverage: 1,
            perScale: [rankScale({ size: 32, contrastStructure: 0.8 })],
          },
        },
      ],
      1,
    );

    expect(ranked[0].appearanceRank).toBeCloseTo(1 / 3, 10);
    expect(ranked[1].appearanceRank).toBeCloseTo(1 / 3, 10);
    expect(ranked[2].appearanceRank).toBeCloseTo(5 / 6, 10);
    expect(ranked.every((candidate) => candidate.mindActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.boundaryActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.structuralActive === false)).toBe(true);
  });

  test('two structural channels outweigh an appearance-favored distractor', () => {
    const ranked = rankFixedCandidateSet(
      [
        {
          index: 4,
          components: {
            coverage: 1,
            perScale: [
              rankScale({
                size: 64,
                mind: 0.9,
                contrastStructure: 0.2,
                lncc: 0.2,
                ngf: 0.9,
                lowerQuartile: 0.7,
              }),
            ],
          },
        },
        {
          index: 5,
          components: {
            coverage: 1,
            perScale: [
              rankScale({
                size: 64,
                mind: 0.2,
                contrastStructure: 0.95,
                lncc: 0.95,
                ngf: 0.2,
                lowerQuartile: 0.3,
              }),
            ],
          },
        },
      ],
      5,
    );

    expect(ranked.find((candidate) => candidate.index === 4)?.perceptualRank).toBeGreaterThan(
      ranked.find((candidate) => candidate.index === 5)?.perceptualRank ?? 0,
    );
  });

  test('drops flat MIND and appearance channels while NGF discriminates', () => {
    const ranked = rankFixedCandidateSet(
      [
        {
          index: 0,
          components: {
            coverage: 1,
            perScale: [rankScale({ size: 32, ngf: 0.2 })],
          },
        },
        {
          index: 1,
          components: {
            coverage: 1,
            perScale: [rankScale({ size: 32, ngf: 0.8 })],
          },
        },
      ],
      0,
    );

    const lower = ranked.find((candidate) => candidate.index === 0);
    const higher = ranked.find((candidate) => candidate.index === 1);
    expect(lower?.boundaryRank).toBeCloseTo(0.25, 10);
    expect(higher?.boundaryRank).toBeCloseTo(0.75, 10);
    expect(higher?.perceptualRank).toBeGreaterThan(lower?.perceptualRank ?? 0);
    expect(ranked.every((candidate) => candidate.mindActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.boundaryActive === true)).toBe(true);
    expect(ranked.every((candidate) => candidate.structuralActive === true)).toBe(true);
    expect(ranked.every((candidate) => candidate.appearanceActive === false)).toBe(true);
  });

  test('falls back to appearance when both structural families are flat', () => {
    const ranked = rankFixedCandidateSet(
      [
        {
          index: 0,
          components: {
            coverage: 1,
            perScale: [
              rankScale({
                size: 32,
                contrastStructure: 0.2,
                lncc: 0.2,
              }),
            ],
          },
        },
        {
          index: 1,
          components: {
            coverage: 1,
            perScale: [
              rankScale({
                size: 32,
                contrastStructure: 0.8,
                lncc: 0.8,
              }),
            ],
          },
        },
      ],
      0,
    );

    expect(ranked[0].appearanceRank).toBeCloseTo(0.25, 10);
    expect(ranked[1].appearanceRank).toBeCloseTo(0.75, 10);
    expect(ranked[0].perceptualRank).toBeCloseTo(0.25, 10);
    expect(ranked[1].perceptualRank).toBeCloseTo(0.75, 10);
    expect(ranked.every((candidate) => candidate.mindActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.boundaryActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.structuralActive === false)).toBe(true);
    expect(ranked.every((candidate) => candidate.appearanceActive === true)).toBe(true);
  });

  test('uses seed distance only as the all-flat prior', () => {
    const ranked = rankFixedCandidateSet(
      [2, 5, 8].map((index) => ({
        index,
        components: {
          coverage: 1,
          perScale: [rankScale({ size: 32 })],
        },
      })),
      5,
    );

    expect(ranked.map((candidate) => candidate.perceptualRank)).toEqual([1 / 3, 5 / 6, 1 / 3]);
    expect(
      ranked.every(
        (candidate) =>
          !candidate.mindActive &&
          !candidate.boundaryActive &&
          !candidate.structuralActive &&
          !candidate.appearanceActive,
      ),
    ).toBe(true);
  });

  test('enforces the 0.25 structure-lead boundary with ten unique midranks', () => {
    const appearancePositions = [1, 2, 3, 4, 0, 9, 5, 6, 7, 8];
    const clearStructure = rankFixedCandidateSet(
      makeTenCandidateRankSet([0, 1, 2, 3, 7, 4, 5, 6, 8, 9], appearancePositions),
      5,
    );
    const closeStructure = rankFixedCandidateSet(
      makeTenCandidateRankSet([0, 1, 2, 3, 5, 4, 6, 7, 8, 9], appearancePositions),
      4,
    );

    const clear = clearStructure[4];
    const appearanceFavored = clearStructure[5];
    expect(clear.mindRank).toBeCloseTo(0.75, 10);
    expect(clear.boundaryRank).toBeCloseTo(0.75, 10);
    expect(clear.structuralRank).toBeCloseTo(0.75, 10);
    expect(clear.appearanceRank).toBeCloseTo(0.05, 10);
    expect(appearanceFavored.mindRank).toBeCloseTo(0.45, 10);
    expect(appearanceFavored.boundaryRank).toBeCloseTo(0.45, 10);
    expect(appearanceFavored.structuralRank).toBeCloseTo(0.45, 10);
    expect(appearanceFavored.appearanceRank).toBeCloseTo(0.95, 10);
    expect(clear.perceptualRank).toBeCloseTo(0.61, 10);
    expect(appearanceFavored.perceptualRank).toBeCloseTo(0.55, 10);
    expect(clear.perceptualRank).toBeGreaterThan(appearanceFavored.perceptualRank);
    expect(choosePerceptualWinner([clear, appearanceFavored], 5).index).toBe(4);
    expect(
      clearStructure.every(
        (candidate) =>
          candidate.mindActive && candidate.boundaryActive && candidate.structuralActive && candidate.appearanceActive,
      ),
    ).toBe(true);

    const close = closeStructure[4];
    const closeAppearanceFavored = closeStructure[5];
    expect(close.structuralRank).toBeCloseTo(0.55, 10);
    expect(close.appearanceRank).toBeCloseTo(0.05, 10);
    expect(closeAppearanceFavored.structuralRank).toBeCloseTo(0.45, 10);
    expect(closeAppearanceFavored.appearanceRank).toBeCloseTo(0.95, 10);
    expect(close.perceptualRank).toBeCloseTo(0.45, 10);
    expect(closeAppearanceFavored.perceptualRank).toBeCloseTo(0.55, 10);
    expect(closeAppearanceFavored.perceptualRank).toBeGreaterThan(close.perceptualRank);
    expect(choosePerceptualWinner([close, closeAppearanceFavored], 4).index).toBe(5);
  });

  test('balances structural families after averaging active scales within each family', () => {
    const values = [0.1, 0.3, 0.6, 0.9];
    const mindPositionsByCandidate = [
      [3, 2, 1],
      [0, 0, 0],
      [1, 1, 2],
      [2, 3, 3],
    ];
    const ngfPositions = [0, 1, 2, 3];
    const candidates = mindPositionsByCandidate.map((mindPositions, index) => ({
      index,
      components: {
        coverage: 1,
        perScale: [
          rankScale({
            size: 256,
            mind: values[mindPositions[0] ?? 0],
          }),
          rankScale({
            size: 128,
            mind: values[mindPositions[1] ?? 0],
          }),
          rankScale({
            size: 64,
            mind: values[mindPositions[2] ?? 0],
            ngf: values[ngfPositions[index] ?? 0],
          }),
        ],
      },
    }));

    const ranked = rankFixedCandidateSet(candidates, 0);
    const candidate = ranked[0];

    expect(candidate.mindRank).toBeCloseTo((0.875 + 0.625 + 0.375) / 3, 10);
    expect(candidate.boundaryRank).toBeCloseTo(0.125, 10);
    expect(candidate.structuralRank).toBeCloseTo((candidate.mindRank + candidate.boundaryRank) / 2, 10);
    expect(candidate.structuralRank).toBeCloseTo(0.375, 10);
    expect(candidate.mindActive).toBe(true);
    expect(candidate.boundaryActive).toBe(true);
    expect(candidate.structuralActive).toBe(true);
  });
});

describe('choosePerceptualWinner', () => {
  test('prefers a higher final rank even when it is farther from the seed', () => {
    const candidates = [
      { index: 5, perceptualRank: 0.5 },
      { index: 9, perceptualRank: 0.500001 },
    ];

    expect(choosePerceptualWinner(candidates, 5)).toBe(candidates[1]);
  });

  test('breaks an exact final tie by seed distance and then ascending index', () => {
    const candidates = [
      { index: 9, perceptualRank: 0.6 },
      { index: 6, perceptualRank: 0.6 },
      { index: 4, perceptualRank: 0.6 },
    ];

    expect(choosePerceptualWinner(candidates, 5)).toBe(candidates[2]);
  });

  test('selects the seed-distance prior when every metric channel is flat', () => {
    const ranked = rankFixedCandidateSet(
      [2, 5, 8].map((index) => ({
        index,
        components: {
          coverage: 1,
          perScale: [rankScale({ size: 32 })],
        },
      })),
      5,
    );

    expect(choosePerceptualWinner(ranked, 5).index).toBe(5);
  });

  test('rejects an empty fine-candidate universe', () => {
    expect(() => choosePerceptualWinner([], 5)).toThrow('Align All produced no fine slice candidates');
  });
});
