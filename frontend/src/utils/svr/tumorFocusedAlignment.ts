import type { ExclusionMask } from '../../types/api';
import { normalizePerceptualSource } from '../perceptualSliceSimilarity';
import { resample2dAreaAverage, resample2dAreaAverageWithValidity } from './resample2d';

const TUMOR_ALIGNMENT_SIZE = 128;
const MINIMUM_COMPONENT_PIXELS = 4;
const MORPHOLOGICAL_OPENING_RADIUS = 4;

type TumorPlane = {
  pixels: Float32Array;
  rows: number;
  cols: number;
  valid?: Uint8Array;
  rowSpacingDsMm?: number;
  colSpacingDsMm?: number;
};

type TumorComponent = {
  area: number;
  row: number;
  column: number;
  contrast: number;
  containsSeed: boolean;
  corePixelCount: number;
  support?: Uint32Array;
};

export type PreparedTumorFocusedAlignment = {
  size: number;
  pixels: Float32Array;
  validity: Float32Array;
  region: Uint8Array;
  regionPixelCount: number;
  core: Uint8Array;
  corePixelCount: number;
  usesDepthProfile: boolean;
  exclusionRect: ExclusionMask;
  component: TumorComponent;
};

export type TumorFocusedDepthSection = {
  offsetMm: number;
  components: TumorComponent[];
  supraHealthyComponents: TumorComponent[];
  healthySupraThresholdMass: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((first, second) => first - second);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

function localBrightResidual(pixels: Float32Array, validity: Float32Array): Float32Array {
  const horizontalErosion = new Float32Array(pixels.length);
  const erosion = new Float32Array(pixels.length);
  const horizontalDilation = new Float32Array(pixels.length);
  const opened = new Float32Array(pixels.length);
  const filter = (source: Float32Array, destination: Float32Array, horizontal: boolean, minimum: boolean) => {
    for (let row = 0; row < TUMOR_ALIGNMENT_SIZE; row++) {
      for (let column = 0; column < TUMOR_ALIGNMENT_SIZE; column++) {
        const index = row * TUMOR_ALIGNMENT_SIZE + column;
        if (validity[index]! < 0.5) continue;
        let value = minimum ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        for (let offset = -MORPHOLOGICAL_OPENING_RADIUS; offset <= MORPHOLOGICAL_OPENING_RADIUS; offset++) {
          const sourceRow = horizontal ? row : row + offset;
          const sourceColumn = horizontal ? column + offset : column;
          if (
            sourceRow < 0 ||
            sourceRow >= TUMOR_ALIGNMENT_SIZE ||
            sourceColumn < 0 ||
            sourceColumn >= TUMOR_ALIGNMENT_SIZE
          ) {
            continue;
          }
          const sourceIndex = sourceRow * TUMOR_ALIGNMENT_SIZE + sourceColumn;
          if (validity[sourceIndex]! < 0.5) continue;
          value = minimum ? Math.min(value, source[sourceIndex]!) : Math.max(value, source[sourceIndex]!);
        }
        destination[index] = Number.isFinite(value) ? value : 0;
      }
    }
  };
  filter(pixels, horizontalErosion, true, true);
  filter(horizontalErosion, erosion, false, true);
  filter(erosion, horizontalDilation, true, false);
  filter(horizontalDilation, opened, false, false);
  return Float32Array.from(pixels, (value, index) =>
    validity[index]! >= 0.5 ? Math.max(0, value - opened[index]!) : 0,
  );
}

function extractTumorComponents(
  residual: Float32Array,
  validity: Float32Array,
  region: Uint8Array,
  seedIndex = -1,
  core?: Uint8Array,
  retainSupport = false,
  explicitThreshold?: number,
): TumorComponent[] {
  const values: number[] = [];
  for (let index = 0; index < residual.length; index++) {
    if (region[index] && validity[index]! >= 0.5) values.push(residual[index]!);
  }
  if (values.length < 16) return [];
  const threshold =
    explicitThreshold ??
    (() => {
      const center = median(values);
      const deviation = median(values.map((value) => Math.abs(value - center)));
      return center + Math.max(0.025, deviation * 2);
    })();
  const visited = new Uint8Array(residual.length);
  const queue = new Uint32Array(residual.length);
  const components: TumorComponent[] = [];

  for (let start = 0; start < residual.length; start++) {
    if (visited[start] || !region[start] || validity[start]! < 0.5 || residual[start]! < threshold) continue;
    let first = 0;
    let last = 1;
    let rowSum = 0;
    let columnSum = 0;
    let contrast = 0;
    let containsSeed = false;
    let corePixelCount = 0;
    visited[start] = 1;
    queue[0] = start;
    while (first < last) {
      const index = queue[first++]!;
      const row = Math.floor(index / TUMOR_ALIGNMENT_SIZE);
      const column = index % TUMOR_ALIGNMENT_SIZE;
      containsSeed ||= index === seedIndex;
      corePixelCount += Number(Boolean(core?.[index]));
      rowSum += row;
      columnSum += column;
      contrast += residual[index]!;
      for (const neighbor of [index - 1, index + 1, index - TUMOR_ALIGNMENT_SIZE, index + TUMOR_ALIGNMENT_SIZE]) {
        if (
          neighbor < 0 ||
          neighbor >= residual.length ||
          Math.abs((neighbor % TUMOR_ALIGNMENT_SIZE) - column) > 1 ||
          visited[neighbor] ||
          !region[neighbor] ||
          validity[neighbor]! < 0.5 ||
          residual[neighbor]! < threshold
        ) {
          continue;
        }
        visited[neighbor] = 1;
        queue[last++] = neighbor;
      }
    }
    if (last < MINIMUM_COMPONENT_PIXELS) continue;
    components.push({
      area: last,
      row: rowSum / last,
      column: columnSum / last,
      contrast: contrast / last,
      containsSeed,
      corePixelCount,
      ...(retainSupport ? { support: Uint32Array.from(queue.subarray(0, last)) } : {}),
    });
  }
  return components;
}

function supraHealthyTumorComponents(
  pixels: Float32Array,
  validity: Float32Array,
  region: Uint8Array,
  core?: Uint8Array,
): TumorComponent[] {
  const excess = Float32Array.from(pixels, (value, index) => (validity[index]! >= 0.5 ? Math.max(0, value - 1) : 0));
  return extractTumorComponents(excess, validity, region, -1, core, true, Number.EPSILON).sort(
    (first, second) => second.area * second.contrast - first.area * first.contrast,
  );
}

function scaleTumorPlane(plane: TumorPlane, exclusionRect: ExclusionMask) {
  const validity = plane.valid ?? new Uint8Array(plane.pixels.length).fill(1);
  const scaled = resample2dAreaAverageWithValidity(
    plane.pixels,
    validity,
    plane.rows,
    plane.cols,
    TUMOR_ALIGNMENT_SIZE,
    TUMOR_ALIGNMENT_SIZE,
  );
  const pixels = normalizePerceptualSource(scaled.pixels, TUMOR_ALIGNMENT_SIZE, {
    exclusionRect,
    validity: scaled.validity,
  });
  const firstColumn = Math.max(0, Math.floor(exclusionRect.x * TUMOR_ALIGNMENT_SIZE));
  const lastColumn = Math.min(
    TUMOR_ALIGNMENT_SIZE,
    Math.ceil((exclusionRect.x + exclusionRect.width) * TUMOR_ALIGNMENT_SIZE),
  );
  const firstRow = Math.max(0, Math.floor(exclusionRect.y * TUMOR_ALIGNMENT_SIZE));
  const lastRow = Math.min(
    TUMOR_ALIGNMENT_SIZE,
    Math.ceil((exclusionRect.y + exclusionRect.height) * TUMOR_ALIGNMENT_SIZE),
  );
  let lowRaw = Number.POSITIVE_INFINITY;
  let highRaw = Number.NEGATIVE_INFINITY;
  let lowNormalized = 0;
  let highNormalized = 0;
  for (let index = 0; index < pixels.length; index++) {
    const row = Math.floor(index / TUMOR_ALIGNMENT_SIZE);
    const column = index % TUMOR_ALIGNMENT_SIZE;
    if (
      (row >= firstRow && row < lastRow && column >= firstColumn && column < lastColumn) ||
      scaled.validity[index]! < 0.5 ||
      !(pixels[index]! > 0.051 && pixels[index]! < 0.999)
    ) {
      continue;
    }
    const raw = scaled.pixels[index]!;
    if (raw < lowRaw) {
      lowRaw = raw;
      lowNormalized = pixels[index]!;
    }
    if (raw > highRaw) {
      highRaw = raw;
      highNormalized = pixels[index]!;
    }
  }
  if (highRaw > lowRaw + 1e-9 && highNormalized > lowNormalized) {
    const gain = (highNormalized - lowNormalized) / (highRaw - lowRaw);
    for (let row = firstRow; row < lastRow; row++) {
      for (let column = firstColumn; column < lastColumn; column++) {
        const index = row * TUMOR_ALIGNMENT_SIZE + column;
        if (scaled.validity[index]! < 0.5) continue;
        // The stable anatomy owns the intensity basis, but explicit tumor focus must
        // not clip the lesion itself to that healthy tissue's 98th percentile.
        pixels[index] = Math.max(0, lowNormalized + (scaled.pixels[index]! - lowRaw) * gain);
      }
    }
  }
  return { pixels, validity: scaled.validity };
}

export function prepareTumorFocusedAlignment(
  reference: TumorPlane,
  tumorRegionMask: Uint8Array,
): PreparedTumorFocusedAlignment | null {
  if (
    reference.rows < 2 ||
    reference.cols < 2 ||
    reference.pixels.length !== reference.rows * reference.cols ||
    (reference.valid && reference.valid.length !== reference.pixels.length) ||
    tumorRegionMask.length !== reference.pixels.length
  ) {
    return null;
  }

  let firstRow = reference.rows;
  let lastRow = -1;
  let firstColumn = reference.cols;
  let lastColumn = -1;
  for (let index = 0; index < tumorRegionMask.length; index++) {
    if (!tumorRegionMask[index]) continue;
    const row = Math.floor(index / reference.cols);
    const column = index % reference.cols;
    firstRow = Math.min(firstRow, row);
    lastRow = Math.max(lastRow, row);
    firstColumn = Math.min(firstColumn, column);
    lastColumn = Math.max(lastColumn, column);
  }
  if (lastRow < firstRow || lastColumn < firstColumn) return null;
  const exclusionRect = {
    x: firstColumn / reference.cols,
    y: firstRow / reference.rows,
    width: (lastColumn - firstColumn + 1) / reference.cols,
    height: (lastRow - firstRow + 1) / reference.rows,
  };
  const scaledRegion = resample2dAreaAverage(
    tumorRegionMask,
    reference.rows,
    reference.cols,
    TUMOR_ALIGNMENT_SIZE,
    TUMOR_ALIGNMENT_SIZE,
  );
  const region = Uint8Array.from(scaledRegion, (support) => Number(support >= 0.5));
  const regionPixelCount = region.reduce((count, support) => count + support, 0);
  if (regionPixelCount < 16) return null;
  const scaled = scaleTumorPlane(reference, exclusionRect);
  const centerRow = (exclusionRect.y + exclusionRect.height / 2) * TUMOR_ALIGNMENT_SIZE;
  const centerColumn = (exclusionRect.x + exclusionRect.width / 2) * TUMOR_ALIGNMENT_SIZE;
  const seedRow = Math.max(0, Math.min(TUMOR_ALIGNMENT_SIZE - 1, Math.floor(centerRow)));
  const seedColumn = Math.max(0, Math.min(TUMOR_ALIGNMENT_SIZE - 1, Math.floor(centerColumn)));
  const seedIndex = seedRow * TUMOR_ALIGNMENT_SIZE + seedColumn;
  const residual = localBrightResidual(scaled.pixels, scaled.validity);
  const components = extractTumorComponents(residual, scaled.validity, region, seedIndex, undefined, true);
  const belongsToBilateralAnatomy = (component: TumorComponent) =>
    components.some((other) => {
      if (other === component) return false;
      const firstOffset = component.column - centerColumn;
      const secondOffset = other.column - centerColumn;
      if (firstOffset * secondOffset >= 0) return false;
      const scale = (Math.sqrt(component.area) + Math.sqrt(other.area)) / 2;
      return (
        Math.min(component.area, other.area) / Math.max(component.area, other.area) >= 0.5 &&
        Math.abs(component.row - other.row) <= scale &&
        Math.abs(firstOffset + secondOffset) <= scale
      );
    });
  components.sort((first, second) => {
    const firstContainsSeed = first.containsSeed;
    const secondContainsSeed = second.containsSeed;
    if (firstContainsSeed !== secondContainsSeed) return Number(secondContainsSeed) - Number(firstContainsSeed);
    const firstBilateral = belongsToBilateralAnatomy(first);
    const secondBilateral = belongsToBilateralAnatomy(second);
    if (firstBilateral !== secondBilateral) return Number(firstBilateral) - Number(secondBilateral);
    const firstDistance = Math.hypot(first.row - centerRow, first.column - centerColumn);
    const secondDistance = Math.hypot(second.row - centerRow, second.column - centerColumn);
    return firstDistance - secondDistance || second.contrast - first.contrast;
  });
  let component = components[0];
  if (!component) return null;
  const supraHealthy = supraHealthyTumorComponents(scaled.pixels, scaled.validity, region);
  const dominant = supraHealthy[0];
  const runner = supraHealthy[1];
  if (
    dominant &&
    Math.sqrt(dominant.area / Math.PI) > MORPHOLOGICAL_OPENING_RADIUS &&
    dominant.area * dominant.contrast > (runner?.area ?? 0) * (runner?.contrast ?? 0) * 2
  ) {
    const support = new Set(dominant.support);
    const overlap = (candidate: TumorComponent) =>
      candidate.support?.reduce((count, index) => count + Number(support.has(index)), 0) ?? 0;
    if (overlap(component) === 0) {
      const matching = [...components].sort((first, second) => overlap(second) - overlap(first))[0];
      if (matching && overlap(matching) > 0) component = matching;
    }
  }
  const rowSpacingMm = (reference.rowSpacingDsMm ?? 1) * (reference.rows / TUMOR_ALIGNMENT_SIZE);
  const colSpacingMm = (reference.colSpacingDsMm ?? 1) * (reference.cols / TUMOR_ALIGNMENT_SIZE);
  const coreRadiusMm = 1.5 * Math.sqrt((component.area * rowSpacingMm * colSpacingMm) / Math.PI);
  const core = new Uint8Array(region.length);
  let corePixelCount = 0;
  for (let index = 0; index < region.length; index++) {
    if (!region[index] || scaled.validity[index]! < 0.5) continue;
    const row = Math.floor(index / TUMOR_ALIGNMENT_SIZE);
    const column = index % TUMOR_ALIGNMENT_SIZE;
    if (Math.hypot((row - component.row) * rowSpacingMm, (column - component.column) * colSpacingMm) > coreRadiusMm) {
      continue;
    }
    core[index] = 1;
    corePixelCount++;
  }
  if (corePixelCount < MINIMUM_COMPONENT_PIXELS) return null;
  return {
    size: TUMOR_ALIGNMENT_SIZE,
    pixels: scaled.pixels,
    validity: scaled.validity,
    region,
    regionPixelCount,
    core,
    corePixelCount,
    usesDepthProfile: Math.sqrt(component.area / Math.PI) > MORPHOLOGICAL_OPENING_RADIUS,
    exclusionRect,
    component,
  };
}

function healthyNeighborhoodAgreement(
  prepared: PreparedTumorFocusedAlignment,
  pixels: Float32Array,
  validity: Float32Array,
): number {
  const rectangle = prepared.exclusionRect;
  const pad = Math.max(rectangle.width, rectangle.height) * 0.5;
  const x0 = Math.max(0, Math.floor((rectangle.x - pad) * prepared.size));
  const x1 = Math.min(prepared.size, Math.ceil((rectangle.x + rectangle.width + pad) * prepared.size));
  const y0 = Math.max(0, Math.floor((rectangle.y - pad) * prepared.size));
  const y1 = Math.min(prepared.size, Math.ceil((rectangle.y + rectangle.height + pad) * prepared.size));
  let count = 0;
  let sumFixed = 0;
  let sumMoving = 0;
  let fixedSquared = 0;
  let movingSquared = 0;
  let product = 0;
  for (let row = y0; row < y1; row++) {
    for (let column = x0; column < x1; column++) {
      const index = row * prepared.size + column;
      if (prepared.region[index] || prepared.validity[index]! < 0.5 || validity[index]! < 0.5) continue;
      const fixed = prepared.pixels[index]!;
      const moving = pixels[index]!;
      if (!(fixed > 0 && moving > 0)) continue;
      count++;
      sumFixed += fixed;
      sumMoving += moving;
      fixedSquared += fixed * fixed;
      movingSquared += moving * moving;
      product += fixed * moving;
    }
  }
  if (count < 32) return Number.NEGATIVE_INFINITY;
  const fixedVariance = fixedSquared - (sumFixed * sumFixed) / count;
  const movingVariance = movingSquared - (sumMoving * sumMoving) / count;
  if (!(fixedVariance > 1e-9 && movingVariance > 1e-9)) return Number.NEGATIVE_INFINITY;
  return (product - (sumFixed * sumMoving) / count) / Math.sqrt(fixedVariance * movingVariance);
}

export function scoreTumorFocusedAlignment(
  prepared: PreparedTumorFocusedAlignment,
  candidate: TumorPlane & { valid: Uint8Array },
): number {
  if (
    candidate.rows < 2 ||
    candidate.cols < 2 ||
    candidate.pixels.length !== candidate.rows * candidate.cols ||
    candidate.valid.length !== candidate.pixels.length
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  const scaled = scaleTumorPlane(candidate, prepared.exclusionRect);
  let supported = 0;
  let coreSupported = 0;
  for (let index = 0; index < prepared.region.length; index++) {
    if (scaled.validity[index]! < 0.5) continue;
    supported += Number(Boolean(prepared.region[index]));
    coreSupported += Number(Boolean(prepared.core[index]));
  }
  if (supported / prepared.regionPixelCount < 0.55 || coreSupported / prepared.corePixelCount < 0.55) {
    return Number.NEGATIVE_INFINITY;
  }
  const neighborhood = healthyNeighborhoodAgreement(prepared, scaled.pixels, scaled.validity);
  if (!(neighborhood > 0.05)) return Number.NEGATIVE_INFINITY;
  const components = extractTumorComponents(
    localBrightResidual(scaled.pixels, scaled.validity),
    scaled.validity,
    prepared.region,
    -1,
    prepared.core,
  );
  const coreMass = components.reduce((mass, component) => mass + component.contrast * component.corePixelCount, 0);
  return coreMass > 0 ? coreMass * Math.max(0, neighborhood) : Number.NEGATIVE_INFINITY;
}

export function prepareTumorFocusedDepthSection(
  prepared: PreparedTumorFocusedAlignment,
  plane: TumorPlane,
  offsetMm: number,
): TumorFocusedDepthSection | null {
  if (
    plane.rows < 2 ||
    plane.cols < 2 ||
    plane.pixels.length !== plane.rows * plane.cols ||
    (plane.valid && plane.valid.length !== plane.pixels.length)
  ) {
    return null;
  }
  const scaled = scaleTumorPlane(plane, prepared.exclusionRect);
  const components = extractTumorComponents(
    localBrightResidual(scaled.pixels, scaled.validity),
    scaled.validity,
    prepared.region,
    -1,
    prepared.core,
    true,
  );
  if (!components.length) return null;
  const healthyRegion = Uint8Array.from(prepared.region, (inside, index) =>
    Number(!inside && scaled.validity[index]! >= 0.5),
  );
  const healthyBackground = supraHealthyTumorComponents(scaled.pixels, scaled.validity, healthyRegion);
  return {
    offsetMm,
    components,
    supraHealthyComponents: supraHealthyTumorComponents(scaled.pixels, scaled.validity, prepared.region, prepared.core),
    healthySupraThresholdMass: (healthyBackground[0]?.area ?? 0) * (healthyBackground[0]?.contrast ?? 0),
  };
}

export function hasPersistentTumorTarget(
  prepared: PreparedTumorFocusedAlignment,
  sections: readonly TumorFocusedDepthSection[],
): boolean {
  return sections.some(({ supraHealthyComponents, healthySupraThresholdMass }) => {
    const sourceRadius = 1.5 * Math.sqrt(prepared.component.area / Math.PI);
    const corresponding = supraHealthyComponents.filter((component) => {
      const sourceDistance = Math.hypot(
        component.row - prepared.component.row,
        component.column - prepared.component.column,
      );
      const radius = Math.sqrt(component.area / Math.PI);
      return component.corePixelCount > 0 || sourceDistance <= radius + sourceRadius;
    });
    const strongest = corresponding.sort(
      (first, second) => second.area * second.contrast - first.area * first.contrast,
    )[0];
    const dominantMass = (supraHealthyComponents[0]?.area ?? 0) * (supraHealthyComponents[0]?.contrast ?? 0);
    return Boolean(
      strongest &&
      Math.sqrt(strongest.area / Math.PI) > MORPHOLOGICAL_OPENING_RADIUS &&
      strongest.contrast > 0.025 &&
      strongest.area * strongest.contrast > healthySupraThresholdMass &&
      strongest.area * strongest.contrast * 2 >= dominantMass,
    );
  });
}

function persistentComponentOverlap(first: TumorComponent, second: TumorComponent): number {
  if (!first.support || !second.support) return 0;
  const occupied = new Set(first.support);
  let shared = 0;
  for (const index of second.support) {
    const row = Math.floor(index / TUMOR_ALIGNMENT_SIZE);
    const column = index % TUMOR_ALIGNMENT_SIZE;
    let overlaps = false;
    for (let rowOffset = -1; rowOffset <= 1 && !overlaps; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        const neighborRow = row + rowOffset;
        const neighborColumn = column + columnOffset;
        if (
          neighborRow >= 0 &&
          neighborRow < TUMOR_ALIGNMENT_SIZE &&
          neighborColumn >= 0 &&
          neighborColumn < TUMOR_ALIGNMENT_SIZE &&
          occupied.has(neighborRow * TUMOR_ALIGNMENT_SIZE + neighborColumn)
        ) {
          overlaps = true;
          break;
        }
      }
    }
    shared += Number(overlaps);
  }
  return shared / Math.max(1, Math.min(first.area, second.area));
}

function trackTumorSections(
  sections: readonly TumorFocusedDepthSection[],
  prepared: PreparedTumorFocusedAlignment,
): Map<number, TumorComponent> {
  const center = sections.findIndex(({ offsetMm }) => Math.abs(offsetMm) <= 1e-6);
  if (center < 0) return new Map();
  const candidates = sections[center]!.components;
  const selected = [...candidates].sort(
    (first, second) =>
      Math.hypot(first.row - prepared.component.row, first.column - prepared.component.column) -
      Math.hypot(second.row - prepared.component.row, second.column - prepared.component.column),
  )[0];
  if (!selected) return new Map();
  const tracked = new Map<number, TumorComponent>([[center, selected]]);
  for (const direction of [-1, 1]) {
    let previous = selected;
    for (let index = center + direction; index >= 0 && index < sections.length; index += direction) {
      let next: TumorComponent | undefined;
      let greatestOverlap = 0;
      for (const component of sections[index]!.components) {
        const overlap = persistentComponentOverlap(previous, component);
        if (overlap > greatestOverlap) {
          next = component;
          greatestOverlap = overlap;
        }
      }
      if (!next) break;
      previous = next;
      tracked.set(index, previous);
    }
  }
  return tracked;
}

export function hasPersistentTumorDepthProfile(
  prepared: PreparedTumorFocusedAlignment,
  sections: readonly TumorFocusedDepthSection[],
): boolean {
  const tracked = trackTumorSections(sections, prepared);
  if (tracked.size < 3) return false;
  const masses = Array.from(tracked.values(), (component) => component.area * component.contrast);
  const mean = masses.reduce((sum, mass) => sum + mass, 0) / masses.length;
  return masses.some((mass) => Math.abs(mass - mean) > 1e-5);
}

export function scoreTumorFocusedDepthProfile(
  prepared: PreparedTumorFocusedAlignment,
  references: readonly TumorFocusedDepthSection[],
  targets: readonly TumorFocusedDepthSection[],
): number {
  const referenceTrack = trackTumorSections(references, prepared);
  const targetTrack = trackTumorSections(targets, prepared);
  const pairs: Array<{ reference: number; target: number }> = [];
  for (const [index, component] of referenceTrack) {
    const offset = references[index]!.offsetMm;
    let closest = -1;
    let minimumDistance = Number.POSITIVE_INFINITY;
    for (const targetIndex of targetTrack.keys()) {
      const distance = Math.abs(targets[targetIndex]!.offsetMm - offset);
      if (distance < minimumDistance) {
        closest = targetIndex;
        minimumDistance = distance;
      }
    }
    if (closest >= 0) {
      pairs.push({
        reference: component.area * component.contrast,
        target: targetTrack.get(closest)!.area * targetTrack.get(closest)!.contrast,
      });
    }
  }
  if (pairs.length < 3) return Number.NEGATIVE_INFINITY;
  const referenceMean = pairs.reduce((sum, pair) => sum + pair.reference, 0) / pairs.length;
  const targetMean = pairs.reduce((sum, pair) => sum + pair.target, 0) / pairs.length;
  let covariance = 0;
  let referenceVariance = 0;
  let targetVariance = 0;
  for (const pair of pairs) {
    const fixed = pair.reference - referenceMean;
    const moving = pair.target - targetMean;
    covariance += fixed * moving;
    referenceVariance += fixed * fixed;
    targetVariance += moving * moving;
  }
  return referenceVariance > 1e-9 && targetVariance > 1e-9
    ? covariance / Math.sqrt(referenceVariance * targetVariance)
    : Number.NEGATIVE_INFINITY;
}
