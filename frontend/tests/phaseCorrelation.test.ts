import { describe, expect, test } from 'vitest';
import {
  estimatePhaseCorrection,
  estimatePreparedPhaseCorrection,
  preparePhaseCorrectionReference,
} from '../src/utils/phaseCorrelation';
import { warpGrayscaleAffine, warpGrayscaleAffineWithValidity } from '../src/utils/warpAffine';
import {
  buildSoftForegroundSupportSquare,
  buildStructuralPhaseImageSquare,
  erodeFractionalSupportSquare,
  inpaintExclusionRectSquare,
} from '../src/utils/imageFeatures';
import { normalizePerceptualSource } from '../src/utils/perceptualSliceSimilarity';
import { expandExclusionRect, mapFixedExclusionToMovingBounds } from '../src/utils/alignmentTransform';
import {
  makeTissueLabelPhantom,
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  remapForeground,
  renderTissueContrast,
} from './helpers/alignmentSynthetic';

function makeCentralPattern(size: number): Float32Array {
  const out = new Float32Array(size * size);
  let state = 0x12345678;
  for (let y = 7; y < size - 7; y++) {
    for (let x = 7; x < size - 7; x++) {
      state = (1664525 * state + 1013904223) >>> 0;
      out[y * size + x] = (state >>> 8) / 0x01000000;
    }
  }
  return out;
}

function translateZeroFilled(input: Float32Array, size: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(input.length);
  for (let y = 0; y < size; y++) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= size) continue;
    for (let x = 0; x < size; x++) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= size) continue;
      out[targetY * size + targetX] = input[y * size + x] ?? 0;
    }
  }
  return out;
}

function prepareWarpedStructuralPhase(
  structuralSource: Float32Array,
  sourceSupport: Float32Array,
  size: number,
  transform: Parameters<typeof warpGrayscaleAffineWithValidity>[2],
) {
  const warpedStructural = warpGrayscaleAffineWithValidity(structuralSource, size, transform);
  const warpedSupport = warpGrayscaleAffineWithValidity(sourceSupport, size, transform);
  const erodedGeometricValidity = erodeFractionalSupportSquare(warpedStructural.validity, size, 1);
  const pixels = new Float32Array(structuralSource.length);
  const support = new Float32Array(structuralSource.length);
  const conditionalSupport = new Float32Array(structuralSource.length);
  for (let index = 0; index < pixels.length; index++) {
    const structuralValidity = warpedStructural.validity[index] ?? 0;
    const supportValidity = warpedSupport.validity[index] ?? 0;
    pixels[index] = structuralValidity > 1e-6 ? (warpedStructural.pixels[index] ?? 0) / structuralValidity : 0;
    conditionalSupport[index] = supportValidity > 1e-6 ? (warpedSupport.pixels[index] ?? 0) / supportValidity : 0;
    support[index] = conditionalSupport[index] * (erodedGeometricValidity[index] ?? 0);
  }
  return { pixels, support, conditionalSupport, erodedGeometricValidity };
}

