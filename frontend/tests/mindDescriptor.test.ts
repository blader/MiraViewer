import { expect, test } from 'vitest';
import {
  computeMindDescriptor2D,
  createMindDescriptorScratch,
  scoreMindDescriptorAgreement,
} from '../src/utils/mindDescriptor';
import {
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  Tissue,
  countConnectedComponents,
  labelTouchesLabel,
  makeTissueLabelPhantom,
  normalizedLabelCentroid,
  relocateInternalStructures,
  remapForeground,
  renderMovingFromFixed,
  renderTissueContrast,
  translateZeroFilled,
} from './helpers/alignmentSynthetic';

test('wrong-structure fixture preserves label counts and rendered histogram', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const wrongLabels = relocateInternalStructures(labels, size);
  const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const wrong = renderTissueContrast(wrongLabels, REFERENCE_CONTRAST);

  expect(Array.from(wrongLabels).sort()).toEqual(Array.from(labels).sort());
  expect(Array.from(wrong).sort()).toEqual(Array.from(reference).sort());
  expect(wrong).not.toEqual(reference);
});

test('nonfunctional contrast is not an affine remap of the reference', () => {
  const labels = makeTissueLabelPhantom(64);
  const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const changed = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);

  const referenceA = REFERENCE_CONTRAST[1];
  const referenceB = REFERENCE_CONTRAST[2];
  const changedA = NONFUNCTIONAL_CONTRAST[1];
  const changedB = NONFUNCTIONAL_CONTRAST[2];
  const scale = (changedB - changedA) / (referenceB - referenceA);
  const offset = changedA - scale * referenceA;

  expect(changed).not.toEqual(reference);
  expect(changed.every((value, index) => reference[index] !== 0 || value === 0)).toBe(true);
  expect(NONFUNCTIONAL_CONTRAST[3]).not.toBeCloseTo(scale * REFERENCE_CONTRAST[3] + offset, 6);
});

test.each([32, 64, 128, 256])('phantom preserves its structural labels at %ipx', (size) => {
  const labels = makeTissueLabelPhantom(size);
  for (const label of [Tissue.outer, Tissue.inner, Tissue.orbit, Tissue.nerve, Tissue.ventricle, Tissue.landmark]) {
    expect(labels.includes(label)).toBe(true);
  }
  expect(countConnectedComponents(labels, size, Tissue.orbit)).toBe(2);
  expect(countConnectedComponents(labels, size, Tissue.ventricle)).toBe(2);
  expect(labelTouchesLabel(labels, size, Tissue.nerve, Tissue.orbit)).toBe(true);
  expect(labelTouchesLabel(labels, size, Tissue.nerve, Tissue.inner)).toBe(true);
  expect(normalizedLabelCentroid(labels, size, Tissue.landmark).x).toBeGreaterThan(0.5);
});

test('remapping and translation preserve canvas and signed direction', () => {
  const pixels = new Float32Array([0, 0.25, 0.75, 1]);
  expect(Array.from(remapForeground(pixels, (value) => value * 2))).toEqual([0, 0.5, 1, 1]);

  const translated = translateZeroFilled(new Float32Array([1, 0, 0, 0]), 2, 1, 1);
  expect(Array.from(translated)).toEqual([0, 0, 0, 1]);
});

test('independent affine fixture renderer follows moving-to-fixed direction', () => {
  const fixed = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const moving = renderMovingFromFixed(fixed, 3, {
    A: { m00: 1, m01: 0, m10: 0, m11: 1 },
    b: { x: -1, y: 0 },
  });
  expect(Array.from(moving)).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test('same anatomy under nonfunctional contrast beats an exact-histogram wrong structure', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const referencePixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const matchingPixels = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);
  const wrongPixels = renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST);
  const weights = Float32Array.from(labels, (label) => (label === Tissue.canvas ? 0 : 1));
  const validity = new Float32Array(size * size).fill(1);

  const reference = computeMindDescriptor2D(referencePixels, size);
  const matching = scoreMindDescriptorAgreement(
    reference,
    computeMindDescriptor2D(matchingPixels, size),
    weights,
    validity,
  );
  const wrong = scoreMindDescriptorAgreement(reference, computeMindDescriptor2D(wrongPixels, size), weights, validity);

  expect(matching.score).toBeGreaterThan(wrong.score);
  expect(matching.meanDistance).toBeLessThan(wrong.meanDistance);
});

