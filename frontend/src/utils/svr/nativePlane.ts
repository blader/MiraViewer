import type { SvrLabelVolume, SvrNativeSource, SvrRoiPlane, SvrSourceFrame, SvrVolume } from '../../types/svr';
import { getDecodedFrameBySopInstanceUid, type DecodedFrame } from '../decodedFrame';
import { getDatasetRevision, getSelectedPatientKey } from '../localApi';
import { SLICE_AXES } from '../segmentation/selectionEditing';
import { waitForNativeFrame } from './nativeFrameWait';
import { computePhysicalBoxScale } from './renderLod';
import { defaultVolumeWindow } from './volumeDisplay';
import {
  inverseTransformPoint,
  patientToVolumeVoxel,
  rotatePoint,
  snapshotPatientTransform,
  transformPoint,
  volumeVoxelToPatient,
} from './volumeGeometry';

type Point = [number, number, number];
type VoxelPoint = readonly [number, number, number];

export type MriPlaneData = {
  image: Pick<DecodedFrame, 'pixels' | 'validity' | 'rows' | 'cols'>;
  /** Object coordinates matching u_box. The origin is pixel (0,0)'s center. */
  origin: Point;
  columnStep: Point;
  rowStep: Point;
  windowRange: [number, number];
  invert: boolean;
};

export type NativePlaneData = MriPlaneData & {
  source: SvrNativeSource;
  frame: SvrSourceFrame;
  frameIndex: number;
  image: DecodedFrame;
};

const dot = (a: VoxelPoint, b: VoxelPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: VoxelPoint, b: VoxelPoint): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normal = (frame: SvrSourceFrame): Point => {
  const a = frame.columnDirection,
    b = frame.rowDirection;
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
};

/** Classify accepted source geometry in patient space, never from a series name or crop dimensions. */
export function nativeSourcePlane(source: SvrNativeSource): SvrRoiPlane | null {
  try {
    const { rotation } = snapshotPatientTransform(source.transform);
    let plane: SvrRoiPlane | null = null;
    for (const frame of source.frames) {
      const a = frame.columnDirection,
        b = frame.rowDirection;
      const lengths = Math.hypot(...a) * Math.hypot(...b);
      if (
        ![...a, ...b, ...frame.originMm].every(Number.isFinite) ||
        !Number.isFinite(lengths) ||
        lengths <= 0 ||
        Math.abs(dot(a, b)) > 1e-3 * lengths ||
        !frame.pixelSpacingMm.every((value) => Number.isFinite(value) && value > 0) ||
        ![frame.rows, frame.columns].every((value) => Number.isSafeInteger(value) && value > 0)
      )
        return null;
      const direction = rotatePoint(rotation, normal(frame)).map(Math.abs);
      const axis = direction.indexOf(Math.max(...direction));
      const current = (['sagittal', 'coronal', 'axial'] as const)[axis]!;
      // Residual tilt up to 30 degrees has a clear anatomical axis. Near-diagonal
      // acquisitions are explicitly oblique, not mislabeled by a tiny tie break.
      if (direction[axis]! / Math.hypot(...direction) < Math.cos(Math.PI / 6) - 1e-8 || (plane && plane !== current))
        return null;
      plane = current;
    }
    return plane;
  } catch {
    return null;
  }
}

function volumePlaneLayout(volume: SvrVolume, orientation: SvrRoiPlane, slice: number) {
  const axes = SLICE_AXES[orientation];
  const indices = { x: 0, y: 1, z: 2 } as const;
  const column = indices[axes.column],
    row = indices[axes.row],
    depth = indices[axes.slice];
  if (
    !volume.dims.every((size) => Number.isSafeInteger(size) && size > 0) ||
    volume.data.length !== volume.dims[0] * volume.dims[1] * volume.dims[2] ||
    (volume.observedSupport && volume.observedSupport.length !== volume.data.length) ||
    !Number.isSafeInteger(slice) ||
    slice < 0 ||
    slice >= volume.dims[depth]
  )
    throw new Error('The MRI reformat does not match a slice of the resident volume.');
  const columns = volume.dims[column],
    rows = volume.dims[row];
  const origin: Point = [0, 0, 0],
    columnStep: Point = [0, 0, 0],
    rowStep: Point = [0, 0, 0];
  origin[depth] = slice;
  origin[row] = axes.flipRows ? rows - 1 : 0;
  columnStep[column] = 1;
  rowStep[row] = axes.flipRows ? -1 : 1;
  const strides: Point = [1, volume.dims[0], volume.dims[0] * volume.dims[1]];
  return {
    columns,
    rows,
    origin,
    columnStep,
    rowStep,
    offset: dot(origin, strides),
    columnStride: dot(columnStep, strides),
    rowStride: dot(rowStep, strides),
  };
}

