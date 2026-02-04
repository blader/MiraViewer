import { describe, expect, it } from 'vitest';
import { computeCostDistanceMap, distThresholdFromSlider } from '../src/utils/segmentation/costDistanceGrow2d';

function idx(x: number, y: number, w: number) {
  return y * w + x;
}

describe('costDistanceGrow2d', () => {
  it('is monotonic when thresholding dist<=T (nested masks as slider increases)', async () => {
    const w = 64;
    const h = 64;
    const gray = new Uint8Array(w * h);
    gray.fill(120);

    // Add a mild gradient so distances aren't totally symmetric.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        gray[idx(x, y, w)] = 120 + Math.round((x / (w - 1)) * 10);
      }
    }

    const seedPx = { x: 20, y: 32 };
    const grow = await computeCostDistanceMap({
      gray,
      w,
      h,
      seedPx,
      roi: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 },
    });

    expect(grow.dist[idx(seedPx.x, seedPx.y, w)]).toBe(0);

    const t1 = distThresholdFromSlider({ quantileLut: grow.quantileLut, slider01: 0.2, gamma: 1.6 });
    const t2 = distThresholdFromSlider({ quantileLut: grow.quantileLut, slider01: 0.4, gamma: 1.6 });
    expect(t2).toBeGreaterThanOrEqual(t1);

    const mask1 = new Uint8Array(w * h);
    const mask2 = new Uint8Array(w * h);

    for (let i = 0; i < grow.dist.length; i++) {
      const d = grow.dist[i] ?? Number.POSITIVE_INFINITY;
      if (d <= t1) mask1[i] = 1;
      if (d <= t2) mask2[i] = 1;
    }

    for (let i = 0; i < mask1.length; i++) {
      if (mask1[i] && !mask2[i]) {
        throw new Error(`Non-monotonic: mask1 has pixel ${i} but mask2 does not`);
      }
    }
  });

  it('assigns substantially higher cost to crossing a strong intensity barrier', async () => {
    const w = 80;
    const h = 80;
    const gray = new Uint8Array(w * h);
    gray.fill(100);

    // A vertical high-intensity wall that spans the ROI.
    const wallX = 40;
    for (let y = 0; y < h; y++) {
      gray[idx(wallX, y, w)] = 250;
    }

    const seedPx = { x: 20, y: 40 };
    const grow = await computeCostDistanceMap({
      gray,
      w,
      h,
      seedPx,
      roi: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 },
    });

    const left = grow.dist[idx(30, 40, w)]!;
    const right = grow.dist[idx(52, 40, w)]!;

    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(right)).toBe(true);

    // Crossing the wall should add a noticeable extra cost beyond pure path length.
    expect(right - left).toBeGreaterThan(12);
  });

  it('penalizes high→low transitions more than low→high across the same step edge', async () => {
    const w = 80;
    const h = 40;
    const gray = new Uint8Array(w * h);

    // Left half bright, right half dark.
    const splitX = 40;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        gray[idx(x, y, w)] = x < splitX ? 200 : 60;
      }
    }

    const roi = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    const weights = { tumorCostStrength: 0, bgCostStrength: 0 };

    const seedBright = { x: 20, y: 20 };
    const targetDark = { x: 60, y: 20 };

    const seedDark = { x: 60, y: 20 };
    const targetBright = { x: 20, y: 20 };

    const growDownhill = await computeCostDistanceMap({
      gray,
      w,
      h,
      seedPx: seedBright,
      roi,
      weights,
    });

    const growUphill = await computeCostDistanceMap({
      gray,
      w,
      h,
      seedPx: seedDark,
      roi,
      weights,
    });

    const downCost = growDownhill.dist[idx(targetDark.x, targetDark.y, w)]!;
    const upCost = growUphill.dist[idx(targetBright.x, targetBright.y, w)]!;

    expect(Number.isFinite(downCost)).toBe(true);
    expect(Number.isFinite(upCost)).toBe(true);

    // Directionality invariant: crossing 200→60 should be noticeably harder than crossing 60→200.
    expect(downCost).toBeGreaterThan(upCost + 8);
  });
});
