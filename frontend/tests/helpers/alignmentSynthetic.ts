export const Tissue = {
  canvas: 0,
  outer: 1,
  inner: 2,
  orbit: 3,
  nerve: 4,
  ventricle: 5,
  landmark: 6,
} as const;

export type TissueLabel = (typeof Tissue)[keyof typeof Tissue];
export type TissueContrast = Readonly<Record<TissueLabel, number>>;

export const REFERENCE_CONTRAST: TissueContrast = {
  0: 0,
  1: 0.18,
  2: 0.62,
  3: 0.86,
  4: 0.74,
  5: 0.28,
  6: 0.96,
};

export const NONFUNCTIONAL_CONTRAST: TissueContrast = {
  0: 0,
  1: 0.72,
  2: 0.24,
  3: 0.16,
  4: 0.88,
  5: 0.67,
  6: 0.36,
};

function isInsideEllipse(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): boolean {
  const normalizedX = (x - centerX) / radiusX;
  const normalizedY = (y - centerY) / radiusY;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
}

function isNearSegment(
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  halfWidth: number,
): boolean {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  const projection = ((x - startX) * segmentX + (y - startY) * segmentY) / segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const nearestX = startX + clampedProjection * segmentX;
  const nearestY = startY + clampedProjection * segmentY;
  return Math.hypot(x - nearestX, y - nearestY) <= halfWidth;
}

export function makeTissueLabelPhantom(size: number): Uint8Array {
  const labels = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const normalizedX = (x + 0.5) / size;
      const normalizedY = (y + 0.5) / size;
      const index = y * size + x;

      if (isInsideEllipse(normalizedX, normalizedY, 0.5, 0.5, 0.43, 0.47)) {
        labels[index] = Tissue.outer;
      }
      if (isInsideEllipse(normalizedX, normalizedY, 0.5, 0.51, 0.35, 0.4)) {
        labels[index] = Tissue.inner;
      }

      const inLeftNerve = isNearSegment(normalizedX, normalizedY, 0.34, 0.36, 0.47, 0.48, 0.014);
      const inRightNerve = isNearSegment(normalizedX, normalizedY, 0.66, 0.36, 0.53, 0.48, 0.014);
      if (inLeftNerve || inRightNerve) labels[index] = Tissue.nerve;

      const inLeftOrbit = isInsideEllipse(normalizedX, normalizedY, 0.34, 0.36, 0.065, 0.075);
      const inRightOrbit = isInsideEllipse(normalizedX, normalizedY, 0.66, 0.36, 0.065, 0.075);
      if (inLeftOrbit || inRightOrbit) labels[index] = Tissue.orbit;

      const inLeftVentricle = isInsideEllipse(normalizedX, normalizedY, 0.445, 0.585, 0.032, 0.082);
      const inRightVentricle = isInsideEllipse(normalizedX, normalizedY, 0.555, 0.585, 0.032, 0.082);
      if (inLeftVentricle || inRightVentricle) {
        labels[index] = Tissue.ventricle;
      }

      if (isInsideEllipse(normalizedX, normalizedY, 0.65, 0.69, 0.035, 0.028)) {
        labels[index] = Tissue.landmark;
      }
    }
  }

  return labels;
}

function isRelocatableInternalLabel(label: number): boolean {
  return label === Tissue.orbit || label === Tissue.ventricle || label === Tissue.landmark;
}

export function relocateInternalStructures(labels: Uint8Array, size: number): Uint8Array {
  const relocated = Uint8Array.from(labels);
  const pairedRows = Math.floor(size / 2);

  for (let y = 0; y < pairedRows; y++) {
    const mirroredY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const mirroredIndex = mirroredY * size + x;
      if (!isRelocatableInternalLabel(labels[index]) && !isRelocatableInternalLabel(labels[mirroredIndex])) {
        continue;
      }
      relocated[index] = labels[mirroredIndex];
      relocated[mirroredIndex] = labels[index];
    }
  }

  return relocated;
}

export function renderTissueContrast(labels: Uint8Array, contrast: TissueContrast): Float32Array {
  return Float32Array.from(labels, (label) => contrast[label as TissueLabel]);
}

