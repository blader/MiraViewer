import type { JsonCompatible } from 'itk-wasm';
import type { AffineAboutOrigin2D, Mat2, StandardAffine2D, Vec2 } from './affine2d';
import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  invertStandardAffine2D,
  standardToAffineAboutOrigin,
} from './affine2d';
import { warpGrayscaleAffine } from './warpAffine';

type ElastixParameterMapJson = Record<string, string[]>;

function readNumberList(map: ElastixParameterMapJson, key: string): number[] {
  const raw = map[key];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new Error(`Elastix transformParameterObject missing ${key}`);
  }
  const out = raw.map((v) => Number(v));
  if (out.some((v) => !Number.isFinite(v))) {
    throw new Error(`Elastix transformParameterObject has non-numeric ${key}`);
  }
  return out;
}

function parse2DTransformFromParameterMap(map: ElastixParameterMapJson): {
  A: Mat2;
  center: Vec2;
  translation: Vec2;
} {
  const transform = map.Transform;
  const transformName = Array.isArray(transform) ? transform[0] : undefined;
  const params = readNumberList(map, 'TransformParameters');
  const center = readNumberList(map, 'CenterOfRotationPoint');
  if (center.length !== 2) {
    throw new Error(`Elastix ${String(transformName)} expected 2 CenterOfRotationPoint values, got ${center.length}`);
  }

  let A: Mat2;
  let translation: Vec2;
  if (transformName === 'AffineTransform') {
    if (params.length !== 6) {
      throw new Error(`Elastix AffineTransform expected 6 parameters, got ${params.length}`);
    }
    A = {
      m00: params[0],
      m01: params[1],
      m10: params[2],
      m11: params[3],
    };
    translation = { x: params[4], y: params[5] };
  } else if (transformName === 'EulerTransform') {
    if (params.length !== 3) {
      throw new Error(`Elastix EulerTransform expected 3 parameters, got ${params.length}`);
    }
    const angle = params[0];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    A = { m00: cos, m01: -sin, m10: sin, m11: cos };
    translation = { x: params[1], y: params[2] };
  } else {
    throw new Error(`Elastix expected AffineTransform or EulerTransform, got ${String(transformName)}`);
  }

  return {
    A,
    center: { x: center[0], y: center[1] },
    translation,
  };
}

export function parseTransformParameterObjectToStandardAffines(
  transformParameterObject: JsonCompatible
): StandardAffine2D[] {
  if (!Array.isArray(transformParameterObject) || transformParameterObject.length === 0) {
    throw new Error('Elastix transformParameterObject expected a non-empty array');
  }

  const maps: StandardAffine2D[] = [];

  for (const entry of transformParameterObject) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Elastix transformParameterObject invalid');
    }

    const map = entry as unknown as ElastixParameterMapJson;
    const { A, center, translation } = parse2DTransformFromParameterMap(map);

    // Elastix / ITK represent transforms about a center:
    //   y = A * (x - C) + C + t
    // Convert to a standard affine so we can compose transforms across multi-stage results.
    maps.push(affineAboutOriginToStandard({ A, origin: center, t: translation }));
  }

  return maps;
}

export function composeStandardAffinesInOrder(affines: StandardAffine2D[]): StandardAffine2D {
  // Apply in sequence: T_total = Tn ∘ ... ∘ T1 ∘ T0.
  let total: StandardAffine2D = {
    A: { m00: 1, m01: 0, m10: 0, m11: 1 },
    b: { x: 0, y: 0 },
  };

  for (const affine of affines) {
    total = composeStandardAffine2D(affine, total);
  }

  return total;
}

export type ElastixTransformCandidateStd = {
  label: string;
  std: StandardAffine2D;
};

export function buildElastixTransformCandidatesStd(standardChain: StandardAffine2D[]): ElastixTransformCandidateStd[] {
  const forward = composeStandardAffinesInOrder(standardChain);
  const reverse = composeStandardAffinesInOrder([...standardChain].reverse());

  return [
    { label: 'forward.direct', std: forward },
    { label: 'forward.inverted', std: invertStandardAffine2D(forward) },
    { label: 'reverse.direct', std: reverse },
    { label: 'reverse.inverted', std: invertStandardAffine2D(reverse) },
  ];
}

export type ElastixTransformCandidateScore = {
  label: string;
  std: StandardAffine2D;
  aboutOrigin: AffineAboutOrigin2D;
  mad: number;
  maxAbs: number;
};

export function chooseBestElastixTransformCandidateAboutOrigin(params: {
  movingPixels: Float32Array;
  resampledMovingPixels: Float32Array;
  size: number;
  candidatesStd: ElastixTransformCandidateStd[];
  origin?: Vec2;
}): { best: ElastixTransformCandidateScore; candidates: ElastixTransformCandidateScore[] } {
  const { movingPixels, resampledMovingPixels, size, candidatesStd } = params;

  const origin: Vec2 = params.origin ?? { x: (size - 1) / 2, y: (size - 1) / 2 };

  const candidates: ElastixTransformCandidateScore[] = [];

  for (const c of candidatesStd) {
    const aboutOrigin = standardToAffineAboutOrigin(c.std.A, c.std.b, origin);
    const warped = warpGrayscaleAffine(movingPixels, size, {
      A: aboutOrigin.A,
      translateX: aboutOrigin.t.x,
      translateY: aboutOrigin.t.y,
    });

    let mad = 0;
    let maxAbs = 0;
    for (let i = 0; i < resampledMovingPixels.length; i++) {
      const d = Math.abs(resampledMovingPixels[i] - warped[i]);
      mad += d;
      if (d > maxAbs) maxAbs = d;
    }
    mad /= Math.max(1, resampledMovingPixels.length);

    candidates.push({ label: c.label, std: c.std, aboutOrigin, mad, maxAbs });
  }

  candidates.sort((a, b) => a.mad - b.mad);
  const best = candidates[0];
  if (!best) {
    throw new Error('No transform candidates provided');
  }

  return { best, candidates };
}
