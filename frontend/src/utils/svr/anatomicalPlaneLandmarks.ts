import type { ExclusionMask } from '../../types/api';
import { computeGradientMagnitudeL1Square } from '../imageFeatures';
import { normalizePerceptualSource } from '../perceptualSliceSimilarity';
import { resample2dAreaAverage, resample2dAreaAverageWithValidity } from './resample2d';
import { cross, dot, norm, type Vec3 } from './vec3';

const LANDMARK_SIZE = 128;
const FOREGROUND_THRESHOLD = 0.045;
const DARK_COMPONENT_THRESHOLD = 0.12;

type OrbitalComponent = { area: number; row: number; column: number; eccentricity: number };
type BilateralAnatomicalTemplate = {
  sides: [Uint8Array, Uint8Array];
  components: [OrbitalComponent, OrbitalComponent];
  rowSpacingMm: number;
  colSpacingMm: number;
  separationMm: number;
};

export type AnatomicalPlaneLandmarks = {
  size: number;
  pixels: Float32Array;
  validity: Float32Array;
  weights: Float32Array;
  totalWeight: number;
  supportedPixels: number;
  exclusionRect?: ExclusionMask;
  bilateral?: BilateralAnatomicalTemplate;
};

type ReferencePlane = {
  pixels: Float32Array;
  rows: number;
  cols: number;
  valid?: Uint8Array;
  ippMm?: Vec3;
  rowDir?: Vec3;
  colDir?: Vec3;
  rowSpacingDsMm?: number;
  colSpacingDsMm?: number;
  frameOfReferenceUid?: string;
};
type AnatomicalDepthContext = { previous?: ReferencePlane; next?: ReferencePlane };
type CandidatePlane = { pixels: Float32Array; valid: Uint8Array; rows: number; cols: number };

function prepareDepthSensitiveAnatomy(
  reference: ReferencePlane,
  normalizedReference: Float32Array,
  context: AnatomicalDepthContext,
  exclusionRect?: ExclusionMask,
): { pixels: Float32Array; validity: Float32Array } | undefined {
  if (!reference.ippMm || !reference.rowDir || !reference.colDir) return undefined;
  if (!(reference.rowSpacingDsMm! > 0) || !(reference.colSpacingDsMm! > 0)) return undefined;
  const normal = cross(reference.rowDir, reference.colDir);
  if (Math.abs(norm(normal) - 1) > 0.005) return undefined;
  const neighbors = [context.previous, context.next].filter((neighbor): neighbor is ReferencePlane =>
    Boolean(neighbor),
  );
  if (neighbors.length === 0) return undefined;
  const prepared: Array<{ pixels: Float32Array; validity: Float32Array; depth: number }> = [];
  for (const neighbor of neighbors) {
    if (
      !neighbor.ippMm ||
      !neighbor.rowDir ||
      !neighbor.colDir ||
      neighbor.rows < 2 ||
      neighbor.cols < 2 ||
      neighbor.pixels.length !== neighbor.rows * neighbor.cols ||
      (neighbor.valid && neighbor.valid.length !== neighbor.pixels.length) ||
      !(neighbor.rowSpacingDsMm! > 0) ||
      !(neighbor.colSpacingDsMm! > 0) ||
      dot(reference.rowDir, neighbor.rowDir) < 0.995 ||
      dot(reference.colDir, neighbor.colDir) < 0.995 ||
      (reference.frameOfReferenceUid &&
        neighbor.frameOfReferenceUid &&
        reference.frameOfReferenceUid !== neighbor.frameOfReferenceUid)
    ) {
      return undefined;
    }
    const rowExtent = reference.rowSpacingDsMm! * reference.rows;
    const columnExtent = reference.colSpacingDsMm! * reference.cols;
    if (
      Math.abs(neighbor.rowSpacingDsMm! * neighbor.rows - rowExtent) > Math.max(reference.rowSpacingDsMm!, 1e-6) ||
      Math.abs(neighbor.colSpacingDsMm! * neighbor.cols - columnExtent) > Math.max(reference.colSpacingDsMm!, 1e-6)
    ) {
      return undefined;
    }
    const displacement = {
      x: neighbor.ippMm.x - reference.ippMm.x,
      y: neighbor.ippMm.y - reference.ippMm.y,
      z: neighbor.ippMm.z - reference.ippMm.z,
    };
    const depth = dot(displacement, normal);
    if (
      !Number.isFinite(depth) ||
      Math.abs(depth) < 1e-6 ||
      Math.abs(dot(displacement, reference.rowDir)) > reference.colSpacingDsMm! ||
      Math.abs(dot(displacement, reference.colDir)) > reference.rowSpacingDsMm!
    ) {
      return undefined;
    }
    const scaled = resample2dAreaAverageWithValidity(
      neighbor.pixels,
      neighbor.valid ?? new Uint8Array(neighbor.pixels.length).fill(1),
      neighbor.rows,
      neighbor.cols,
      LANDMARK_SIZE,
      LANDMARK_SIZE,
    );
    prepared.push({
      pixels: normalizePerceptualSource(scaled.pixels, LANDMARK_SIZE, {
        exclusionRect,
        validity: scaled.validity,
      }),
      validity: scaled.validity,
      depth,
    });
  }
  if (prepared.length === 2 && prepared[0]!.depth * prepared[1]!.depth >= 0) return undefined;
  const pixels = new Float32Array(normalizedReference.length);
  const validity = new Float32Array(normalizedReference.length);
  for (let index = 0; index < pixels.length; index++) {
    const first = prepared[0]!;
    const second = prepared[1];
    if (!(first.validity[index]! >= 0.5) || (second && !(second.validity[index]! >= 0.5))) continue;
    pixels[index] = second
      ? Math.abs((second.pixels[index]! - first.pixels[index]!) / (second.depth - first.depth))
      : Math.abs((first.pixels[index]! - normalizedReference[index]!) / first.depth);
    validity[index] = second ? Math.min(first.validity[index]!, second.validity[index]!) : first.validity[index]!;
  }
  return { pixels, validity };
}

