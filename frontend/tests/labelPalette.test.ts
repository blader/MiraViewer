import { describe, expect, it } from 'vitest';
import { buildRgbaPalette256, rgbCss } from '../src/utils/segmentation/labelPalette';

describe('labelPalette', () => {
  it('creates a 256-entry RGBA palette', () => {
    const p = buildRgbaPalette256([]);
    expect(p).toBeInstanceOf(Uint8Array);
    expect(p.length).toBe(256 * 4);
  });

  it('keeps label 0 transparent by default', () => {
    const p = buildRgbaPalette256([{ id: 0, name: 'bg', color: [255, 0, 0] }]);
    expect(p[0]).toBe(255);
    expect(p[1]).toBe(0);
    expect(p[2]).toBe(0);
    expect(p[3]).toBe(0);
  });

  it('sets non-zero labels to opaque and clamps to byte', () => {
    const p = buildRgbaPalette256([{ id: 4, name: 'ET', color: [999, -3, 127.2] }]);
    const o = 4 * 4;
    expect(p[o]).toBe(255);
    expect(p[o + 1]).toBe(0);
    expect(p[o + 2]).toBe(127);
    expect(p[o + 3]).toBe(255);
  });

  it('ignores out-of-range label IDs', () => {
    const p = buildRgbaPalette256([
      { id: -1, name: 'bad', color: [10, 20, 30] },
      { id: 999, name: 'bad', color: [10, 20, 30] },
      { id: 1, name: 'ok', color: [10, 20, 30] },
    ]);

    expect(p[1 * 4 + 0]).toBe(10);
    expect(p[1 * 4 + 1]).toBe(20);
    expect(p[1 * 4 + 2]).toBe(30);
    expect(p[1 * 4 + 3]).toBe(255);
  });

  it('rgbCss clamps components', () => {
    expect(rgbCss([300, -2, 10.4])).toBe('rgb(255, 0, 10)');
  });
});
