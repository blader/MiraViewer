import type { SvrLabelVolume, SvrNativeSource, SvrSourceFrame, SvrVolume } from '../../types/svr';
import { getDecodedFrameBySopInstanceUid, type DecodedFrame } from '../decodedFrame';
import { getDatasetRevision, getSelectedPatientKey } from '../localApi';
import { waitForNativeFrame } from './nativeFrameWait';
import { computePhysicalBoxScale } from './renderLod';
import { inverseTransformPoint, patientToVolumeVoxel, transformPoint, volumeVoxelToPatient } from './volumeGeometry';

type Point = [number, number, number];
type VoxelPoint = readonly [number, number, number];

export type NativePlaneData = {
  source: SvrNativeSource;
  frame: SvrSourceFrame;
  frameIndex: number;
  image: DecodedFrame;
  /** Object coordinates matching u_box. The origin is native pixel (0,0)'s center. */
  origin: Point;
  columnStep: Point;
  rowStep: Point;
  windowRange: [number, number];
  invert: boolean;
};

const dot = (a: VoxelPoint, b: VoxelPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: VoxelPoint, b: VoxelPoint): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normal = (frame: SvrSourceFrame): Point => {
  const a = frame.columnDirection,
    b = frame.rowDirection;
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
};

/** DICOM IPP names a pixel center; the direction names refer to increasing array indices. */
export function nativePixelToVolumeVoxel(
  volume: SvrVolume,
  source: SvrNativeSource,
  frame: SvrSourceFrame,
  column: number,
  row: number,
): Point {
  const native = frame.originMm.map(
    (value, axis) =>
      value +
      frame.columnDirection[axis]! * column * frame.pixelSpacingMm[1] +
      frame.rowDirection[axis]! * row * frame.pixelSpacingMm[0],
  ) as Point;
  return patientToVolumeVoxel(volume, transformPoint(source.transform, native));
}

export function volumeVoxelToNativePixel(
  volume: SvrVolume,
  source: SvrNativeSource,
  frame: SvrSourceFrame,
  cursor: VoxelPoint,
): [number, number] {
  const native = inverseTransformPoint(source.transform, volumeVoxelToPatient(volume, cursor));
  const offset = subtract(native, frame.originMm);
  return [
    dot(offset, frame.columnDirection) / frame.pixelSpacingMm[1],
    dot(offset, frame.rowDirection) / frame.pixelSpacingMm[0],
  ];
}

export function nearestNativeFrame(volume: SvrVolume, source: SvrNativeSource, cursor: VoxelPoint): number {
  const native = inverseTransformPoint(source.transform, volumeVoxelToPatient(volume, cursor));
  let nearest = 0,
    distance = Infinity;
  for (const [index, frame] of source.frames.entries()) {
    const n = normal(frame);
    const current = Math.abs(dot(subtract(native, frame.originMm), n)) / Math.hypot(...n);
    if (current < distance) {
      nearest = index;
      distance = current;
    }
  }
  return nearest;
}

/** Keep the in-plane patient point while moving to an actual acquired plane, without voxel snapping. */
export function nativeFrameCursor(
  volume: SvrVolume,
  source: SvrNativeSource,
  frame: SvrSourceFrame,
  cursor: VoxelPoint,
): Point {
  const native = inverseTransformPoint(source.transform, volumeVoxelToPatient(volume, cursor));
  const n = normal(frame);
  const distance = dot(subtract(native, frame.originMm), n) / dot(n, n);
  return patientToVolumeVoxel(
    volume,
    transformPoint(source.transform, native.map((value, axis) => value - distance * n[axis]!) as Point),
  );
}

/** Source VOI uses DICOM's center-0.5 / width-1 convention; width one is a strict threshold. */
export function nativeDisplayWindow(image: DecodedFrame, frame?: SvrSourceFrame): [number, number] {
  const center = image.windowCenter ?? frame?.windowCenter;
  const width = image.windowWidth ?? frame?.windowWidth;
  if (Number.isFinite(center) && Number.isFinite(width) && width! >= 1) {
    return [center! - 0.5 - (width! - 1) / 2, center! - 0.5 + (width! - 1) / 2];
  }
  let low = Infinity,
    high = -Infinity;
  for (let index = 0; index < image.pixels.length; index++) {
    if (!(image.validity[index]! > 0) || !Number.isFinite(image.pixels[index])) continue;
    low = Math.min(low, image.pixels[index]!);
    high = Math.max(high, image.pixels[index]!);
  }
  return Number.isFinite(low) ? [low, high > low ? high : low + 1] : [0, 1];
}

export function makeNativePlaneData(
  volume: SvrVolume,
  source: SvrNativeSource,
  frameIndex: number,
  image: DecodedFrame,
): NativePlaneData {
  const frame = source.frames[frameIndex];
  if (
    !frame ||
    image.sopInstanceUid !== frame.sopInstanceUid ||
    image.seriesUid !== source.seriesUid ||
    image.rows !== frame.rows ||
    image.cols !== frame.columns
  ) {
    throw new Error('The original MRI image does not match its accepted source geometry.');
  }
  const [nx, ny, nz] = volume.dims;
  const box = computePhysicalBoxScale({ nx, ny, nz }, volume.voxelSizeMm);
  const object = (column: number, row: number): Point =>
    nativePixelToVolumeVoxel(volume, source, frame, column, row).map(
      (value, axis) => ((value + 0.5) / volume.dims[axis]! - 0.5) * box[axis]!,
    ) as Point;
  const origin = object(0, 0);
  return {
    source,
    frame,
    frameIndex,
    image,
    origin,
    columnStep: subtract(object(1, 0), origin),
    rowStep: subtract(object(0, 1), origin),
    windowRange: nativeDisplayWindow(image, frame),
    invert: image.invert === true,
  };
}

