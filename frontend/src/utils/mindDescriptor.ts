import { erodeFractionalSupportSquare } from './imageFeatures';

export type MindOffset2D = Readonly<{ dx: number; dy: number }>;

export type MindDescriptor2D = {
  size: number;
  channelCount: number;
  patchRadius: number;
  offsets: readonly MindOffset2D[];
  footprintRadius: number;
  /** Pixel-major layout: values[pixelIndex * channelCount + channelIndex]. */
  values: Float32Array;
  /** One only where the complete patch-plus-offset footprint is inside the image. */
  validCenters: Uint8Array;
};

/** Serial candidate scratch. Descriptor values are ephemeral until the next use of this scratch. */
export type MindDescriptorScratch = {
  size: number;
  squaredDifferences: Float32Array;
  horizontalConvolution: Float32Array;
  patchDistances: Float32Array;
  values: Float32Array;
  validCenters: Uint8Array;
};

export type MindAgreement = {
  /** Fixed-reference-denominator agreement in [0, 1]; higher is better. */
  score: number;
  /** Observed mean absolute descriptor distance in [0, 1]; lower is better. */
  meanDistance: number;
  /** Fixed-reference-weighted valid support before division by the denominator. */
  coverageNumerator: number;
};

// Fixed 2D adaptation. Cardinal channels stay first because they define local variation.
const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const PATCH_KERNEL = [0.25, 0.5, 0.25] as const;
const PATCH_RADIUS = 1;
const CARDINAL_CHANNEL_COUNT = 4;
const MIN_LOCAL_VARIATION = 1e-6;

const DEFAULT_OFFSETS: readonly MindOffset2D[] = Object.freeze(DIRECTIONS.map(([dx, dy]) => Object.freeze({ dx, dy })));
export const MIND_DESCRIPTOR_FOOTPRINT_RADIUS = descriptorFootprintRadius(PATCH_RADIUS, DEFAULT_OFFSETS);

export function createMindDescriptorScratch(size: number): MindDescriptorScratch {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('createMindDescriptorScratch: size must be a positive integer');
  }
  const centers = size * size;
  return {
    size,
    squaredDifferences: new Float32Array(centers),
    horizontalConvolution: new Float32Array(centers),
    patchDistances: new Float32Array(centers * DEFAULT_OFFSETS.length),
    values: new Float32Array(centers * DEFAULT_OFFSETS.length),
    validCenters: new Uint8Array(centers),
  };
}

function assertImageShape(pixels: Float32Array, size: number): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('computeMindDescriptor2D: size must be a positive integer');
  }
  const expectedLength = size * size;
  if (pixels.length !== expectedLength) {
    throw new Error(
      `computeMindDescriptor2D: expected ${size}x${size} (${expectedLength}) pixels, got ${pixels.length}`,
    );
  }
}

function finitePixel(pixels: Float32Array, index: number): number {
  const value = pixels[index] ?? 0;
  return Number.isFinite(value) ? value : 0;
}

function descriptorFootprintRadius(patchRadius: number, offsets: readonly MindOffset2D[]): number {
  let maximumOffset = 0;
  for (const offset of offsets) {
    maximumOffset = Math.max(maximumOffset, Math.abs(offset.dx), Math.abs(offset.dy));
  }
  return patchRadius + maximumOffset;
}

