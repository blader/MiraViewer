import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodedFrame } from '../src/utils/decodedFrame';
import type { SvrLabelVolume, SvrNativeSource, SvrVolume } from '../src/types/svr';
import { deferred } from './helpers/deferred';
import { runSvrSliceGpuProbe } from './svrNativeCompositing.gpu';

const mocks = vi.hoisted(() => ({ decode: vi.fn(), revision: vi.fn(), patient: vi.fn() }));
vi.mock('../src/utils/decodedFrame', () => ({ getDecodedFrameBySopInstanceUid: mocks.decode }));
vi.mock('../src/utils/localApi', () => ({ getDatasetRevision: mocks.revision, getSelectedPatientKey: mocks.patient }));

import { useSvrNativePlane } from '../src/hooks/useSvrNativePlane';
import { createNativePlaneBinding, RAYMARCH_FRAGMENT_SHADER } from '../src/utils/svr/glRaymarch';
import {
  makeNativePlaneData,
  makeVolumePlaneData,
  NativeFrameCache,
  nativeDisplayWindow,
  nativeFrameCursor,
  nativePixelToVolumeVoxel,
  nativeSourcePlane,
  nearestNativeFrame,
  projectNativePlaneMask,
  projectVolumePlaneMask,
  volumeVoxelToNativePixel,
} from '../src/utils/svr/nativePlane';
import { computePhysicalBoxScale } from '../src/utils/svr/renderLod';
import { volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

function fixture() {
  const source: SvrNativeSource = {
    seriesUid: 'source',
    label: 'Synthetic original MRI',
    kind: 'original-3d',
    transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translationMm: [0, 0, 0] },
    frames: Array.from({ length: 4 }, (_, index) => ({
      sopInstanceUid: `frame-${index}`,
      rows: 3,
      columns: 4,
      originMm: [10, 20, 30 + 3 * index] as const,
      columnDirection: [1, 0, 0] as const,
      rowDirection: [0, 1, 0] as const,
      pixelSpacingMm: [2, 0.5] as const,
    })),
    contributingSopInstanceUids: ['frame-0', 'frame-1', 'frame-2', 'frame-3'],
  };
  const volume: SvrVolume = {
    data: new Float32Array(48).fill(0.5),
    observedSupport: new Uint8Array(48).fill(1),
    dims: [4, 3, 4],
    originMm: [10, 20, 30],
    voxelSizeMm: [0.5, 2, 3],
    boundsMm: { min: [9.75, 19, 28.5], max: [11.75, 25, 40.5] },
    reconstructionFingerprint: 'accepted',
    sourceProvenance: {
      mode: 'native-3d',
      datasetRevision: 1,
      patientKey: 'synthetic',
      studyUid: 'examination',
      frameOfReferenceUid: 'frame',
      fingerprint: 'accepted',
      primarySeriesUid: 'source',
      sources: [source],
      explanation: 'Synthetic source fixture',
    },
  };
  return { source, volume };
}

function image(sopInstanceUid = 'frame-0'): DecodedFrame {
  return {
    pixels: Float32Array.from({ length: 12 }, (_, index) => index * 31 - 150),
    validity: new Float32Array(12).fill(1),
    rows: 3,
    cols: 4,
    imageId: `miradb:${sopInstanceUid}`,
    seriesUid: 'source',
    sopInstanceUid,
    windowCenter: 50,
    windowWidth: 201,
    invert: false,
  };
}