/** Project categorical annotations from the exact CPU grid, never a reduced GPU label volume. */
export function projectNativePlaneMask(
  volume: SvrVolume,
  labels: SvrLabelVolume | null,
  source: SvrNativeSource,
  frame: SvrSourceFrame,
): Uint8Array {
  const mask = new Uint8Array(frame.rows * frame.columns);
  if (!labels) return mask;
  if (labels.data.length !== volume.data.length || labels.dims.some((size, axis) => size !== volume.dims[axis]))
    throw new Error('The selection does not match the original MRI plane reconstruction.');
  const origin = nativePixelToVolumeVoxel(volume, source, frame, 0, 0);
  const columnStep = subtract(nativePixelToVolumeVoxel(volume, source, frame, 1, 0), origin);
  const rowStep = subtract(nativePixelToVolumeVoxel(volume, source, frame, 0, 1), origin);
  const [nx, ny, nz] = volume.dims;
  for (let row = 0; row < frame.rows; row++) {
    const base = origin.map((value, axis) => value + row * rowStep[axis]!) as Point;
    for (let column = 0; column < frame.columns; column++) {
      const x = Math.round(base[0] + column * columnStep[0]);
      const y = Math.round(base[1] + column * columnStep[1]);
      const z = Math.round(base[2] + column * columnStep[2]);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      const index = (z * ny + y) * nx + x;
      if ((!volume.observedSupport || volume.observedSupport[index]) && Number.isFinite(volume.data[index]))
        mask[row * frame.columns + column] = labels.data[index]!;
    }
  }
  return mask;
}

type CacheEntry = { promise: Promise<DecodedFrame>; bytes: number };
const cancelled = () => new DOMException('Original MRI loading was canceled.', 'AbortError');

/** Sole owner of converted native frames; Cornerstone still owns the decoded DICOM image cache. */
export class NativeFrameCache {
  readonly volume: SvrVolume;
  readonly maxBytes: number;
  private entries = new Map<string, CacheEntry>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly controller = new AbortController();
  constructor(volume: SvrVolume, maxBytes = 32 * 1024 * 1024) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0)
      throw new Error('The native-image cache needs a positive byte budget.');
    this.volume = volume;
    this.maxBytes = maxBytes;
  }
  get residentBytes() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  }
  get size() {
    return this.entries.size;
  }
  private key(source: SvrNativeSource, index: number) {
    return `${source.seriesUid}\0${source.frames[index]?.sopInstanceUid}`;
  }
  retain(source: SvrNativeSource, index: number) {
    const retained = new Set(
      [index, index - 1, index + 1].filter((at) => source.frames[at]).map((at) => this.key(source, at)),
    );
    for (const key of this.entries.keys()) if (!retained.has(key)) this.entries.delete(key);
  }
  private async verifyOwner() {
    if (this.controller.signal.aborted) throw cancelled();
    const provenance = this.volume.sourceProvenance;
    const [revision, patient] = await Promise.all([getDatasetRevision(), getSelectedPatientKey()]);
    if (this.controller.signal.aborted) throw cancelled();
    if (
      !provenance ||
      provenance.fingerprint !== this.volume.reconstructionFingerprint ||
      revision !== provenance.datasetRevision ||
      (patient && patient !== provenance.patientKey)
    )
      throw new Error('MRI data changed. Reopen the accepted reconstruction before viewing its original images.');
  }
  load(source: SvrNativeSource, index: number): Promise<DecodedFrame> {
    if (this.controller.signal.aborted) return Promise.reject(cancelled());
    const frame = source.frames[index];
    if (!frame || !this.volume.sourceProvenance?.sources.includes(source))
      return Promise.reject(new Error('The original MRI frame does not belong to this accepted reconstruction.'));
    if (frame.rows * frame.columns * 8 > this.maxBytes)
      return Promise.reject(
        new Error(
          'This original MRI frame exceeds the native-image memory budget. Its resolution has not been reduced.',
        ),
      );
    const key = this.key(source, index);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return this.verifyOwner().then(() => cached.promise);
    }
    const entry: CacheEntry = {
      bytes: 0,
      promise: this.tail
        .catch(() => undefined)
        .then(async () => {
          if (this.entries.get(key) !== entry) throw cancelled();
          await this.verifyOwner();
          const image = await waitForNativeFrame(
            getDecodedFrameBySopInstanceUid(source.seriesUid, frame.sopInstanceUid, { cache: 'reuse-only' }),
            this.controller.signal,
          );
          await this.verifyOwner();
          if (this.entries.get(key) !== entry) throw cancelled();
          if (image.rows !== frame.rows || image.cols !== frame.columns)
            throw new Error('The original MRI image dimensions changed after reconstruction.');
          entry.bytes = image.pixels.byteLength + image.validity.byteLength;
          for (const [otherKey] of this.entries) {
            if (this.residentBytes <= this.maxBytes && this.entries.size <= 3) break;
            if (otherKey !== key) this.entries.delete(otherKey);
          }
          return image;
        })
        .catch((error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        }),
    };
    this.entries.set(key, entry);
    while (this.entries.size > 3) this.entries.delete(this.entries.keys().next().value!);
    this.tail = entry.promise.catch(() => undefined);
    return entry.promise;
  }
  dispose() {
    this.controller.abort();
    this.entries.clear();
    this.tail = Promise.resolve();
  }
}
