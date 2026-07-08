import { describe, expect, it } from 'vitest';
import type { JsonCompatible } from 'itk-wasm';
import { standardToAffineAboutOrigin, type StandardAffine2D } from '../src/utils/affine2d';
import { warpGrayscaleAffine } from '../src/utils/warpAffine';
import {
  buildElastixTransformCandidatesStd,
  chooseBestElastixTransformCandidateAboutOrigin,
  composeStandardAffinesInOrder,
  parseTransformParameterObjectToStandardAffines,
} from '../src/utils/elastixTransform';

describe('elastixTransform', () => {
  it('parses a simple AffineTransform parameter map into a standard affine', () => {
    const transformParameterObject = [
      {
        Transform: ['AffineTransform'],
        TransformParameters: ['1', '0', '0', '1', '2', '3'],
        CenterOfRotationPoint: ['0', '0'],
      },
    ];

    const chain = parseTransformParameterObjectToStandardAffines(
      transformParameterObject as unknown as JsonCompatible
    );

    expect(chain).toHaveLength(1);
    expect(chain[0].A).toEqual({ m00: 1, m01: 0, m10: 0, m11: 1 });
    expect(chain[0].b).toEqual({ x: 2, y: 3 });
  });

  it('parses a centered EulerTransform into a standard affine', () => {
    const transformParameterObject = [
      {
        Transform: ['EulerTransform'],
        TransformParameters: [String(Math.PI / 2), '3', '-4'],
        CenterOfRotationPoint: ['10', '20'],
      },
    ];

    const [transform] = parseTransformParameterObjectToStandardAffines(
      transformParameterObject as unknown as JsonCompatible
    );

    expect(transform.A.m00).toBeCloseTo(0, 10);
    expect(transform.A.m01).toBeCloseTo(-1, 10);
    expect(transform.A.m10).toBeCloseTo(1, 10);
    expect(transform.A.m11).toBeCloseTo(0, 10);
    expect(transform.b.x).toBeCloseTo(33, 10);
    expect(transform.b.y).toBeCloseTo(6, 10);
  });

  it('preserves mixed Euler-then-affine chain order', () => {
    const transformParameterObject = [
      {
        Transform: ['EulerTransform'],
        TransformParameters: [String(Math.PI / 2), '0', '0'],
        CenterOfRotationPoint: ['0', '0'],
      },
      {
        Transform: ['AffineTransform'],
        TransformParameters: ['1', '0', '0', '1', '2', '0'],
        CenterOfRotationPoint: ['0', '0'],
      },
    ];

    const chain = parseTransformParameterObjectToStandardAffines(
      transformParameterObject as unknown as JsonCompatible
    );
    const total = composeStandardAffinesInOrder(chain);

    expect(total.A.m00).toBeCloseTo(0, 10);
    expect(total.A.m01).toBeCloseTo(-1, 10);
    expect(total.A.m10).toBeCloseTo(1, 10);
    expect(total.A.m11).toBeCloseTo(0, 10);
    expect(total.b).toEqual({ x: 2, y: 0 });
  });

  it('composes standard affines in order (T1 ∘ T0)', () => {
    const t0: StandardAffine2D = { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: 1, y: 0 } };
    const t1: StandardAffine2D = { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 2 } };

    const total = composeStandardAffinesInOrder([t0, t1]);

    expect(total.A).toEqual({ m00: 1, m01: 0, m10: 0, m11: 1 });
    expect(total.b).toEqual({ x: 1, y: 2 });
  });

  it('selects the best candidate by comparing to the resampled moving image', () => {
    const size = 16;

    const moving = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        moving[y * size + x] = x / (size - 1);
      }
    }

    const correct = {
      label: 'correct',
      std: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: { x: 2, y: -1 },
      },
    };

    const wrong = {
      label: 'wrong',
      std: {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: { x: -2, y: 1 },
      },
    };

    const resampled = warpGrayscaleAffine(moving, size, {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translateX: 2,
      translateY: -1,
    });

    const { best } = chooseBestElastixTransformCandidateAboutOrigin({
      movingPixels: moving,
      resampledMovingPixels: resampled,
      size,
      candidatesStd: [wrong, correct],
    });

    expect(best.label).toBe('correct');
    expect(best.mad).toBeCloseTo(0, 6);
    expect(best.aboutOrigin.t.x).toBeCloseTo(2, 6);
    expect(best.aboutOrigin.t.y).toBeCloseTo(-1, 6);
  });

  it('validates a parsed nonidentity transform chain against the resampled output', () => {
    const size = 24;
    const center = (size - 1) / 2;
    const moving = new Float32Array(size * size);
    for (let y = 3; y < size - 4; y++) {
      for (let x = 5; x < size - 2; x++) {
        moving[y * size + x] = ((x * 13 + y * 7) % 29) / 28;
      }
    }
    const transformParameterObject = [
      {
        Transform: ['EulerTransform'],
        TransformParameters: ['0.12', '1.5', '-0.75'],
        CenterOfRotationPoint: [String(center), String(center)],
      },
      {
        Transform: ['AffineTransform'],
        TransformParameters: ['1', '0.08', '-0.03', '1', '2', '1'],
        CenterOfRotationPoint: [String(center), String(center)],
      },
    ];
    const chain = parseTransformParameterObjectToStandardAffines(
      transformParameterObject as unknown as JsonCompatible
    );
    const expected = composeStandardAffinesInOrder(chain);
    const expectedAboutCenter = standardToAffineAboutOrigin(expected.A, expected.b, { x: center, y: center });
    const resampled = warpGrayscaleAffine(moving, size, {
      A: expectedAboutCenter.A,
      translateX: expectedAboutCenter.t.x,
      translateY: expectedAboutCenter.t.y,
    });

    const { best } = chooseBestElastixTransformCandidateAboutOrigin({
      movingPixels: moving,
      resampledMovingPixels: resampled,
      size,
      candidatesStd: buildElastixTransformCandidatesStd(chain),
    });

    expect(best.mad).toBeCloseTo(0, 8);
    expect(best.std.A.m00).toBeCloseTo(expected.A.m00, 10);
    expect(best.std.A.m01).toBeCloseTo(expected.A.m01, 10);
    expect(best.std.A.m10).toBeCloseTo(expected.A.m10, 10);
    expect(best.std.A.m11).toBeCloseTo(expected.A.m11, 10);
    expect(best.std.b.x).toBeCloseTo(expected.b.x, 10);
    expect(best.std.b.y).toBeCloseTo(expected.b.y, 10);
  });
});
