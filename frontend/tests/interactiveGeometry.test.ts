import { describe, expect, it } from 'vitest';
import type { SvrDirection, SvrRoiPlane, SvrSelectionPlane, SvrVolume } from '../src/types/svr';
import {
  createInteractivePlaneReader,
  mapInteractiveMarks,
  mapInteractivePlane,
} from '../src/utils/segmentation/interactiveGeometry';
import { voxelIndex, type VoxelBounds } from '../src/utils/segmentation/voxelGeometry';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

type Triple = [number, number, number];
function volume(dims: Triple = [8, 8, 6], geometry: Partial<SvrVolume> = {}): SvrVolume {
  const result: SvrVolume = {
    dims,
    voxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [0, 0, 0], max: dims },
    data: Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => index - 17.25),
    observedSupport: new Uint8Array(dims[0] * dims[1] * dims[2]).fill(1),
    ...geometry,
  };
  result.boundsMm = physicalVolumeBounds(result);
  return result;
}
const at = (source: SvrVolume, point: Triple) => voxelIndex({ x: point[0], y: point[1], z: point[2] }, source.dims);
const full = (source: SvrVolume): VoxelBounds => ({
  min: { x: 0, y: 0, z: 0 },
  max: { x: source.dims[0] - 1, y: source.dims[1] - 1, z: source.dims[2] - 1 },
});

