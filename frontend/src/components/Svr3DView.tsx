import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import cornerstone from 'cornerstone-core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDB } from '../db/db';
import type { DicomInstance } from '../db/schema';
import type { ComparisonData } from '../types/api';
import type { SvrLabelVolume, SvrParams, SvrRoi, SvrRoiPlane, SvrSelectedSeries, SvrVolume } from '../types/svr';
import { formatPatientName, formatSequenceLabel } from '../utils/clinicalData';
import { formatDate } from '../utils/format';
import { decodeImageWithValidity, loadCornerstoneImage } from '../utils/decodedFrame';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { useSvrReconstruction } from '../hooks/useSvrReconstruction';
import { getSeriesFrameManifest, getSortedSopInstanceUidsForSeries } from '../utils/localApi';
import type { SeriesFrameManifest } from '../utils/localApi';
import type { SliceGeometry } from '../utils/svr/dicomGeometry';
import { getSliceGeometryFromInstance, INDEPENDENT_NORMAL_COSINE, sliceCornersMm } from '../utils/svr/dicomGeometry';
import { computeSvrDownsampleSize } from '../utils/svr/downsample';
import { filterSvrManifestFramesForRoi } from '../utils/svr/sliceRoiCrop';
import {
  estimateSvrPeakMemoryBytes,
  estimateSvrRegistrationBytes,
  SVR_MEMORY_BUDGET_BYTES,
} from '../utils/svr/svrMemoryPlan';
import { quantileSorted } from '../utils/svr/svrUtils';
import { dot } from '../utils/svr/vec3';
import { SvrVolume3DViewer } from './SvrVolume3DViewer';
import { SvrImagingContext } from './svrImagingContext';
import { regionalRefinementParameters, selectionFocusRoi } from '../utils/svr/refineRegion';
import { clamp, clamp01, clampInt } from '../utils/math';

function sortedDatesDesc(dates: string[]): string[] {
  return [...dates].sort((a, b) => b.localeCompare(a));
}

function formatSeriesLabel(seq: { plane: string | null; weight: string | null; sequence: string | null }): string {
  const base = formatSequenceLabel(seq);
  return [seq.plane, base].filter(Boolean).join(' ') || 'Unknown';
}

function sequenceGroupKey(seq: { weight: string | null; sequence: string | null }): string {
  return `${seq.weight ?? ''}|||${seq.sequence ?? ''}`;
}

type RoiRect01 = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

function normalizeRect01(rect: RoiRect01): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.min(rect.x0, rect.x1),
    right: Math.max(rect.x0, rect.x1),
    top: Math.min(rect.y0, rect.y1),
    bottom: Math.max(rect.y0, rect.y1),
  };
}

function inferRoiPlaneFromNormalDir(normalDir: SliceGeometry['normalDir']): SvrRoiPlane {
  const ax = Math.abs(normalDir.x);
  const ay = Math.abs(normalDir.y);
  const az = Math.abs(normalDir.z);

  // DICOM patient/world axes: X=left-right, Y=posterior-anterior, Z=foot-head.
  // Normal mostly along Z => axial slices.
  if (az >= ax && az >= ay) return 'axial';
  if (ay >= ax && ay >= az) return 'coronal';
  return 'sagittal';
}

function computeCubeRoiFromDicomRect01(params: {
  rect: RoiRect01;
  geom: SliceGeometry;
  sourceSeriesUid: string;
}): SvrRoi | null {
  const { rect, geom, sourceSeriesUid } = params;

  const r = normalizeRect01(rect);
  const w01 = r.right - r.left;
  const h01 = r.bottom - r.top;
  if (w01 <= 1e-4 || h01 <= 1e-4) return null;

  const rMax = Math.max(0, geom.rows - 1);
  const cMax = Math.max(0, geom.cols - 1);

  // In-plane box extents in mm.
  const widthMm = w01 * cMax * geom.colSpacingMm;
  const heightMm = h01 * rMax * geom.rowSpacingMm;

  const depthMm = Math.max(widthMm, heightMm);
  if (!(depthMm > 1e-6)) return null;

  const halfDepth = depthMm * 0.5;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  // A selected rectangle is expressed in its acquisition plane, not in the
  // patient axes. Include all four rotated corners and the selected thickness.
  for (const row of [r.top * rMax, r.bottom * rMax]) {
    for (const col of [r.left * cMax, r.right * cMax]) {
      for (const normalOffset of [-halfDepth, halfDepth]) {
        const point = (['x', 'y', 'z'] as const).map(
          (axis) =>
            geom.ippMm[axis] +
            geom.colDir[axis] * row * geom.rowSpacingMm +
            geom.rowDir[axis] * col * geom.colSpacingMm +
            geom.normalDir[axis] * normalOffset,
        );

        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], point[axis]!);
          max[axis] = Math.max(max[axis], point[axis]!);
        }
      }
    }
  }

  return {
    mode: 'cube',
    sourcePlane: inferRoiPlaneFromNormalDir(geom.normalDir),
    sourceSeriesUid,
    boundsMm: {
      min,
      max,
    },
  };
}

function computeDownsampleSize(rows: number, cols: number, maxSize: number): { dsRows: number; dsCols: number } {
  const maxDim = Math.max(rows, cols);
  if (!Number.isFinite(maxSize) || maxSize <= 1) {
    return { dsRows: Math.max(1, rows), dsCols: Math.max(1, cols) };
  }

  const scale = maxDim > maxSize ? maxSize / maxDim : 1;
  return {
    dsRows: Math.max(1, Math.round(rows * scale)),
    dsCols: Math.max(1, Math.round(cols * scale)),
  };
}