function findOrbitalComponents(
  pixels: Float32Array,
  validity: ArrayLike<number>,
  side: Uint8Array,
): OrbitalComponent[] {
  const visited = new Uint8Array(pixels.length);
  const queue = new Uint32Array(pixels.length);
  const components: OrbitalComponent[] = [];
  for (let initial = 0; initial < pixels.length; initial++) {
    if (
      visited[initial] ||
      !(validity[initial]! >= 0.5) ||
      !side[initial] ||
      pixels[initial]! >= DARK_COMPONENT_THRESHOLD
    ) {
      continue;
    }
    let first = 0;
    let last = 1;
    queue[0] = initial;
    visited[initial] = 1;
    let rowSum = 0;
    let columnSum = 0;
    let rowSquared = 0;
    let columnSquared = 0;
    let rowColumn = 0;
    while (first < last) {
      const current = queue[first++]!;
      const row = Math.floor(current / LANDMARK_SIZE);
      const column = current % LANDMARK_SIZE;
      rowSum += row;
      columnSum += column;
      rowSquared += row * row;
      columnSquared += column * column;
      rowColumn += row * column;
      for (const neighbor of [current - 1, current + 1, current - LANDMARK_SIZE, current + LANDMARK_SIZE]) {
        if (
          neighbor < 0 ||
          neighbor >= pixels.length ||
          Math.abs((neighbor % LANDMARK_SIZE) - column) > 1 ||
          visited[neighbor] ||
          !(validity[neighbor]! >= 0.5) ||
          !side[neighbor] ||
          pixels[neighbor]! >= DARK_COMPONENT_THRESHOLD
        ) {
          continue;
        }
        visited[neighbor] = 1;
        queue[last++] = neighbor;
      }
    }
    if (last < 4) continue;
    const row = rowSum / last;
    const column = columnSum / last;
    const rowVariance = rowSquared / last - row * row;
    const columnVariance = columnSquared / last - column * column;
    const covariance = rowColumn / last - row * column;
    const trace = rowVariance + columnVariance;
    const discriminant = Math.sqrt(Math.max(0, (rowVariance - columnVariance) ** 2 + 4 * covariance ** 2));
    const eccentricity = Math.sqrt(Math.max(1, (trace + discriminant) / Math.max(1e-6, trace - discriminant)));
    components.push({ area: last, row, column, eccentricity });
  }
  return components.sort((first, second) => second.area - first.area);
}