/** Exact resident-grid samples, with display row orientation but no invented acquisition metadata. */
export function makeVolumePlaneData(volume: SvrVolume, orientation: SvrRoiPlane, slice: number): MriPlaneData {
  const layout = volumePlaneLayout(volume, orientation, slice);
  const pixels = new Float32Array(layout.columns * layout.rows);
  const validity = new Float32Array(pixels.length);
  for (let row = 0; row < layout.rows; row++) {
    let index = layout.offset + row * layout.rowStride;
    for (let column = 0; column < layout.columns; column++, index += layout.columnStride) {
      const pixel = row * layout.columns + column;
      pixels[pixel] = volume.data[index]!;
      validity[pixel] =
        (!volume.observedSupport || volume.observedSupport[index]) && Number.isFinite(pixels[pixel]) ? 1 : 0;
    }
  }
  const [nx, ny, nz] = volume.dims;
  const box = computePhysicalBoxScale({ nx, ny, nz }, volume.voxelSizeMm);
  const step = (point: Point) => point.map((value, axis) => (value / volume.dims[axis]!) * box[axis]!) as Point;
  return {
    image: { pixels, validity, rows: layout.rows, cols: layout.columns },
    origin: layout.origin.map((value, axis) => ((value + 0.5) / volume.dims[axis]! - 0.5) * box[axis]!) as Point,
    columnStep: step(layout.columnStep),
    rowStep: step(layout.rowStep),
    windowRange: [...defaultVolumeWindow(volume)],
    invert: volume.displayInvert === true,
  };
}

/** Resident reformats use exact categorical cells, independent of the volume renderer's label LOD. */
export function projectVolumePlaneMask(
  volume: SvrVolume,
  labels: SvrLabelVolume | null,
  orientation: SvrRoiPlane,
  slice: number,
): Uint8Array {
  const layout = volumePlaneLayout(volume, orientation, slice);
  const mask = new Uint8Array(layout.columns * layout.rows);
  if (!labels) return mask;
  if (labels.data.length !== volume.data.length || labels.dims.some((size, axis) => size !== volume.dims[axis]))
    throw new Error('The selection does not match the MRI reformat volume.');
  for (let row = 0; row < layout.rows; row++) {
    let index = layout.offset + row * layout.rowStride;
    for (let column = 0; column < layout.columns; column++, index += layout.columnStride)
      if ((!volume.observedSupport || volume.observedSupport[index]) && Number.isFinite(volume.data[index]))
        mask[row * layout.columns + column] = labels.data[index]!;
  }
  return mask;
}

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

type CacheEntry = {
  promise: Promise<DecodedFrame>;
  bytes: number;
  prefetch: boolean;
  start?: () => Promise<void>;
  reject: (reason: unknown) => void;
};
export class NativeFrameOwnershipError extends Error {}
const cancelled = () => new DOMException('Original MRI loading was canceled.', 'AbortError');

/** Sole owner of converted native frames; Cornerstone still owns the decoded DICOM image cache. */
export class NativeFrameCache {
  readonly volume: SvrVolume;
  readonly maxBytes: number;
  private entries = new Map<string, CacheEntry>();
  private loading = false;
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
    const requested = this.key(source, index);
    const retained = new Set(
      [index, index - 1, index + 1].filter((at) => source.frames[at]).map((at) => this.key(source, at)),
    );
    for (const [key, entry] of this.entries) {
      // Completed frames remain byte-bounded LRU entries; only obsolete pending work is discarded.
      if (entry.bytes) continue;
      if (!retained.has(key)) {
        this.entries.delete(key);
        entry.reject(cancelled());
      } else entry.prefetch = key !== requested;
    }
  }
  private evictFor(bytes: number, retained: CacheEntry) {
    for (const [key, entry] of this.entries) {
      if (this.residentBytes + bytes <= this.maxBytes) break;
      if (entry !== retained && entry.bytes) this.entries.delete(key);
    }
  }
  private startNext() {
    if (this.loading || this.controller.signal.aborted) return;
    const queued = [...this.entries.values()].filter((entry) => entry.start);
    const entry = queued.find((entry) => !entry.prefetch) ?? queued[0];
    if (!entry?.start) return;
    const start = entry.start;
    entry.start = undefined;
    this.loading = true;
    void start().finally(() => {
      this.loading = false;
      this.startNext();
    });
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
      throw new NativeFrameOwnershipError(
        'MRI data changed. Reopen the accepted reconstruction before viewing its original images.',
      );
  }
  load(source: SvrNativeSource, index: number, { prefetch = false } = {}): Promise<DecodedFrame> {
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
      if (!prefetch) cached.prefetch = false;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return this.verifyOwner().then(() => cached.promise);
    }
    let resolve!: (image: DecodedFrame) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<DecodedFrame>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const entry: CacheEntry = {
      bytes: 0,
      prefetch,
      promise,
      reject,
      start: async () => {
        try {
          if (this.entries.get(key) !== entry) throw cancelled();
          await this.verifyOwner();
          if (this.entries.get(key) !== entry) throw cancelled();
          // Reserve the incoming converted frame before decoding; only one conversion runs at a time.
          this.evictFor(frame.rows * frame.columns * 8, entry);
          const image = await waitForNativeFrame(
            getDecodedFrameBySopInstanceUid(source.seriesUid, frame.sopInstanceUid, { cache: 'reuse-only' }),
            this.controller.signal,
          );
          await this.verifyOwner();
          if (this.entries.get(key) !== entry) throw cancelled();
          if (
            image.rows !== frame.rows ||
            image.cols !== frame.columns ||
            image.pixels.length !== frame.rows * frame.columns ||
            image.validity.length !== frame.rows * frame.columns
          )
            throw new Error('The original MRI image dimensions changed after reconstruction.');
          entry.bytes = image.pixels.byteLength + image.validity.byteLength;
          this.evictFor(0, entry);
          resolve(image);
        } catch (error: unknown) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          reject(error);
        }
      },
    };
    this.entries.set(key, entry);
    this.startNext();
    return entry.promise;
  }
  dispose() {
    this.controller.abort();
    for (const entry of this.entries.values()) if (!entry.bytes) entry.reject(cancelled());
    this.entries.clear();
  }
}