describe('exact interactive physical-grid mapping', () => {
  it.each([false, true])('maps swapped native axes and in-plane flips=%s without changing the real section', (flip) => {
    const native = volume([5, 6, 7], { voxelSizeMm: [0.8, 1.2, 2.5], originMm: [10, -20, 30] });
    const sign = flip ? -1 : 1;
    const editing = volume([6, 7, 5], {
      direction: [0, 0, 1, sign, 0, 0, 0, sign, 0],
      voxelSizeMm: [1.2, 2.5, 0.8],
      originMm: volumeVoxelToPatient(native, flip ? [0, 5, 6] : [0, 0, 0]),
    });
    const stroke = { plane: 'axial', slice: 1 } as const;
    const mapped = mapInteractivePlane(editing, native, stroke);
    expect(mapped).toEqual({ plane: 'sagittal', slice: 1 });
    const expected: Triple = [1, flip ? 3 : 2, 3];
    const indices = Uint32Array.of(at(editing, [2, 3, 1]));
    expect(mapInteractiveMarks(editing, native, indices, stroke)).toEqual(Uint32Array.of(at(native, expected)));
    const reader = createInteractivePlaneReader(native, mapped.plane, full(native));
    expect(reader.readFrame(mapped.slice)[expected[2] * reader.width + expected[1]]).toBe(
      native.data[at(native, expected)],
    );
  });

  it('keeps a reversed slice axis and its integer crop phase instead of reusing the editing slice number', () => {
    const native = volume();
    const editing = volume(native.dims, { direction: [1, 0, 0, 0, 1, 0, 0, 0, -1], originMm: [0, 0, 5] });
    const stroke = { plane: 'axial', slice: 2 } as const;
    expect(mapInteractivePlane(editing, native, stroke)).toEqual({ plane: 'axial', slice: 3 });
    expect(mapInteractiveMarks(editing, native, Uint32Array.of(at(editing, [2, 4, 2])), stroke)).toEqual(
      Uint32Array.of(at(native, [2, 4, 3])),
    );
  });

  it('maps an anisotropic cropped overview sharing an oblique accepted rotation without rounding away phase', () => {
    const c = Math.cos(0.37),
      s = Math.sin(0.37),
      k = Math.cos(0.21),
      t = Math.sin(0.21);
    const direction: SvrDirection = [c, -s * k, s * t, s, c * k, -c * t, 0, t, k];
    const native = volume([12, 10, 8], { direction, voxelSizeMm: [0.7, 1.1, 2.3], originMm: [12, -34, 56] });
    const editing = volume([4, 4, 3], {
      direction,
      voxelSizeMm: [1.4, 2.2, 4.6],
      originMm: volumeVoxelToPatient(native, [2, 1, 0]),
    });
    const stroke = { plane: 'axial', slice: 1 } as const;
    expect(mapInteractivePlane(editing, native, stroke)).toEqual({ plane: 'axial', slice: 2 });
    expect(mapInteractiveMarks(editing, native, Uint32Array.of(at(editing, [2, 1, 1])), stroke)).toEqual(
      Uint32Array.of(at(native, [6, 3, 2])),
    );
    expect(mapInteractivePlane(native, editing, { plane: 'axial', slice: 2 })).toEqual(stroke);
    expect(() => mapInteractivePlane(native, editing, { plane: 'axial', slice: 3 })).toThrow(
      /exact native-cell center/,
    );
  });

  it.each([0.5, 0.01, 1e-8])('rejects a real fractional plane offset of %s cells rather than snapping it', (offset) => {
    const native = volume(),
      editing = volume(undefined, { originMm: [0, 0, offset] });
    expect(() => mapInteractivePlane(editing, native, { plane: 'axial', slice: 1 })).toThrow(
      /exact native-cell center/,
    );
  });

  it('rejects a noncoplanar section even when one marked point happens to coincide', () => {
    const angle = 0.2;
    const native = volume(),
      editing = volume(undefined, {
        direction: [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)],
      });
    expect(() => mapInteractivePlane(editing, native, { plane: 'axial', slice: 0 })).toThrow(/not coplanar/);
  });

  it('retains other real 3D marks without projecting them into a conditioning section', () => {
    const source = volume();
    const marks = Uint32Array.of(at(source, [2, 3, 1]), at(source, [2, 3, 2]));
    expect(mapInteractiveMarks(source, source, marks)).toEqual(marks);
    expect(() => mapInteractiveMarks(source, source, marks, { plane: 'axial', slice: 1 })).toThrow(/Off-plane/);
    expect(mapInteractiveMarks(source, source, new Uint32Array(), { plane: 'axial', slice: 1 })).toHaveLength(0);
  });

  it('rejects fractional in-plane mark centers even when the physical plane itself exists', () => {
    const native = volume(),
      editing = volume(undefined, { originMm: [0.5, 0, 0] });
    const stroke = { plane: 'axial', slice: 1 } as const;
    expect(mapInteractivePlane(editing, native, stroke)).toEqual(stroke);
    expect(() => mapInteractiveMarks(editing, native, Uint32Array.of(at(editing, [2, 3, 1])), stroke)).toThrow(
      /exact native-cell center/,
    );
  });

  it.each([
    'source support',
    'native support',
    'source nonfinite',
    'native nonfinite',
    'outside source',
    'outside context',
  ])('rejects %s rather than changing or dropping a literal mark', (kind) => {
    const source = volume(),
      native = volume();
    const marks = Uint32Array.of(0);
    if (kind === 'source support') source.observedSupport![0] = 0;
    if (kind === 'native support') native.observedSupport![0] = 0;
    if (kind === 'source nonfinite') source.data[0] = NaN;
    if (kind === 'native nonfinite') native.data[0] = Infinity;
    if (kind === 'outside source') marks[0] = 0xffffffff;
    if (kind === 'outside context') native.originMm = [1, 0, 0];
    const before = marks.slice();
    expect(() => mapInteractiveMarks(source, native, marks)).toThrow(/sample|outside/);
    expect(marks).toEqual(before);
  });

  it('preserves mark order, duplicates, all source bytes and caller geometry', () => {
    const source = volume(),
      native = volume();
    const marks = Uint32Array.of(19, 2, 19, 7);
    const before = {
      source: source.data.slice(),
      native: native.data.slice(),
      marks: marks.slice(),
      grid: JSON.stringify(source),
    };
    const mapped = mapInteractiveMarks(source, native, marks);
    expect(mapped).toEqual(marks);
    expect(mapped.buffer).not.toBe(marks.buffer);
    mapped.fill(0);
    expect(source.data).toEqual(before.source);
    expect(native.data).toEqual(before.native);
    expect(marks).toEqual(before.marks);
    expect(JSON.stringify(source)).toBe(before.grid);
  });

  it.each([
    { plane: 'axial', slice: -1 },
    { plane: 'axial', slice: 1.5 },
    { plane: 'axial', slice: 6 },
    { plane: 'unknown', slice: 1 },
  ])('rejects absent or invalid actual plane metadata %j', (stroke) => {
    const source = volume();
    expect(() => mapInteractivePlane(source, source, stroke as SvrSelectionPlane)).toThrow(/plane/);
    expect(() => mapInteractivePlane(source, source, undefined as unknown as SvrSelectionPlane)).toThrow(/plane/);
  });

  it('rejects an actual plane outside the loaded native context', () => {
    const source = volume(),
      native = volume([8, 8, 2], { originMm: [0, 0, 3] });
    expect(() => mapInteractivePlane(source, native, { plane: 'axial', slice: 1 })).toThrow(/outside/);
  });
});