function prepareBilateralAnatomicalTemplate(
  reference: ReferencePlane,
  pixels: Float32Array,
  validity: Float32Array,
  excluded: Float32Array | undefined,
): BilateralAnatomicalTemplate | undefined {
  if (!reference.ippMm || !reference.rowDir || !reference.colDir) return undefined;
  if (!(reference.rowSpacingDsMm! > 0) || !(reference.colSpacingDsMm! > 0)) return undefined;
  const rowSpacingMm = reference.rowSpacingDsMm! * (reference.rows / LANDMARK_SIZE);
  const colSpacingMm = reference.colSpacingDsMm! * (reference.cols / LANDMARK_SIZE);
  const firstByRow = new Int32Array(LANDMARK_SIZE).fill(LANDMARK_SIZE);
  const lastByRow = new Int32Array(LANDMARK_SIZE).fill(-1);
  const firstByColumn = new Int32Array(LANDMARK_SIZE).fill(LANDMARK_SIZE);
  const lastByColumn = new Int32Array(LANDMARK_SIZE).fill(-1);
  let anterior = Number.POSITIVE_INFINITY;
  let posterior = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  const point = (row: number, column: number) => ({
    x: reference.ippMm!.x + reference.colDir!.x * row * rowSpacingMm + reference.rowDir!.x * column * colSpacingMm,
    y: reference.ippMm!.y + reference.colDir!.y * row * rowSpacingMm + reference.rowDir!.y * column * colSpacingMm,
  });
  for (let row = 0; row < LANDMARK_SIZE; row++) {
    for (let column = 0; column < LANDMARK_SIZE; column++) {
      const index = row * LANDMARK_SIZE + column;
      if (!(validity[index]! >= 0.5) || pixels[index]! <= 0.08) continue;
      const position = point(row, column);
      anterior = Math.min(anterior, position.y);
      posterior = Math.max(posterior, position.y);
      left = Math.min(left, position.x);
      right = Math.max(right, position.x);
      firstByRow[row] = Math.min(firstByRow[row]!, column);
      lastByRow[row] = Math.max(lastByRow[row]!, column);
      firstByColumn[column] = Math.min(firstByColumn[column]!, row);
      lastByColumn[column] = Math.max(lastByColumn[column]!, row);
    }
  }
  if (!(posterior > anterior && right > left)) return undefined;
  const sides: [Uint8Array, Uint8Array] = [new Uint8Array(pixels.length), new Uint8Array(pixels.length)];
  for (let row = 1; row < LANDMARK_SIZE - 1; row++) {
    for (let column = 1; column < LANDMARK_SIZE - 1; column++) {
      const index = row * LANDMARK_SIZE + column;
      if (
        excluded?.[index] ||
        column <= firstByRow[row]! + 2 ||
        column >= lastByRow[row]! - 2 ||
        row <= firstByColumn[column]! + 2 ||
        row >= lastByColumn[column]! - 2
      ) {
        continue;
      }
      const position = point(row, column);
      const anteriorFraction = (position.y - anterior) / (posterior - anterior);
      const lateralFraction = (position.x - left) / (right - left);
      if (anteriorFraction < 0.03 || anteriorFraction > 0.25 || lateralFraction < 0.12 || lateralFraction > 0.88) {
        continue;
      }
      sides[lateralFraction < 0.5 ? 0 : 1][index] = 1;
    }
  }
  const fixedLeft = findOrbitalComponents(pixels, validity, sides[0])[0];
  const fixedRight = findOrbitalComponents(pixels, validity, sides[1])[0];
  if (!fixedLeft || !fixedRight) return undefined;
  const separationMm = Math.hypot(
    (fixedLeft.row - fixedRight.row) * rowSpacingMm,
    (fixedLeft.column - fixedRight.column) * colSpacingMm,
  );
  return separationMm > 0
    ? { sides, components: [fixedLeft, fixedRight], rowSpacingMm, colSpacingMm, separationMm }
    : undefined;
}

