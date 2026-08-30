import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareTrackingFrame, resizeTrackingGray } from '../src/utils/segmentation/interactiveFrame';

function hash(values: Uint8Array | Float32Array): string {
  return createHash('sha256')
    .update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
    .digest('hex');
}

// Synthetic Pillow 11.3.0 BICUBIC / Torch Float32 controls, not MRI or model predictions.
// Each row pins resize to 512², 13×9, the unchanged grid, then normalized CHW 512².
const controls = [
  [
    1,
    1,
    [
      '8a39d2abd3999ab73c34db2476849cddf303ce389b35826850f9a700589b4a90',
      'fee3d3a17121f0dd0962d02ae385a9076d6e1ccc7b82085992ff41eca3c2811a',
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
      '69e83f06523413fd91b2c478df38722ac39b6a22f68fd57843d5c510d178a4bc',
    ],
  ],
  [
    1,
    7,
    [
      '8297ba261a30840507bca825b877a5b67d5f57251c955d4842934f95db1dadc1',
      '67d4396694a3d4b7f4cc65390709755cace3379acfeb46477e8aa2f46f7a4083',
      '7803823953c7b00e982140b12bf29ee11f7f14a9a0a0dedd6d806f9e0b597355',
      '3aa11d06731371e07caf718e59aa3cca098ca3c1baeb4fa20c3581b3e495fc42',
    ],
  ],
  [
    7,
    1,
    [
      '46b1f7bb30570d21fb1da27a9c685670cd62a0eaaad8d590cf8efab654860fd8',
      '2184697b1829cbf98c3fa167d60c1c2b753d3521c78c99d6752cb2723b77d35d',
      '51438e5a0f443f5651fb816e1116b899886a0035cfe0ced8bcfa0c3bb276bf7c',
      'd4757e1e648e845f28f6c79a8ec1d422f0387a43e7db8eda88925caaf62ced4f',
    ],
  ],
  [
    2,
    2,
    [
      '2538717d0ad92c95624e8bb7f11d4488e7f8a9c099d97165f62e8d3aa5048e60',
      'eb9c326369c2533eaabd888c5c27f1a7c47458133b19b1d2ce3aee5cb29b0af3',
      'f673c0ee10b0c8fbe97e207c6c4e146dbfd8bee9b36831861fc336cf13e178d1',
      '20265f0516652ffa391da2d7ae419f6d37a9c1a8a69522ecd6918ae4da80e80a',
    ],
  ],
  [
    182,
    182,
    [
      '2ef9613214df70f1a8ae3f0faeec5217aa58914bae3eda202e4755112a0602ea',
      'e49cf970f5741dbb4c7be23de8830720565df31539cda2f819e3760ef0bb9fec',
      'eee9602a979c9bdb35d6da4a9b3b1ed549db7a02004507b55e8196a6a5b99638',
      'f2dd253e1fd9f7f8b944ad37a663e85a43f4e8d6ab9fc0c46d062dec78d39f59',
    ],
  ],
  [
    173,
    201,
    [
      '776af9e9f2263860538a5547d94e04f4c2156a8d20448ba0518689be5cca7504',
      '2a67a4320ae6b2a3c500e266d31d3f250a458fc9734af5082f9b985455558700',
      '4a43509e9ed4cf1ae9cbe4689bfdf3ff0724c69347484b6d8959095af008b891',
      '1bb2bb5f0a0ddae9f5275606ff49853015aa8fc37e7d3ae123516c036a5e686f',
    ],
  ],
  [
    513,
    511,
    [
      '8f8aee6813d996bc38de985d1524b5f1f3744a2b179532eeb47850f7dabef833',
      '24a5757d07f6d12fefec628b497008cf6b0ee7e4f094898689bef736796e9e8c',
      '5ddaa155fe48e984d386e4e5ee3bd283142f6ab0af99e925ba4721de58f66312',
      '145eda7105a39ee5cee685ddbef4edbd75eb612de6dc9a6ef4d4a484c37a0b21',
    ],
  ],
  [
    768,
    640,
    [
      '5b441c3fb2a9b8f342f2a120822203539257d8274f3e2209d3d1af2d30e450bf',
      'b4ae4448907f5412963b14824f982532f99ce089de668cb74f84090a1401dce9',
      'cae98da3b45d32038e26bdfed6913e85897ce8b2b06303e6dd2cf2ea8b3a92e3',
      '00941ab94c65f7537334aabc0216332e32d466b704b62176759a1b6d56935be8',
    ],
  ],
  [
    512,
    512,
    [
      '87bbe30743238f0a3944d335c0c8fe63fac291c88d1f955aa148c5be8e1673f9',
      '8656fc97267dafaf15f91b99056874b1e5463376b7371c42c2ac41665a5ed87d',
      '87bbe30743238f0a3944d335c0c8fe63fac291c88d1f955aa148c5be8e1673f9',
      '55d31d10658c7245e06da164ae58ae31a7e3f0292cbfee16e04050d0e12e5f99',
    ],
  ],
] as const;