function drawDicomPixelDataToCanvas(params: {
  canvas: HTMLCanvasElement;
  image: Parameters<typeof decodeImageWithValidity>[0];
  rows: number;
  cols: number;
  maxSize: number;
}): void {
  const { canvas, image, rows, cols, maxSize } = params;

  const { dsRows, dsCols } = computeDownsampleSize(rows, cols, maxSize);
  const { pixels: down, validity } = decodeImageWithValidity(image, dsRows, dsCols);

  if (canvas.width !== dsCols) canvas.width = dsCols;
  if (canvas.height !== dsRows) canvas.height = dsRows;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Robust windowing (percentiles) is less sensitive to background/outliers than raw min/max.
  const finite: number[] = [];
  const samplingStride = Math.max(1, Math.floor(down.length / 16_384));
  for (let i = 0; i < down.length; i += samplingStride) {
    if (!validity[i]) continue;
    const v = down[i];
    if (Number.isFinite(v)) finite.push(v);
  }

  finite.sort((a, b) => a - b);

  let lo = quantileSorted(finite, 0.01);
  let hi = quantileSorted(finite, 0.99);

  if (!(hi > lo + 1e-12)) {
    lo = finite[0] ?? 0;
    hi = finite[finite.length - 1] ?? lo + 1;
  }

  const invRange = hi > lo + 1e-12 ? 1 / (hi - lo) : 0;

  const img = ctx.createImageData(dsCols, dsRows);
  const out = img.data;

  for (let i = 0; i < down.length; i++) {
    const v = down[i];
    const n = validity[i] && Number.isFinite(v) && invRange > 0 ? (v - lo) * invRange : 0;
    const b = Math.round(clamp01(n) * 255);

    const idx = i * 4;
    out[idx] = b;
    out[idx + 1] = b;
    out[idx + 2] = b;
    out[idx + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
}

export function DicomRoiSlicePreview(props: {
  slice: { sopInstanceUid: string; geom: SliceGeometry } | null;
  sourceSeriesUid: string | null;
  maxSize: number;
  roiRect: RoiRect01 | null;
  setRoiRect: (next: RoiRect01 | null) => void;
  roiDragRef: { current: { x0: number; y0: number } | null };
  onSliceDelta: (delta: number) => void;
  onRoiFinalized: (roi: SvrRoi | null) => void;
  disabled?: boolean;
}) {
  const { slice, sourceSeriesUid, maxSize, roiRect, setRoiRect, roiDragRef, onSliceDelta, onRoiFinalized, disabled } =
    props;

  const rect = roiRect ? normalizeRect01(roiRect) : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!slice) {
      // Clear canvas.
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let alive = true;

    const run = async () => {
      try {
        const imageId = `miradb:${slice.sopInstanceUid}`;
        const image = (await loadCornerstoneImage(imageId)) as unknown as Parameters<typeof decodeImageWithValidity>[0];

        if (!alive) return;

        drawDicomPixelDataToCanvas({
          canvas,
          image,
          rows: slice.geom.rows,
          cols: slice.geom.cols,
          maxSize,
        });
        setRenderError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!alive) return;
        setRenderError(msg);
      }
    };

    void run();

    return () => {
      alive = false;
    };
  }, [maxSize, slice]);

  const wheelAccumRef = useRef(0);
  const wheelTargetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wheelTargetRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (disabled) return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      // Trackpads generate many small deltas; accumulate and step in whole slices.
      wheelAccumRef.current += e.deltaY;

      const stepPx = 60;
      while (Math.abs(wheelAccumRef.current) >= stepPx) {
        const dir = wheelAccumRef.current > 0 ? 1 : -1;
        wheelAccumRef.current -= dir * stepPx;

        // Convention: wheel down (deltaY>0) => next slice.
        onSliceDelta(dir);
      }

      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, onSliceDelta]);

  const aspect = slice
    ? { w: slice.geom.cols * slice.geom.colSpacingMm, h: slice.geom.rows * slice.geom.rowSpacingMm }
    : { w: 1, h: 1 };

  return (
    <div className="overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]">
      <div className="relative w-full bg-[var(--bg-primary)]" style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Acquired MRI slice preview"
          className="absolute inset-0 w-full h-full"
        />

        {rect ? (
          <div
            className="absolute border border-[var(--signal-metal)]"
            style={{
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${(rect.right - rect.left) * 100}%`,
              height: `${(rect.bottom - rect.top) * 100}%`,
            }}
          />
        ) : null}

        {renderError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-3 text-center text-xs text-[var(--danger)]">
            {renderError}
          </div>
        ) : !slice ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-3 text-center text-xs text-[var(--text-secondary)]">
            Select a series to preview an input slice.
          </div>
        ) : null}

        <div
          ref={wheelTargetRef}
          role="application"
          aria-label="Focus-box source slice; use the arrow keys to change slices"
          tabIndex={disabled || !slice ? -1 : 0}
          className={`absolute inset-0 ${disabled ? 'cursor-not-allowed' : slice ? 'cursor-crosshair' : 'cursor-default'}`}
          onKeyDown={(event) => {
            if (disabled || !slice) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              onSliceDelta(-1);
              event.preventDefault();
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              onSliceDelta(1);
              event.preventDefault();
            }
          }}
          onPointerDown={(e) => {
            if (disabled || !slice || !sourceSeriesUid) return;
            const box = e.currentTarget.getBoundingClientRect();
            const x = clamp01((e.clientX - box.left) / box.width);
            const y = clamp01((e.clientY - box.top) / box.height);

            roiDragRef.current = { x0: x, y0: y };
            setRoiRect({ x0: x, y0: y, x1: x, y1: y });
            onRoiFinalized(null);

            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            const drag = roiDragRef.current;
            if (disabled || !slice || !drag) return;

            const box = e.currentTarget.getBoundingClientRect();
            const x = clamp01((e.clientX - box.left) / box.width);
            const y = clamp01((e.clientY - box.top) / box.height);

            setRoiRect({ x0: drag.x0, y0: drag.y0, x1: x, y1: y });
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerUp={(e) => {
            const drag = roiDragRef.current;
            roiDragRef.current = null;

            if (!drag || !slice || !sourceSeriesUid) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }

            const box = e.currentTarget.getBoundingClientRect();
            const x = clamp01((e.clientX - box.left) / box.width);
            const y = clamp01((e.clientY - box.top) / box.height);

            const finalRect: RoiRect01 = { x0: drag.x0, y0: drag.y0, x1: x, y1: y };
            setRoiRect(finalRect);

            const roi = computeCubeRoiFromDicomRect01({ rect: finalRect, geom: slice.geom, sourceSeriesUid });
            onRoiFinalized(roi);

            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerCancel={(e) => {
            roiDragRef.current = null;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </div>

      <div className="flex items-center justify-between bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]">
        <span>Input slice</span>
        {roiRect ? <span className="text-xs text-[var(--signal-metal)]">Box</span> : null}
      </div>
    </div>
  );
}

const lastRoiPreviewSliceIndexBySeriesUid = new Map<string, number>();

type SvrSourceReadiness = {
  identity: string;
  manifests: SeriesFrameManifest[];
  independentOrientationCount: number;
  error: string | null;
};

type SvrWorkspaceState = {
  identity: string | null;
  showAcquiredStack: boolean;
  roiSeriesUid: string | null;
  roiSeriesSopUids: string[] | null;
  roiSeriesSopUidsError: string | null;
  // Use -1 as a sentinel meaning "auto (middle slice)".
  roiSliceIndex: number;
  roiSliceGeom: SliceGeometry | null;
  roiSliceGeomError: string | null;
  // Keep a stable preview slice so we don't clear the canvas between fast slice changes.
  roiPreviewSliceStable: { sopInstanceUid: string; geom: SliceGeometry } | null;
  roiRect: RoiRect01 | null;
  // Canonical ROI used for reconstruction (stays valid even if the user scrolls away from the selection slice).
  roiWorld: SvrRoi | null;
};

type SvrWorkspaceUpdate =
  | Partial<Omit<SvrWorkspaceState, 'identity'>>
  | ((state: SvrWorkspaceState) => Partial<Omit<SvrWorkspaceState, 'identity'>>);

function initialSvrWorkspaceState(identity: string | null): SvrWorkspaceState {
  return {
    identity,
    showAcquiredStack: false,
    roiSeriesUid: null,
    roiSeriesSopUids: null,
    roiSeriesSopUidsError: null,
    roiSliceIndex: -1,
    roiSliceGeom: null,
    roiSliceGeomError: null,
    roiPreviewSliceStable: null,
    roiRect: null,
    roiWorld: null,
  };
}

function useSvrWorkspaceState(identity: string | null) {
  const [stored, dispatch] = useReducer(
    (
      previous: SvrWorkspaceState,
      action: { identity: string | null; update: SvrWorkspaceUpdate },
    ): SvrWorkspaceState => {
      const current = previous.identity === action.identity ? previous : initialSvrWorkspaceState(action.identity);
      return { ...current, ...(typeof action.update === 'function' ? action.update(current) : action.update) };
    },
    identity,
    initialSvrWorkspaceState,
  );
  const state = stored.identity === identity ? stored : initialSvrWorkspaceState(identity);
  const update = useCallback((next: SvrWorkspaceUpdate) => dispatch({ identity, update: next }), [identity]);

  return {
    ...state,
    setShowAcquiredStack: useCallback(
      (next: boolean | ((previous: boolean) => boolean)) =>
        update(
          typeof next === 'function'
            ? (current) => ({ showAcquiredStack: next(current.showAcquiredStack) })
            : { showAcquiredStack: next },
        ),
      [update],
    ),
    setRoiSeriesUid: useCallback((roiSeriesUid: string | null) => update({ roiSeriesUid }), [update]),
    setRoiSeriesSopUids: useCallback((roiSeriesSopUids: string[] | null) => update({ roiSeriesSopUids }), [update]),
    setRoiSeriesSopUidsError: useCallback(
      (roiSeriesSopUidsError: string | null) => update({ roiSeriesSopUidsError }),
      [update],
    ),
    setRoiSliceIndex: useCallback((roiSliceIndex: number) => update({ roiSliceIndex }), [update]),
    setRoiSliceGeom: useCallback((roiSliceGeom: SliceGeometry | null) => update({ roiSliceGeom }), [update]),
    setRoiSliceGeomError: useCallback((roiSliceGeomError: string | null) => update({ roiSliceGeomError }), [update]),
    setRoiPreviewSliceStable: useCallback(
      (roiPreviewSliceStable: { sopInstanceUid: string; geom: SliceGeometry } | null) =>
        update({ roiPreviewSliceStable }),
      [update],
    ),
    setRoiRect: useCallback((roiRect: RoiRect01 | null) => update({ roiRect }), [update]),
    setRoiWorld: useCallback((roiWorld: SvrRoi | null) => update({ roiWorld }), [update]),
  };
}

function countIndependentOrientations(manifests: SeriesFrameManifest[]): number {
  const normals: SliceGeometry['normalDir'][] = [];

  for (const manifest of manifests) {
    const frame = manifest.frames[0];
    if (!frame) continue;

    const normal = getSliceGeometryFromInstance(frame).normalDir;
    const alreadyRepresented = normals.some((existing) => Math.abs(dot(existing, normal)) >= INDEPENDENT_NORMAL_COSINE);

    if (!alreadyRepresented) normals.push(normal);
  }

  return normals.length;
}

/** Native Cornerstone-decoded source pixels coexist with the transferred SVR slice copies. */
function estimateSourceMemory(
  manifests: SeriesFrameManifest[],
  params: SvrParams,
  roi: SvrRoi | null,
): { sourceBytes: number; decodedSourceCacheBytes: number } {
  let sourceBytes = 0;
  let selectedNativeBytes = 0;

  for (const manifest of manifests) {
    const frame = manifest.frames[0];
    if (!frame) continue;

    const geometry = getSliceGeometryFromInstance(frame);
    const sampled = computeSvrDownsampleSize({
      rows: geometry.rows,
      cols: geometry.cols,
      maxSize: params.sliceDownsampleMaxSize,
      mode: params.sliceDownsampleMode,
      rowSpacingMm: geometry.rowSpacingMm,
      colSpacingMm: geometry.colSpacingMm,
      targetVoxelSizeMm: params.targetVoxelSizeMm,
    });

    // Float32 intensity and the authoritative byte-per-pixel acquired mask.
    const admittedFrames = filterSvrManifestFramesForRoi(manifest, roi, params).frames;
    sourceBytes += sampled.dsRows * sampled.dsCols * admittedFrames.length * 5;

    for (const admittedFrame of admittedFrames) {
      // Some source modalities promote signed values or modality-scaled pixels
      // to Float32. Count that worst-case resident representation explicitly.
      selectedNativeBytes += admittedFrame.rows * admittedFrame.columns * Float32Array.BYTES_PER_ELEMENT;
    }
  }

  try {
    const cache = cornerstone.imageCache?.getCacheInfo?.();
    const existingBytes = Math.max(0, Number(cache?.cacheSizeInBytes) || 0);
    const maximumBytes = Number(cache?.maximumSizeInBytes);
    const projectedBytes = existingBytes + selectedNativeBytes;
    return {
      sourceBytes,
      decodedSourceCacheBytes:
        Number.isFinite(maximumBytes) && maximumBytes > 0 ? Math.min(maximumBytes, projectedBytes) : projectedBytes,
    };
  } catch {
    // Missing cache telemetry never makes the selected native frames free.
    return { sourceBytes, decodedSourceCacheBytes: selectedNativeBytes };
  }
}

/** Mirror the solver's physical output grid instead of budgeting a fictional max-dimension cube. */
function estimateReconstructionGrid(
  manifests: SeriesFrameManifest[],
  params: SvrParams,
  roi: SvrRoi | null,
): { voxelCount: number; effectiveVoxelSizeMm: number } {
  const minimum = roi ? [...roi.boundsMm.min] : [Infinity, Infinity, Infinity];
  const maximum = roi ? [...roi.boundsMm.max] : [-Infinity, -Infinity, -Infinity];

  if (!roi) {
    for (const manifest of manifests) {
      for (const frame of manifest.frames) {
        const geometry = getSliceGeometryFromInstance(frame);
        const halfThickness =
          typeof frame.sliceThickness === 'number' && Number.isFinite(frame.sliceThickness) && frame.sliceThickness > 0
            ? frame.sliceThickness / 2
            : 0;
        const halfExtent = (['x', 'y', 'z'] as const).map(
          (axis) =>
            Math.abs(geometry.colDir[axis]) * geometry.rowSpacingMm * 0.5 +
            Math.abs(geometry.rowDir[axis]) * geometry.colSpacingMm * 0.5 +
            Math.abs(geometry.normalDir[axis]) * halfThickness,
        );

        for (const corner of sliceCornersMm(geometry)) {
          const coordinates = [corner.x, corner.y, corner.z];
          for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis]!, coordinates[axis]! - halfExtent[axis]!);
            maximum[axis] = Math.max(maximum[axis]!, coordinates[axis]! + halfExtent[axis]!);
          }
        }
      }
    }
  }

  const maximumDimension = Math.max(2, Math.floor(params.maxVolumeDim));
  let voxelSize = Math.max(0.001, params.targetVoxelSizeMm);
  if (minimum.some((value, axis) => !Number.isFinite(value) || !Number.isFinite(maximum[axis]!))) {
    return { voxelCount: maximumDimension ** 3, effectiveVoxelSizeMm: voxelSize };
  }

  let dimensions = [2, 2, 2];
  for (let attempt = 0; attempt < 10; attempt++) {
    dimensions = minimum.map((value, axis) => Math.max(2, Math.ceil((maximum[axis]! - value) / voxelSize) + 1));
    const largestDimension = Math.max(...dimensions);
    if (largestDimension <= maximumDimension) break;
    voxelSize *= largestDimension / maximumDimension;
  }

  return {
    voxelCount: dimensions.reduce((count, dimension) => count * dimension, 1),
    effectiveVoxelSizeMm: voxelSize,
  };
}

function planReconstruction(
  manifests: SeriesFrameManifest[],
  params: SvrParams,
  roi: SvrRoi | null,
  retainedVolume?: SvrVolume,
) {
  const retainedVoxelCount = retainedVolume?.data.length ?? 0;
  // Recomputing deliberately preserves the prior Float32 result and its
  // support evidence while both independent 3D GPU textures stay visible.
  const retainedBytes = retainedVolume
    ? retainedVolume.data.byteLength +
      (retainedVolume.observedSupport?.byteLength ?? 0) +
      retainedVoxelCount * (Uint16Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT)
    : 0;

  const evaluate = (targetVoxelSizeMm: number) => {
    const effectiveParams = { ...params, targetVoxelSizeMm };
    const { sourceBytes, decodedSourceCacheBytes } = estimateSourceMemory(manifests, effectiveParams, roi);
    const { voxelCount, effectiveVoxelSizeMm } = estimateReconstructionGrid(manifests, effectiveParams, roi);

    return {
      effectiveParams,
      effectiveVoxelSizeMm,
      sourceBytes,
      memoryPlan: estimateSvrPeakMemoryBytes({
        voxelCount,
        sourceBytes,
        iterations: effectiveParams.iterations,
        retainedBytes: retainedBytes + decodedSourceCacheBytes,
        // Reserve independently owned CPU/GPU labels for both the incoming
        // result and any already-annotated retained reconstruction.
        labelBytes: (voxelCount + retainedVoxelCount) * Uint8Array.BYTES_PER_ELEMENT * 2,
        registrationBytes:
          roi && effectiveParams.seriesRegistrationMode === 'roi-rigid' ? estimateSvrRegistrationBytes(voxelCount) : 0,
      }),
    };
  };

  const requested = evaluate(params.targetVoxelSizeMm);
  if (requested.memoryPlan.totalBytes <= SVR_MEMORY_BUDGET_BYTES) return requested;

  let lower = Math.floor(params.targetVoxelSizeMm * 100);
  let upper = Math.min(1000, Math.max(lower + 1, Math.ceil(lower * 1.25)));
  let nearestSafe = evaluate(upper / 100);

  while (nearestSafe.memoryPlan.totalBytes > SVR_MEMORY_BUDGET_BYTES && upper < 1000) {
    lower = upper;
    upper = Math.min(1000, Math.ceil(upper * 1.5));
    nearestSafe = evaluate(upper / 100);
  }

  if (nearestSafe.memoryPlan.totalBytes > SVR_MEMORY_BUDGET_BYTES) return requested;

  while (upper - lower > 1) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = evaluate(midpoint / 100);
    if (candidate.memoryPlan.totalBytes > SVR_MEMORY_BUDGET_BYTES) {
      lower = midpoint;
    } else {
      upper = midpoint;
      nearestSafe = candidate;
    }
  }

  return nearestSafe;
}

export type Svr3DViewProps = {
  data: ComparisonData;
  defaultDateIso?: string | null;
  defaultSeqId?: string | null;
  /**
   * Fallback slice selection for the ROI preview.
   * Usually comes from the last-viewed slice in the grid/overlay views.
   */
  fallbackRoiSeriesUid?: string | null;
  fallbackRoiSliceIndex?: number | null;
};

function useSvrReconstructionWorkspace({
  data,
  defaultDateIso,
  defaultSeqId,
  fallbackRoiSeriesUid,
  fallbackRoiSliceIndex,
}: Svr3DViewProps) {
  const roiSeriesSelectId = useId();
  const dates = useMemo(() => sortedDatesDesc(data.dates), [data.dates]);
  const dateIso = defaultDateIso && dates.includes(defaultDateIso) ? defaultDateIso : dates[0] || null;

  const [params, setParams] = useState<SvrParams>(() => ({
    ...DEFAULT_SVR_PARAMS,
    sliceDownsampleMode: 'voxel-aware',
    seriesRegistrationMode: 'roi-rigid',
  }));
  const [generationCollapsed, setGenerationCollapsed] = useState(false);

  const { status, isRunning, progress, result, resultIdentity, error, run, cancel, clear } = useSvrReconstruction();

  const sequenceGroupsForDate = useMemo(() => {
    if (!dateIso) return [];

    const byKey = new Map<
      string,
      {
        label: string;
        weight: string | null;
        sequence: string | null;
        series: SvrSelectedSeries[];
        planeSet: Set<string>;
        sliceCount: number;
      }
    >();

    for (const seq of data.sequences) {
      const ref = data.series_map[seq.id]?.[dateIso];
      if (!ref) continue;

      const formattedSequence = formatSequenceLabel(seq);
      const seqLabel = formattedSequence === 'Unknown' ? 'Unclassified' : formattedSequence;

      const key = sequenceGroupKey(seq);
      let g = byKey.get(key);
      if (!g) {
        g = {
          label: seqLabel,
          weight: seq.weight,
          sequence: seq.sequence,
          series: [],
          planeSet: new Set<string>(),
          sliceCount: 0,
        };
        byKey.set(key, g);
      }

      g.series.push({
        seriesUid: ref.series_uid,
        studyId: ref.study_id,
        dateIso,
        instanceCount: ref.instance_count,
        label: formatSeriesLabel(seq),
        plane: seq.plane,
        weight: seq.weight,
        sequence: seq.sequence,
      });

      g.planeSet.add(seq.plane || 'Unknown');
      g.sliceCount += ref.instance_count;
    }

    const out = Array.from(byKey, ([key, g]) => {
      // Keep stable ordering within a group: plane, then label.
      g.series.sort((a, b) => {
        const pa = a.plane || '';
        const pb = b.plane || '';
        if (pa !== pb) return pa.localeCompare(pb);
        return a.label.localeCompare(b.label);
      });

      return {
        key,
        label: g.label,
        weight: g.weight,
        sequence: g.sequence,
        series: g.series,
        planeCount: g.planeSet.size,
        sliceCount: g.sliceCount,
      };
    });

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [data.sequences, data.series_map, dateIso]);

  const defaultSelectedSequenceKey = useMemo(() => {
    if (!dateIso) return null;

    const fallback = sequenceGroupsForDate[0]?.key ?? null;
    if (!defaultSeqId) return fallback;

    const currentSeq = data.sequences.find((s) => s.id === defaultSeqId);
    if (!currentSeq) return fallback;

    const key = sequenceGroupKey(currentSeq);
    return sequenceGroupsForDate.some((g) => g.key === key) ? key : fallback;
  }, [data.sequences, dateIso, defaultSeqId, sequenceGroupsForDate]);

  const [selectedSequenceKey, setSelectedSequenceKey] = useState<string | null>(defaultSelectedSequenceKey);

  useEffect(() => {
    setSelectedSequenceKey(defaultSelectedSequenceKey);
  }, [defaultSelectedSequenceKey]);

  const selectedGroup = useMemo(() => {
    if (!selectedSequenceKey) return null;
    return sequenceGroupsForDate.find((g) => g.key === selectedSequenceKey) ?? null;
  }, [selectedSequenceKey, sequenceGroupsForDate]);

  const selectedSeries = useMemo(() => selectedGroup?.series ?? [], [selectedGroup]);

  const volumeIdentity = useMemo(() => {
    if (selectedSeries.length === 0) return null;
    const seriesUids = selectedSeries.map((series) => series.seriesUid);
    const selectedSeriesUids = new Set(seriesUids);
    const matchingReference = Object.values(data.series_map)
      .map((byDate) => (dateIso ? byDate[dateIso] : undefined))
      .find((ref) => ref && selectedSeriesUids.has(ref.series_uid));

    return {
      patientKey: data.selected_patient_key ?? matchingReference?.patient_key,
      studyUid: matchingReference?.study_uid ?? selectedSeries[0]?.studyId,
      seriesUids,
      frameOfReferenceUid: matchingReference?.frame_of_reference_uid,
      datasetRevision: data.dataset_revision,
    };
  }, [data.dataset_revision, data.selected_patient_key, data.series_map, dateIso, selectedSeries]);

  const workspaceIdentity = useMemo(() => {
    if (!volumeIdentity) return null;
    return JSON.stringify({
      patient: volumeIdentity.patientKey ?? null,
      study: volumeIdentity.studyUid ?? null,
      sequence: selectedSequenceKey,
      revision: volumeIdentity.datasetRevision ?? null,
      frame: volumeIdentity.frameOfReferenceUid ?? null,
      series: [...volumeIdentity.seriesUids].sort(),
    });
  }, [selectedSequenceKey, volumeIdentity]);

  const acceptedResult = resultIdentity === workspaceIdentity ? result : null;
  const {
    showAcquiredStack,
    setShowAcquiredStack,
    roiSeriesUid,
    setRoiSeriesUid,
    roiSeriesSopUids,
    setRoiSeriesSopUids,
    roiSeriesSopUidsError,
    setRoiSeriesSopUidsError,
    roiSliceIndex,
    setRoiSliceIndex,
    roiSliceGeom,
    setRoiSliceGeom,
    roiSliceGeomError,
    setRoiSliceGeomError,
    roiPreviewSliceStable,
    setRoiPreviewSliceStable,
    roiRect,
    setRoiRect,
    roiWorld,
    setRoiWorld,
  } = useSvrWorkspaceState(workspaceIdentity);
  const [sourceReadiness, setSourceReadiness] = useState<SvrSourceReadiness | null>(null);

  useEffect(() => {
    if (!workspaceIdentity || selectedSeries.length === 0) {
      setSourceReadiness(null);
      return;
    }

    let current = true;
    setSourceReadiness(null);

    void Promise.all(selectedSeries.map((series) => getSeriesFrameManifest(series.seriesUid)))
      .then((manifests) => {
        if (!current) return;

        const reference = manifests[0];
        if (!reference) throw new Error('No acquired source frames are available.');

        for (let index = 0; index < manifests.length; index++) {
          const manifest = manifests[index]!;
          const selected = selectedSeries[index]!;
          if (manifest.patientKey !== reference.patientKey) {
            throw new Error('The selected acquisitions do not belong to the same patient.');
          }
          if (manifest.studyUid !== reference.studyUid) {
            throw new Error('The selected acquisitions do not belong to the same examination.');
          }
          if (volumeIdentity?.patientKey && manifest.patientKey !== volumeIdentity.patientKey) {
            throw new Error('The selected acquisition no longer belongs to the current patient.');
          }
          if (manifest.frames.length !== selected.instanceCount) {
            throw new Error('An acquired source frame changed or disappeared. Reload this examination.');
          }
          if (!manifest.geometryReliable) {
            throw new Error('An acquisition has unreliable physical geometry and cannot be reconstructed safely.');
          }
          if (!manifest.frameOfReferenceUid) {
            throw new Error('An acquisition is missing a verified spatial coordinate frame.');
          }
        }

        if (manifests.some((manifest) => manifest.frameOfReferenceUid !== reference.frameOfReferenceUid)) {
          throw new Error('These acquisitions use incompatible spatial coordinate frames.');
        }

        setSourceReadiness({
          identity: workspaceIdentity,
          manifests,
          independentOrientationCount: countIndependentOrientations(manifests),
          error: null,
        });
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setSourceReadiness({
          identity: workspaceIdentity,
          manifests: [],
          independentOrientationCount: 0,
          error: reason instanceof Error ? reason.message : 'The acquisition could not be verified.',
        });
      });

    return () => {
      current = false;
    };
  }, [selectedSeries, volumeIdentity?.patientKey, workspaceIdentity]);

  // ROI-first flow: pick a ROI on an input slice, then run SVR restricted to that cube.
  const preferredRoiSeriesUid = useMemo(() => {
    if (!defaultSeqId) return null;
    const seq = data.sequences.find((s) => s.id === defaultSeqId);
    if (!seq) return null;

    // Prefer the same plane the user was looking at in the comparison grid/overlay.
    const match = selectedSeries.find((s) => (s.plane ?? null) === (seq.plane ?? null));
    return match?.seriesUid ?? null;
  }, [data.sequences, defaultSeqId, selectedSeries]);

  const effectiveRoiSeriesUid = useMemo(() => {
    if (roiSeriesUid && selectedSeries.some((s) => s.seriesUid === roiSeriesUid)) {
      return roiSeriesUid;
    }
    return preferredRoiSeriesUid ?? selectedSeries[0]?.seriesUid ?? null;
  }, [preferredRoiSeriesUid, roiSeriesUid, selectedSeries]);

  const roiSeries = useMemo(() => {
    if (!effectiveRoiSeriesUid) return null;
    return selectedSeries.find((s) => s.seriesUid === effectiveRoiSeriesUid) ?? null;
  }, [effectiveRoiSeriesUid, selectedSeries]);

  const roiDragRef = useRef<{ x0: number; y0: number } | null>(null);

  // Keep fallback slice inputs in refs so ROI-series effects don't retrigger on every slice tick.
  const fallbackRoiSeriesUidRef = useRef<string | null | undefined>(fallbackRoiSeriesUid);
  const fallbackRoiSliceIndexRef = useRef<number | null | undefined>(fallbackRoiSliceIndex);
  useEffect(() => {
    fallbackRoiSeriesUidRef.current = fallbackRoiSeriesUid;
    fallbackRoiSliceIndexRef.current = fallbackRoiSliceIndex;
  }, [fallbackRoiSeriesUid, fallbackRoiSliceIndex]);

  // Selection identity, not a date string, owns all patient-scoped SVR state.
  const previousWorkspaceIdentityRef = useRef<string | null>(workspaceIdentity);
  useEffect(() => {
    if (previousWorkspaceIdentityRef.current === workspaceIdentity) return;
    previousWorkspaceIdentityRef.current = workspaceIdentity;

    roiDragRef.current = null;
    clear();
  }, [clear, workspaceIdentity]);

  useEffect(() => {
    setRoiSeriesSopUids(null);
    setRoiSeriesSopUidsError(null);

    // Slice selection priority:
    // 1) The last slice the user viewed in the SVR ROI preview for this series.
    // 2) The last slice the user viewed in the grid/overlay views (if it matches this series).
    // 3) Default to the middle slice.
    const saved = effectiveRoiSeriesUid ? lastRoiPreviewSliceIndexBySeriesUid.get(effectiveRoiSeriesUid) : undefined;

    let nextSliceIndex = -1;
    if (typeof saved === 'number' && Number.isFinite(saved)) {
      nextSliceIndex = Math.round(saved);
    } else {
      const fallbackSeries = fallbackRoiSeriesUidRef.current;
      const fallbackSlice = fallbackRoiSliceIndexRef.current;

      if (
        effectiveRoiSeriesUid &&
        fallbackSeries &&
        effectiveRoiSeriesUid === fallbackSeries &&
        typeof fallbackSlice === 'number' &&
        Number.isFinite(fallbackSlice)
      ) {
        nextSliceIndex = Math.round(fallbackSlice);
      }
    }

    setRoiSliceIndex(nextSliceIndex);
    setRoiSliceGeom(null);
    setRoiSliceGeomError(null);

    setRoiRect(null);
    roiDragRef.current = null;
    setRoiWorld(null);
    setRoiPreviewSliceStable(null);

    if (!effectiveRoiSeriesUid) return;

    let alive = true;
    const run = async () => {
      try {
        const uids = await getSortedSopInstanceUidsForSeries(effectiveRoiSeriesUid);
        if (!alive) return;
        setRoiSeriesSopUids(uids);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!alive) return;
        setRoiSeriesSopUidsError(msg);
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [
    effectiveRoiSeriesUid,
    setRoiPreviewSliceStable,
    setRoiRect,
    setRoiSeriesSopUids,
    setRoiSeriesSopUidsError,
    setRoiSliceGeom,
    setRoiSliceGeomError,
    setRoiSliceIndex,
    setRoiWorld,
  ]);

  // Persist explicit slice selection (>=0) so leaving/re-entering SVR preserves ROI preview position.
  const roiSeriesCount = roiSeriesSopUids?.length ?? 0;
  useEffect(() => {
    if (!effectiveRoiSeriesUid) return;
    if (roiSliceIndex < 0) return;

    const idx = roiSeriesCount > 0 ? clampInt(roiSliceIndex, 0, roiSeriesCount - 1) : roiSliceIndex;
    lastRoiPreviewSliceIndexBySeriesUid.set(effectiveRoiSeriesUid, idx);
  }, [effectiveRoiSeriesUid, roiSeriesCount, roiSliceIndex]);

  const effectiveRoiSliceIndex = useMemo(() => {
    if (roiSeriesCount <= 0) return 0;

    const dflt = Math.floor(roiSeriesCount / 2);
    return roiSliceIndex >= 0 ? clampInt(roiSliceIndex, 0, roiSeriesCount - 1) : dflt;
  }, [roiSeriesCount, roiSliceIndex]);

  const stepRoiSlice = useCallback(
    (delta: number) => {
      if (!roiSeriesSopUids?.length) return;
      const current = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
      setRoiSliceIndex(clampInt(current + delta, 0, roiSeriesSopUids.length - 1));
    },
    [effectiveRoiSliceIndex, roiSeriesSopUids, roiSliceIndex, setRoiSliceIndex],
  );

  const roiSopInstanceUid = roiSeriesSopUids ? (roiSeriesSopUids[effectiveRoiSliceIndex] ?? null) : null;

  useEffect(() => {
    setRoiSliceGeom(null);
    setRoiSliceGeomError(null);

    // The selection rectangle is tied to a specific slice; clear it when the slice changes.
    setRoiRect(null);
    roiDragRef.current = null;

    if (!roiSopInstanceUid) return;

    let alive = true;
    const run = async () => {
      try {
        const db = await getDB();
        const inst = (await db.get('instances', roiSopInstanceUid)) as DicomInstance | undefined;
        if (!inst) {
          throw new Error('Missing DICOM instance for ROI preview');
        }

        const geom = getSliceGeometryFromInstance(inst);
        if (!alive) return;
        setRoiSliceGeom(geom);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!alive) return;
        setRoiSliceGeomError(msg);
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [roiSopInstanceUid, setRoiRect, setRoiSliceGeom, setRoiSliceGeomError]);

  useEffect(() => {
    if (!roiSopInstanceUid || !roiSliceGeom) return;
    setRoiPreviewSliceStable({ sopInstanceUid: roiSopInstanceUid, geom: roiSliceGeom });
  }, [roiSliceGeom, roiSopInstanceUid, setRoiPreviewSliceStable]);

  const roiSideMm = useMemo(() => {
    if (!roiWorld) return null;
    const dx = roiWorld.boundsMm.max[0] - roiWorld.boundsMm.min[0];
    const dy = roiWorld.boundsMm.max[1] - roiWorld.boundsMm.min[1];
    const dz = roiWorld.boundsMm.max[2] - roiWorld.boundsMm.min[2];
    return Math.max(dx, dy, dz);
  }, [roiWorld]);

  const currentReadiness = sourceReadiness?.identity === workspaceIdentity ? sourceReadiness : null;
  const selectedPlaneCount = currentReadiness?.independentOrientationCount ?? selectedGroup?.planeCount ?? 0;
  const plannedReconstruction = useMemo(
    () =>
      currentReadiness?.manifests.length
        ? planReconstruction(currentReadiness.manifests, params, roiWorld, acceptedResult?.volume)
        : null,
    [acceptedResult, currentReadiness, params, roiWorld],
  );
  const memoryPlan = plannedReconstruction?.memoryPlan ?? null;
  const sourceMemoryBytes = plannedReconstruction?.sourceBytes ?? 0;
  const effectiveVoxelSizeMm = plannedReconstruction?.effectiveVoxelSizeMm ?? params.targetVoxelSizeMm;
  const automaticallyAdjustedVoxelSpacing = Boolean(
    plannedReconstruction && plannedReconstruction.effectiveParams.targetVoxelSizeMm > params.targetVoxelSizeMm,
  );
  const exceedsMemoryBudget = Boolean(memoryPlan && memoryPlan.totalBytes > SVR_MEMORY_BUDGET_BYTES);

  const sourceReadinessMessage = !selectedGroup
    ? 'Select an examination and sequence to inspect its acquired source images.'
    : currentReadiness?.error
      ? currentReadiness.error
      : !currentReadiness
        ? 'Verifying acquired frames and physical source geometry…'
        : currentReadiness.independentOrientationCount < 2
          ? 'A second independent acquisition orientation is required for multiplane reconstruction.'
          : !selectedGroup.weight?.trim() && !selectedGroup.sequence?.trim()
            ? 'The selected acquisitions have no verified shared contrast or sequence and cannot be fused safely.'
            : exceedsMemoryBudget
              ? acceptedResult
                ? 'The selected quality exceeds the safe browser-memory budget. Clear the previous reconstruction or reduce the maximum volume size.'
                : 'The selected quality exceeds the safe browser-memory budget. Reduce the maximum volume size.'
              : null;

  const canRun =
    !isRunning &&
    Boolean(workspaceIdentity) &&
    Boolean(currentReadiness) &&
    !sourceReadinessMessage &&
    selectedSeries.length >= 2 &&
    selectedPlaneCount >= 2;
  const percent = progress ? Math.round((progress.current / Math.max(1, progress.total)) * 100) : 0;
  const progressMessage = progress ? progress.message : '';
  const sourceFrameCount =
    currentReadiness?.manifests.reduce((count, manifest) => count + manifest.frames.length, 0) ?? 0;
  const sourceMemoryMiB = sourceMemoryBytes / (1024 * 1024);
  const estimatedPeakMemoryMiB = memoryPlan ? memoryPlan.totalBytes / (1024 * 1024) : null;
  const displayedPatient = data.patients?.find((patient) => patient.key === data.selected_patient_key)?.patient_name;
  const displayedDate = dateIso ? (data.examinations?.[dateIso]?.date_iso ?? dateIso.split('#')[0] ?? dateIso) : null;

  const startReconstruction = useCallback(() => {
    if (!canRun || !workspaceIdentity) return;
    const paramsToRun: SvrParams = { ...(plannedReconstruction?.effectiveParams ?? params), roi: roiWorld ?? null };
    void run(selectedSeries, paramsToRun, workspaceIdentity).then((outcome) => {
      if (outcome.result) setGenerationCollapsed(true);
    });
  }, [canRun, params, plannedReconstruction, roiWorld, run, selectedSeries, workspaceIdentity]);

  const refineRegion = useCallback(
    (labels: SvrLabelVolume) => {
      if (!canRun || !workspaceIdentity || !acceptedResult || !currentReadiness) return;
      const volume = acceptedResult.volume;
      const requested = regionalRefinementParameters(
        acceptedResult.parameters ?? params,
        selectionFocusRoi(volume, labels, effectiveRoiSeriesUid ?? undefined),
      );
      const roi = requested.roi!;
      const planned = planReconstruction(currentReadiness.manifests, requested, roi, volume);
      setRoiWorld(roi);
      setRoiRect(null);
      setParams(requested);
      setGenerationCollapsed(false);
      void run(selectedSeries, { ...planned.effectiveParams, roi }, workspaceIdentity, { volume, labels }).then(
        (outcome) => {
          if (outcome.result) setGenerationCollapsed(true);
        },
      );
    },
    [
      acceptedResult,
      canRun,
      currentReadiness,
      effectiveRoiSeriesUid,
      params,
      run,
      selectedSeries,
      setRoiRect,
      setRoiWorld,
      workspaceIdentity,
    ],
  );

  return {
    acceptedResult,
    canRun,
    cancel,
    clear,
    currentReadiness,
    displayedDate,
    displayedPatient,
    effectiveVoxelSizeMm,
    effectiveRoiSeriesUid,
    effectiveRoiSliceIndex,
    error,
    estimatedPeakMemoryMiB,
    exceedsMemoryBudget,
    generationCollapsed,
    isRunning,
    params,
    percent,
    progress,
    progressMessage,
    roiDragRef,
    roiPreviewSliceStable,
    roiRect,
    roiSeries,
    roiSeriesSelectId,
    roiSeriesSopUids,
    roiSeriesSopUidsError,
    roiSideMm,
    roiSliceGeomError,
    roiWorld,
    selectedGroup,
    selectedPlaneCount,
    selectedSequenceKey,
    selectedSeries,
    sequenceGroupsForDate,
    setGenerationCollapsed,
    setParams,
    setRoiRect,
    setRoiSeriesUid,
    setRoiWorld,
    setSelectedSequenceKey,
    setShowAcquiredStack,
    showAcquiredStack,
    sourceFrameCount,
    sourceMemoryMiB,
    sourceReadinessMessage,
    startReconstruction,
    refineRegion,
    status,
    stepRoiSlice,
    automaticallyAdjustedVoxelSpacing,
    volumeIdentity,
    workspaceIdentity,
  };
}

type SvrReconstructionWorkspace = ReturnType<typeof useSvrReconstructionWorkspace>;

function SvrSourceEvidence({ workspace }: { workspace: SvrReconstructionWorkspace }) {
  const {
    acceptedResult,
    automaticallyAdjustedVoxelSpacing,
    currentReadiness,
    effectiveVoxelSizeMm,
    estimatedPeakMemoryMiB,
    exceedsMemoryBudget,
    isRunning,
    params,
    selectedSequenceKey,
    selectedSeries,
    sequenceGroupsForDate,
    setSelectedSequenceKey,
    sourceMemoryMiB,
  } = workspace;

  return (
    <>
      <div className="space-y-3">
        <div className="text-xs font-medium tracking-[0.08em] text-[var(--text-secondary)]">
          Acquired source sequences
        </div>
        <div className="max-h-[260px] overflow-auto">
          {sequenceGroupsForDate.length === 0 ? (
            <div className="py-2 text-xs text-[var(--text-tertiary)]">No series found for this date.</div>
          ) : (
            <div className="space-y-1">
              {sequenceGroupsForDate.map((g) => {
                const checked = selectedSequenceKey === g.key;

                const planeLabel = `${g.planeCount} plane${g.planeCount === 1 ? '' : 's'}`;
                const sliceLabel = `${g.sliceCount} slice${g.sliceCount === 1 ? '' : 's'}`;

                return (
                  <label
                    key={g.key}
                    className={`flex min-h-10 cursor-pointer items-center gap-2 border-l-2 py-2 pl-2 pr-1 text-xs transition-colors hover:bg-[var(--bg-tertiary)] ${
                      checked
                        ? 'border-l-[var(--signal-metal)] text-[var(--text-primary)]'
                        : 'border-l-transparent text-[var(--text-secondary)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="svr-sequence"
                      checked={checked}
                      disabled={isRunning}
                      onChange={() => setSelectedSequenceKey(g.key)}
                    />
                    <span className="flex-1 min-w-0 truncate">{g.label}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
                      {planeLabel} · {sliceLabel}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {currentReadiness?.manifests.length ? (
        <div className="border-t border-[var(--border-color)] pt-4">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--evidence)]">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--evidence)]" />
            Verified acquired evidence
          </div>
          <div className="mt-3 space-y-2.5 text-xs">
            {currentReadiness.manifests.map((manifest, index) => {
              const frame = manifest.frames[0]!;
              const geometry = getSliceGeometryFromInstance(frame);
              const series = selectedSeries[index];

              return (
                <div key={manifest.seriesUid} className="flex flex-col gap-1">
                  <span className="min-w-0 truncate text-[var(--text-primary)]">
                    {series?.plane ?? 'Acquired'} · {manifest.frames.length} slices
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)] [font-family:var(--font-mono)]">
                    {geometry.rowSpacingMm.toFixed(2)} × {geometry.colSpacingMm.toFixed(2)} mm
                  </span>
                </div>
              );
            })}
            <details className="svr-sampling-details border-t border-[var(--border-color)] pt-2 text-[var(--text-secondary)]">
              <summary>Resolution &amp; device memory</summary>
              <div className="mt-3">
                <div className="flex items-center justify-between gap-2">
                  <span>{acceptedResult ? 'Next source data' : 'Acquired source data'}</span>
                  <span className="tabular-nums">{sourceMemoryMiB.toFixed(1)} MiB</span>
                </div>
                {estimatedPeakMemoryMiB !== null ? (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span>{acceptedResult ? 'Next conservative peak' : 'Conservative peak'}</span>
                    <span
                      className={`tabular-nums ${exceedsMemoryBudget ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'}`}
                    >
                      {Math.ceil(estimatedPeakMemoryMiB)} MiB
                    </span>
                  </div>
                ) : null}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span>Requested voxel spacing</span>
                  <span className="tabular-nums">{params.targetVoxelSizeMm.toFixed(2)} mm</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span>{acceptedResult ? 'Next effective spacing' : 'Effective voxel spacing'}</span>
                  <span className="tabular-nums">{effectiveVoxelSizeMm.toFixed(2)} mm</span>
                </div>
                {automaticallyAdjustedVoxelSpacing ? (
                  <div className="mt-2 leading-relaxed text-[var(--text-tertiary)]">
                    Source sampling automatically adjusted to stay within the 512 MiB memory budget.
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SvrAdvancedSettings({ workspace }: { workspace: SvrReconstructionWorkspace }) {
  const { isRunning, params, setParams } = workspace;

  return (
    <details className="border-t border-[var(--border-color)] pt-3">
      <summary className="min-h-9 cursor-pointer select-none py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        Advanced SVR settings
      </summary>

      <div className="mt-2 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-[var(--text-secondary)]">
            Voxel size (mm)
            <input
              type="number"
              step={0.1}
              min={0.1}
              max={10}
              value={params.targetVoxelSizeMm}
              disabled={isRunning}
              onChange={(e) =>
                setParams((p) => ({
                  ...p,
                  targetVoxelSizeMm: clamp(Number(e.target.value) || 0.1, 0.1, 10),
                }))
              }
              className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Iterations
            <input
              type="number"
              step={1}
              min={0}
              max={10}
              value={params.iterations}
              disabled={isRunning}
              onChange={(e) => setParams((p) => ({ ...p, iterations: clampInt(Number(e.target.value) || 0, 0, 10) }))}
              className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Slice downsample max (px)
            <input
              type="number"
              step={16}
              min={32}
              max={512}
              value={params.sliceDownsampleMaxSize}
              disabled={isRunning}
              onChange={(e) =>
                setParams((p) => ({
                  ...p,
                  sliceDownsampleMaxSize: clampInt(Number(e.target.value) || 32, 32, 512),
                }))
              }
              className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Max volume dim (vox)
            <input
              type="number"
              step={16}
              min={64}
              max={384}
              value={params.maxVolumeDim}
              disabled={isRunning}
              onChange={(e) =>
                setParams((p) => ({ ...p, maxVolumeDim: clampInt(Number(e.target.value) || 64, 64, 384) }))
              }
              className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            />
          </label>
        </div>

        <div className="space-y-1 text-xs text-[var(--text-tertiary)] leading-snug">
          <div>
            <span className="text-[var(--text-secondary)]">Voxel size</span>: Target isotropic output spacing. Smaller =
            more detail but slower/heavier. The voxel size may be increased automatically to respect{' '}
            <span className="text-[var(--text-secondary)]">Max volume dim</span>.
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Iterations</span>: How many SVR refinement passes to run. 0 =
            quick “splat/average only”; higher can reduce slice-to-slice inconsistency but costs time.
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Slice downsample max</span>: Each input slice may be
            downsampled before reconstruction, but we won't downsample so far that in-plane spacing becomes worse than
            the target voxel size.
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Max volume dim</span>: Caps each output grid dimension (in
            voxels) by increasing voxel size if needed. Lower = faster/smaller; higher = more memory/time.
          </div>
          <div>
            Tip: draw a box on an input slice and run{' '}
            <span className="text-[var(--text-secondary)]">Run SVR (box)</span> to keep the volume smaller + faster.
          </div>
        </div>
      </div>
    </details>
  );
}

function SvrFocusBox({ workspace }: { workspace: SvrReconstructionWorkspace }) {
  const {
    effectiveRoiSeriesUid,
    effectiveRoiSliceIndex,
    isRunning,
    roiDragRef,
    roiPreviewSliceStable,
    roiRect,
    roiSeries,
    roiSeriesSelectId,
    roiSeriesSopUids,
    roiSeriesSopUidsError,
    roiSideMm,
    roiSliceGeomError,
    roiWorld,
    selectedSeries,
    setRoiRect,
    setRoiSeriesUid,
    setRoiWorld,
    stepRoiSlice,
  } = workspace;

  return (
    <details className="border-t border-[var(--border-color)] pt-3">
      <summary className="min-h-9 cursor-pointer select-none py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        Focus box (optional)
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          Draw a box around an area of interest to reconstruct a smaller volume. This is a crop, not a tumor
          segmentation.
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={roiSeriesSelectId} className="text-xs text-[var(--text-secondary)] w-16">
            Draw on
          </label>
          <select
            id={roiSeriesSelectId}
            value={effectiveRoiSeriesUid ?? ''}
            onChange={(e) => {
              const next = e.target.value || null;
              setRoiSeriesUid(next);
            }}
            disabled={isRunning || selectedSeries.length === 0}
            className="flex-1 px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)] disabled:opacity-50"
          >
            {selectedSeries.length === 0 ? <option value="">Select a sequence above</option> : null}
            {selectedSeries.map((s) => (
              <option key={s.seriesUid} value={s.seriesUid}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {roiSeriesSopUidsError ? (
          <div className="rounded-[4px] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--danger)]">
            {roiSeriesSopUidsError}
          </div>
        ) : roiSliceGeomError ? (
          <div className="rounded-[4px] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--danger)]">
            {roiSliceGeomError}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-[var(--text-tertiary)]">
            {roiSeriesSopUids && roiSeriesSopUids.length > 0
              ? `Slice ${effectiveRoiSliceIndex + 1} / ${roiSeriesSopUids.length}`
              : roiSeries
                ? 'Loading slices…'
                : 'Select a series to preview'}
          </div>

          <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
            <button
              type="button"
              aria-label="Previous acquired source slice"
              disabled={isRunning || !roiSeriesSopUids || roiSeriesSopUids.length === 0}
              onClick={() => stepRoiSlice(-1)}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              ◀
            </button>

            <button
              type="button"
              aria-label="Next acquired source slice"
              disabled={isRunning || !roiSeriesSopUids || roiSeriesSopUids.length === 0}
              onClick={() => stepRoiSlice(1)}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              ▶
            </button>
          </div>
        </div>

        <DicomRoiSlicePreview
          slice={roiPreviewSliceStable}
          sourceSeriesUid={effectiveRoiSeriesUid}
          maxSize={512}
          roiRect={roiRect}
          setRoiRect={setRoiRect}
          roiDragRef={roiDragRef}
          onSliceDelta={stepRoiSlice}
          onRoiFinalized={(roi) => {
            setRoiWorld(roi);
          }}
          disabled={isRunning}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isRunning || (!roiRect && !roiWorld)}
            onClick={() => {
              setRoiRect(null);
              roiDragRef.current = null;
              setRoiWorld(null);
            }}
            className="min-h-9 rounded-[4px] border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            Clear box
          </button>

          {roiWorld && roiSideMm ? (
            <div className="text-xs text-[var(--text-tertiary)]">
              Box: ~{roiSideMm.toFixed(1)}mm cube ({roiWorld.sourcePlane})
            </div>
          ) : null}
        </div>

        <div className="text-xs text-[var(--text-tertiary)]">
          Drag to draw a box on an input slice. When a box is set,{' '}
          <span className="text-[var(--text-secondary)]">Reconstruct focus box</span> will reconstruct only that box.
          Starting with a smaller box lets you decrease voxel size for more detail without making the volume huge.
        </div>
      </div>
    </details>
  );
}

function SvrReconstructButton({ workspace }: { workspace: SvrReconstructionWorkspace }) {
  return (
    <button
      type="button"
      disabled={!workspace.canRun}
      onClick={workspace.startReconstruction}
      aria-describedby={workspace.sourceReadinessMessage ? 'svr-source-readiness' : undefined}
      className="svr-reconstruct-button"
    >
      {workspace.roiWorld ? 'Reconstruct focus box' : 'Reconstruct volume'}
    </button>
  );
}

function SvrReconstructionActions({ workspace }: { workspace: SvrReconstructionWorkspace }) {
  const {
    acceptedResult,
    cancel,
    clear,
    currentReadiness,
    error,
    exceedsMemoryBudget,
    isRunning,
    percent,
    progress,
    progressMessage,
    roiDragRef,
    setRoiRect,
    setRoiSeriesUid,
    setRoiWorld,
    setSelectedSequenceKey,
    sourceReadinessMessage,
    status,
  } = workspace;

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--border-color)] pt-4">
        <button
          type="button"
          disabled={isRunning}
          onClick={() => {
            setSelectedSequenceKey(null);
            setRoiSeriesUid(null);
            setRoiRect(null);
            roiDragRef.current = null;
            setRoiWorld(null);
            clear();
          }}
          className="min-h-9 rounded-[4px] px-2 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Clear
        </button>

        <div className="flex items-center gap-2">
          {isRunning && acceptedResult ? (
            <button
              type="button"
              onClick={cancel}
              className="min-h-9 rounded-[4px] border border-[var(--border-color)] px-2 py-2 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </button>
          ) : null}

          {acceptedResult ? <SvrReconstructButton workspace={workspace} /> : null}
        </div>
      </div>

      {sourceReadinessMessage && !isRunning ? (
        <div
          id="svr-source-readiness"
          role={currentReadiness?.error ? 'alert' : 'status'}
          className={`border-l-2 px-3 py-2 text-xs leading-relaxed ${
            currentReadiness?.error || exceedsMemoryBudget
              ? 'border-l-[var(--warning)] bg-[var(--bg-tertiary)] text-[var(--warning)]'
              : 'border-l-[var(--border-color)] text-[var(--text-secondary)]'
          }`}
        >
          {sourceReadinessMessage}
        </div>
      ) : null}

      {isRunning && progress ? (
        <div
          role="progressbar"
          aria-label={progressMessage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="border-t border-[var(--border-color)] pt-3"
        >
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="truncate">{progressMessage}</span>
            <span className="ml-auto tabular-nums">{percent}%</span>
          </div>
          <div className="mt-2 h-px overflow-hidden bg-[var(--border-color)]">
            <div className="h-px bg-[var(--signal-metal)]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="border-l-2 border-l-[var(--danger)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--danger)]"
        >
          {error}
        </div>
      ) : null}

      {acceptedResult ? (
        <div className="border-t border-[var(--border-color)] pt-3 text-xs text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">Accepted reconstruction</div>
          <div className="mt-1 tabular-nums">
            {acceptedResult.volume.dims[0]} × {acceptedResult.volume.dims[1]} × {acceptedResult.volume.dims[2]} voxels ·{' '}
            {acceptedResult.volume.voxelSizeMm[0].toFixed(2)} mm
          </div>
          {acceptedResult.volume.observedSupport ? (
            <div className="mt-1 text-[var(--evidence)]">
              {typeof acceptedResult.volume.supportedVoxelCount === 'number'
                ? `${Math.round((acceptedResult.volume.supportedVoxelCount / Math.max(1, acceptedResult.volume.data.length)) * 100)}% acquired-voxel support`
                : 'Acquired-voxel support preserved'}
            </div>
          ) : null}
        </div>
      ) : status === 'canceled' ? (
        <div role="status" className="text-xs text-[var(--text-secondary)]">
          Reconstruction canceled. Verified source images remain available.
        </div>
      ) : null}
    </>
  );
}

export function Svr3DView(props: Svr3DViewProps) {
  const workspace = useSvrReconstructionWorkspace(props);
  const {
    acceptedResult,
    canRun,
    currentReadiness,
    displayedDate,
    displayedPatient,
    effectiveRoiSeriesUid,
    exceedsMemoryBudget,
    generationCollapsed,
    isRunning,
    params,
    percent,
    progress,
    progressMessage,
    roiDragRef,
    roiPreviewSliceStable,
    roiRect,
    selectedGroup,
    selectedPlaneCount,
    selectedSeries,
    setGenerationCollapsed,
    setRoiRect,
    setRoiWorld,
    setShowAcquiredStack,
    showAcquiredStack,
    sourceFrameCount,
    sourceReadinessMessage,
    stepRoiSlice,
    volumeIdentity,
    workspaceIdentity,
  }: SvrReconstructionWorkspace = workspace;

  const imaging = useMemo(
    () => ({
      volume: acceptedResult?.volume ?? null,
      initialSelection: acceptedResult?.initialSelection,
      busy: isRunning,
      refineRegion: workspace.refineRegion,
    }),
    [acceptedResult, isRunning, workspace.refineRegion],
  );

  return (
    <section
      aria-label="MRI reconstruction workspace"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)]"
    >
      <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-xs font-medium tracking-[0.12em] text-[var(--text-tertiary)]">
            RECONSTRUCTION
          </span>
          {displayedPatient ? (
            <span className="truncate text-xs text-[var(--text-primary)]">{formatPatientName(displayedPatient)}</span>
          ) : null}
        </div>
        {displayedDate ? (
          <span className="text-xs tabular-nums text-[var(--text-secondary)] [font-family:var(--font-mono)]">
            Examination {formatDate(displayedDate)}
          </span>
        ) : null}
        {selectedGroup ? <span className="text-xs text-[var(--text-secondary)]">{selectedGroup.label}</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs tabular-nums text-[var(--text-secondary)]">
          {currentReadiness?.manifests.length ? (
            <>
              <span>
                {currentReadiness.independentOrientationCount}{' '}
                {currentReadiness.independentOrientationCount === 1 ? 'orientation' : 'orientations'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{sourceFrameCount} acquired slices</span>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setGenerationCollapsed((value) => !value)}
          aria-label={
            generationCollapsed
              ? 'Show reconstruction sources and controls'
              : 'Hide reconstruction sources and controls'
          }
          aria-expanded={!generationCollapsed}
          className="inline-flex min-h-10 items-center gap-2 rounded-[4px] border border-[var(--border-color)] px-3 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          {generationCollapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          )}
          Sources
        </button>
      </header>
      <div
        data-generation-open={!generationCollapsed}
        className={`svr-generation-layout grid min-h-0 flex-1 overflow-hidden ${generationCollapsed ? 'grid-cols-1' : 'grid-cols-[minmax(240px,304px)_minmax(0,1fr)]'}`}
      >
        {generationCollapsed ? null : (
          <aside
            aria-label="Reconstruction sources and quality"
            className="space-y-5 overflow-auto border-r border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-5"
          >
            <SvrSourceEvidence workspace={workspace} />
            <SvrReconstructionActions workspace={workspace} />
            <SvrFocusBox workspace={workspace} />
            <SvrAdvancedSettings workspace={workspace} />
          </aside>
        )}

        <div className="relative min-h-0 overflow-hidden bg-[var(--bg-primary)]">
          {acceptedResult ? (
            <SvrImagingContext.Provider value={imaging}>
              <SvrVolume3DViewer
                key={workspaceIdentity ?? 'unselected-reconstruction'}
                volumeIdentity={volumeIdentity}
              />
            </SvrImagingContext.Provider>
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center bg-[var(--bg-primary)] px-6 py-10">
              <div className="w-full max-w-lg text-center">
                {isRunning ? (
                  <>
                    <div className="text-xs tracking-[0.14em] text-[var(--signal-metal)]">ACQUIRED EVIDENCE</div>
                    <h2 className="mt-4 text-2xl font-normal text-[var(--text-primary)] [font-family:var(--font-display)]">
                      Reconstructing supported anatomy
                    </h2>
                    <p aria-live="polite" className="mt-2 text-sm text-[var(--text-secondary)]">
                      {progressMessage || 'Validating acquired MRI source images…'}
                    </p>
                    <p className="mt-2 text-xs tabular-nums text-[var(--text-tertiary)]">
                      {progress ? `${percent}% · ` : ''}
                      {sourceFrameCount} acquired slices
                    </p>
                    <button
                      type="button"
                      onClick={workspace.cancel}
                      className="mt-6 min-h-11 rounded-[4px] border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      Cancel reconstruction
                    </button>
                  </>
                ) : (
                  <>
                    <div
                      className={`text-xs tracking-[0.14em] ${
                        currentReadiness?.error || exceedsMemoryBudget
                          ? 'text-[var(--warning)]'
                          : canRun
                            ? 'text-[var(--evidence)]'
                            : 'text-[var(--text-tertiary)]'
                      }`}
                    >
                      {currentReadiness?.error || exceedsMemoryBudget
                        ? 'SOURCE REVIEW REQUIRED'
                        : canRun
                          ? 'VERIFIED SOURCE EVIDENCE'
                          : 'ACQUIRED SOURCE EVIDENCE'}
                    </div>
                    <h2 className="mt-4 text-2xl font-normal text-[var(--text-primary)] [font-family:var(--font-display)]">
                      {currentReadiness?.error || exceedsMemoryBudget
                        ? 'This acquisition cannot be reconstructed safely'
                        : selectedSeries.length === 1
                          ? 'This examination has one acquired orientation'
                          : canRun
                            ? 'Ready to reconstruct supported anatomy'
                            : 'Verify acquired MRI source images'}
                    </h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
                      {sourceReadinessMessage ??
                        'Independent acquired orientations are ready for a physically supported reconstruction.'}
                    </p>
                    {currentReadiness?.manifests.length ? (
                      <p className="mt-3 text-xs tabular-nums text-[var(--text-tertiary)]">
                        {selectedPlaneCount} {selectedPlaneCount === 1 ? 'orientation' : 'orientations'} ·{' '}
                        {sourceFrameCount} acquired slices · {params.targetVoxelSizeMm.toFixed(2)} mm requested voxels
                      </p>
                    ) : null}
                    {selectedPlaneCount === 1 && roiPreviewSliceStable ? (
                      <button
                        type="button"
                        onClick={() => setShowAcquiredStack((current) => !current)}
                        className="mt-6 min-h-10 rounded-[4px] border border-[var(--border-color)] px-4 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--signal-metal)]"
                      >
                        {showAcquiredStack ? 'Hide acquired stack' : 'Inspect acquired stack'}
                      </button>
                    ) : null}
                    <div className="mt-6">
                      <SvrReconstructButton workspace={workspace} />
                    </div>
                    {canRun ? (
                      <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                        After reconstruction, use tumor segmentation to isolate the area of interest.
                      </p>
                    ) : null}
                    {showAcquiredStack && roiPreviewSliceStable ? (
                      <div className="mx-auto mt-5 max-w-sm text-left">
                        <DicomRoiSlicePreview
                          slice={roiPreviewSliceStable}
                          sourceSeriesUid={effectiveRoiSeriesUid}
                          maxSize={512}
                          roiRect={roiRect}
                          setRoiRect={setRoiRect}
                          roiDragRef={roiDragRef}
                          onSliceDelta={stepRoiSlice}
                          onRoiFinalized={setRoiWorld}
                        />
                        <p className="mt-2 text-center text-xs text-[var(--text-secondary)]">
                          Acquired slice only. Unsupported between-slice detail is not fabricated.
                        </p>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