function matchBilateralAnatomicalTemplate(
  prepared: AnatomicalPlaneLandmarks,
  candidate: Float32Array,
  validity: Float32Array,
): { score: number; minimumComponentRetention: number } | null {
  const bilateral = prepared.bilateral!;
  const matched: Array<{ component: OrbitalComponent; agreement: number }> = [];
  let minimumOverlap = 1;
  let minimumComponentRetention = 1;
  for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
    const side = bilateral.sides[sideIndex]!;
    let referenceDark = 0;
    let candidateDark = 0;
    let sharedDark = 0;
    for (let index = 0; index < candidate.length; index++) {
      if (!side[index] || !(validity[index]! >= 0.5) || !(prepared.validity[index]! >= 0.5)) continue;
      const fixed = prepared.pixels[index]! < DARK_COMPONENT_THRESHOLD;
      const moving = candidate[index]! < DARK_COMPONENT_THRESHOLD;
      referenceDark += Number(fixed);
      candidateDark += Number(moving);
      sharedDark += Number(fixed && moving);
    }
    if (sharedDark === 0) return null;
    minimumOverlap = Math.min(minimumOverlap, (2 * sharedDark) / (referenceDark + candidateDark));
    const fixed = bilateral.components[sideIndex]!;
    const component = findOrbitalComponents(candidate, validity, side)
      .map((moving) => {
        const areaRatio = moving.area / fixed.area;
        const centroidMm = Math.hypot(
          (moving.row - fixed.row) * bilateral.rowSpacingMm,
          (moving.column - fixed.column) * bilateral.colSpacingMm,
        );
        const eccentricityRatio = moving.eccentricity / fixed.eccentricity;
        return {
          component: moving,
          agreement: Math.exp(
            -Math.abs(Math.log(areaRatio)) - centroidMm / 15 - Math.abs(Math.log(eccentricityRatio)) / 4,
          ),
        };
      })
      .sort((first, second) => second.agreement - first.agreement)[0];
    if (!component) return null;
    matched.push(component);
    minimumComponentRetention = Math.min(minimumComponentRetention, component.component.area / fixed.area);
  }
  const movingSeparation = Math.hypot(
    (matched[0]!.component.row - matched[1]!.component.row) * bilateral.rowSpacingMm,
    (matched[0]!.component.column - matched[1]!.component.column) * bilateral.colSpacingMm,
  );
  if (!(movingSeparation > 0)) return null;
  const morphology =
    Math.min(matched[0]!.agreement, matched[1]!.agreement) *
    Math.exp(-Math.abs(Math.log(movingSeparation / bilateral.separationMm)));
  const [first, second] = bilateral.components;
  const symmetry = Math.min(first.area, second.area) / Math.max(first.area, second.area);
  return {
    score: morphology ** (symmetry * symmetry) * minimumOverlap ** (1 - symmetry) * minimumComponentRetention ** 0.3,
    minimumComponentRetention,
  };
}