describe.each(controls)('tracking preprocessing %i×%i', (width, height, expected) => {
  const gray = Uint8Array.from(
    { length: width * height },
    (_, i) => (i * 37 + Math.floor(i / width) * 53 + ((i * i) % 251)) % 256,
  );
  it.each([
    [512, 512],
    [13, 9],
    [width, height],
  ])('matches exact Pillow bytes at %i×%i', (outWidth, outHeight) => {
    const index = outWidth === 13 ? 1 : outWidth === 512 && outHeight === 512 ? 0 : 2;
    const before = hash(gray);
    expect(hash(resizeTrackingGray(gray, width, height, outWidth, outHeight))).toBe(expected[index]);
    expect(hash(gray)).toBe(before);
  });
  it('matches exact CHW Float32 quantization, resize and normalization without changing source', () => {
    const source = Float32Array.from(gray, (value) => value * 7.5 - 80);
    const before = hash(source);
    const normalized = prepareTrackingFrame(source, width, height, [-37, 1433]);
    expect(normalized).toHaveLength(3 * 512 * 512);
    expect(normalized.buffer).not.toBe(source.buffer);
    expect(hash(normalized)).toBe(expected[3]);
    expect(hash(source)).toBe(before);
  });
});

it('keeps unchanged byte grids and clamps the caller-specified range before normalization', () => {
  const gray = Uint8Array.of(5, 10, 20, 30);
  expect(resizeTrackingGray(gray, 2, 2, 2, 2)).toBe(gray);
  expect(hash(prepareTrackingFrame(Float32Array.of(-10), 1, 1, [0, 1]))).toBe(
    hash(prepareTrackingFrame(Float32Array.of(0), 1, 1, [0, 1])),
  );
  expect(hash(prepareTrackingFrame(Float32Array.of(10), 1, 1, [0, 1]))).toBe(
    hash(prepareTrackingFrame(Float32Array.of(1), 1, 1, [0, 1])),
  );
});

it('rejects partial, unavailable or nonfinite source pixels and invalid ranges or output grids', () => {
  expect(() => prepareTrackingFrame(new Float32Array(3), 2, 2, [0, 1])).toThrow(/complete source grid/);
  expect(() => prepareTrackingFrame(Float32Array.of(NaN), 1, 1, [0, 1])).toThrow(/unavailable or nonfinite/);
  expect(() => prepareTrackingFrame(Float32Array.of(Infinity), 1, 1, [0, 1])).toThrow(/unavailable or nonfinite/);
  expect(() => prepareTrackingFrame(Float32Array.of(1), 1, 1, [1, 1])).toThrow(/source range/);
  expect(() => prepareTrackingFrame(Float32Array.of(1), 1, 1, [-Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(
    /source range/,
  );
  expect(() => resizeTrackingGray(Uint8Array.of(1), 1, 1, 0, 1)).toThrow(/positive integer grid/);
});
