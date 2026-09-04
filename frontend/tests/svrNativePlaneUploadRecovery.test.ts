import { describe, expect, it, vi } from 'vitest';
import { createNativePlaneBinding } from '../src/utils/svr/glRaymarch';
import type { MriPlaneData } from '../src/utils/svr/nativePlane';

function textureGl() {
  let activeSlot = 0;
  let failingSlot: number | null = null;
  let error = 0;
  const pixels = new Map<number, Float32Array | Uint8Array>();
  const upload = (data: Float32Array | Uint8Array) => {
    if (activeSlot === failingSlot) {
      failingSlot = null;
      error = 1285; // OUT_OF_MEMORY leaves earlier successful uploads in place.
    } else pixels.set(activeSlot, data.slice());
  };
  const gl = {
    NO_ERROR: 0,
    TEXTURE0: 100,
    TEXTURE_2D: 101,
    UNPACK_ALIGNMENT: 102,
    UNPACK_ROW_LENGTH: 103,
    TEXTURE_MIN_FILTER: 104,
    TEXTURE_MAG_FILTER: 105,
    TEXTURE_WRAP_S: 106,
    TEXTURE_WRAP_T: 107,
    NEAREST: 108,
    CLAMP_TO_EDGE: 109,
    R32F: 110,
    R8: 111,
    RED: 112,
    FLOAT: 113,
    UNSIGNED_BYTE: 114,
    MAX_TEXTURE_SIZE: 115,
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => name),
    activeTexture: vi.fn((unit: number) => {
      activeSlot = unit - 100;
    }),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn((...args: unknown[]) => upload(args[8] as Float32Array | Uint8Array)),
    texSubImage2D: vi.fn((...args: unknown[]) => upload(args[8] as Float32Array | Uint8Array)),
    getError: vi.fn(() => {
      const current = error;
      error = 0;
      return current;
    }),
    getParameter: vi.fn(() => 4096),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform3f: vi.fn(),
  };
  return {
    gl,
    pixels,
    failNextUpload: (slot: number) => {
      failingSlot = slot;
    },
  };
}

function plane(size: number, value: number): MriPlaneData {
  return {
    image: {
      rows: size,
      cols: size,
      pixels: new Float32Array(size * size).fill(value),
      validity: new Float32Array(size * size).fill(1),
    },
    origin: [-0.25, -0.25, 0],
    columnStep: [0.5, 0, 0],
    rowStep: [0, 0.5, 0],
    windowRange: [-10, 100],
    invert: false,
  };
}

describe.each([2, 3])('native texture recovery after a replacement with side %i', (size) => {
  it.each([
    { stage: 'validity', slot: 6 },
    { stage: 'mask', slot: 7 },
  ])('restores every channel of the old source after the replacement $stage upload fails', ({ slot }) => {
    const { gl, pixels, failNextUpload } = textureGl();
    const binding = createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram);
    const original = plane(2, -2);
    original.image.pixels[1] = -0;
    original.image.validity[1] = 0;
    const mask = Uint8Array.of(1, 0, 1, 0);
    const replacement = plane(size, 99);
    replacement.origin[2] = 0.3;
    const replacementMask = new Uint8Array(size * size).fill(2);
    try {
      binding.setPlane(original, mask);
      failNextUpload(slot);
      expect(() => binding.setPlane(replacement, replacementMask)).toThrow(/could not preserve/i);
      expect(pixels.get(5)).toEqual(replacement.image.pixels); // The failure was genuinely partial.
      binding.bind({ enabled: true });
      expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeEnabled', 0);

      gl.texImage2D.mockClear();
      gl.texSubImage2D.mockClear();
      // The cache returns the exact old image object when the user browses back.
      binding.setPlane(original, mask);
      binding.bind({ enabled: true });
      expect(pixels.get(5)).toEqual(original.image.pixels);
      expect(pixels.get(6)).toEqual(Uint8Array.of(255, 0, 255, 255));
      expect(pixels.get(7)).toEqual(mask);
      expect(gl.texImage2D.mock.calls.length + gl.texSubImage2D.mock.calls.length).toBe(3);
      expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeEnabled', 1);
      expect(gl.uniform3f).toHaveBeenCalledWith('u_nativeOrigin', ...original.origin);
      expect(Object.is(original.image.pixels[1], -0)).toBe(true);
      expect(original.image.pixels).toEqual(Float32Array.of(-2, -0, -2, -2));
      expect(replacement.image.pixels).toEqual(new Float32Array(size * size).fill(99));

      binding.setPlane(original, mask);
      expect(gl.texImage2D.mock.calls.length + gl.texSubImage2D.mock.calls.length).toBe(3);
    } finally {
      binding.dispose();
    }
  });
});