function assertDescriptorSelfConsistent(descriptor: MindDescriptor2D, label: string): void {
  if (
    !Number.isInteger(descriptor.size) ||
    descriptor.size <= 0 ||
    !Number.isInteger(descriptor.channelCount) ||
    descriptor.channelCount <= 0 ||
    !Number.isInteger(descriptor.patchRadius) ||
    descriptor.patchRadius < 0 ||
    !Number.isInteger(descriptor.footprintRadius) ||
    descriptor.footprintRadius < descriptor.patchRadius ||
    !Array.isArray(descriptor.offsets) ||
    descriptor.channelCount !== descriptor.offsets.length
  ) {
    throw new Error(`${label} descriptor layout is inconsistent`);
  }

  for (const offset of descriptor.offsets) {
    if (!Number.isInteger(offset?.dx) || !Number.isInteger(offset?.dy)) {
      throw new Error(`${label} descriptor layout is inconsistent`);
    }
  }
  if (descriptor.footprintRadius !== descriptorFootprintRadius(descriptor.patchRadius, descriptor.offsets)) {
    throw new Error(`${label} descriptor layout is inconsistent`);
  }

  const centerCount = descriptor.size * descriptor.size;
  if (
    descriptor.values.length !== centerCount * descriptor.channelCount ||
    descriptor.validCenters.length !== centerCount
  ) {
    throw new Error(`${label} descriptor length is inconsistent with its layout`);
  }
}

function sameDescriptorLayout(a: MindDescriptor2D, b: MindDescriptor2D): boolean {
  return (
    a.size === b.size &&
    a.channelCount === a.offsets.length &&
    b.channelCount === b.offsets.length &&
    a.channelCount === b.channelCount &&
    a.patchRadius === b.patchRadius &&
    a.footprintRadius === b.footprintRadius &&
    a.values.length === a.size * a.size * a.channelCount &&
    b.values.length === b.size * b.size * b.channelCount &&
    a.validCenters.length === a.size * a.size &&
    b.validCenters.length === b.size * b.size &&
    a.offsets.length === b.offsets.length &&
    a.offsets.every((offset, index) => offset.dx === b.offsets[index]?.dx && offset.dy === b.offsets[index]?.dy)
  );
}

export function computeMindDescriptor2D(
  pixels: Float32Array,
  size: number,
  scratch?: MindDescriptorScratch,
): MindDescriptor2D {
  assertImageShape(pixels, size);
  if (scratch && scratch.size !== size) {
    throw new Error('computeMindDescriptor2D: scratch dimensions do not match the image');
  }

  const offsets = DEFAULT_OFFSETS;
  const channelCount = offsets.length;
  const centerCount = size * size;
  const footprintRadius = MIND_DESCRIPTOR_FOOTPRINT_RADIUS;
  const squaredDifferences = scratch?.squaredDifferences ?? new Float32Array(centerCount);
  const horizontalConvolution = scratch?.horizontalConvolution ?? new Float32Array(centerCount);
  const patchDistances = scratch?.patchDistances ?? new Float32Array(centerCount * channelCount);
  patchDistances.fill(0);

  for (let channel = 0; channel < channelCount; channel++) {
    const { dx, dy } = offsets[channel];
    for (let y = 0; y < size; y++) {
      const shiftedY = y + dy;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const index = row + x;
        const shiftedX = x + dx;
        if (shiftedX < 0 || shiftedX >= size || shiftedY < 0 || shiftedY >= size) {
          squaredDifferences[index] = 0;
          continue;
        }
        const difference = finitePixel(pixels, index) - finitePixel(pixels, shiftedY * size + shiftedX);
        squaredDifferences[index] = difference * difference;
      }
    }

    horizontalConvolution.fill(0);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = PATCH_RADIUS; x < size - PATCH_RADIUS; x++) {
        const index = row + x;
        horizontalConvolution[index] =
          PATCH_KERNEL[0] * squaredDifferences[index - 1] +
          PATCH_KERNEL[1] * squaredDifferences[index] +
          PATCH_KERNEL[2] * squaredDifferences[index + 1];
      }
    }

    const channelOffset = channel * centerCount;
    for (let y = PATCH_RADIUS; y < size - PATCH_RADIUS; y++) {
      const row = y * size;
      for (let x = PATCH_RADIUS; x < size - PATCH_RADIUS; x++) {
        const index = row + x;
        patchDistances[channelOffset + index] =
          PATCH_KERNEL[0] * horizontalConvolution[index - size] +
          PATCH_KERNEL[1] * horizontalConvolution[index] +
          PATCH_KERNEL[2] * horizontalConvolution[index + size];
      }
    }
  }

  const values = scratch?.values ?? new Float32Array(centerCount * channelCount);
  const validCenters = scratch?.validCenters ?? new Uint8Array(centerCount);
  values.fill(0);
  validCenters.fill(0);
  for (let y = footprintRadius; y < size - footprintRadius; y++) {
    const row = y * size;
    for (let x = footprintRadius; x < size - footprintRadius; x++) {
      const index = row + x;
      validCenters[index] = 1;

      let localVariation = 0;
      for (let channel = 0; channel < CARDINAL_CHANNEL_COUNT; channel++) {
        localVariation += patchDistances[channel * centerCount + index];
      }
      localVariation /= CARDINAL_CHANNEL_COUNT;
      const varianceScale = Math.max(localVariation, MIN_LOCAL_VARIATION);
      const outputOffset = index * channelCount;
      let maximumResponse = 0;
      for (let channel = 0; channel < channelCount; channel++) {
        const response = Math.exp(-patchDistances[channel * centerCount + index] / varianceScale);
        values[outputOffset + channel] = response;
        maximumResponse = Math.max(maximumResponse, response);
      }
      if (maximumResponse > 0) {
        for (let channel = 0; channel < channelCount; channel++) {
          values[outputOffset + channel] /= maximumResponse;
        }
      }
    }
  }

  return {
    size,
    channelCount,
    patchRadius: PATCH_RADIUS,
    offsets,
    footprintRadius,
    values,
    validCenters,
  };
}