export function prepareAnatomicalPlaneLandmarks(
  reference: ReferencePlane,
  exclusionMask?: Uint8Array,
  depthContext?: AnatomicalDepthContext,
): AnatomicalPlaneLandmarks | null {
  if (
    !Number.isInteger(reference.rows) ||
    !Number.isInteger(reference.cols) ||
    reference.rows < 2 ||
    reference.cols < 2 ||
    reference.pixels.length !== reference.rows * reference.cols ||
    (reference.valid && reference.valid.length !== reference.pixels.length) ||
    (exclusionMask && exclusionMask.length !== reference.pixels.length)
  ) {
    return null;
  }

  const nativeValidity = reference.valid ?? new Uint8Array(reference.pixels.length).fill(1);
  const scaled = resample2dAreaAverageWithValidity(
    reference.pixels,
    nativeValidity,
    reference.rows,
    reference.cols,
    LANDMARK_SIZE,
    LANDMARK_SIZE,
  );
  let minimumColumn = reference.cols;
  let maximumColumn = -1;
  let minimumRow = reference.rows;
  let maximumRow = -1;
  if (exclusionMask) {
    for (let index = 0; index < exclusionMask.length; index++) {
      if (!exclusionMask[index]) continue;
      const row = Math.floor(index / reference.cols);
      const column = index % reference.cols;
      minimumColumn = Math.min(minimumColumn, column);
      maximumColumn = Math.max(maximumColumn, column);
      minimumRow = Math.min(minimumRow, row);
      maximumRow = Math.max(maximumRow, row);
    }
  }
  const exclusionRect: ExclusionMask | undefined =
    maximumColumn >= minimumColumn && maximumRow >= minimumRow
      ? {
          x: minimumColumn / reference.cols,
          y: minimumRow / reference.rows,
          width: (maximumColumn - minimumColumn + 1) / reference.cols,
          height: (maximumRow - minimumRow + 1) / reference.rows,
        }
      : undefined;
  const normalized = normalizePerceptualSource(scaled.pixels, LANDMARK_SIZE, {
    exclusionRect,
    validity: scaled.validity,
  });
  const foreground = Uint8Array.from(normalized, (value, index) =>
    Number(scaled.validity[index]! > 0 && value > FOREGROUND_THRESHOLD),
  );
  const outside = new Uint8Array(normalized.length);
  const queue = new Uint32Array(normalized.length);
  let first = 0;
  let last = 0;
  const enqueue = (index: number) => {
    if (foreground[index] || outside[index]) return;
    outside[index] = 1;
    queue[last++] = index;
  };
  for (let index = 0; index < LANDMARK_SIZE; index++) {
    enqueue(index);
    enqueue((LANDMARK_SIZE - 1) * LANDMARK_SIZE + index);
    enqueue(index * LANDMARK_SIZE);
    enqueue(index * LANDMARK_SIZE + LANDMARK_SIZE - 1);
  }
  while (first < last) {
    const index = queue[first++]!;
    const column = index % LANDMARK_SIZE;
    if (column > 0) enqueue(index - 1);
    if (column + 1 < LANDMARK_SIZE) enqueue(index + 1);
    if (index >= LANDMARK_SIZE) enqueue(index - LANDMARK_SIZE);
    if (index + LANDMARK_SIZE < normalized.length) enqueue(index + LANDMARK_SIZE);
  }

  const holes = Uint8Array.from(normalized, (_value, index) =>
    Number(!foreground[index] && !outside[index] && scaled.validity[index]! > 0),
  );
  const excluded = exclusionMask
    ? resample2dAreaAverage(exclusionMask, reference.rows, reference.cols, LANDMARK_SIZE, LANDMARK_SIZE)
    : undefined;
  const gradient = computeGradientMagnitudeL1Square(normalized, LANDMARK_SIZE);
  const hasPhysicalGeometry = Boolean(
    reference.ippMm || reference.rowDir || reference.colDir || reference.rowSpacingDsMm || reference.colSpacingDsMm,
  );
  const axialGeometry = Boolean(
    reference.rowDir && reference.colDir && Math.abs(cross(reference.rowDir, reference.colDir).z) >= 0.9,
  );
  const bilateral =
    hasPhysicalGeometry && axialGeometry
      ? prepareBilateralAnatomicalTemplate(reference, normalized, scaled.validity, excluded)
      : undefined;
  const depthAnatomy =
    !bilateral && depthContext
      ? prepareDepthSensitiveAnatomy(reference, normalized, depthContext, exclusionRect)
      : undefined;
  if (hasPhysicalGeometry && !bilateral && !depthAnatomy) return null;
  const weights = new Float32Array(normalized.length);
  let supportedWeight = 0;
  let supportedPixels = 0;
  for (let row = 2; row < LANDMARK_SIZE - 2; row++) {
    for (let column = 2; column < LANDMARK_SIZE - 2; column++) {
      const index = row * LANDMARK_SIZE + column;
      if (excluded?.[index] || !(scaled.validity[index]! > 0)) continue;
      if (depthAnatomy) {
        if (outside[index] || !(normalized[index]! > FOREGROUND_THRESHOLD) || !(depthAnatomy.validity[index]! >= 0.5)) {
          continue;
        }
        const edge = gradient[index]!;
        const depth = depthAnatomy.pixels[index]!;
        const weight = (edge * edge + depth * depth) * scaled.validity[index]! * depthAnatomy.validity[index]!;
        if (!(weight > 0) || !Number.isFinite(weight)) continue;
        weights[index] = weight;
        supportedWeight += weight;
        supportedPixels++;
        continue;
      }
      if (!(normalized[index]! > 0.025 || holes[index])) continue;
      let nearHole = holes[index] ? 1 : 0;
      for (let y = -2; y <= 2 && !nearHole; y++) {
        for (let x = -2; x <= 2; x++) {
          if (holes[index + y * LANDMARK_SIZE + x]) {
            nearHole = 1;
            break;
          }
        }
      }
      if (!nearHole) continue;
      const weight = (0.1 + Math.max(0, 1 - normalized[index]!) * gradient[index]!) * scaled.validity[index]!;
      weights[index] = weight;
      supportedWeight += weight;
      supportedPixels++;
    }
  }
  if (!(supportedWeight > 0) || supportedPixels < 16) return null;
  return {
    size: LANDMARK_SIZE,
    pixels: normalized,
    validity: scaled.validity,
    weights,
    totalWeight: supportedWeight,
    supportedPixels,
    ...(exclusionRect ? { exclusionRect } : {}),
    ...(bilateral ? { bilateral } : {}),
  };
}