describe('estimatePhaseCorrection', () => {
  test('structural phase preserves a zero correction under exact polarity reversal', () => {
    const size = 64;
    const bright = new Float32Array(size * size);
    const dark = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        bright[y * size + x] = x < size / 2 ? 0.2 : 0.8;
        dark[y * size + x] = x < size / 2 ? 0.8 : 0.2;
      }
    }

    const correction = estimatePhaseCorrection(
      buildStructuralPhaseImageSquare(bright, size),
      buildStructuralPhaseImageSquare(dark, size),
      size,
      { fftSize: 128, maxCorrectionPx: 12 },
    );

    expect(correction.correctionX).toBeCloseTo(0, 6);
    expect(correction.correctionY).toBeCloseTo(0, 6);
  });

  test('structural phase finds a shifted match under a nonfunctional tissue LUT', () => {
    const size = 64;
    const dx = 7;
    const dy = -5;
    const labels = makeTissueLabelPhantom(size);
    const reference = buildStructuralPhaseImageSquare(
      normalizePerceptualSource(renderTissueContrast(labels, REFERENCE_CONTRAST), size),
      size,
    );
    const moving = buildStructuralPhaseImageSquare(
      normalizePerceptualSource(
        translateZeroFilled(renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST), size, dx, dy),
        size,
      ),
      size,
    );

    const correction = estimatePhaseCorrection(reference, moving, size, {
      fftSize: 128,
      maxCorrectionPx: 12,
    });

    expect(correction.correctionX).toBeCloseTo(-dx, 0);
    expect(correction.correctionY).toBeCloseTo(-dy, 0);
  });

  test('structural phase recovers a displacement that signed intensity phase rejects', () => {
    const size = 64;
    const dx = 6;
    const dy = -4;
    const reference = makeCentralPattern(size);
    const polarityReversed = remapForeground(reference, (value) => 1.001 - value);
    const moving = translateZeroFilled(polarityReversed, size, dx, dy);
    const referenceSupport = Float32Array.from(reference, (value) => (value > 0 ? 1 : 0));
    const movingSupport = Float32Array.from(moving, (value) => (value > 0 ? 1 : 0));

    const intensityCorrection = estimatePhaseCorrection(reference, moving, size, {
      fftSize: 128,
      maxCorrectionPx: 12,
      support: referenceSupport,
      movingSupport,
    });
    const structuralCorrection = estimatePhaseCorrection(
      buildStructuralPhaseImageSquare(reference, size),
      buildStructuralPhaseImageSquare(moving, size),
      size,
      {
        fftSize: 128,
        maxCorrectionPx: 12,
        support: referenceSupport,
        movingSupport,
      },
    );

    expect(Math.hypot(intensityCorrection.correctionX + dx, intensityCorrection.correctionY + dy)).toBeGreaterThan(2);
    expect(structuralCorrection.correctionX).toBeCloseTo(-dx, 0);
    expect(structuralCorrection.correctionY).toBeCloseTo(-dy, 0);
  });

  test('source-space structure avoids snapping to an off-frame seed-warp crop edge', () => {
    const size = 64;
    const maxCorrectionPx = 12;
    const translateX = 9.5;
    const translateY = -7.5;
    const normalized = normalizePerceptualSource(
      renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
      size,
    );
    const structural = buildStructuralPhaseImageSquare(normalized, size);
    const sourceSupport = buildSoftForegroundSupportSquare(normalized, size);
    const moving = prepareWarpedStructuralPhase(structural, sourceSupport, size, {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translateX,
      translateY,
    });

    const correction = estimatePhaseCorrection(structural, moving.pixels, size, {
      fftSize: 128,
      maxCorrectionPx,
      support: sourceSupport,
      movingSupport: moving.support,
    });

    expect(Math.abs(correction.correctionX)).toBeLessThanOrEqual(maxCorrectionPx);
    expect(Math.abs(correction.correctionY)).toBeLessThanOrEqual(maxCorrectionPx);
    expect(correction.correctionX).toBeCloseTo(-translateX, 0);
    expect(correction.correctionY).toBeCloseTo(-translateY, 0);
  });

  test('source-space exclusion inpainting prevents a changing bright region from moving the structural peak', () => {
    const size = 64;
    const dx = 7;
    const dy = -5;
    const referenceSource = makeCentralPattern(size);
    const movingSource = translateZeroFilled(referenceSource, size, dx, dy);
    const referenceExclusion = { x: 6 / size, y: 8 / size, width: 18 / size, height: 18 / size };
    const movingExclusion = { x: 38 / size, y: 34 / size, width: 18 / size, height: 18 / size };
    for (let y = 8; y < 26; y++) {
      for (let x = 6; x < 24; x++) referenceSource[y * size + x] = 100;
    }
    for (let y = 34; y < 52; y++) {
      for (let x = 38; x < 56; x++) movingSource[y * size + x] = 500;
    }

    const normalizedReference = normalizePerceptualSource(referenceSource, size, {
      exclusionRect: referenceExclusion,
    });
    const normalizedMoving = normalizePerceptualSource(movingSource, size, {
      exclusionRect: movingExclusion,
    });
    const structuralReference = buildStructuralPhaseImageSquare(
      inpaintExclusionRectSquare(normalizedReference, size, referenceExclusion, 6).pixels,
      size,
    );
    const structuralMoving = buildStructuralPhaseImageSquare(
      inpaintExclusionRectSquare(normalizedMoving, size, movingExclusion, 6).pixels,
      size,
    );

    const correction = estimatePhaseCorrection(structuralReference, structuralMoving, size, {
      fftSize: 128,
      maxCorrectionPx: 12,
    });

    expect(correction.correctionX).toBeCloseTo(-dx, 0);
    expect(correction.correctionY).toBeCloseTo(-dy, 0);
  });

  test('recovers conditional source support before applying geometric validity once', () => {
    const size = 8;
    const source = new Float32Array(size * size).fill(0.75);
    const sourceSupport = new Float32Array(size * size).fill(1);
    const prepared = prepareWarpedStructuralPhase(source, sourceSupport, size, {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translateX: 0.5,
      translateY: 0,
    });

    expect(prepared.conditionalSupport[0]).toBeCloseTo(1, 6);
    expect(prepared.erodedGeometricValidity[0]).toBeCloseTo(0.5, 6);
    expect(prepared.support[0]).toBeCloseTo(prepared.erodedGeometricValidity[0] ?? 0, 6);
    expect(prepared.support[0]).not.toBeCloseTo(0.25, 6);
  });

  test('returns the signed correction that maps a shifted moving image back to the reference', () => {
    const sampleGridSize = 32;
    const reference = makeCentralPattern(sampleGridSize);
    const moving = translateZeroFilled(reference, sampleGridSize, 5, -3);

    const correction = estimatePhaseCorrection(reference, moving, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx: 8,
    });

    expect(correction.correctionX).toBeCloseTo(-5, 1);
    expect(correction.correctionY).toBeCloseTo(3, 1);
    expect(correction.sampleGridSize).toBe(32);
    expect(correction.fftSize).toBe(64);
    expect(correction.peak).toBeGreaterThan(0);
    expect(Number.isFinite(correction.peakToSidelobeRatio)).toBe(true);
  });

  test.each([
    { direction: '+x', dx: 5, dy: 0, expectedX: -5, expectedY: 0 },
    { direction: '-x', dx: -5, dy: 0, expectedX: 5, expectedY: 0 },
    { direction: '+y', dx: 0, dy: 5, expectedX: 0, expectedY: -5 },
    { direction: '-y', dx: 0, dy: -5, expectedX: 0, expectedY: 5 },
  ])(
    'uses the moving-to-reference correction sign for an in-bound $direction shift',
    ({ dx, dy, expectedX, expectedY }) => {
      const sampleGridSize = 32;
      const reference = makeCentralPattern(sampleGridSize);
      const moving = translateZeroFilled(reference, sampleGridSize, dx, dy);

      const correction = estimatePhaseCorrection(reference, moving, sampleGridSize, {
        fftSize: 64,
        maxCorrectionPx: 8,
      });

      expect(correction.correctionX).toBeCloseTo(expectedX, 1);
      expect(correction.correctionY).toBeCloseTo(expectedY, 1);
    },
  );

  test('refines a bounded peak to a subpixel correction in sample-grid units', () => {
    const sampleGridSize = 32;
    const reference = makeCentralPattern(sampleGridSize);
    const moving = warpGrayscaleAffine(reference, sampleGridSize, {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translateX: 2.5,
      translateY: -1.75,
    });

    const correction = estimatePhaseCorrection(reference, moving, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx: 8,
    });

    expect(correction.correctionX).toBeCloseTo(-2.5, 0);
    expect(correction.correctionY).toBeCloseTo(1.75, 0);
  });

  test.each([
    { direction: '+x', dx: 9, dy: 0 },
    { direction: '-x', dx: -9, dy: 0 },
    { direction: '+y', dx: 0, dy: 9 },
    { direction: '-y', dx: 0, dy: -9 },
  ])('searches the signed window instead of clamping a wrapped $direction peak', ({ dx, dy }) => {
    const sampleGridSize = 32;
    const maxCorrectionPx = 3;
    const reference = makeCentralPattern(sampleGridSize);
    const moving = translateZeroFilled(reference, sampleGridSize, dx, dy);

    const correction = estimatePhaseCorrection(reference, moving, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx,
    });

    expect(Math.abs(correction.correctionX)).toBeLessThanOrEqual(maxCorrectionPx);
    expect(Math.abs(correction.correctionY)).toBeLessThanOrEqual(maxCorrectionPx);

    const displacement = dx || dy;
    const correctionOnDisplacedAxis = dx ? correction.correctionX : correction.correctionY;
    const globallySelectedThenClamped = -Math.sign(displacement) * maxCorrectionPx;
    expect(correctionOnDisplacedAxis).not.toBeCloseTo(globallySelectedThenClamped, 3);
  });

  test('reuses a prepared reference FFT across moving candidates', () => {
    const sampleGridSize = 32;
    const reference = makeCentralPattern(sampleGridSize);
    const prepared = preparePhaseCorrectionReference(reference, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx: 8,
    });

    const first = estimatePreparedPhaseCorrection(prepared, translateZeroFilled(reference, sampleGridSize, 4, 2));
    const second = estimatePreparedPhaseCorrection(prepared, translateZeroFilled(reference, sampleGridSize, -3, 1));

    expect(first.correctionX).toBeCloseTo(-4, 1);
    expect(first.correctionY).toBeCloseTo(-2, 1);
    expect(second.correctionX).toBeCloseTo(3, 1);
    expect(second.correctionY).toBeCloseTo(-1, 1);
  });

  test('returns a neutral correction when the reference has no usable structure', () => {
    const sampleGridSize = 32;
    const empty = new Float32Array(sampleGridSize * sampleGridSize);

    const correction = estimatePhaseCorrection(empty, empty, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx: 8,
      support: new Float32Array(empty.length),
      movingSupport: new Float32Array(empty.length),
    });

    expect(correction.correctionX).toBe(0);
    expect(correction.correctionY).toBe(0);
    expect(correction.peak).toBe(0);
    expect(correction.pixelsUsed).toBe(0);
  });

  test('uses caller-provided source-local soft support instead of deriving an intensity threshold', () => {
    const sampleGridSize = 8;
    const pixels = new Float32Array(sampleGridSize * sampleGridSize).fill(1);
    const support = new Float32Array(pixels.length);
    support[3 * sampleGridSize + 4] = 1;

    const prepared = preparePhaseCorrectionReference(pixels, sampleGridSize, {
      fftSize: 16,
      maxCorrectionPx: 2,
      support,
    });

    expect(prepared.pixelsUsed).toBe(1);
  });

  test('a shared excluded-region boundary cannot manufacture a zero-shift winner', () => {
    const sampleGridSize = 32;
    const exclusion = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
    const reference = makeCentralPattern(sampleGridSize);
    const moving = translateZeroFilled(reference, sampleGridSize, 4, 0);
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        reference[y * sampleGridSize + x] = 10;
        moving[y * sampleGridSize + x] = 10;
      }
    }

    const inpaintedReference = inpaintExclusionRectSquare(reference, sampleGridSize, exclusion, 4).pixels;
    const inpaintedMoving = inpaintExclusionRectSquare(moving, sampleGridSize, exclusion, 4).pixels;
    const correction = estimatePhaseCorrection(inpaintedReference, inpaintedMoving, sampleGridSize, {
      fftSize: 64,
      maxCorrectionPx: 8,
    });

    expect(correction.correctionX).toBeCloseTo(-4, 0);
    expect(Math.abs(correction.correctionX)).toBeGreaterThan(2);
  });

  test('bright changing pathology cannot corrupt normalization or residual translation', () => {
    const sampleGridSize = 64;
    const dx = 10;
    const dy = -7;
    const exclusion = { x: 0.4, y: 0.4, width: 0.12, height: 0.12 };
    const referenceSource = makeCentralPattern(sampleGridSize);
    const movingSource = translateZeroFilled(referenceSource, sampleGridSize, dx, dy);
    for (let y = 26; y < 34; y++) {
      for (let x = 26; x < 34; x++) referenceSource[y * sampleGridSize + x] = 100;
    }
    for (let y = 26 + dy; y < 34 + dy; y++) {
      for (let x = 26 + dx; x < 34 + dx; x++) movingSource[y * sampleGridSize + x] = 500;
    }

    const expandedFixed = expandExclusionRect(exclusion, 12 / sampleGridSize);
    const movingExclusion = mapFixedExclusionToMovingBounds(
      exclusion,
      {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        translateX: 0,
        translateY: 0,
      },
      sampleGridSize,
      12,
    );
    const reference = normalizePerceptualSource(referenceSource, sampleGridSize, {
      exclusionRect: expandedFixed,
    });
    const moving = normalizePerceptualSource(movingSource, sampleGridSize, {
      exclusionRect: movingExclusion,
    });
    const phaseReference = inpaintExclusionRectSquare(reference, sampleGridSize, expandedFixed, 6).pixels;
    const phaseMoving = inpaintExclusionRectSquare(moving, sampleGridSize, expandedFixed, 6).pixels;
    const correction = estimatePhaseCorrection(phaseReference, phaseMoving, sampleGridSize, {
      fftSize: 128,
      maxCorrectionPx: 12,
      support: buildSoftForegroundSupportSquare(reference, sampleGridSize),
      movingSupport: buildSoftForegroundSupportSquare(moving, sampleGridSize),
    });

    expect(correction.correctionX).toBeCloseTo(-dx, 0);
    expect(correction.correctionY).toBeCloseTo(-dy, 0);
  });
});
