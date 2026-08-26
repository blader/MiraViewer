import { describe, expect, it } from 'vitest';
import {
  hasPersistentTumorDepthProfile,
  hasPersistentTumorTarget,
  prepareTumorFocusedAlignment,
  prepareTumorFocusedDepthSection,
  scoreTumorFocusedAlignment,
  scoreTumorFocusedDepthProfile,
  type TumorFocusedDepthSection,
} from '../src/utils/svr/tumorFocusedAlignment';

const SIZE = 128;

function lesionPhantom(options: { row?: number; column?: number; radius?: number; contrast?: number } = {}) {
  const { row: centerRow = 65, column: centerColumn = 64, radius = 8, contrast = 0.48 } = options;
  const pixels = new Float32Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const x = (column - SIZE / 2) / (SIZE * 0.43);
      const y = (row - SIZE / 2) / (SIZE * 0.46);
      if (x * x + y * y >= 1) continue;
      const anatomy = 0.3 + 0.08 * Math.cos(x * 4) + 0.04 * Math.sin(y * 5);
      const lesion = ((row - centerRow) / radius) ** 2 + ((column - centerColumn) / (radius * 0.8)) ** 2;
      pixels[row * SIZE + column] = anatomy + (lesion <= 1 ? contrast : 0);
    }
  }
  return pixels;
}

function tumorMask() {
  const mask = new Uint8Array(SIZE * SIZE);
  for (let row = 42; row < 91; row++) mask.fill(1, row * SIZE + 43, row * SIZE + 85);
  return mask;
}

