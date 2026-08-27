export function segmentationQuality(truth: Uint8Array, indices: Uint32Array) {
  const expected = truth.reduce((sum, value) => sum + value, 0);
  const intersection = indices.reduce((sum, index) => sum + truth[index]!, 0);
  return {
    dice: (2 * intersection) / (expected + indices.length),
    precision: intersection / indices.length,
    recall: intersection / expected,
  };
}
