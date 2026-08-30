import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retainMarkedComponents } from '../src/utils/segmentation/seedConnectedSelection';
import { yieldToMain } from '../src/utils/svr/svrUtils';

vi.mock('../src/utils/svr/svrUtils', () => ({ yieldToMain: vi.fn() }));

type Dims = readonly [number, number, number];
type Point = readonly [number, number, number];
const at = (dims: Dims, [x, y, z]: Point) => (z * dims[1] + y) * dims[0] + x;
function mask(dims: Dims, points: readonly Point[]) {
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (const point of points) data[at(dims, point)] = 1;
  return data;
}
const neighbors: Point[] = [];
for (let z = -1; z <= 1; z++)
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (x || y || z) neighbors.push([x, y, z]);

beforeEach(() => vi.mocked(yieldToMain).mockReset().mockResolvedValue(undefined));
afterEach(() => vi.unstubAllGlobals());

describe('literal-mark connected binary selection', () => {
  it.each(neighbors)('keeps the actual neighbor at offset [%s,%s,%s], including diagonals', async (x, y, z) => {
    const dims = [3, 3, 3] as const;
    const data = mask(dims, [
      [1, 1, 1],
      [1 + x, 1 + y, 1 + z],
    ]);
    const before = data.slice();
    expect(await retainMarkedComponents(data, dims, Uint32Array.of(at(dims, [1, 1, 1])))).toBe(0);
    expect(data).toEqual(before);
  });

  it.each([
    [
      [3, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 3, 0],
      [0, 0, 1],
    ],
    [
      [3, 3, 0],
      [0, 0, 1],
    ],
  ] as const)('does not connect wrapped row or plane endpoints %j and %j', async (first, second) => {
    const dims = [4, 4, 3] as const;
    const data = mask(dims, [first, second]);
    expect(await retainMarkedComponents(data, dims, Uint32Array.of(at(dims, first)))).toBe(1);
    expect(data).toEqual(mask(dims, [first]));
  });

  it('retains separately marked components, ignores duplicate anchors, and removes only unmarked islands', async () => {
    const dims = [12, 5, 3] as const;
    const kept = [
      [1, 1, 1],
      [2, 1, 1],
      [8, 1, 1],
      [9, 1, 1],
    ] as const;
    const data = mask(dims, [...kept, [5, 4, 1]]);
    const marks = Uint32Array.of(at(dims, kept[0]), at(dims, kept[0]), at(dims, kept[2]));
    const originalMarks = marks.slice();
    expect(await retainMarkedComponents(data, dims, marks)).toBe(1);
    expect(data).toEqual(mask(dims, kept));
    expect(marks).toEqual(originalMarks);
  });

  it('preserves an enclosed hole, thin boundary and every retained interior value exactly', async () => {
    const dims = [7, 7, 7] as const,
      kept: Point[] = [];
    for (let z = 1; z <= 3; z++)
      for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) if (x !== 2 || y !== 2 || z !== 2) kept.push([x, y, z]);
    kept.push([4, 3, 3]);
    const data = mask(dims, [...kept, [6, 6, 6]]);
    expect(await retainMarkedComponents(data, dims, Uint32Array.of(at(dims, [1, 1, 1])))).toBe(1);
    expect(data).toEqual(mask(dims, kept));
    expect(data[at(dims, [2, 2, 2])]).toBe(0);
  });

  it.each([{ marks: [] }, { marks: [1] }])(
    'removes all selected components when no mark is already selected: $marks',
    async ({ marks }) => {
      const data = Uint8Array.of(1, 0, 1);
      expect(await retainMarkedComponents(data, [3, 1, 1], Uint32Array.from(marks))).toBe(2);
      expect(data).toEqual(new Uint8Array(3));
    },
  );

  it('does not force zero-valued marks into the mask when another selected mark exists', async () => {
    const data = Uint8Array.of(1, 0, 1, 0, 1);
    expect(await retainMarkedComponents(data, [5, 1, 1], Uint32Array.of(0, 1))).toBe(2);
    expect(data).toEqual(Uint8Array.of(1, 0, 0, 0, 0));
  });

  it('handles an empty binary mask and singleton axes without adding anything', async () => {
    const data = new Uint8Array(1);
    expect(await retainMarkedComponents(data, [1, 1, 1], Uint32Array.of(0))).toBe(0);
    expect(data[0]).toBe(0);
    const column = Uint8Array.of(1, 1, 0, 1);
    expect(await retainMarkedComponents(column, [1, 4, 1], Uint32Array.of(0))).toBe(1);
    expect(column).toEqual(Uint8Array.of(1, 1, 0, 0));
  });

  it('changes only the supplied mask view and never mutates the foreground view', async () => {
    const backing = Uint8Array.of(9, 1, 0, 1, 9),
      marks = Uint32Array.of(99, 0, 99);
    expect(await retainMarkedComponents(backing.subarray(1, 4), [3, 1, 1], marks.subarray(1, 2))).toBe(1);
    expect(backing).toEqual(Uint8Array.of(9, 1, 0, 0, 9));
    expect(marks).toEqual(Uint32Array.of(99, 0, 99));
  });

  it.each(
    [
      null,
      [],
      [1, 1],
      [1, 1, 1, 1],
      [0, 1, 1],
      [-1, 1, 1],
      [0.5, 1, 1],
      [NaN, 1, 1],
      [Infinity, 1, 1],
      [2, 1, 1],
      [65536, 65536, 2],
      [Number.MAX_SAFE_INTEGER, 2, 2],
      ['1', 1, 1],
    ].map((dims) => ({ dims })),
  )('rejects invalid or incomplete dimensions $dims before mutation', async ({ dims }) => {
    const data = Uint8Array.of(1);
    await expect(retainMarkedComponents(data, dims as unknown as Dims, Uint32Array.of(0))).rejects.toThrow(
      /dimensions|grid/,
    );
    expect(data).toEqual(Uint8Array.of(1));
  });

  it.each([null, [1], new Uint16Array([1]), new Uint8ClampedArray([1])].map((data) => ({ data })))(
    'rejects non-Uint8 masks',
    async ({ data }) => {
      await expect(retainMarkedComponents(data as unknown as Uint8Array, [1, 1, 1], Uint32Array.of(0))).rejects.toThrow(
        /byte mask/,
      );
    },
  );

  it.each([null, [0], new Uint8Array([0]), new Int32Array([-1]), new Float32Array([0.5])].map((marks) => ({ marks })))(
    'rejects non-Uint32 marks',
    async ({ marks }) => {
      const data = Uint8Array.of(1);
      await expect(retainMarkedComponents(data, [1, 1, 1], marks as unknown as Uint32Array)).rejects.toThrow(
        /Uint32 marks/,
      );
      expect(data).toEqual(Uint8Array.of(1));
    },
  );

  it.each([2, 255])(
    'rejects binary value %s even after an earlier validation chunk, without mutation',
    async (value) => {
      const data = new Uint8Array(65537).fill(1);
      data[data.length - 1] = value;
      const before = data.slice();
      await expect(retainMarkedComponents(data, [65537, 1, 1], Uint32Array.of(0))).rejects.toThrow(/binary mask/);
      expect(data).toEqual(before);
    },
  );

  it.each([2, 0xffffffff])(
    'validates every foreground index before marking the valid first anchor (%s)',
    async (badIndex) => {
      const data = Uint8Array.of(1, 1);
      await expect(retainMarkedComponents(data, [2, 1, 1], Uint32Array.of(0, badIndex))).rejects.toThrow(/outside/);
      expect(data).toEqual(Uint8Array.of(1, 1));
    },
  );

  it('rejects pre-cancellation before touching the owned mask', async () => {
    const data = Uint8Array.of(1);
    await expect(retainMarkedComponents(data, [1, 1, 1], Uint32Array.of(0), AbortSignal.abort())).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(data[0]).toBe(1);
    expect(yieldToMain).not.toHaveBeenCalled();
  });

  it('cancels during validation without starting visitation', async () => {
    const abort = new AbortController(),
      data = new Uint8Array(65537).fill(1);
    vi.mocked(yieldToMain).mockImplementationOnce(async () => abort.abort());
    await expect(retainMarkedComponents(data, [65537, 1, 1], Uint32Array.of(0), abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(data.every((value) => value === 1)).toBe(true);
  });

  it('cancels a bounded traversal chunk without touching the separately published mask', async () => {
    const published = new Uint8Array(65537).fill(1),
      owned = published.slice(),
      abort = new AbortController();
    vi.mocked(yieldToMain).mockImplementation(async () => {
      if (owned[2048] === 2) abort.abort();
    });
    await expect(retainMarkedComponents(owned, [65537, 1, 1], Uint32Array.of(0), abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(owned[2048]).toBe(2);
    expect(owned[4096]).toBe(1);
    expect(published.every((value) => value === 1)).toBe(true);
  });

  it('rejects cancellation during final normalization instead of returning a partial result', async () => {
    const data = new Uint8Array(65537).fill(1),
      abort = new AbortController();
    vi.mocked(yieldToMain).mockImplementation(async () => {
      if (data[0] === 1 && data[65536] === 2) abort.abort();
    });
    await expect(retainMarkedComponents(data, [65537, 1, 1], Uint32Array.of(0), abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(data[0]).toBe(1);
    expect(data[65536]).toBe(2);
  });

  it.each([8192, 16384])(
    'uses a single four-byte-per-selected queue and linear bounded work for %s voxels',
    async (count) => {
      const data = new Uint8Array(count).fill(1),
        foreground = Uint32Array.of(0);
      const NativeUint32 = Uint32Array,
        allocations: number[] = [];
      vi.stubGlobal(
        'Uint32Array',
        new Proxy(NativeUint32, {
          construct(target, args) {
            allocations.push(args[0]);
            return Reflect.construct(target, args);
          },
        }),
      );
      expect(await retainMarkedComponents(data, [count, 1, 1], foreground)).toBe(0);
      expect(allocations).toEqual([count]);
      expect(yieldToMain).toHaveBeenCalledTimes(4 + count / 2048);
      expect(data.every((value) => value === 1)).toBe(true);
    },
  );

  it('sizes scratch by selected cells, not the full sparse volume', async () => {
    const dims = [128, 128, 32] as const;
    const data = mask(dims, [
        [1, 1, 1],
        [2, 2, 2],
        [127, 127, 31],
      ]),
      foreground = Uint32Array.of(at(dims, [1, 1, 1]));
    const NativeUint32 = Uint32Array,
      allocations: number[] = [];
    vi.stubGlobal(
      'Uint32Array',
      new Proxy(NativeUint32, {
        construct(target, args) {
          allocations.push(args[0]);
          return Reflect.construct(target, args);
        },
      }),
    );
    expect(await retainMarkedComponents(data, dims, foreground)).toBe(1);
    expect(allocations).toEqual([3]);
    expect(yieldToMain).toHaveBeenCalledTimes(19);
  });
});