beforeEach(() => {
  mocks.decode.mockReset().mockImplementation(async (_series: string, sop: string) => image(sop));
  mocks.revision.mockReset().mockResolvedValue(1);
  mocks.patient.mockReset().mockResolvedValue('synthetic');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native MRI geometry and categorical projection', () => {
  it('preserves original pixel centers and anisotropic pitch in volume/object coordinates', () => {
    const { source, volume } = fixture();
    const plane = makeNativePlaneData(volume, source, 1, image('frame-1'));
    expect(nativePixelToVolumeVoxel(volume, source, source.frames[1]!, 2, 1)).toEqual([2, 1, 1]);
    expect(volumeVoxelToNativePixel(volume, source, source.frames[1]!, [2, 1, 1])).toEqual([2, 1]);
    expect(plane.origin[0]).toBeCloseTo(-0.75 / 12);
    expect(plane.origin[1]).toBeCloseTo(-2 / 12);
    expect(plane.origin[2]).toBeCloseTo(-1.5 / 12);
    expect(plane.columnStep[0]).toBeCloseTo(0.5 / 12, 15);
    expect(plane.columnStep.slice(1)).toEqual([0, 0]);
    expect(plane.rowStep[1]).toBeCloseTo(2 / 12);
  });

  it('applies accepted absolute registration before the oriented volume mapping', () => {
    const { source, volume } = fixture();
    source.transform = { rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1], translationMm: [50, -10, 0] };
    volume.direction = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    volume.originMm = [30, 0, 30];
    expect(nativePixelToVolumeVoxel(volume, source, source.frames[2]!, 3, 2)).toEqual([3, 2, 2]);
    expect(nativeFrameCursor(volume, source, source.frames[2]!, [1.25, 1.5, 0.4])).toEqual([1.25, 1.5, 2]);
  });

  it('uses physical distance for reversed frame order and retains fractional canonical crosshairs', () => {
    const { source, volume } = fixture();
    source.frames = [...source.frames].reverse();
    expect(nearestNativeFrame(volume, source, [1, 1, 2.1])).toBe(1);
    expect(nativeFrameCursor(volume, source, source.frames[1]!, [0.25, 1.75, 0.1])).toEqual([0.25, 1.75, 2]);
  });

  it('retains full planes outside a reconstruction crop instead of clamping their geometry', () => {
    const { source, volume } = fixture();
    volume.originMm = [10.5, 22, 33];
    const plane = makeNativePlaneData(volume, source, 0, image());
    expect(nativePixelToVolumeVoxel(volume, source, source.frames[0]!, 0, 0)).toEqual([-1, -1, -1]);
    expect(plane.origin[0]).toBeLessThan((-0.5 * 2) / 12);
    expect(plane.image.pixels).toHaveLength(12);
  });

  it('projects exact label IDs and never selects unsupported or nonfinite reconstruction cells', () => {
    const { source, volume } = fixture();
    const labels: SvrLabelVolume = { data: new Uint8Array(48), dims: volume.dims, meta: [] };
    labels.data[14] = 7;
    labels.data[15] = 3;
    labels.data[16] = 9;
    volume.observedSupport![15] = 0;
    volume.data[16] = NaN;
    expect([...projectNativePlaneMask(volume, labels, source, source.frames[1]!)]).toEqual([
      0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(() => projectNativePlaneMask(volume, { ...labels, dims: [3, 4, 4] }, source, source.frames[0]!)).toThrow(
      /does not match/,
    );
  });

  it('uses categorical nearest-cell boundaries rather than interpolating labels', () => {
    const { source, volume } = fixture();
    const labels: SvrLabelVolume = { data: new Uint8Array(48), dims: volume.dims, meta: [] };
    labels.data[1] = 8;
    const frame = { ...source.frames[0]!, originMm: [10.25, 20, 30] as const };
    const projected = projectNativePlaneMask(volume, labels, source, frame);
    expect(projected[0]).toBe(8);
    expect(projected[1]).toBe(0);
    expect([...projected].filter(Boolean)).toEqual([8]);
  });

  it('preserves DICOM VOI including a width-one threshold, with a finite padding-aware fallback', () => {
    const decoded = image();
    expect(nativeDisplayWindow(decoded)).toEqual([-50.5, 149.5]);
    expect(nativeDisplayWindow({ ...decoded, windowWidth: 1 })).toEqual([49.5, 49.5]);
    decoded.windowCenter = undefined;
    decoded.windowWidth = undefined;
    decoded.validity[0] = 0;
    expect(nativeDisplayWindow(decoded)).toEqual([-119, 191]);
  });

  it('refuses mismatched pixels instead of texturing them with accepted geometry', () => {
    const { source, volume } = fixture();
    expect(() => makeNativePlaneData(volume, source, 0, image('other'))).toThrow(/does not match/);
    expect(() => makeNativePlaneData(volume, source, 0, { ...image(), rows: 4 })).toThrow(/does not match/);
  });
});

describe('resident MRI reformats', () => {
  it.each([
    ['axial', 4, 3, [95, 96, 97, 98, 105, 106, 107, 108, 115, 116, 117, 118]],
    ['coronal', 4, 4, [305, 306, 307, 308, 205, 206, 207, 208, 105, 106, 107, 108, 5, 6, 7, 8]],
    ['sagittal', 3, 4, [296, 306, 316, 196, 206, 216, 96, 106, 116, -4, 6, 16]],
  ] as const)(
    'reads exact %s samples in display order without decoding or inventing acquisition identity',
    (orientation, cols, rows, expected) => {
      const { volume } = fixture();
      volume.data = Float32Array.from(
        { length: 48 },
        (_, index) => Math.floor(index / 12) * 100 + (Math.floor(index / 4) % 3) * 10 + (index % 4) - 5,
      );
      volume.intensityRange = [-5, 318];
      volume.displayWindow = [40, 60];
      volume.displayInvert = true;
      const before = volume.data.slice();
      const provenance = volume.sourceProvenance;
      const plane = makeVolumePlaneData(volume, orientation, 1);
      expect([...plane.image.pixels]).toEqual(expected);
      expect([plane.image.cols, plane.image.rows]).toEqual([cols, rows]);
      expect([...plane.image.validity]).toEqual(new Array(cols * rows).fill(1));
      expect(Object.keys(plane.image).sort()).toEqual(['cols', 'pixels', 'rows', 'validity']);
      expect(plane).not.toHaveProperty('source');
      expect(plane).not.toHaveProperty('frame');
      expect(plane).not.toHaveProperty('frameIndex');
      expect(plane.windowRange).toEqual([40, 60]);
      expect(plane.invert).toBe(true);
      expect(mocks.decode).not.toHaveBeenCalled();
      plane.image.pixels.fill(-999);
      plane.image.validity.fill(0);
      plane.windowRange[0] = -999;
      expect(volume.data).toEqual(before);
      expect(volume.observedSupport).toEqual(new Uint8Array(48).fill(1));
      expect(volume.intensityRange).toEqual([-5, 318]);
      expect(volume.sourceProvenance).toBe(provenance);
    },
  );

  it.each(['axial', 'coronal', 'sagittal'] as const)(
    'keeps anisotropic, oblique %s pixel centers and steps in the accepted volume frame',
    (orientation) => {
      const { volume } = fixture();
      volume.originMm = [-10, 20, 15];
      volume.direction = [0, -1, 0, 1, 0, 0, 0, 0, 1];
      const plane = makeVolumePlaneData(volume, orientation, 1);
      const [nx, ny, nz] = volume.dims;
      const box = computePhysicalBoxScale({ nx, ny, nz }, volume.voxelSizeMm);
      for (const [column, row] of [
        [0, 0],
        [plane.image.cols - 1, plane.image.rows - 1],
      ]) {
        const object = plane.origin.map(
          (value, axis) => value + column! * plane.columnStep[axis]! + row! * plane.rowStep[axis]!,
        );
        const voxel = object.map((value, axis) => (value / box[axis]! + 0.5) * volume.dims[axis]! - 0.5) as [
          number,
          number,
          number,
        ];
        const expected: [number, number, number] =
          orientation === 'axial'
            ? [column!, row!, 1]
            : orientation === 'coronal'
              ? [column!, 1, nz - 1 - row!]
              : [1, column!, nz - 1 - row!];
        const patient = volumeVoxelToPatient(volume, voxel);
        volumeVoxelToPatient(volume, expected).forEach((value, axis) => expect(patient[axis]).toBeCloseTo(value, 12));
      }
      expect(Math.hypot(...plane.columnStep)).toBeCloseTo((orientation === 'sagittal' ? 2 : 0.5) / 12, 12);
      expect(Math.hypot(...plane.rowStep)).toBeCloseTo((orientation === 'axial' ? 2 : 3) / 12, 12);
    },
  );

  it('preserves raw zeros and unavailable pixels while keeping unsupported/nonfinite cells out of categorical masks', () => {
    const { volume } = fixture();
    volume.data[12] = -0;
    volume.data[13] = 0;
    volume.data[14] = -17;
    volume.observedSupport![14] = 0;
    volume.data[15] = NaN;
    volume.data[16] = Infinity;
    const before = volume.data.slice();
    const support = volume.observedSupport!.slice();
    const labels: SvrLabelVolume = {
      data: Uint8Array.from({ length: 48 }, (_, index) => index + 1),
      dims: volume.dims,
      meta: [],
    };
    const labelBefore = labels.data.slice();
    const plane = makeVolumePlaneData(volume, 'axial', 1);
    expect(Object.is(plane.image.pixels[0], -0)).toBe(true);
    expect(plane.image.pixels.slice(1, 5)).toEqual(Float32Array.of(0, -17, NaN, Infinity));
    expect([...plane.image.validity]).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);
    expect([...projectVolumePlaneMask(volume, labels, 'axial', 1)]).toEqual([
      13, 14, 0, 0, 0, 18, 19, 20, 21, 22, 23, 24,
    ]);
    expect(projectVolumePlaneMask(volume, null, 'axial', 1)).toEqual(new Uint8Array(12));
    expect(() => projectVolumePlaneMask(volume, { ...labels, dims: [3, 4, 4] }, 'axial', 1)).toThrow(/does not match/);
    expect(volume.data).toEqual(before);
    expect(volume.observedSupport).toEqual(support);
    expect(labels.data).toEqual(labelBefore);
  });

  it.each([
    ['coronal', [41, 42, 43, 44, 29, 30, 31, 32, 17, 18, 19, 20, 5, 6, 7, 8]],
    ['sagittal', [38, 42, 46, 26, 30, 34, 14, 18, 22, 2, 6, 10]],
  ] as const)(
    'projects %s categorical IDs with the same display row ordering as source samples',
    (orientation, expected) => {
      const { volume } = fixture();
      const labels: SvrLabelVolume = {
        data: Uint8Array.from({ length: 48 }, (_, index) => index + 1),
        dims: volume.dims,
        meta: [],
      };
      const before = labels.data.slice();
      const mask = projectVolumePlaneMask(volume, labels, orientation, 1);
      expect([...mask]).toEqual(expected);
      mask.fill(255);
      expect(labels.data).toEqual(before);
    },
  );

  it('uses the reconstruction window rather than a native source VOI for independent-2d reformats', () => {
    const { volume } = fixture();
    volume.sourceProvenance!.mode = 'independent-2d';
    volume.intensityRange = [-1000, 2000];
    volume.displayWindow = [0.2, 0.8];
    delete volume.observedSupport;
    expect(makeVolumePlaneData(volume, 'axial', 0)).toMatchObject({ windowRange: [0.2, 0.8], invert: false });
    expect([...makeVolumePlaneData(volume, 'axial', 0).image.validity]).toEqual(new Array(12).fill(1));
  });

  it.each([-1, 0.5, NaN, Infinity, 4])(
    'refuses invalid slice %s instead of clamping to different geometry',
    (slice) => {
      const { volume } = fixture();
      expect(() => makeVolumePlaneData(volume, 'axial', slice)).toThrow(/does not match/);
      expect(() => projectVolumePlaneMask(volume, null, 'axial', slice)).toThrow(/does not match/);
    },
  );
});

