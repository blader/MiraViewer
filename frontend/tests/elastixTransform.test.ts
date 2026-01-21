import { describe, expect, it } from 'vitest';
import type { JsonCompatible } from 'itk-wasm';
import type { StandardAffine2D } from '../src/utils/affine2d';
import { warpGrayscaleAffine } from '../src/utils/warpAffine';
import {
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
});
