import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cornerstone from 'cornerstone-core';
import { ChevronLeft, ChevronRight, CircleAlert, Layers3, Loader2, ScanLine, ShieldCheck } from 'lucide-react';
import { getDB } from '../db/db';
import type { DicomInstance } from '../db/schema';
import type { ComparisonData } from '../types/api';
import type { SvrParams, SvrRoi, SvrRoiPlane, SvrSelectedSeries } from '../types/svr';
import { formatSequenceLabel } from '../utils/clinicalData';
import { formatDate } from '../utils/format';
import { decodeImageWithValidity, loadCornerstoneImage } from '../utils/decodedFrame';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { useSvrReconstruction } from '../hooks/useSvrReconstruction';
import { getSeriesFrameManifest, getSortedSopInstanceUidsForSeries } from '../utils/localApi';
import type { SeriesFrameManifest } from '../utils/localApi';
import type { SliceGeometry } from '../utils/svr/dicomGeometry';
import { getSliceGeometryFromInstance, sliceCornersMm } from '../utils/svr/dicomGeometry';
import { computeSvrDownsampleSize } from '../utils/svr/downsample';
import { filterSvrManifestFramesForRoi } from '../utils/svr/sliceRoiCrop';
import {
  estimateSvrPeakMemoryBytes,
  estimateSvrRegistrationBytes,
  SVR_MEMORY_BUDGET_BYTES,
} from '../utils/svr/svrMemoryPlan';
import { quantileSorted } from '../utils/svr/svrUtils';
import { SvrVolume3DViewer } from './SvrVolume3DViewer';
import { clamp01, clampInt } from '../utils/math';

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
        const point = [
          geom.ippMm.x +
            geom.colDir.x * row * geom.rowSpacingMm +
            geom.rowDir.x * col * geom.colSpacingMm +
            geom.normalDir.x * normalOffset,
          geom.ippMm.y +
            geom.colDir.y * row * geom.rowSpacingMm +
            geom.rowDir.y * col * geom.colSpacingMm +
            geom.normalDir.y * normalOffset,
          geom.ippMm.z +
            geom.colDir.z * row * geom.rowSpacingMm +
            geom.rowDir.z * col * geom.colSpacingMm +
            geom.normalDir.z * normalOffset,
        ] as const;

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
    <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
      <div className="relative w-full bg-black" style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Acquired MRI slice preview"
          className="absolute inset-0 w-full h-full"
        />

        {rect ? (
          <div
            className="absolute border border-[var(--accent)] bg-[var(--accent)]/10"
            style={{
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${(rect.right - rect.left) * 100}%`,
              height: `${(rect.bottom - rect.top) * 100}%`,
            }}
          />
        ) : null}

        {renderError ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 bg-black/60 p-3 text-center">
            {renderError}
          </div>
        ) : !slice ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/70 bg-black/40 p-3 text-center">
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

      <div className="px-2 py-1 text-xs text-white/70 bg-black/60 flex items-center justify-between">
        <span>Input slice</span>
        {roiRect ? <span className="text-xs text-[var(--accent)]">Box</span> : null}
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

function countIndependentOrientations(manifests: SeriesFrameManifest[]): number {
  const normals: SliceGeometry['normalDir'][] = [];

  for (const manifest of manifests) {
    const frame = manifest.frames[0];
    if (!frame) continue;

    const normal = getSliceGeometryFromInstance(frame).normalDir;
    const alreadyRepresented = normals.some(
      (existing) =>
        Math.abs(existing.x * normal.x + existing.y * normal.y + existing.z * normal.z) >= Math.cos(Math.PI / 18),
    );

    if (!alreadyRepresented) normals.push(normal);
  }

  return normals.length;
}

function estimateSourceMemoryBytes(manifests: SeriesFrameManifest[], params: SvrParams, roi: SvrRoi | null): number {
  let sourceBytes = 0;

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
    const admittedFrames = filterSvrManifestFramesForRoi(manifest, roi, params).frames.length;
    sourceBytes += sampled.dsRows * sampled.dsCols * admittedFrames * 5;
  }

  return sourceBytes;
}

/** Native Cornerstone-decoded source pixels coexist with the transferred SVR slice copies. */
function estimateDecodedSourceCacheBytes(
  manifests: SeriesFrameManifest[],
  params: SvrParams,
  roi: SvrRoi | null,
): number {
  let selectedNativeBytes = 0;

  for (const manifest of manifests) {
    for (const frame of filterSvrManifestFramesForRoi(manifest, roi, params).frames) {
      // Some source modalities promote signed values or modality-scaled pixels
      // to Float32. Count that worst-case resident representation explicitly.
      selectedNativeBytes += frame.rows * frame.columns * Float32Array.BYTES_PER_ELEMENT;
    }
  }

  try {
    const cache = cornerstone.imageCache?.getCacheInfo?.();
    const existingBytes = Math.max(0, Number(cache?.cacheSizeInBytes) || 0);
    const maximumBytes = Number(cache?.maximumSizeInBytes);
    const projectedBytes = existingBytes + selectedNativeBytes;
    return Number.isFinite(maximumBytes) && maximumBytes > 0 ? Math.min(maximumBytes, projectedBytes) : projectedBytes;
  } catch {
    // Missing cache telemetry never makes the selected native frames free.
    return selectedNativeBytes;
  }
}

/** Mirror the solver's physical output grid instead of budgeting a fictional max-dimension cube. */
function estimateReconstructionVoxelCount(
  manifests: SeriesFrameManifest[],
  params: SvrParams,
  roi: SvrRoi | null,
): number {
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
        const halfExtent = [
          Math.abs(geometry.colDir.x) * geometry.rowSpacingMm * 0.5 +
            Math.abs(geometry.rowDir.x) * geometry.colSpacingMm * 0.5 +
            Math.abs(geometry.normalDir.x) * halfThickness,
          Math.abs(geometry.colDir.y) * geometry.rowSpacingMm * 0.5 +
            Math.abs(geometry.rowDir.y) * geometry.colSpacingMm * 0.5 +
            Math.abs(geometry.normalDir.y) * halfThickness,
          Math.abs(geometry.colDir.z) * geometry.rowSpacingMm * 0.5 +
            Math.abs(geometry.rowDir.z) * geometry.colSpacingMm * 0.5 +
            Math.abs(geometry.normalDir.z) * halfThickness,
        ];

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
  if (minimum.some((value, axis) => !Number.isFinite(value) || !Number.isFinite(maximum[axis]!))) {
    return maximumDimension ** 3;
  }

  let voxelSize = Math.max(0.001, params.targetVoxelSizeMm);
  let dimensions = [2, 2, 2];
  for (let attempt = 0; attempt < 10; attempt++) {
    dimensions = minimum.map((value, axis) => Math.max(2, Math.ceil((maximum[axis]! - value) / voxelSize) + 1));
    const largestDimension = Math.max(...dimensions);
    if (largestDimension <= maximumDimension) break;
    voxelSize *= largestDimension / maximumDimension;
  }

  return dimensions.reduce((count, dimension) => count * dimension, 1);
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

export function Svr3DView({
  data,
  defaultDateIso,
  defaultSeqId,
  fallbackRoiSeriesUid,
  fallbackRoiSliceIndex,
}: Svr3DViewProps) {
  const dates = useMemo(() => sortedDatesDesc(data.dates), [data.dates]);
  const dateIso = defaultDateIso && dates.includes(defaultDateIso) ? defaultDateIso : dates[0] || null;

  const [params, setParams] = useState<SvrParams>(() => ({
    ...DEFAULT_SVR_PARAMS,
    sliceDownsampleMode: 'voxel-aware',
    seriesRegistrationMode: 'roi-rigid',
  }));
  const [generationCollapsed, setGenerationCollapsed] = useState(false);

  const [sliceInspectorPortalTarget, setSliceInspectorPortalTarget] = useState<Element | null>(null);
  const sliceInspectorPortalRef = useCallback((el: HTMLElement | null) => {
    setSliceInspectorPortalTarget(el);
  }, []);

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
    const matchingReference = Object.values(data.series_map)
      .map((byDate) => (dateIso ? byDate[dateIso] : undefined))
      .find((ref) => ref && seriesUids.includes(ref.series_uid));

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
  const [sourceReadiness, setSourceReadiness] = useState<SvrSourceReadiness | null>(null);
  const [showAcquiredStack, setShowAcquiredStack] = useState(false);

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

        const frameIdentities = new Set(
          manifests.map((manifest) => manifest.frameOfReferenceUid).filter((frame): frame is string => Boolean(frame)),
        );
        if (frameIdentities.size > 1) {
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
  const [roiSeriesUid, setRoiSeriesUid] = useState<string | null>(null);

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

  const [roiSeriesSopUids, setRoiSeriesSopUids] = useState<string[] | null>(null);
  const [roiSeriesSopUidsError, setRoiSeriesSopUidsError] = useState<string | null>(null);

  // Use -1 as a sentinel meaning "auto (middle slice)".
  const [roiSliceIndex, setRoiSliceIndex] = useState(-1);

  const [roiSliceGeom, setRoiSliceGeom] = useState<SliceGeometry | null>(null);
  const [roiSliceGeomError, setRoiSliceGeomError] = useState<string | null>(null);

  // Keep a stable preview slice so we don't clear the canvas between fast slice changes.
  const [roiPreviewSliceStable, setRoiPreviewSliceStable] = useState<{
    sopInstanceUid: string;
    geom: SliceGeometry;
  } | null>(null);

  const [roiRect, setRoiRect] = useState<RoiRect01 | null>(null);
  const roiDragRef = useRef<{ x0: number; y0: number } | null>(null);

  // Keep fallback slice inputs in refs so ROI-series effects don't retrigger on every slice tick.
  const fallbackRoiSeriesUidRef = useRef<string | null | undefined>(fallbackRoiSeriesUid);
  const fallbackRoiSliceIndexRef = useRef<number | null | undefined>(fallbackRoiSliceIndex);
  useEffect(() => {
    fallbackRoiSeriesUidRef.current = fallbackRoiSeriesUid;
    fallbackRoiSliceIndexRef.current = fallbackRoiSliceIndex;
  }, [fallbackRoiSeriesUid, fallbackRoiSliceIndex]);

  // Canonical ROI used for reconstruction (stays valid even if the user scrolls away from the selection slice).
  const [roiWorld, setRoiWorld] = useState<SvrRoi | null>(null);

  // Selection identity, not a date string, owns all patient-scoped SVR state.
  const previousWorkspaceIdentityRef = useRef<string | null>(workspaceIdentity);
  useEffect(() => {
    if (previousWorkspaceIdentityRef.current === workspaceIdentity) return;
    previousWorkspaceIdentityRef.current = workspaceIdentity;

    setRoiSeriesUid(null);
    setRoiRect(null);
    roiDragRef.current = null;
    setRoiWorld(null);
    setRoiPreviewSliceStable(null);
    setShowAcquiredStack(false);

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
  }, [effectiveRoiSeriesUid]);

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
  }, [roiSopInstanceUid]);

  useEffect(() => {
    if (!roiSopInstanceUid || !roiSliceGeom) return;
    setRoiPreviewSliceStable({ sopInstanceUid: roiSopInstanceUid, geom: roiSliceGeom });
  }, [roiSliceGeom, roiSopInstanceUid]);

  const roiSideMm = useMemo(() => {
    if (!roiWorld) return null;
    const dx = roiWorld.boundsMm.max[0] - roiWorld.boundsMm.min[0];
    const dy = roiWorld.boundsMm.max[1] - roiWorld.boundsMm.min[1];
    const dz = roiWorld.boundsMm.max[2] - roiWorld.boundsMm.min[2];
    return Math.max(dx, dy, dz);
  }, [roiWorld]);

  const currentReadiness = sourceReadiness?.identity === workspaceIdentity ? sourceReadiness : null;
  const selectedPlaneCount = currentReadiness?.independentOrientationCount ?? selectedGroup?.planeCount ?? 0;
  const sourceMemoryBytes = useMemo(
    () =>
      currentReadiness?.manifests.length ? estimateSourceMemoryBytes(currentReadiness.manifests, params, roiWorld) : 0,
    [currentReadiness, params, roiWorld],
  );
  const decodedSourceCacheBytes = useMemo(
    () =>
      currentReadiness?.manifests.length
        ? estimateDecodedSourceCacheBytes(currentReadiness.manifests, params, roiWorld)
        : 0,
    [currentReadiness, params, roiWorld],
  );
  const memoryPlan = useMemo(() => {
    if (!currentReadiness?.manifests.length) return null;

    const voxelCount = estimateReconstructionVoxelCount(currentReadiness.manifests, params, roiWorld);
    const retainedVolume = acceptedResult?.volume;
    const retainedVoxelCount = retainedVolume?.data.length ?? 0;
    // Recomputing deliberately preserves the prior Float32 result and its
    // support evidence while both independent 3D GPU textures stay visible.
    const retainedBytes = retainedVolume
      ? retainedVolume.data.byteLength +
        (retainedVolume.observedSupport?.byteLength ?? 0) +
        retainedVoxelCount * (Uint16Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT)
      : 0;

    return estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes: sourceMemoryBytes,
      iterations: params.iterations,
      retainedBytes: retainedBytes + decodedSourceCacheBytes,
      // Reserve independently owned CPU/GPU labels for both the incoming
      // result and any already-annotated retained reconstruction.
      labelBytes: (voxelCount + retainedVoxelCount) * Uint8Array.BYTES_PER_ELEMENT * 2,
      registrationBytes:
        roiWorld && params.seriesRegistrationMode === 'roi-rigid' ? estimateSvrRegistrationBytes(voxelCount) : 0,
    });
  }, [acceptedResult, currentReadiness, decodedSourceCacheBytes, params, roiWorld, sourceMemoryBytes]);
  const exceedsMemoryBudget = Boolean(memoryPlan && memoryPlan.totalBytes > SVR_MEMORY_BUDGET_BYTES);

  const sourceReadinessMessage = !selectedGroup
    ? 'Select an examination and sequence to inspect its acquired source images.'
    : currentReadiness?.error
      ? currentReadiness.error
      : !currentReadiness
        ? 'Verifying acquired frames and physical source geometry…'
        : currentReadiness.independentOrientationCount < 2
          ? 'A second independent acquisition orientation is required for multiplane reconstruction.'
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
    const paramsToRun: SvrParams = { ...params, roi: roiWorld ?? null };
    void run(selectedSeries, paramsToRun, workspaceIdentity);
  }, [canRun, params, roiWorld, run, selectedSeries, workspaceIdentity]);

  return (
    <section
      aria-label="MRI reconstruction workspace"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-secondary)]"
    >
      <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Layers3 aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <span className="truncate text-sm font-medium text-[var(--text-primary)]">MRI reconstruction</span>
          {displayedPatient ? (
            <span className="hidden truncate text-xs text-[var(--text-secondary)] sm:inline">{displayedPatient}</span>
          ) : null}
        </div>
        {displayedDate ? (
          <span className="rounded-full border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)]">
            Examination {formatDate(displayedDate)}
          </span>
        ) : null}
        {selectedGroup ? (
          <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-secondary)]">
            {selectedGroup.label}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
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
      </header>
      <div
        data-generation-open={!generationCollapsed}
        className={`svr-generation-layout grid min-h-0 flex-1 gap-3 overflow-hidden p-3 ${generationCollapsed ? 'grid-cols-1' : 'grid-cols-[minmax(280px,340px)_minmax(0,1fr)]'}`}
      >
        {generationCollapsed ? null : (
          <aside aria-label="Reconstruction sources and quality" className="space-y-3 overflow-auto pr-1">
            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 bg-[var(--bg-tertiary)] px-3 py-2.5 text-xs font-medium text-[var(--text-primary)]">
                <ScanLine aria-hidden="true" className="h-4 w-4 text-[var(--text-secondary)]" />
                Acquired source sequences
              </div>
              <div className="max-h-[260px] overflow-auto">
                {sequenceGroupsForDate.length === 0 ? (
                  <div className="p-3 text-xs text-[var(--text-tertiary)]">No series found for this date.</div>
                ) : (
                  <div className="divide-y divide-[var(--border-color)]">
                    {sequenceGroupsForDate.map((g) => {
                      const checked = selectedSequenceKey === g.key;

                      const planeLabel = `${g.planeCount} plane${g.planeCount === 1 ? '' : 's'}`;
                      const sliceLabel = `${g.sliceCount} slice${g.sliceCount === 1 ? '' : 's'}`;

                      return (
                        <label
                          key={g.key}
                          className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] cursor-pointer"
                        >
                          <input
                            type="radio"
                            name="svr-sequence"
                            checked={checked}
                            disabled={isRunning}
                            onChange={() => setSelectedSequenceKey(g.key)}
                          />
                          <span className="flex-1 min-w-0 truncate">{g.label}</span>
                          <span className="text-[var(--text-tertiary)] shrink-0">
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
              <div className="overflow-hidden rounded-lg border border-[var(--border-color)]">
                <div className="flex items-center gap-2 bg-[var(--bg-tertiary)] px-3 py-2.5 text-xs font-medium text-[var(--text-primary)]">
                  <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-400" />
                  Verified acquired evidence
                </div>
                <div className="space-y-2 px-3 py-2.5 text-xs">
                  {currentReadiness.manifests.map((manifest, index) => {
                    const frame = manifest.frames[0]!;
                    const geometry = getSliceGeometryFromInstance(frame);
                    const series = selectedSeries[index];

                    return (
                      <div key={manifest.seriesUid} className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[var(--text-primary)]">
                          {series?.plane ?? 'Acquired'} · {manifest.frames.length} slices
                        </span>
                        <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                          {geometry.rowSpacingMm.toFixed(2)} × {geometry.colSpacingMm.toFixed(2)} mm
                        </span>
                      </div>
                    );
                  })}
                  <div className="border-t border-[var(--border-color)] pt-2 text-[var(--text-secondary)]">
                    <div className="flex items-center justify-between gap-2">
                      <span>Acquired source data</span>
                      <span className="tabular-nums">{sourceMemoryMiB.toFixed(1)} MiB</span>
                    </div>
                    {estimatedPeakMemoryMiB !== null ? (
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span>Conservative peak</span>
                        <span
                          className={`tabular-nums ${exceedsMemoryBudget ? 'text-amber-300' : 'text-[var(--text-primary)]'}`}
                        >
                          {Math.ceil(estimatedPeakMemoryMiB)} MiB
                        </span>
                      </div>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span>Requested voxel spacing</span>
                      <span className="tabular-nums">{params.targetVoxelSizeMm.toFixed(2)} mm</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <details className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
              <summary className="cursor-pointer select-none text-xs text-[var(--text-secondary)]">
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
                      value={params.targetVoxelSizeMm}
                      disabled={isRunning}
                      onChange={(e) => setParams((p) => ({ ...p, targetVoxelSizeMm: Number(e.target.value) }))}
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
                      onChange={(e) => setParams((p) => ({ ...p, iterations: Number(e.target.value) }))}
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
                      onChange={(e) => setParams((p) => ({ ...p, sliceDownsampleMaxSize: Number(e.target.value) }))}
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
                      onChange={(e) => setParams((p) => ({ ...p, maxVolumeDim: Number(e.target.value) }))}
                      className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                    />
                  </label>
                </div>

                <div className="space-y-1 text-xs text-[var(--text-tertiary)] leading-snug">
                  <div>
                    <span className="text-[var(--text-secondary)]">Voxel size</span>: Target isotropic output spacing.
                    Smaller = more detail but slower/heavier. The voxel size may be increased automatically to respect{' '}
                    <span className="text-[var(--text-secondary)]">Max volume dim</span>.
                  </div>
                  <div>
                    <span className="text-[var(--text-secondary)]">Iterations</span>: How many SVR refinement passes to
                    run. 0 = quick “splat/average only”; higher can reduce slice-to-slice inconsistency but costs time.
                  </div>
                  <div>
                    <span className="text-[var(--text-secondary)]">Slice downsample max</span>: Each input slice may be
                    downsampled before reconstruction, but we won't downsample so far that in-plane spacing becomes
                    worse than the target voxel size.
                  </div>
                  <div>
                    <span className="text-[var(--text-secondary)]">Max volume dim</span>: Caps each output grid
                    dimension (in voxels) by increasing voxel size if needed. Lower = faster/smaller; higher = more
                    memory/time.
                  </div>
                  <div>
                    Tip: draw a box on an input slice and run{' '}
                    <span className="text-[var(--text-secondary)]">Run SVR (box)</span> to keep the volume smaller +
                    faster.
                  </div>
                </div>
              </div>
            </details>

            <details className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
              <summary className="cursor-pointer select-none text-xs text-[var(--text-secondary)]">
                Focus box (optional)
              </summary>
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-[var(--text-secondary)] w-16">Draw on</label>
                  <select
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
                  <div className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">{roiSeriesSopUidsError}</div>
                ) : roiSliceGeomError ? (
                  <div className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">{roiSliceGeomError}</div>
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
                      onClick={() => {
                        if (!roiSeriesSopUids || roiSeriesSopUids.length === 0) return;
                        const cur = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
                        setRoiSliceIndex(clampInt(cur - 1, 0, roiSeriesSopUids.length - 1));
                      }}
                      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    >
                      ◀
                    </button>

                    <button
                      type="button"
                      aria-label="Next acquired source slice"
                      disabled={isRunning || !roiSeriesSopUids || roiSeriesSopUids.length === 0}
                      onClick={() => {
                        if (!roiSeriesSopUids || roiSeriesSopUids.length === 0) return;
                        const cur = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
                        setRoiSliceIndex(clampInt(cur + 1, 0, roiSeriesSopUids.length - 1));
                      }}
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
                  onSliceDelta={(delta) => {
                    if (!roiSeriesSopUids || roiSeriesSopUids.length === 0) return;
                    const cur = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
                    setRoiSliceIndex(clampInt(cur + delta, 0, roiSeriesSopUids.length - 1));
                  }}
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
                    className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
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
                  <span className="text-[var(--text-secondary)]">Run SVR</span> will reconstruct only that box. Starting
                  with a smaller box lets you decrease voxel size for more detail without making the volume huge.
                </div>
              </div>
            </details>

            <div className="flex items-center justify-between gap-2">
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
                className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Clear
              </button>

              <div className="flex items-center gap-2">
                {isRunning ? (
                  <button
                    type="button"
                    onClick={cancel}
                    className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/20 text-white"
                  >
                    Cancel
                  </button>
                ) : null}

                <button
                  type="button"
                  disabled={!canRun}
                  onClick={startReconstruction}
                  aria-describedby={sourceReadinessMessage ? 'svr-source-readiness' : undefined}
                  className="min-h-9 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent)]/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {roiWorld ? 'Reconstruct focus box' : 'Reconstruct volume'}
                </button>
              </div>
            </div>

            {sourceReadinessMessage && !isRunning ? (
              <div
                id="svr-source-readiness"
                role={currentReadiness?.error ? 'alert' : 'status'}
                className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  currentReadiness?.error || exceedsMemoryBudget
                    ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
                    : 'border-[var(--border-color)] text-[var(--text-secondary)]'
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
                className="mt-2"
              >
                <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin" />
                  <span className="truncate">{progressMessage}</span>
                  <span className="ml-auto tabular-nums">{percent}%</span>
                </div>
                <div className="mt-1 h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
                  <div className="h-2 bg-[var(--accent)]" style={{ width: `${percent}%` }} />
                </div>
              </div>
            ) : null}

            {error ? (
              <div role="alert" className="mt-2 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            ) : null}

            {acceptedResult ? (
              <div className="rounded-lg border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                <div className="font-medium text-[var(--text-primary)]">Accepted reconstruction</div>
                <div className="mt-1 tabular-nums">
                  {acceptedResult.volume.dims[0]} × {acceptedResult.volume.dims[1]} × {acceptedResult.volume.dims[2]}{' '}
                  voxels · {acceptedResult.volume.voxelSizeMm[0].toFixed(2)} mm
                </div>
                {acceptedResult.volume.observedSupport ? (
                  <div className="mt-1 text-emerald-300">
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

            <div ref={sliceInspectorPortalRef} />
          </aside>
        )}

        <div className="relative min-h-0 overflow-hidden">
          <button
            type="button"
            onClick={() => setGenerationCollapsed((v) => !v)}
            aria-label={
              generationCollapsed
                ? 'Show reconstruction sources and controls'
                : 'Hide reconstruction sources and controls'
            }
            aria-expanded={!generationCollapsed}
            className="absolute left-2 top-2 z-30 inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white/80 hover:bg-black/80"
            title={generationCollapsed ? 'Show SVR controls' : 'Hide SVR controls'}
          >
            {generationCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>

          {acceptedResult ? (
            <SvrVolume3DViewer
              key={workspaceIdentity ?? 'unselected-reconstruction'}
              volume={acceptedResult.volume}
              volumeIdentity={volumeIdentity}
              sliceInspectorPortalTarget={generationCollapsed ? undefined : sliceInspectorPortalTarget}
            />
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-6 py-10">
              <div className="w-full max-w-lg text-center">
                {isRunning ? (
                  <>
                    <Loader2 aria-hidden="true" className="mx-auto h-8 w-8 animate-spin text-[var(--accent)]" />
                    <h2 className="mt-5 text-base font-medium text-[var(--text-primary)]">
                      Reconstructing supported anatomy
                    </h2>
                    <p aria-live="polite" className="mt-2 text-sm text-[var(--text-secondary)]">
                      {progressMessage || 'Validating acquired MRI source images…'}
                    </p>
                    <p className="mt-2 text-xs tabular-nums text-[var(--text-tertiary)]">
                      {percent}% · {sourceFrameCount} acquired slices
                    </p>
                  </>
                ) : (
                  <>
                    {currentReadiness?.error || exceedsMemoryBudget ? (
                      <CircleAlert aria-hidden="true" className="mx-auto h-8 w-8 text-amber-300" />
                    ) : (
                      <Layers3 aria-hidden="true" className="mx-auto h-8 w-8 text-[var(--accent)]" />
                    )}
                    <h2 className="mt-5 text-base font-medium text-[var(--text-primary)]">
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
                        className="mt-5 min-h-9 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-2 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                      >
                        {showAcquiredStack ? 'Hide acquired stack' : 'Inspect acquired stack'}
                      </button>
                    ) : canRun ? (
                      <button
                        type="button"
                        onClick={startReconstruction}
                        className="mt-5 min-h-9 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white hover:bg-[var(--accent)]/90"
                      >
                        Reconstruct volume
                      </button>
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
                          onSliceDelta={(delta) => {
                            if (!roiSeriesSopUids?.length) return;
                            setRoiSliceIndex(clampInt(effectiveRoiSliceIndex + delta, 0, roiSeriesSopUids.length - 1));
                          }}
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