describe('accepted source anatomical planes', () => {
  it.each([
    ['axial', [1, 0, 0, 0, 1, 0, 0, 0, 1]],
    ['coronal', [1, 0, 0, 0, 0, -1, 0, 1, 0]],
    ['sagittal', [0, 0, 1, 0, 1, 0, -1, 0, 0]],
  ] as const)('classifies %s from the accepted transformed normal, not the source name', (expected, rotation) => {
    const { source } = fixture();
    source.label = 'Unreliable SAG name';
    source.transform = { rotation, translationMm: [123, -456, 789] };
    const before = JSON.stringify(source);
    expect(nativeSourcePlane(source)).toBe(expected);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('accepts residual obliquity and reversed frame normals without changing anatomical classification', () => {
    const { source } = fixture();
    const angle = Math.PI / 6;
    source.transform = {
      rotation: [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)],
      translationMm: [0, 0, 0],
    };
    source.frames = source.frames.map((frame) => ({ ...frame, columnDirection: [-1, 0, 0] }));
    expect(nativeSourcePlane(source)).toBe('axial');
  });

  it.each([31, 44, 45, 46, 59])(
    'reports a %s degree source as oblique instead of picking the nearest axis',
    (degrees) => {
      const { source } = fixture();
      const angle = (degrees * Math.PI) / 180;
      source.transform = {
        rotation: [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)],
        translationMm: [0, 0, 0],
      };
      expect(nativeSourcePlane(source)).toBeNull();
    },
  );

  it.each(['empty', 'nonfinite', 'overflow', 'parallel', 'spacing', 'dimensions', 'pose', 'mixed'] as const)(
    'does not invent a plane for %s source geometry',
    (kind) => {
      const { source } = fixture();
      if (kind === 'empty') source.frames = [];
      else if (kind === 'pose') source.transform = { ...source.transform, translationMm: [NaN, 0, 0] };
      else
        source.frames = source.frames.map((frame, index) =>
          index !== 0
            ? frame
            : {
                ...frame,
                ...(kind === 'nonfinite' ? { columnDirection: [NaN, 0, 0] as const } : {}),
                ...(kind === 'overflow'
                  ? { columnDirection: [1e308, 0, 0] as const, rowDirection: [0, 1e308, 0] as const }
                  : {}),
                ...(kind === 'parallel' ? { rowDirection: [1, 0, 0] as const } : {}),
                ...(kind === 'spacing' ? { pixelSpacingMm: [0, 1] as const } : {}),
                ...(kind === 'dimensions' ? { rows: 0 } : {}),
                ...(kind === 'mixed' ? { rowDirection: [0, 0, 1] as const } : {}),
              },
        );
      expect(nativeSourcePlane(source)).toBeNull();
    },
  );
});