test('descriptor agreement keeps invalid footprint in the fixed denominator', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const pixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const descriptor = computeMindDescriptor2D(pixels, size);
  const weights = Float32Array.from(labels, (label) => (label === Tissue.canvas ? 0 : 1));
  const full = new Float32Array(size * size).fill(1);
  const cropped = new Float32Array(size * size).fill(1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2; x++) cropped[y * size + x] = 0;
  }

  const fullScore = scoreMindDescriptorAgreement(descriptor, descriptor, weights, full);
  const croppedScore = scoreMindDescriptorAgreement(descriptor, descriptor, weights, cropped);

  expect(fullScore.score).toBeGreaterThan(croppedScore.score);
  expect(fullScore.coverageNumerator).toBeGreaterThan(croppedScore.coverageNumerator);
});

test('self agreement is exact and descriptor borders are explicitly invalid', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const pixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const descriptor = computeMindDescriptor2D(pixels, size);
  const weights = Float32Array.from(labels, (label) => (label === Tissue.canvas ? 0 : 1));
  const validity = new Float32Array(size * size).fill(1);
  const self = scoreMindDescriptorAgreement(descriptor, descriptor, weights, validity);

  expect(descriptor.footprintRadius).toBe(2);
  expect(descriptor.validCenters[0]).toBe(0);
  expect(descriptor.validCenters[2 * size + 2]).toBe(1);
  expect(self.score).toBeCloseTo(1, 6);
  expect(self.meanDistance).toBeCloseTo(0, 6);
});

test('serial candidate descriptors reuse bounded scratch without changing their structural values', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const pixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const independentlyAllocated = computeMindDescriptor2D(pixels, size);
  const scratch = createMindDescriptorScratch(size);

  const first = computeMindDescriptor2D(pixels, size, scratch);
  const retainedBuffer = first.values;
  const second = computeMindDescriptor2D(pixels, size, scratch);

  expect(second.values).toBe(retainedBuffer);
  expect(second.values).toEqual(independentlyAllocated.values);
  expect(second.validCenters).toEqual(independentlyAllocated.validCenters);
});

test('fractional validity contributes once against the fixed denominator', () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const descriptor = computeMindDescriptor2D(renderTissueContrast(labels, REFERENCE_CONTRAST), size);
  const weights = Float32Array.from(labels, (label) => (label === Tissue.canvas ? 0 : 1));
  const halfValidity = new Float32Array(size * size).fill(0.5);
  const score = scoreMindDescriptorAgreement(descriptor, descriptor, weights, halfValidity);

  expect(score.score).toBeCloseTo(0.5, 6);
});