export function remapForeground(pixels: Float32Array, remap: (value: number) => number): Float32Array {
  return Float32Array.from(pixels, (value) => (value === 0 ? 0 : Math.max(0.001, Math.min(1, remap(value)))));
}

export function translateZeroFilled(input: Float32Array, size: number, dx: number, dy: number): Float32Array {
  const translated = new Float32Array(input.length);
  for (let sourceY = 0; sourceY < size; sourceY++) {
    const targetY = sourceY + dy;
    if (targetY < 0 || targetY >= size) continue;
    for (let sourceX = 0; sourceX < size; sourceX++) {
      const targetX = sourceX + dx;
      if (targetX < 0 || targetX >= size) continue;
      translated[targetY * size + targetX] = input[sourceY * size + sourceX];
    }
  }
  return translated;
}

export type SyntheticStandardAffine2D = Readonly<{
  A: Readonly<{
    m00: number;
    m01: number;
    m10: number;
    m11: number;
  }>;
  b: Readonly<{ x: number; y: number }>;
}>;

function bilinearZeroSample(pixels: Float32Array, size: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xFraction = x - x0;
  const yFraction = y - y0;
  let sampled = 0;

  for (let yOffset = 0; yOffset <= 1; yOffset++) {
    const sourceY = y0 + yOffset;
    if (sourceY < 0 || sourceY >= size) continue;
    const yWeight = yOffset === 0 ? 1 - yFraction : yFraction;
    for (let xOffset = 0; xOffset <= 1; xOffset++) {
      const sourceX = x0 + xOffset;
      if (sourceX < 0 || sourceX >= size) continue;
      const xWeight = xOffset === 0 ? 1 - xFraction : xFraction;
      sampled += pixels[sourceY * size + sourceX] * xWeight * yWeight;
    }
  }

  return sampled;
}

/**
 * Generate moving[m] = fixed[movingToFixed(m)]. A production moving-to-fixed
 * warp should therefore recover fixed when given the same transform.
 */
export function renderMovingFromFixed(
  fixed: Float32Array,
  size: number,
  movingToFixed: SyntheticStandardAffine2D,
): Float32Array {
  if (fixed.length !== size * size) throw new Error('fixed length mismatch');
  const moving = new Float32Array(fixed.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fixedX = movingToFixed.A.m00 * x + movingToFixed.A.m01 * y + movingToFixed.b.x;
      const fixedY = movingToFixed.A.m10 * x + movingToFixed.A.m11 * y + movingToFixed.b.y;
      moving[y * size + x] = bilinearZeroSample(fixed, size, fixedX, fixedY);
    }
  }
  return moving;
}

export function countConnectedComponents(labels: Uint8Array, size: number, label: TissueLabel): number {
  const visited = new Uint8Array(labels.length);
  let components = 0;

  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== label || visited[start] === 1) continue;
    components += 1;
    const pending = [start];
    visited[start] = 1;

    while (pending.length > 0) {
      const index = pending.pop();
      if (index === undefined) break;
      const x = index % size;
      const y = Math.floor(index / size);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < size ? index + 1 : -1,
        y > 0 ? index - size : -1,
        y + 1 < size ? index + size : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && labels[neighbor] === label && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          pending.push(neighbor);
        }
      }
    }
  }

  return components;
}

export function labelTouchesLabel(
  labels: Uint8Array,
  size: number,
  label: TissueLabel,
  neighborLabel: TissueLabel,
): boolean {
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] !== label) continue;
    const x = index % size;
    const y = Math.floor(index / size);
    if (
      (x > 0 && labels[index - 1] === neighborLabel) ||
      (x + 1 < size && labels[index + 1] === neighborLabel) ||
      (y > 0 && labels[index - size] === neighborLabel) ||
      (y + 1 < size && labels[index + size] === neighborLabel)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizedLabelCentroid(
  labels: Uint8Array,
  size: number,
  label: TissueLabel,
): Readonly<{ x: number; y: number }> {
  let xSum = 0;
  let ySum = 0;
  let count = 0;
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] !== label) continue;
    xSum += index % size;
    ySum += Math.floor(index / size);
    count += 1;
  }
  if (count === 0) throw new Error(`label ${label} is absent`);
  return { x: xSum / count / size, y: ySum / count / size };
}