describe('opt-in tumor-focused acquired-plane correspondence', () => {
  it('tracks a spatially corresponding lesion through size and contrast changes instead of following peak brightness', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const reference = lesionPhantom();
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, valid, rows: SIZE, cols: SIZE }, tumorMask());
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const changed = lesionPhantom({ radius: 11, contrast: 0.31 });
    const wrongDepth = lesionPhantom({ row: 79, column: 76, radius: 8, contrast: 0.7 });

    const corresponding = scoreTumorFocusedAlignment(prepared, { pixels: changed, valid, rows: SIZE, cols: SIZE });
    const displaced = scoreTumorFocusedAlignment(prepared, { pixels: wrongDepth, valid, rows: SIZE, cols: SIZE });

    expect(corresponding).toBeGreaterThan(0.2);
    expect(corresponding).toBeGreaterThan(displaced + 0.1);
  });

  it('keeps lesion localization invariant to acquisition gain and additive intensity shifts', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const reference = lesionPhantom();
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, valid, rows: SIZE, cols: SIZE }, tumorMask());
    if (!prepared) throw new Error('Expected a visible reference lesion');

    const original = scoreTumorFocusedAlignment(prepared, { pixels: reference, valid, rows: SIZE, cols: SIZE });
    const transformed = Float32Array.from(reference, (value) => value * 420 + 37);
    const changed = scoreTumorFocusedAlignment(prepared, { pixels: transformed, valid, rows: SIZE, cols: SIZE });

    expect(changed).toBeCloseTo(original, 3);
  });

  it('preserves hyperintense lesion contrast beyond the healthy percentile and ignores a brighter displaced focus', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const reference = lesionPhantom({ contrast: 3 });
    const addDistractor = (pixels: Float32Array, contrast: number) => {
      for (let row = 45; row < 51; row++) {
        for (let column = 46; column < 52; column++) pixels[row * SIZE + column]! += contrast;
      }
      return pixels;
    };
    const prepared = prepareTumorFocusedAlignment(
      { pixels: addDistractor(reference, 5), valid, rows: SIZE, cols: SIZE },
      tumorMask(),
    );
    expect(prepared).not.toBeNull();
    if (!prepared) return;
    expect(prepared.component.row).toBeGreaterThan(57);
    expect(prepared.component.row).toBeLessThan(73);
    expect(prepared.component.column).toBeGreaterThan(56);
    expect(prepared.component.column).toBeLessThan(72);

    const growingLesion = addDistractor(lesionPhantom({ radius: 11, contrast: 1.8 }), 8);
    const unrelatedFocus = addDistractor(lesionPhantom({ contrast: 0 }), 10);

    expect(
      scoreTumorFocusedAlignment(prepared, { pixels: growingLesion, valid, rows: SIZE, cols: SIZE }),
    ).toBeGreaterThan(
      scoreTumorFocusedAlignment(prepared, { pixels: unrelatedFocus, valid, rows: SIZE, cols: SIZE }) + 0.2,
    );
  });

  it('uses the user-marked center to distinguish a small lesion from larger symmetric healthy lobes', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const pixels = lesionPhantom({ row: 60, column: 63, radius: 4, contrast: 0.36 });
    for (const centerColumn of [49, 78]) {
      for (let row = 50; row <= 71; row++) {
        for (let column = centerColumn - 8; column <= centerColumn + 8; column++) {
          if (((row - 61) / 10) ** 2 + ((column - centerColumn) / 8) ** 2 <= 1) {
            pixels[row * SIZE + column]! += 0.28;
          }
        }
      }
    }

    const prepared = prepareTumorFocusedAlignment({ pixels, valid, rows: SIZE, cols: SIZE }, tumorMask());

    expect(prepared).not.toBeNull();
    if (!prepared) return;
    expect(Math.abs(prepared.component.row - 60)).toBeLessThan(4);
    expect(Math.abs(prepared.component.column - 63)).toBeLessThan(4);
    expect(prepared.component.area).toBeLessThan(100);
  });

  it('recovers a uniquely dominant acquired supra-healthy source lesion when a centered distractor has no overlap', () => {
    const pixels = lesionPhantom({ row: 77, column: 58, radius: 7, contrast: 1.6 });
    for (let row = 63; row <= 67; row++) {
      for (let column = 62; column <= 66; column++) pixels[row * SIZE + column]! += 0.14;
    }

    const prepared = prepareTumorFocusedAlignment({ pixels, rows: SIZE, cols: SIZE }, tumorMask());

    expect(prepared).not.toBeNull();
    if (!prepared) return;
    expect(Math.abs(prepared.component.row - 77)).toBeLessThan(4);
    expect(Math.abs(prepared.component.column - 58)).toBeLessThan(4);
  });

  it('keeps the subtle marked source lesion when symmetric supra-healthy competitors are not uniquely dominant', () => {
    const pixels = lesionPhantom({ row: 65, column: 64, radius: 4, contrast: 0.22 });
    for (const centerColumn of [48, 79]) {
      for (let row = 54; row <= 65; row++) {
        for (let column = centerColumn - 5; column <= centerColumn + 5; column++) {
          if (((row - 59) / 5) ** 2 + ((column - centerColumn) / 5) ** 2 <= 1) {
            pixels[row * SIZE + column]! += 0.7;
          }
        }
      }
    }

    const prepared = prepareTumorFocusedAlignment({ pixels, rows: SIZE, cols: SIZE }, tumorMask());

    expect(prepared).not.toBeNull();
    if (!prepared) return;
    expect(Math.abs(prepared.component.row - 65)).toBeLessThan(4);
    expect(Math.abs(prepared.component.column - 64)).toBeLessThan(4);
  });

  it('prefers persistent lesion contrast through biological growth over a dimmer same-position lookalike', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const reference = lesionPhantom({ row: 62, column: 63, radius: 5, contrast: 0.36 });
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, valid, rows: SIZE, cols: SIZE }, tumorMask());
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const dimmerLookalike = lesionPhantom({ row: 62, column: 63, radius: 5, contrast: 0.12 });
    const growingLesion = lesionPhantom({ row: 60, column: 65, radius: 7, contrast: 0.35 });

    expect(
      scoreTumorFocusedAlignment(prepared, { pixels: growingLesion, valid, rows: SIZE, cols: SIZE }),
    ).toBeGreaterThan(scoreTumorFocusedAlignment(prepared, { pixels: dimmerLookalike, valid, rows: SIZE, cols: SIZE }));
  });

  it('tracks the nearest seeded lesion before considering a larger nearby competing component', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const reference = lesionPhantom({ row: 60, column: 60, radius: 4, contrast: 0.4 });
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, valid, rows: SIZE, cols: SIZE }, tumorMask());
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    const corresponding = lesionPhantom({ row: 60, column: 60, radius: 4, contrast: 0.38 });
    const withNearbyDistractor = Float32Array.from(corresponding);
    for (let row = 62; row <= 68; row++) {
      for (let column = 66; column <= 72; column++) {
        if (((row - 65) / 3) ** 2 + ((column - 69) / 3) ** 2 <= 1) {
          withNearbyDistractor[row * SIZE + column]! += 2;
        }
      }
    }

    const baseline = scoreTumorFocusedAlignment(prepared, { pixels: corresponding, valid, rows: SIZE, cols: SIZE });
    const tracked = scoreTumorFocusedAlignment(prepared, {
      pixels: withNearbyDistractor,
      valid,
      rows: SIZE,
      cols: SIZE,
    });

    expect(tracked).toBeLessThan(baseline * 1.5);
  });

  it('derives compact-versus-volumetric behavior only from the selected reference lesion scale', () => {
    const compact = prepareTumorFocusedAlignment(
      { pixels: lesionPhantom({ radius: 3, contrast: 0.55 }), rows: SIZE, cols: SIZE },
      tumorMask(),
    );
    const broad = prepareTumorFocusedAlignment(
      { pixels: lesionPhantom({ radius: 6, contrast: 0.55 }), rows: SIZE, cols: SIZE },
      tumorMask(),
    );

    expect(compact?.usesDepthProfile).toBe(false);
    expect(broad?.usesDepthProfile).toBe(true);
  });

  it('compares the same connected through-plane lesion independently of growth and acquisition intensity', () => {
    const reference = lesionPhantom({ radius: 6, contrast: 0.6 });
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, rows: SIZE, cols: SIZE }, tumorMask());
    if (!prepared) throw new Error('Expected a persistent reference lesion');
    const sections = (contrasts: number[]): TumorFocusedDepthSection[] =>
      contrasts.flatMap((contrast, index) => {
        const section = prepareTumorFocusedDepthSection(
          prepared,
          { pixels: lesionPhantom({ radius: 6, contrast }), rows: SIZE, cols: SIZE },
          index - 2,
        );
        return section ? [section] : [];
      });
    const fixed = sections([0.18, 0.35, 0.6, 0.43, 0.21]);
    const grown = sections([0.3, 0.52, 0.88, 0.67, 0.34]);
    const differentSection = sections([0.8, 0.32, 0.17, 0.38, 0.74]);

    expect(hasPersistentTumorDepthProfile(prepared, fixed)).toBe(true);
    expect(scoreTumorFocusedDepthProfile(prepared, fixed, grown)).toBeGreaterThan(0.98);
    expect(scoreTumorFocusedDepthProfile(prepared, fixed, grown)).toBeGreaterThan(
      scoreTumorFocusedDepthProfile(prepared, fixed, differentSection) + 0.5,
    );
  });

  it('rejects disconnected through-plane lookalikes and unsupported reference-core anatomy', () => {
    const reference = lesionPhantom({ radius: 6, contrast: 0.6 });
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, rows: SIZE, cols: SIZE }, tumorMask());
    if (!prepared) throw new Error('Expected a persistent reference lesion');
    const fixed = [-1, 0, 1].flatMap((offset) => {
      const section = prepareTumorFocusedDepthSection(
        prepared,
        { pixels: lesionPhantom({ radius: 6, contrast: 0.6 - Math.abs(offset) * 0.2 }), rows: SIZE, cols: SIZE },
        offset,
      );
      return section ? [section] : [];
    });
    const disconnected = [-1, 0, 1].flatMap((offset) => {
      const section = prepareTumorFocusedDepthSection(
        prepared,
        {
          pixels: lesionPhantom({ row: offset === 0 ? 65 : 81, radius: 4, contrast: 0.7 }),
          rows: SIZE,
          cols: SIZE,
        },
        offset,
      );
      return section ? [section] : [];
    });
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    for (let index = 0; index < valid.length; index++) {
      if (prepared.core[index]) valid[index] = 0;
    }

    expect(scoreTumorFocusedDepthProfile(prepared, fixed, disconnected)).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreTumorFocusedAlignment(prepared, { pixels: reference, valid, rows: SIZE, cols: SIZE })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('uses acquired target morphology only when a corresponding lesion exceeds the same reference aperture', () => {
    const prepared = prepareTumorFocusedAlignment(
      { pixels: lesionPhantom({ radius: 7, contrast: 1 }), rows: SIZE, cols: SIZE },
      tumorMask(),
    );
    if (!prepared) throw new Error('Expected a broad acquired reference lesion');
    const section = (pixels: Float32Array) => {
      const result = prepareTumorFocusedDepthSection(prepared, { pixels, rows: SIZE, cols: SIZE }, 0);
      if (!result) throw new Error('Expected a supported target section');
      return result;
    };
    const broadCorresponding = section(lesionPhantom({ row: 68, column: 62, radius: 7, contrast: 1.1 }));
    const weakCorresponding = section(lesionPhantom({ row: 68, column: 62, radius: 2, contrast: 0.6 }));
    const displacedBrightAnatomy = section(lesionPhantom({ row: 49, column: 77, radius: 7, contrast: 1.4 }));

    expect(hasPersistentTumorTarget(prepared, [broadCorresponding])).toBe(true);
    expect(hasPersistentTumorTarget(prepared, [weakCorresponding])).toBe(false);
    expect(hasPersistentTumorTarget(prepared, [displacedBrightAnatomy])).toBe(false);
  });

  it('defines the user-seeded reference core in physical space for anisotropic pixels', () => {
    const prepared = prepareTumorFocusedAlignment(
      {
        pixels: lesionPhantom({ radius: 5 }),
        rows: SIZE,
        cols: SIZE,
        rowSpacingDsMm: 2,
        colSpacingDsMm: 0.5,
      },
      tumorMask(),
    );
    if (!prepared) throw new Error('Expected a physical lesion core');
    let minimumRow = SIZE;
    let maximumRow = 0;
    let minimumColumn = SIZE;
    let maximumColumn = 0;
    for (let index = 0; index < prepared.core.length; index++) {
      if (!prepared.core[index]) continue;
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      minimumRow = Math.min(minimumRow, row);
      maximumRow = Math.max(maximumRow, row);
      minimumColumn = Math.min(minimumColumn, column);
      maximumColumn = Math.max(maximumColumn, column);
    }

    expect(maximumColumn - minimumColumn).toBeGreaterThan((maximumRow - minimumRow) * 2);
  });

  it('declines flat or unsupported lesion regions and never treats invalid pixels as tumor evidence', () => {
    const valid = new Uint8Array(SIZE * SIZE).fill(1);
    const mask = tumorMask();
    const flat = new Float32Array(SIZE * SIZE).fill(0.4);
    expect(prepareTumorFocusedAlignment({ pixels: flat, valid, rows: SIZE, cols: SIZE }, mask)).toBeNull();

    const reference = lesionPhantom();
    const prepared = prepareTumorFocusedAlignment({ pixels: reference, valid, rows: SIZE, cols: SIZE }, mask);
    if (!prepared) throw new Error('Expected a visible reference lesion');
    const unsupported = Uint8Array.from(valid, (value, index) => (mask[index] ? 0 : value));

    expect(
      scoreTumorFocusedAlignment(prepared, {
        pixels: Float32Array.from(reference, (value, index) => (mask[index] ? 1000 : value)),
        valid: unsupported,
        rows: SIZE,
        cols: SIZE,
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
  });

  it('rejects malformed planes and masks without mutating caller-owned buffers', () => {
    const pixels = lesionPhantom();
    const mask = tumorMask();
    const unchanged = Float32Array.from(pixels);

    expect(prepareTumorFocusedAlignment({ pixels, rows: SIZE, cols: SIZE }, new Uint8Array(3))).toBeNull();
    const prepared = prepareTumorFocusedAlignment({ pixels, rows: SIZE, cols: SIZE }, mask);
    expect(prepared).not.toBeNull();
    expect(pixels).toEqual(unchanged);
    if (!prepared) return;

    expect(
      scoreTumorFocusedAlignment(prepared, {
        pixels: new Float32Array(4),
        valid: new Uint8Array(4),
        rows: SIZE,
        cols: SIZE,
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
  });
});