test('uses the fixed ordered patch descriptor in pixel-major layout', () => {
  const size = 7;
  const pixels = Float32Array.from({ length: size * size }, (_, index) => {
    const x = index % size;
    const y = Math.floor(index / size);
    return ((3 * x + 5 * y + ((x * y) % 4)) % 13) / 12;
  });
  const descriptor = computeMindDescriptor2D(pixels, size);
  const offsets = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: 1 },
  ];
  const kernel = [0.25, 0.5, 0.25];
  const x = 3;
  const y = 3;
  const patchDistances = offsets.map(({ dx, dy }) => {
    let distance = 0;
    for (let patchY = -1; patchY <= 1; patchY++) {
      for (let patchX = -1; patchX <= 1; patchX++) {
        const center = pixels[(y + patchY) * size + x + patchX];
        const shifted = pixels[(y + patchY + dy) * size + x + patchX + dx];
        const difference = center - shifted;
        distance += kernel[patchY + 1] * kernel[patchX + 1] * difference * difference;
      }
    }
    return distance;
  });
  const localVariation = (patchDistances[0] + patchDistances[1] + patchDistances[2] + patchDistances[3]) / 4;
  const expected = patchDistances.map((distance) => Math.exp(-distance / Math.max(localVariation, 1e-6)));
  const maximum = Math.max(...expected);
  const pixelIndex = y * size + x;

  expect(descriptor.offsets).toEqual(offsets);
  expect(descriptor.channelCount).toBe(8);
  expect(descriptor.patchRadius).toBe(1);
  expect(Object.isFrozen(descriptor.offsets)).toBe(true);
  expect(descriptor.offsets.every(Object.isFrozen)).toBe(true);
  for (let channel = 0; channel < descriptor.channelCount; channel++) {
    expect(descriptor.values[pixelIndex * descriptor.channelCount + channel]).toBeCloseTo(
      expected[channel] / maximum,
      6,
    );
  }
});

test('treats non-finite image samples as zero', () => {
  const size = 7;
  const nonFinite = new Float32Array(size * size);
  nonFinite[2 * size + 2] = Number.NaN;
  nonFinite[3 * size + 3] = Number.POSITIVE_INFINITY;
  nonFinite[4 * size + 4] = Number.NEGATIVE_INFINITY;

  expect(computeMindDescriptor2D(nonFinite, size).values).toEqual(
    computeMindDescriptor2D(new Float32Array(size * size), size).values,
  );
});

test('rejects invalid image sizes, incompatible lengths, and descriptor layouts', () => {
  expect(() => computeMindDescriptor2D(new Float32Array(3), 2)).toThrow(/pixels|expected/i);
  expect(() => computeMindDescriptor2D(new Float32Array(0), 0)).toThrow(/size/i);

  const descriptor = computeMindDescriptor2D(new Float32Array(64 * 64), 64);
  expect(() =>
    scoreMindDescriptorAgreement(
      descriptor,
      computeMindDescriptor2D(new Float32Array(32 * 32), 32),
      new Float32Array(64 * 64),
      new Float32Array(64 * 64),
    ),
  ).toThrow(/descriptor size/i);
  expect(() =>
    scoreMindDescriptorAgreement(descriptor, descriptor, new Float32Array(1), new Float32Array(64 * 64)),
  ).toThrow(/weights/i);

  const reversedOffsets = {
    ...descriptor,
    offsets: [...descriptor.offsets].reverse(),
  };
  const wrongChannelCount = {
    ...descriptor,
    channelCount: descriptor.channelCount - 1,
  };
  const wrongPatchRadius = {
    ...descriptor,
    patchRadius: descriptor.patchRadius + 1,
  };
  const wrongFootprint = {
    ...descriptor,
    footprintRadius: descriptor.footprintRadius + 1,
  };
  const truncatedValues = {
    ...descriptor,
    values: descriptor.values.slice(1),
  };
  const truncatedCenters = {
    ...descriptor,
    validCenters: descriptor.validCenters.slice(1),
  };
  const weights = new Float32Array(64 * 64);
  const validity = new Float32Array(64 * 64).fill(1);

  for (const incompatible of [
    reversedOffsets,
    wrongChannelCount,
    wrongPatchRadius,
    wrongFootprint,
    truncatedValues,
    truncatedCenters,
  ]) {
    expect(() => scoreMindDescriptorAgreement(descriptor, incompatible, weights, validity)).toThrow(
      /descriptor (layout|length)/i,
    );
  }
  expect(() => scoreMindDescriptorAgreement(truncatedValues, descriptor, weights, validity)).toThrow(
    /descriptor length/i,
  );
  expect(() => scoreMindDescriptorAgreement(descriptor, descriptor, weights, new Float32Array(1))).toThrow(/validity/i);
});