describe('accepted native-frame cache', () => {
  it('loads exact SOP identities once and retains completed frames within its byte budget', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    const first = await cache.load(source, 0);
    expect(await cache.load(source, 0)).toBe(first);
    for (const index of [1, 2, 3]) await cache.load(source, index);
    expect(mocks.decode).toHaveBeenCalledTimes(4);
    expect(mocks.decode).toHaveBeenNthCalledWith(1, 'source', 'frame-0', { cache: 'reuse-only' });
    expect(mocks.decode.mock.calls.every((call) => call[2]?.cache === 'reuse-only')).toBe(true);
    expect(cache.size).toBe(4);
    expect(cache.residentBytes).toBe(4 * 12 * 8);
    cache.retain(source, 3);
    expect(await cache.load(source, 0)).toBe(first);
    expect(mocks.decode).toHaveBeenCalledTimes(4);
    cache.dispose();
    expect(cache.residentBytes).toBe(0);
  });

  it('retains source pixels, validity and physical metadata without mutating them during native reuse', async () => {
    const { source, volume } = fixture();
    const original = image();
    original.validity[0] = 0;
    original.invert = true;
    original.windowWidth = 1;
    const pixels = original.pixels.slice();
    const validity = original.validity.slice();
    mocks.decode.mockResolvedValue(original);
    const cache = new NativeFrameCache(volume);
    try {
      const decoded = await cache.load(source, 0);
      const plane = makeNativePlaneData(volume, source, 0, decoded);
      expect(await cache.load(source, 0)).toBe(decoded);
      expect(decoded).toBe(original);
      expect(decoded.pixels).toEqual(pixels);
      expect(decoded.validity).toEqual(validity);
      expect(plane.windowRange).toEqual([49.5, 49.5]);
      expect(plane.invert).toBe(true);
      expect(nativePixelToVolumeVoxel(volume, source, plane.frame, 2, 1)).toEqual([2, 1, 0]);
      expect(mocks.decode).toHaveBeenCalledExactlyOnceWith('source', 'frame-0', { cache: 'reuse-only' });
    } finally {
      cache.dispose();
    }
    expect(original.pixels).toEqual(pixels);
    expect(original.validity).toEqual(validity);
  });

  it('enforces a byte ceiling and refuses oversized native frames without downsampling', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume, 2 * 12 * 8);
    for (const index of [0, 1, 2]) await cache.load(source, index);
    expect(cache.residentBytes).toBe(2 * 12 * 8);
    await expect(new NativeFrameCache(volume, 12).load(source, 0)).rejects.toThrow(/has not been reduced/);
    expect(() => new NativeFrameCache(volume, NaN)).toThrow(/positive byte budget/);
  });

  it.each(['pixels', 'validity'] as const)(
    'rejects mismatched %s buffers instead of admitting bytes beyond the frame budget',
    async (field) => {
      const { source, volume } = fixture();
      const cache = new NativeFrameCache(volume, 12 * 8);
      mocks.decode.mockResolvedValueOnce({ ...image(), [field]: new Float32Array(13) });
      await expect(cache.load(source, 0)).rejects.toThrow(/dimensions changed/);
      expect(cache.size).toBe(0);
      expect(cache.residentBytes).toBe(0);
      expect((await cache.load(source, 0)).pixels).toHaveLength(12);
      expect(cache.residentBytes).toBe(12 * 8);
      cache.dispose();
    },
  );

  it('evicts the least recently used completed frame before allocating the next conversion', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume, 2 * 12 * 8);
    const first = await cache.load(source, 0);
    await cache.load(source, 1);
    expect(await cache.load(source, 0)).toBe(first);
    const decoded = deferred<DecodedFrame>();
    mocks.decode.mockImplementationOnce(() => decoded.promise);
    const pending = cache.load(source, 2);
    await waitFor(() => expect(mocks.decode).toHaveBeenCalledTimes(3));
    expect(cache.residentBytes).toBe(12 * 8);
    decoded.resolve(image('frame-2'));
    await pending;
    expect(cache.residentBytes).toBe(2 * 12 * 8);
    expect(await cache.load(source, 0)).toBe(first);
    expect(mocks.decode).toHaveBeenCalledTimes(3);
    await cache.load(source, 1);
    expect(mocks.decode).toHaveBeenCalledTimes(4);
    expect(cache.residentBytes).toBe(2 * 12 * 8);
    cache.dispose();
  });

  it.each(['new request', 'promoted prefetch'] as const)(
    'prioritizes a %s ahead of queued speculative frames without concurrent conversion',
    async (kind) => {
      const { source, volume } = fixture();
      const cache = new NativeFrameCache(volume);
      const decoded = deferred<DecodedFrame>();
      mocks.decode.mockImplementationOnce(() => decoded.promise);
      const active = cache.load(source, 0);
      await waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
      const firstPrefetch = cache.load(source, 1, { prefetch: true });
      const secondPrefetch = cache.load(source, 2, { prefetch: true });
      const requested = cache.load(source, kind === 'new request' ? 3 : 2);
      expect(mocks.decode).toHaveBeenCalledOnce();
      decoded.resolve(image('frame-0'));
      await active;
      await requested;
      expect(mocks.decode.mock.calls[1]?.[1]).toBe(kind === 'new request' ? 'frame-3' : 'frame-2');
      await Promise.all([firstPrefetch, secondPrefetch]);
      expect(mocks.decode.mock.calls.map((call) => call[1])).toEqual(
        kind === 'new request' ? ['frame-0', 'frame-3', 'frame-1', 'frame-2'] : ['frame-0', 'frame-2', 'frame-1'],
      );
      cache.dispose();
    },
  );

  it.each(['revision', 'patient', 'fingerprint'] as const)(
    'rejects stale %s ownership even on cache hits',
    async (kind) => {
      const { source, volume } = fixture();
      const cache = new NativeFrameCache(volume);
      await cache.load(source, 0);
      if (kind === 'revision') mocks.revision.mockResolvedValue(2);
      else if (kind === 'patient') mocks.patient.mockResolvedValue('another');
      else volume.reconstructionFingerprint = 'replacement';
      await expect(cache.load(source, 0)).rejects.toThrow(/MRI data changed/);
      expect(mocks.decode).toHaveBeenCalledOnce();
    },
  );

  it('rejects data changed while decoding and refuses foreign metadata', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    mocks.decode.mockImplementationOnce(async () => {
      mocks.revision.mockResolvedValue(2);
      return image();
    });
    await expect(cache.load(source, 0)).rejects.toThrow(/MRI data changed/);
    await expect(cache.load({ ...source }, 0)).rejects.toThrow(/does not belong/);
    expect(cache.size).toBe(0);
  });

  it('drops displaced in-flight frames and serializes native conversion', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    const decoded = deferred<DecodedFrame>();
    mocks.decode.mockImplementationOnce(() => decoded.promise);
    const previous = cache.load(source, 0);
    await waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
    cache.retain(source, 3);
    const current = cache.load(source, 3);
    expect(mocks.decode).toHaveBeenCalledOnce();
    decoded.resolve(image());
    await expect(previous).rejects.toMatchObject({ name: 'AbortError' });
    expect((await current).sopInstanceUid).toBe('frame-3');
    expect(cache.size).toBe(1);
  });

  it.each(['replace', 'dispose'] as const)(
    'rejects queued work on %s without starting abandoned decodes',
    async (transition) => {
      const { source, volume } = fixture();
      const cache = new NativeFrameCache(volume);
      const decoded = deferred<DecodedFrame>();
      mocks.decode.mockImplementationOnce(() => decoded.promise);
      const active = cache.load(source, 0);
      const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
      await waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
      const queued = cache.load(source, 1, { prefetch: true });
      const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
      if (transition === 'replace') cache.retain(source, 3);
      else cache.dispose();
      await Promise.all([activeRejected, queuedRejected]);
      expect(mocks.decode).toHaveBeenCalledOnce();
      expect(cache.size).toBe(0);
      decoded.resolve(image());
      if (transition === 'replace') {
        expect((await cache.load(source, 3)).sopInstanceUid).toBe('frame-3');
        expect(mocks.decode.mock.calls.map((call) => call[1])).toEqual(['frame-0', 'frame-3']);
      } else {
        await expect(cache.load(source, 3)).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();
        expect(mocks.decode).toHaveBeenCalledOnce();
        expect(cache.residentBytes).toBe(0);
      }
      cache.dispose();
    },
  );

  it('releases a disposed cache without waiting for a stalled decoder and allows a fresh view', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    const decoded = deferred<DecodedFrame>();
    mocks.decode.mockImplementationOnce(() => decoded.promise);
    const pending = cache.load(source, 0);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
    cache.dispose();
    await rejected;
    expect(cache.size).toBe(0);
    const replacement = new NativeFrameCache(volume);
    expect((await replacement.load(source, 1)).sopInstanceUid).toBe('frame-1');
    decoded.resolve(image());
    await Promise.resolve();
    await expect(cache.load(source, 1)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.size).toBe(0);
    expect(replacement.size).toBe(1);
    replacement.dispose();
  });

  it('times out a stalled source image and lets later frames load without retaining the failed entry', async () => {
    vi.useFakeTimers();
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    mocks.decode.mockImplementationOnce(() => new Promise<DecodedFrame>(() => undefined));
    const pending = cache.load(source, 0);
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.decode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(cache.size).toBe(0);
    expect((await cache.load(source, 1)).sopInstanceUid).toBe('frame-1');
    cache.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('native-plane publication', () => {
  it.each(['hide', 'replace'] as const)(
    'releases the loaded owner on %s and reloads original pixels instead of resurrecting a discarded plane',
    async (transition) => {
      const { volume, source } = fixture();
      source.frames = [source.frames[0]!]; // No neighboring prefetch obscures the owner transition.
      const dispose = vi.spyOn(NativeFrameCache.prototype, 'dispose');
      const { result, rerender, unmount } = renderHook(
        ({ volume }: { volume: SvrVolume | null }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex: 0 }),
        { initialProps: { volume: volume as SvrVolume | null } },
      );
      await waitFor(() => expect(result.current.plane?.frameIndex).toBe(0));
      const original = result.current.plane;
      const pending: ((decoded: DecodedFrame) => void)[] = [];
      mocks.decode.mockImplementation(() => new Promise<DecodedFrame>((resolve) => pending.push(resolve)));

      rerender({ volume: transition === 'hide' ? null : { ...volume, data: volume.data.slice() } });
      expect(result.current.plane).toBeNull();
      expect(result.current.error).toBeNull();
      expect(dispose).toHaveBeenCalledOnce();
      expect((dispose.mock.contexts[0] as NativeFrameCache).residentBytes).toBe(0);
      if (transition === 'replace') await waitFor(() => expect(pending).toHaveLength(1));

      rerender({ volume });
      // Returning to the identical old object must not revive its discarded loaded state.
      expect(result.current).toMatchObject({ plane: null, loading: true, error: null });
      await waitFor(() => expect(pending).toHaveLength(transition === 'hide' ? 1 : 2));
      const fresh = image();
      fresh.pixels[0] = 777;
      await act(async () => pending.at(-1)!(fresh));
      await waitFor(() => expect(result.current.plane?.image.pixels[0]).toBe(777));
      expect(result.current.plane).not.toBe(original);
      expect(result.current).toMatchObject({ loading: false, error: null });
      if (transition === 'replace') {
        await act(async () => pending[0]!(image()));
        expect(result.current.plane?.image.pixels[0]).toBe(777);
      }
      unmount();
      expect(dispose.mock.contexts.every((cache) => (cache as NativeFrameCache).residentBytes === 0)).toBe(true);
    },
  );

  it('loads in Strict Mode without reusing its disposed first-mount cache', async () => {
    const { volume } = fixture();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex: 1 }), { wrapper });
    await waitFor(() => expect(result.current.plane?.frameIndex).toBe(1));
    expect(result.current.error).toBeNull();
  });

  it('keeps the complete previous plane while a cached neighbor revalidates its owner', async () => {
    const { volume, source } = fixture();
    const load = vi.spyOn(NativeFrameCache.prototype, 'load');
    const { result, rerender } = renderHook(
      ({ frameIndex }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex }),
      { initialProps: { frameIndex: 0 } },
    );
    await waitFor(() => expect(result.current.plane?.frameIndex).toBe(0));
    await act(async () => {
      await Promise.all(load.mock.results.map((entry) => entry.value));
    });
    const previous = result.current.plane!;
    const owner = deferred<number>();
    mocks.revision.mockImplementation(() => owner.promise);
    rerender({ frameIndex: 1 });
    expect(result.current).toEqual({ plane: previous, loading: true, error: null });
    expect(result.current.plane).toBe(previous);
    expect(result.current.plane?.frame).toBe(source.frames[0]);
    expect(result.current.plane?.image).toBe(previous.image);
    expect(result.current.plane?.origin).toBe(previous.origin);
    expect(mocks.decode).toHaveBeenCalledTimes(2);
    await act(async () => owner.resolve(1));
    await waitFor(() => expect(result.current).toMatchObject({ loading: false, plane: { frameIndex: 1 } }));
    expect(result.current.plane?.frame).toBe(source.frames[1]);
    expect(result.current.plane?.image.sopInstanceUid).toBe('frame-1');
    expect(result.current.plane?.origin[2]).toBeCloseTo(previous.origin[2] + 3 / 12, 12);
  });

  it.each(['source index', 'same-index source replacement'] as const)(
    'clears continuity on %s and ignores that source after switching back',
    async (transition) => {
      const { volume, source } = fixture();
      const other: SvrNativeSource = {
        ...source,
        seriesUid: 'other',
        frames: source.frames.map((frame, index) => ({
          ...frame,
          sopInstanceUid: `other-${index}`,
          originMm: [40, 20, 30 + 3 * index],
        })),
      };
      volume.sourceProvenance!.sources = [source, other];
      const pending = deferred<DecodedFrame>();
      mocks.decode.mockImplementation(async (series: string, sop: string) =>
        series === 'other' && sop === 'other-0' ? pending.promise : { ...image(sop), seriesUid: series },
      );
      const { result, rerender } = renderHook(
        ({ sourceIndex }) => useSvrNativePlane({ volume, sourceIndex, frameIndex: 0 }),
        { initialProps: { sourceIndex: 0 } },
      );
      await waitFor(() => expect(result.current.plane?.source).toBe(source));
      if (transition === 'same-index source replacement') volume.sourceProvenance!.sources = [other, source];
      rerender({ sourceIndex: transition === 'source index' ? 1 : 0 });
      expect(result.current).toEqual({ plane: null, loading: true, error: null });
      await waitFor(() => expect(mocks.decode).toHaveBeenCalledWith('other', 'other-0', { cache: 'reuse-only' }));
      if (transition === 'same-index source replacement') volume.sourceProvenance!.sources = [source, other];
      rerender({ sourceIndex: 0 });
      expect(result.current).toEqual({ plane: null, loading: true, error: null });
      await waitFor(() => expect(result.current.plane?.source).toBe(source));
      const returned = result.current.plane;
      await act(async () => pending.resolve({ ...image('other-0'), seriesUid: 'other' }));
      expect(result.current.plane).toBe(returned);
      expect(result.current).toMatchObject({ loading: false, error: null });
    },
  );

  it.each(['source', 'frame'] as const)(
    'clears a missing %s immediately and does not resurrect it before validation on return',
    async (missing) => {
      const { volume } = fixture();
      const { result, rerender } = renderHook(
        ({ sourceIndex, frameIndex }) => useSvrNativePlane({ volume, sourceIndex, frameIndex }),
        { initialProps: { sourceIndex: 0, frameIndex: 0 } },
      );
      await waitFor(() => expect(result.current.plane?.frameIndex).toBe(0));
      rerender({ sourceIndex: missing === 'source' ? 9 : 0, frameIndex: missing === 'frame' ? 9 : 0 });
      expect(result.current).toEqual({ plane: null, loading: false, error: null });
      rerender({ sourceIndex: 0, frameIndex: 0 });
      expect(result.current).toEqual({ plane: null, loading: true, error: null });
      await waitFor(() => expect(result.current.plane?.frameIndex).toBe(0));
    },
  );

  it.each(['revision', 'patient', 'fingerprint', 'decode'] as const)(
    'keeps safe previous pixels for a decode failure but clears revoked %s ownership',
    async (failure) => {
      const { volume } = fixture();
      const load = vi.spyOn(NativeFrameCache.prototype, 'load');
      const { result, rerender } = renderHook(
        ({ frameIndex }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex }),
        { initialProps: { frameIndex: 0 } },
      );
      await waitFor(() => expect(result.current.plane?.frameIndex).toBe(0));
      await act(async () => {
        await Promise.all(load.mock.results.map((entry) => entry.value));
      });
      const previous = result.current.plane;
      if (failure === 'revision') mocks.revision.mockResolvedValue(2);
      else if (failure === 'patient') mocks.patient.mockResolvedValue('another patient');
      else if (failure === 'fingerprint') volume.reconstructionFingerprint = 'replacement';
      else mocks.decode.mockRejectedValueOnce(new Error('The current source decode failed.'));
      rerender({ frameIndex: failure === 'decode' ? 3 : 1 });
      expect(result.current).toEqual({ plane: previous, loading: true, error: null });
      await waitFor(() => expect(result.current.error).toMatch(/MRI data changed|decode failed/));
      expect(result.current.plane).toBe(failure === 'decode' ? previous : null);
      expect(result.current.loading).toBe(false);
      if (failure !== 'decode') expect(mocks.decode).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['success', 'error'] as const)(
    "revalidates rapid reversals and ignores the superseded frame's late %s",
    async (late) => {
      const { volume } = fixture();
      const load = vi.spyOn(NativeFrameCache.prototype, 'load');
      const { result, rerender } = renderHook(
        ({ frameIndex }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex }),
        { initialProps: { frameIndex: 1 } },
      );
      await waitFor(() => expect(result.current.plane?.frameIndex).toBe(1));
      await act(async () => {
        await Promise.all(load.mock.results.map((entry) => entry.value));
      });
      const previous = result.current.plane!;
      const pending = deferred<DecodedFrame>();
      mocks.decode.mockImplementationOnce(() =>
        pending.promise.then((decoded) => {
          if (late === 'error') throw new Error('Superseded frame failed.');
          return decoded;
        }),
      );
      rerender({ frameIndex: 3 });
      expect(result.current).toEqual({ plane: previous, loading: true, error: null });
      await waitFor(() => expect(mocks.decode).toHaveBeenCalledWith('source', 'frame-3', { cache: 'reuse-only' }));
      const owner = deferred<number>();
      mocks.revision.mockImplementation(() => owner.promise);
      rerender({ frameIndex: 1 });
      expect(result.current).toEqual({ plane: previous, loading: true, error: null });
      expect(result.current.plane).toBe(previous);
      await act(async () => owner.resolve(1));
      await waitFor(() => expect(result.current).toMatchObject({ loading: false, plane: { frameIndex: 1 } }));
      const returned = result.current.plane;
      await act(async () => pending.resolve(image('frame-3')));
      expect(result.current.plane).toBe(returned);
      expect(result.current).toMatchObject({ loading: false, error: null });
      expect(result.current.plane?.image.sopInstanceUid).toBe('frame-1');
    },
  );

  it('never publishes a superseded first frame when no prior complete plane exists', async () => {
    const { volume } = fixture();
    const decoded = deferred<DecodedFrame>();
    mocks.decode.mockImplementationOnce(() => decoded.promise);
    const { result, rerender } = renderHook(
      ({ frameIndex }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex }),
      { initialProps: { frameIndex: 0 } },
    );
    await waitFor(() => expect(mocks.decode).toHaveBeenCalledOnce());
    rerender({ frameIndex: 3 });
    expect(result.current.plane).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => decoded.resolve(image()));
    await waitFor(() => expect(result.current.plane?.frameIndex).toBe(3));
    expect(result.current.plane?.image.sopInstanceUid).toBe('frame-3');
  });

  it('publishes the requested frame before queued neighbors after a rapid browsing jump', async () => {
    const { volume } = fixture();
    const previousNeighbor = deferred<DecodedFrame>();
    mocks.decode.mockImplementation(async (_series: string, sop: string) =>
      sop === 'frame-0' ? previousNeighbor.promise : image(sop),
    );
    const { result, rerender } = renderHook(
      ({ frameIndex }) => useSvrNativePlane({ volume, sourceIndex: 0, frameIndex }),
      { initialProps: { frameIndex: 1 } },
    );
    await waitFor(() => expect(result.current.plane?.frameIndex).toBe(1));
    await waitFor(() => expect(mocks.decode.mock.calls.map((call) => call[1])).toEqual(['frame-1', 'frame-0']));
    const previous = result.current.plane!;
    rerender({ frameIndex: 3 });
    expect(result.current).toEqual({ plane: previous, loading: true, error: null });
    expect(result.current.plane).toBe(previous);
    expect(result.current.plane?.frameIndex).toBe(1);
    expect(result.current.plane?.image.sopInstanceUid).toBe('frame-1');
    await act(async () => previousNeighbor.resolve(image('frame-0')));
    await waitFor(() => expect(result.current.plane?.frameIndex).toBe(3));
    expect(result.current.plane?.image.sopInstanceUid).toBe('frame-3');
    expect(mocks.decode.mock.calls.map((call) => call[1])).toEqual(['frame-1', 'frame-0', 'frame-3', 'frame-2']);
  });
});