export function scoreAnatomicalPlaneLandmarks(prepared: AnatomicalPlaneLandmarks, candidate: CandidatePlane): number {
  if (
    candidate.rows < 2 ||
    candidate.cols < 2 ||
    candidate.pixels.length !== candidate.rows * candidate.cols ||
    candidate.valid.length !== candidate.pixels.length
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  const scaled = resample2dAreaAverageWithValidity(
    candidate.pixels,
    candidate.valid,
    candidate.rows,
    candidate.cols,
    prepared.size,
    prepared.size,
  );
  const normalized = normalizePerceptualSource(scaled.pixels, prepared.size, {
    exclusionRect: prepared.exclusionRect,
    validity: scaled.validity,
  });
  let weightSum = 0;
  let referenceSum = 0;
  let candidateSum = 0;
  let referenceSquared = 0;
  let candidateSquared = 0;
  let product = 0;
  for (let index = 0; index < normalized.length; index++) {
    const weight = prepared.weights[index]! * scaled.validity[index]!;
    if (!(weight > 0)) continue;
    const fixed = prepared.pixels[index]!;
    const moving = normalized[index]!;
    weightSum += weight;
    referenceSum += weight * fixed;
    candidateSum += weight * moving;
    referenceSquared += weight * fixed * fixed;
    candidateSquared += weight * moving * moving;
    product += weight * fixed * moving;
  }
  if (weightSum / prepared.totalWeight < 0.55) return Number.NEGATIVE_INFINITY;
  const fixedVariance = referenceSquared - (referenceSum * referenceSum) / Math.max(1e-9, weightSum);
  const movingVariance = candidateSquared - (candidateSum * candidateSum) / Math.max(1e-9, weightSum);
  if (!(fixedVariance > 1e-9 && movingVariance > 1e-9)) return Number.NEGATIVE_INFINITY;
  const structural = (product - (referenceSum * candidateSum) / weightSum) / Math.sqrt(fixedVariance * movingVariance);
  if (!prepared.bilateral) return structural;
  if (!(structural > 0)) return Number.NEGATIVE_INFINITY;
  const morphology = matchBilateralAnatomicalTemplate(prepared, normalized, scaled.validity);
  if (!morphology || !Number.isFinite(morphology.score) || !(morphology.score > 0)) {
    return Number.NEGATIVE_INFINITY;
  }
  return structural * morphology.score;
}

/** Return the least preserved independently matched acquired bilateral component. */
export function minimumBilateralAnatomicalRetention(
  prepared: AnatomicalPlaneLandmarks,
  candidate: CandidatePlane,
): number {
  if (
    !prepared.bilateral ||
    candidate.rows < 2 ||
    candidate.cols < 2 ||
    candidate.pixels.length !== candidate.rows * candidate.cols ||
    candidate.valid.length !== candidate.pixels.length
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  const scaled = resample2dAreaAverageWithValidity(
    candidate.pixels,
    candidate.valid,
    candidate.rows,
    candidate.cols,
    prepared.size,
    prepared.size,
  );
  const normalized = normalizePerceptualSource(scaled.pixels, prepared.size, {
    exclusionRect: prepared.exclusionRect,
    validity: scaled.validity,
  });
  return (
    matchBilateralAnatomicalTemplate(prepared, normalized, scaled.validity)?.minimumComponentRetention ??
    Number.NEGATIVE_INFINITY
  );
}
