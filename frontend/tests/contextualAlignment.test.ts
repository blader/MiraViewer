import { describe, expect, it } from 'vitest';
import { prepareAlignmentContext, selectInformativeAlignmentPlane } from '../src/utils/contextualAlignment';
import {
  makeTissueLabelPhantom,
  REFERENCE_CONTRAST,
  renderTissueContrast,
  translateZeroFilled,
} from './helpers/alignmentSynthetic';

const size = 64;
const anatomy = renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST);
const plane = (pixels: Float32Array, valid?: Uint8Array) => ({ pixels, valid, rows: size, cols: size });
const blank = () => plane(new Float32Array(size * size));

describe('automatic alignment context', () => {
  it('chooses sustained anatomical detail instead of blank ends or an isolated bright frame', () => {
    const selection = selectInformativeAlignmentPlane([
      blank(),
      plane(anatomy),
      blank(),
      blank(),
      plane(anatomy),
      plane(anatomy),
      plane(anatomy),
      blank(),
      blank(),
    ]);
    expect(selection).toBeGreaterThanOrEqual(4);
    expect(selection).toBeLessThanOrEqual(6);
  });

  it('does not mistake full-field random noise, constants, or unsupported images for anatomy', () => {
    let seed = 197;
    const noise = () =>
      Float32Array.from({ length: size * size }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0xffffffff;
      });
    expect(selectInformativeAlignmentPlane([plane(noise()), plane(noise()), plane(noise())])).toBeNull();
    expect(selectInformativeAlignmentPlane([blank(), blank(), blank()])).toBeNull();
    expect(selectInformativeAlignmentPlane([plane(new Float32Array(size * size).fill(200))])).toBeNull();
    expect(selectInformativeAlignmentPlane([plane(anatomy, new Uint8Array(size * size))])).toBeNull();
  });

  it('selects the same slab after a brightness/contrast change', () => {
    const inputs = [blank(), plane(anatomy), plane(anatomy), plane(anatomy), blank()];
    expect(selectInformativeAlignmentPlane(inputs)).toBe(2);
    expect(
      selectInformativeAlignmentPlane(
        inputs.map((frame) => plane(Float32Array.from(frame.pixels, (p) => p * 137 + 20))),
      ),
    ).toBe(2);
  });

  it('uses neighboring anatomy to reject an incorrect pose favored by one changed central slice', () => {
    const shifted = translateZeroFilled(anatomy, size, 4, -3);
    const references = [plane(anatomy), plane(anatomy), plane(anatomy), plane(anatomy), plane(anatomy)];
    const context = prepareAlignmentContext(references);
    const correct = context.score((index) => plane(index === 2 ? shifted : anatomy));
    const wrong = context.score((index) => plane(index === 2 ? anatomy : shifted));
    expect(correct.coverage).toBeGreaterThan(0.99);
    expect(correct.score).toBeGreaterThan(wrong.score + 0.02);
  });

  it('requires acquired support in every evidence plane and rejects malformed dimensions', () => {
    const context = prepareAlignmentContext([plane(anatomy), plane(anatomy), plane(anatomy)]);
    expect(context.score((index) => plane(anatomy, index === 1 ? new Uint8Array(size * size) : undefined)).score).toBe(
      -Infinity,
    );
    expect(() => prepareAlignmentContext([{ pixels: anatomy, rows: 3, cols: 4 }])).toThrow(/dimensions/);
    expect(prepareAlignmentContext([]).score(() => plane(anatomy)).score).toBe(-Infinity);
  });
});