function textureGl() {
  return {
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
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    getError: vi.fn(() => 0),
    getParameter: vi.fn(() => 4096),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform3f: vi.fn(),
  };
}

describe('source-faithful native-plane GL resources', () => {
  it('refuses GPU validation without WebGL instead of reporting an unrendered pass', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => runSvrSliceGpuProbe()).toThrow(/pixel tests require WebGL2/);
  });

  it('uploads original Float32 pixels and categorical validity/mask without a float-linear dependency', () => {
    const gl = textureGl();
    const binding = createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram);
    gl.texImage2D.mockClear();
    const { source, volume } = fixture();
    const decoded = image();
    decoded.validity[3] = 0;
    const plane = makeNativePlaneData(volume, source, 0, decoded);
    const mask = new Uint8Array(12);
    mask[2] = 7;
    binding.setPlane(plane, mask);
    expect(gl.texImage2D).toHaveBeenNthCalledWith(
      1,
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      4,
      3,
      0,
      gl.RED,
      gl.FLOAT,
      decoded.pixels,
    );
    expect(gl.texImage2D.mock.calls[1]![8]).toEqual(
      Uint8Array.of(255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255),
    );
    expect(gl.texImage2D.mock.calls[2]![8]).toBe(mask);
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    binding.bind({ enabled: true, selectionOnly: true, invert: true, windowRange: [49.5, 49.5] });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeImage', 5);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeValidity', 6);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeMask', 7);
    expect(gl.getUniformLocation).not.toHaveBeenCalledWith(expect.anything(), 'u_nativeCutaway');
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeInvert', 1);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_nativeWindowWidth', 0);
    binding.dispose();
    binding.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(3);
  });

  it('reuses resident native pixels across display and categorical-mask changes, with fail-closed stale geometry', () => {
    const gl = textureGl();
    const binding = createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram);
    const { source, volume } = fixture();
    const plane = makeNativePlaneData(volume, source, 0, image());
    const mask = new Uint8Array(12);
    binding.setPlane(plane, mask);
    gl.texImage2D.mockClear();
    binding.setPlane(plane, mask);
    binding.bind({ enabled: true, windowRange: [0, 100] });
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(gl.texSubImage2D).not.toHaveBeenCalled();
    binding.setPlane(plane, mask.slice());
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(gl.texSubImage2D).toHaveBeenCalledExactlyOnceWith(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      4,
      3,
      gl.RED,
      gl.UNSIGNED_BYTE,
      mask,
    );
    expect(() => binding.setPlane(plane, new Uint8Array(2))).toThrow(/different dimensions/);
    binding.bind({ enabled: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeEnabled', 0);
    binding.setPlane(null);
    binding.dispose();
  });

  it('updates equal-size raw planes in resident textures and reallocates only changed dimensions', () => {
    const gl = textureGl();
    const binding = createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram);
    const { source, volume } = fixture();
    const mask = new Uint8Array(12);
    binding.setPlane(makeNativePlaneData(volume, source, 0, image()), mask);
    gl.texImage2D.mockClear();
    gl.texSubImage2D.mockClear();
    const next = makeNativePlaneData(volume, source, 1, image('frame-1'));
    binding.setPlane(next, mask);
    expect(gl.texImage2D).not.toHaveBeenCalled();
    expect(gl.texSubImage2D).toHaveBeenCalledTimes(3);
    expect(gl.texSubImage2D.mock.calls[0]).toEqual([gl.TEXTURE_2D, 0, 0, 0, 4, 3, gl.RED, gl.FLOAT, next.image.pixels]);
    gl.texSubImage2D.mockClear();
    const reformat = makeVolumePlaneData(volume, 'sagittal', 1);
    binding.setPlane(reformat, projectVolumePlaneMask(volume, null, 'sagittal', 1));
    expect(gl.texImage2D).toHaveBeenCalledTimes(3);
    expect(gl.texSubImage2D).not.toHaveBeenCalled();
    expect(gl.texImage2D.mock.calls[0]?.[8]).toBe(reformat.image.pixels);
    binding.dispose();
  });

  it('refuses oversized textures and releases partially created resources on allocation failure', () => {
    const gl = textureGl();
    const binding = createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram);
    const { source, volume } = fixture();
    gl.getParameter.mockReturnValue(2);
    expect(() => binding.setPlane(makeNativePlaneData(volume, source, 0, image()))).toThrow(/has not been downsampled/);
    binding.dispose();
    gl.createTexture.mockReturnValueOnce({}).mockReturnValueOnce(null as unknown as object);
    expect(() => createNativePlaneBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram)).toThrow(
      /allocate/,
    );
    expect(gl.deleteTexture).toHaveBeenCalledTimes(4);
  });

  it('bounds native cross-sections by the volume before composition and scales settled samples to voxel distance', () => {
    const shader = RAYMARCH_FRAGMENT_SHADER;
    // Derivatives must run before divergent ray/bounds rejection. GPU readback
    // coverage in svrNativeCompositing.gpu.ts exercises the resulting pixels.
    expect(shader.indexOf('nativeSurface(ro, rd, nativeT)')).toBeLessThan(shader.indexOf('!intersectBox(ro, rd'));
    expect(shader).not.toContain('outColor = nativeHit ? nativeSection');
    expect(shader.indexOf('bool nativeHit =')).toBeGreaterThan(shader.indexOf('!intersectBox(ro, rd'));
    expect(shader).toContain('u_tumorOnly != 0 || u_nativeSelectionOnly != 0');
    expect(shader).not.toContain('u_nativeCutaway');
    expect(shader).not.toContain('if (slope > 0.0) t0 = max(t0, boundary)');
    expect(shader).not.toContain('else t1 = min(t1, boundary)');
    expect(shader).not.toContain('if (nativeHit) t1 = min(t1, nativeT)');
    expect(shader).toContain('if (nativeHit && t + float(i) * dt < nativeT)');
    expect(shader).toContain('frontAccum += (1.0 - frontAlpha) * sampleColor * aStep');
    expect(shader).toContain('accum += (1.0 - aAccum) * sampleColor * aStep');
    expect(shader).toContain('(nativeSection.rgb * nativeSection.a + (1.0 - nativeSection.a) * accum)');
    expect(shader).toContain('if (u_labelsEnabled != 0 && u_tumorOnly == 0 && lesionAlpha > 0.0)');
    expect(shader).toContain('const int MAX_STEPS = 1536;');
    expect(shader).toContain('traversedVoxels * 1.5');
    expect(shader).toContain('u_jitter > 0.0 ? u_steps');
    expect(shader).toContain('texelFetch(u_nativeValidity, pixel, 0).r <= 0.0');
  });
});
