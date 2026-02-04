import type { SvrLabelMeta } from '../../types/svr';

function clampByte(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const xi = Math.round(x);
  return xi < 0 ? 0 : xi > 255 ? 255 : xi;
}

function clampLabelId(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const xi = Math.round(x);
  if (xi < 0 || xi > 255) return null;
  return xi;
}

export type RgbaPalette256 = Uint8Array;

export function buildRgbaPalette256(labels: readonly SvrLabelMeta[]): RgbaPalette256 {
  const rgba = new Uint8Array(256 * 4);

  // Default: label 0 is fully transparent (background/unlabeled).
  rgba[0] = 0;
  rgba[1] = 0;
  rgba[2] = 0;
  rgba[3] = 0;

  for (const m of labels) {
    const id = clampLabelId(m.id);
    if (id === null) continue;

    const [r, g, b] = m.color;
    const o = id * 4;
    rgba[o] = clampByte(r);
    rgba[o + 1] = clampByte(g);
    rgba[o + 2] = clampByte(b);

    // Keep label 0 transparent even if callers specify a color.
    rgba[o + 3] = id === 0 ? 0 : 255;
  }

  return rgba;
}

export function rgbCss(color: readonly [number, number, number]): string {
  const [r, g, b] = color;
  return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;
}
