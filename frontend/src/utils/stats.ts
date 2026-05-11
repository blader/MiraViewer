export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export type RobustStats = { mu: number; sigma: number };

export function robustStats(samples: number[], sigmaFloor: number, minSamples = 16): RobustStats | null {
  if (samples.length < minSamples) return null;
  const mu = median(samples);
  const mad = median(samples.map((v) => Math.abs(v - mu)));
  const sigma = Math.max(sigmaFloor, 1.4826 * mad);
  if (!Number.isFinite(mu) || !Number.isFinite(sigma)) return null;
  return { mu, sigma };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