describe('streamed native tracking planes, separate from output cropping', () => {
  it.each(['axial', 'coronal', 'sagittal'] as SvrRoiPlane[])(
    'reads the entire %s context in column-fast native order without display transforms',
    (plane) => {
      const source = volume([4, 3, 2], {
        voxelSizeMm: [0.5, 1.2, 3],
        displayInvert: true,
        displayWindow: [1000, 1001],
      });
      source.data = Float32Array.from(
        { length: 24 },
        (_, i) => Math.floor(i / 12) * 100 + (Math.floor(i / 4) % 3) * 10 + (i % 4) - 5,
      );
      const before = source.data.slice();
      const reader = createInteractivePlaneReader(source, plane, full(source));
      const frame = reader.readFrame(1);
      const expected =
        plane === 'axial'
          ? [95, 96, 97, 98, 105, 106, 107, 108, 115, 116, 117, 118]
          : plane === 'coronal'
            ? [5, 6, 7, 8, 105, 106, 107, 108]
            : [-4, 6, 16, 96, 106, 116];
      expect([...frame]).toEqual(expected);
      expect(reader.spacingMm).toEqual(
        plane === 'axial' ? [0.5, 1.2, 3] : plane === 'coronal' ? [0.5, 3, 1.2] : [1.2, 3, 0.5],
      );
      expect(frame.buffer.byteLength).toBe(frame.byteLength);
      frame.fill(-999);
      expect(source.data).toEqual(before);
      expect(reader.readFrame(1)).toEqual(Float32Array.from(expected));
    },
  );

  it('keeps a square real context separate from a shorter offset output without stretching or cropping input', () => {
    const source = volume([8, 8, 4]);
    const bounds = { min: { x: 0, y: 1, z: 1 }, max: { x: 7, y: 6, z: 2 } };
    const reader = createInteractivePlaneReader(source, 'axial', bounds);
    expect([reader.width, reader.height, reader.frameCount]).toEqual([8, 8, 4]);
    expect(reader.output).toEqual({ columnOffset: 0, rowOffset: 1, frameOffset: 1, columns: 8, rows: 6, frames: 2 });
    expect(reader.readFrame(0)).toEqual(source.data.slice(0, 64));
    expect(reader.readFrame(3)).toEqual(source.data.slice(192, 256));
    expect(createInteractivePlaneReader(source, 'coronal', bounds).output).toEqual({
      columnOffset: 0,
      rowOffset: 1,
      frameOffset: 1,
      columns: 8,
      rows: 2,
      frames: 6,
    });
    bounds.min.y = 0;
    expect(reader.output.rowOffset).toBe(1);
  });

  it.each(['support', 'NaN', 'Infinity'])('rejects unavailable %s context even outside the output crop', (kind) => {
    const source = volume([4, 4, 2]);
    const reader = createInteractivePlaneReader(source, 'axial', {
      min: { x: 1, y: 1, z: 0 },
      max: { x: 2, y: 2, z: 1 },
    });
    if (kind === 'support') source.observedSupport![0] = 0;
    else source.data[0] = kind === 'NaN' ? NaN : Infinity;
    expect(() => reader.readFrame(0)).toThrow(/unavailable or nonfinite/);
    expect(reader.readFrame(1)).toEqual(source.data.slice(16));
  });

  it('preserves observed zero, signed zero and backing-buffer offsets without retaining source aliases', () => {
    const backing = Float32Array.of(999, -0, 0, -7, 42, 777);
    const source = volume([2, 2, 1], { data: backing.subarray(1, 5) });
    const reader = createInteractivePlaneReader(source, 'axial', full(source));
    const values = reader.readFrame(0);
    expect(values).toEqual(Float32Array.of(-0, 0, -7, 42));
    expect(values.buffer).not.toBe(backing.buffer);
    values.fill(1);
    expect(backing).toEqual(Float32Array.of(999, -0, 0, -7, 42, 777));
  });

  it('rejects out-of-context output bounds, invalid frame indices and cancellation without clamping', () => {
    const source = volume();
    for (const x of [-1, 0.5, 8]) {
      const bounds = full(source);
      bounds.min.x = x;
      expect(() => createInteractivePlaneReader(source, 'axial', bounds)).toThrow(/exact cells/);
    }
    const reader = createInteractivePlaneReader(source, 'axial', full(source));
    for (const index of [-1, 1.5, 6, NaN]) expect(() => reader.readFrame(index)).toThrow(/outside/);
    const controller = new AbortController();
    controller.abort();
    expect(() => reader.readFrame(0, controller.signal)).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it.each(['dimensions', 'spacing', 'origin', 'direction', 'pixels', 'support'])(
    'rejects malformed %s before accepting source geometry or reading a frame',
    (kind) => {
      const source = volume(),
        native = volume();
      if (kind === 'dimensions') source.dims[0] = 0;
      if (kind === 'spacing') source.voxelSizeMm[1] = 0;
      if (kind === 'origin') source.originMm[0] = NaN;
      if (kind === 'direction') source.direction = [1, 1, 0, 0, 1, 0, 0, 0, 1];
      if (kind === 'pixels') source.data = new Float32Array(1);
      if (kind === 'support') source.observedSupport = new Uint8Array(1);
      expect(() => createInteractivePlaneReader(source, 'axial', full(native))).toThrow(/grid/);
      expect(() => mapInteractiveMarks(source, native, Uint32Array.of(0))).toThrow(/grid/);
    },
  );
});