export function scoreMindDescriptorAgreement(
  reference: MindDescriptor2D,
  candidate: MindDescriptor2D,
  referenceWeights: Float32Array,
  candidateValidity: Float32Array,
): MindAgreement {
  assertDescriptorSelfConsistent(reference, 'reference');
  assertDescriptorSelfConsistent(candidate, 'candidate');
  if (reference.size !== candidate.size) {
    throw new Error('descriptor size mismatch');
  }
  if (!sameDescriptorLayout(reference, candidate)) {
    throw new Error('descriptor layout mismatch');
  }

  const centerCount = reference.size * reference.size;
  if (referenceWeights.length !== centerCount) {
    throw new Error(`reference weights length mismatch: expected ${centerCount}, got ${referenceWeights.length}`);
  }
  if (candidateValidity.length !== centerCount) {
    throw new Error(`candidate validity length mismatch: expected ${centerCount}, got ${candidateValidity.length}`);
  }

  const erodedValidity = erodeFractionalSupportSquare(candidateValidity, reference.size, reference.footprintRadius);
  let totalReferenceWeight = 0;
  let agreementSum = 0;
  let distanceSumObserved = 0;
  let coverageNumerator = 0;

  for (let index = 0; index < centerCount; index++) {
    const referenceWeight = referenceWeights[index] ?? 0;
    if (!Number.isFinite(referenceWeight) || referenceWeight <= 0) continue;
    totalReferenceWeight += referenceWeight;

    const localValidity =
      reference.validCenters[index] && candidate.validCenters[index]
        ? Math.max(0, Math.min(1, erodedValidity[index] ?? 0))
        : 0;
    if (localValidity <= 0) continue;

    const descriptorOffset = index * reference.channelCount;
    let distanceSum = 0;
    for (let channel = 0; channel < reference.channelCount; channel++) {
      distanceSum += Math.abs(
        reference.values[descriptorOffset + channel] - candidate.values[descriptorOffset + channel],
      );
    }
    const channelDistance = distanceSum / reference.channelCount;
    const localAgreement = Math.max(0, Math.min(1, 1 - channelDistance));
    agreementSum += referenceWeight * localValidity * localAgreement;
    distanceSumObserved += referenceWeight * localValidity * channelDistance;
    coverageNumerator += referenceWeight * localValidity;
  }

  return {
    score: totalReferenceWeight > 0 ? agreementSum / totalReferenceWeight : 0,
    meanDistance: coverageNumerator > 0 ? distanceSumObserved / coverageNumerator : 1,
    coverageNumerator,
  };
}
