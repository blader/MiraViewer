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
  NativeFrameCache,
  nativeDisplayWindow,
  nativeFrameCursor,
  nativePixelToVolumeVoxel,
  nearestNativeFrame,
  projectNativePlaneMask,
  volumeVoxelToNativePixel,
} from '../src/utils/svr/nativePlane';

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

describe('accepted native-frame cache', () => {
  it('loads exact SOP identities once and keeps at most three converted frames', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume);
    const first = await cache.load(source, 0);
    expect(await cache.load(source, 0)).toBe(first);
    for (const index of [1, 2, 3]) await cache.load(source, index);
    expect(mocks.decode).toHaveBeenCalledTimes(4);
    expect(mocks.decode).toHaveBeenNthCalledWith(1, 'source', 'frame-0');
    expect(cache.size).toBe(3);
    expect(cache.residentBytes).toBe(3 * 12 * 8);
    cache.dispose();
    expect(cache.residentBytes).toBe(0);
  });

  it('enforces a byte ceiling and refuses oversized native frames without downsampling', async () => {
    const { source, volume } = fixture();
    const cache = new NativeFrameCache(volume, 2 * 12 * 8);
    for (const index of [0, 1, 2]) await cache.load(source, index);
    expect(cache.residentBytes).toBe(2 * 12 * 8);
    await expect(new NativeFrameCache(volume, 12).load(source, 0)).rejects.toThrow(/has not been reduced/);
    expect(() => new NativeFrameCache(volume, NaN)).toThrow(/positive byte budget/);
  });

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

  it('hides old pixels immediately when source geometry changes and ignores late results', async () => {
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
    expect(() => runSvrSliceGpuProbe()).toThrow('The native-cutaway pixel tests require WebGL2.');
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
    binding.bind({ enabled: true, selectionOnly: true, cutaway: true, invert: true, windowRange: [49.5, 49.5] });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeImage', 5);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeValidity', 6);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeMask', 7);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeCutaway', 1);
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
    binding.setPlane(plane, mask.slice());
    expect(gl.texImage2D).toHaveBeenCalledOnce();
    expect(gl.texImage2D.mock.calls[0]![2]).toBe(gl.R8);
    expect(() => binding.setPlane(plane, new Uint8Array(2))).toThrow(/different dimensions/);
    binding.bind({ enabled: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_nativeEnabled', 0);
    binding.setPlane(null);
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
    expect(shader).toContain('if (slope > 0.0) t0 = max(t0, boundary)');
    expect(shader).toContain('else t1 = min(t1, boundary)');
    expect(shader).toContain('if (nativeHit) t1 = min(t1, nativeT)');
    expect(shader).toContain('if (nativeHit) accum += (1.0 - aAccum) * nativeSection.rgb');
    expect(shader).toContain('if (!nativeHit && u_labelsEnabled');
    expect(shader).toContain('const int MAX_STEPS = 1536;');
    expect(shader).toContain('traversedVoxels * 1.5');
    expect(shader).toContain('u_jitter > 0.0 ? u_steps');
    expect(shader).toContain('texelFetch(u_nativeValidity, pixel, 0).r <= 0.0');
  });
});
