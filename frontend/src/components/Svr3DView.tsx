import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import cornerstone from 'cornerstone-core';
import { getDB } from '../db/db';
import type { DicomInstance } from '../db/schema';
import type { ComparisonData } from '../types/api';
import type { SvrParams, SvrRoi, SvrRoiPlane, SvrSelectedSeries } from '../types/svr';
import { formatSequenceLabel } from '../utils/clinicalData';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { useSvrReconstruction } from '../hooks/useSvrReconstruction';
import { getSortedSopInstanceUidsForSeries } from '../utils/localApi';
import type { SliceGeometry } from '../utils/svr/dicomGeometry';
import { getSliceGeometryFromInstance } from '../utils/svr/dicomGeometry';
import { resample2dAreaAverage } from '../utils/svr/resample2d';
import { SvrVolume3DViewer } from './SvrVolume3DViewer';

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

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normalizeRect01(rect: RoiRect01): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.min(rect.x0, rect.x1),
    right: Math.max(rect.x0, rect.x1),
    top: Math.min(rect.y0, rect.y1),
    bottom: Math.max(rect.y0, rect.y1),
  };
}

function clampInt(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  const xi = Math.round(x);
  return xi < min ? min : xi > max ? max : xi;
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

  // Pixel-space center.
  const rowCenter = (r.top + r.bottom) * 0.5 * rMax;
  const colCenter = (r.left + r.right) * 0.5 * cMax;

  // World center using the same mapping used by the reconstruction:
  // world(r,c) = IPP + colDir*(r*rowSpacing) + rowDir*(c*colSpacing)
  const cx =
    geom.ippMm.x + geom.colDir.x * (rowCenter * geom.rowSpacingMm) + geom.rowDir.x * (colCenter * geom.colSpacingMm);
  const cy =
    geom.ippMm.y + geom.colDir.y * (rowCenter * geom.rowSpacingMm) + geom.rowDir.y * (colCenter * geom.colSpacingMm);
  const cz =
    geom.ippMm.z + geom.colDir.z * (rowCenter * geom.rowSpacingMm) + geom.rowDir.z * (colCenter * geom.colSpacingMm);

  // In-plane box extents in mm.
  const widthMm = w01 * cMax * geom.colSpacingMm;
  const heightMm = h01 * rMax * geom.rowSpacingMm;

  // Expand to a cube (equal extents along X/Y/Z) for simplicity.
  const sideMm = Math.max(widthMm, heightMm);
  if (!(sideMm > 1e-6)) return null;

  const half = sideMm * 0.5;
  return {
    mode: 'cube',
    sourcePlane: inferRoiPlaneFromNormalDir(geom.normalDir),
    sourceSeriesUid,
    boundsMm: {
      min: [cx - half, cy - half, cz - half],
      max: [cx + half, cy + half, cz + half],
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
  pixelData: ArrayLike<number>;
  rows: number;
  cols: number;
  maxSize: number;
  slope?: number;
  intercept?: number;
}): void {
  const { canvas, pixelData, rows, cols, maxSize } = params;
  const slope = typeof params.slope === 'number' ? params.slope : 1;
  const intercept = typeof params.intercept === 'number' ? params.intercept : 0;

  const { dsRows, dsCols } = computeDownsampleSize(rows, cols, maxSize);

  // Higher-fidelity downsampling (box/area average) to reduce aliasing in the ROI preview.
  const down = resample2dAreaAverage(pixelData, rows, cols, dsRows, dsCols);

  // Apply modality scaling when available. (Linear, so applying post-downsample is equivalent.)
  if (slope !== 1 || intercept !== 0) {
    for (let i = 0; i < down.length; i++) {
      down[i] = down[i] * slope + intercept;
    }
  }

  if (canvas.width !== dsCols) canvas.width = dsCols;
  if (canvas.height !== dsRows) canvas.height = dsRows;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Robust windowing (percentiles) is less sensitive to background/outliers than raw min/max.
  const finite: number[] = [];
  for (let i = 0; i < down.length; i++) {
    const v = down[i];
    if (Number.isFinite(v)) finite.push(v);
  }

  finite.sort((a, b) => a - b);

  const quantileSorted = (sorted: number[], q: number): number => {
    const n = sorted.length;
    if (n === 0) return 0;
    const qq = q < 0 ? 0 : q > 1 ? 1 : q;
    const idx = qq * (n - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(n - 1, i0 + 1);
    const t = idx - i0;
    const a = sorted[i0] ?? 0;
    const b = sorted[i1] ?? a;
    return a + (b - a) * t;
  };

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
    const n = Number.isFinite(v) && invRange > 0 ? (v - lo) * invRange : 0;
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
  const { slice, sourceSeriesUid, maxSize, roiRect, setRoiRect, roiDragRef, onSliceDelta, onRoiFinalized, disabled } = props;

  const rect = roiRect ? normalizeRect01(roiRect) : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setRenderError(null);

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
        const image = await cornerstone.loadImage(imageId);

        const getPixelData = (image as unknown as { getPixelData?: () => ArrayLike<number> }).getPixelData;
        if (typeof getPixelData !== 'function') {
          throw new Error('Cornerstone image did not expose getPixelData()');
        }

        const pixelData = getPixelData.call(image);

        if (!alive) return;

        const slope = typeof (image as unknown as { slope?: unknown }).slope === 'number' ? (image as unknown as { slope: number }).slope : 1;
        const intercept =
          typeof (image as unknown as { intercept?: unknown }).intercept === 'number' ? (image as unknown as { intercept: number }).intercept : 0;

        drawDicomPixelDataToCanvas({
          canvas,
          pixelData,
          rows: slice.geom.rows,
          cols: slice.geom.cols,
          maxSize,
          slope,
          intercept,
        });
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

  const aspect = slice ? { w: slice.geom.cols, h: slice.geom.rows } : { w: 1, h: 1 };

  return (
    <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
      <div className="relative w-full bg-black" style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

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
          className={`absolute inset-0 ${disabled ? 'cursor-not-allowed' : slice ? 'cursor-crosshair' : 'cursor-default'}`}
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

      <div className="px-2 py-1 text-[10px] text-white/70 bg-black/60 flex items-center justify-between">
        <span>Input slice</span>
        {roiRect ? <span className="text-[9px] text-[var(--accent)]">Box</span> : null}
      </div>
    </div>
  );
}

const lastRoiPreviewSliceIndexBySeriesUid = new Map<string, number>();

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

export function Svr3DView({ data, defaultDateIso, defaultSeqId, fallbackRoiSeriesUid, fallbackRoiSliceIndex }: Svr3DViewProps) {
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

  const { isRunning, progress, result, error, run, cancel, clear } = useSvrReconstruction();

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

      const seqLabel = formatSequenceLabel(seq);
      if (seqLabel === 'Unknown') continue;

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

    if (formatSequenceLabel(currentSeq) === 'Unknown') return fallback;

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
  const [roiPreviewSliceStable, setRoiPreviewSliceStable] = useState<{ sopInstanceUid: string; geom: SliceGeometry } | null>(
    null,
  );

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

  // Date is controlled by the surrounding UI (Dates sidebar). When it changes, clear local selection/ROI/run results.
  const prevDateIsoRef = useRef<string | null>(dateIso);
  useEffect(() => {
    if (prevDateIsoRef.current === dateIso) return;
    prevDateIsoRef.current = dateIso;

    setRoiSeriesUid(null);
    setRoiRect(null);
    roiDragRef.current = null;
    setRoiWorld(null);
    setRoiPreviewSliceStable(null);

    clear();
  }, [clear, dateIso]);

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

  const selectedPlaneCount = selectedGroup?.planeCount ?? 0;
  const canRun = !isRunning && selectedSeries.length >= 2 && selectedPlaneCount >= 2;
  const percent = progress ? Math.round((progress.current / Math.max(1, progress.total)) * 100) : 0;

  const progressMessage = progress ? progress.message : '';

  return (
    <div className="flex-1 flex overflow-hidden bg-[var(--bg-secondary)]">
      <div
        className={`flex-1 grid gap-4 p-4 overflow-hidden ${generationCollapsed ? 'grid-cols-1' : 'grid-cols-[minmax(320px,420px)_minmax(0,1fr)]'}`}
      >
        {generationCollapsed ? null : (
          <div className="space-y-3 overflow-auto pr-1">
            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
            <div className="px-3 py-2 text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              Sequence on this date (uses all planes)
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

              <div className="space-y-1 text-[10px] text-[var(--text-tertiary)] leading-snug">
                <div>
                  <span className="text-[var(--text-secondary)]">Voxel size</span>: Target isotropic output spacing. Smaller = more detail but slower/heavier. The voxel size may be
                  increased automatically to respect <span className="text-[var(--text-secondary)]">Max volume dim</span>.
                </div>
                <div>
                  <span className="text-[var(--text-secondary)]">Iterations</span>: How many SVR refinement passes to run. 0 = quick “splat/average only”; higher can reduce
                  slice-to-slice inconsistency but costs time.
                </div>
                <div>
                  <span className="text-[var(--text-secondary)]">Slice downsample max</span>: Each input slice may be downsampled before reconstruction, but we won't downsample so far
                  that in-plane spacing becomes worse than the target voxel size.
                </div>
                <div>
                  <span className="text-[var(--text-secondary)]">Max volume dim</span>: Caps each output grid dimension (in voxels) by increasing voxel size if needed. Lower =
                  faster/smaller; higher = more memory/time.
                </div>
                <div>
                  Tip: draw a box on an input slice and run <span className="text-[var(--text-secondary)]">Run SVR (box)</span> to keep the volume smaller + faster.
                </div>
              </div>
            </div>
          </details>

          <details className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
            <summary className="cursor-pointer select-none text-xs text-[var(--text-secondary)]">Focus box (optional)</summary>
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
                <div className="text-[10px] text-[var(--text-tertiary)]">
                  {roiSeriesSopUids && roiSeriesSopUids.length > 0
                    ? `Slice ${effectiveRoiSliceIndex + 1} / ${roiSeriesSopUids.length}`
                    : roiSeries
                      ? 'Loading slices…'
                      : 'Select a series to preview'}
                </div>

                <div className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
                  <button
                    type="button"
                    disabled={isRunning || !roiSeriesSopUids || roiSeriesSopUids.length === 0}
                    onClick={() => {
                      if (!roiSeriesSopUids || roiSeriesSopUids.length === 0) return;
                      const cur = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
                      setRoiSliceIndex(clampInt(cur - 1, 0, roiSeriesSopUids.length - 1));
                    }}
                    className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    ◀
                  </button>

                  <button
                    type="button"
                    disabled={isRunning || !roiSeriesSopUids || roiSeriesSopUids.length === 0}
                    onClick={() => {
                      if (!roiSeriesSopUids || roiSeriesSopUids.length === 0) return;
                      const cur = roiSliceIndex >= 0 ? roiSliceIndex : effectiveRoiSliceIndex;
                      setRoiSliceIndex(clampInt(cur + 1, 0, roiSeriesSopUids.length - 1));
                    }}
                    className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
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
                  if (!roi) return;

                  setParams((p) => {
                    const clamp = (x: number, min: number, max: number) => (x < min ? min : x > max ? max : x);

                    const inPlaneMm = roiSliceGeom ? Math.min(roiSliceGeom.rowSpacingMm, roiSliceGeom.colSpacingMm) : p.targetVoxelSizeMm;
                    const nextVoxel = clamp(inPlaneMm, 0.25, 1.0);

                    return {
                      ...p,
                      // Favor voxel size at (or slightly above) the best in-plane spacing.
                      targetVoxelSizeMm: nextVoxel,
                      // Ensure we don't downsample to a coarser spacing than the output voxels.
                      sliceDownsampleMode: 'voxel-aware',
                      // Allow near-native resolution (especially once ROI cropping is in place).
                      sliceDownsampleMaxSize: Math.max(p.sliceDownsampleMaxSize, 512),
                      // Allow higher-res grids for ROI work.
                      maxVolumeDim: Math.max(p.maxVolumeDim, 320),
                      // More refinement iterations for detail.
                      iterations: Math.max(p.iterations, 6),
                      stepSize: 0.5,
                      // Always use ROI rigid alignment.
                      seriesRegistrationMode: 'roi-rigid',
                    };
                  });
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
                  <div className="text-[10px] text-[var(--text-tertiary)]">
                    Box: ~{roiSideMm.toFixed(1)}mm cube ({roiWorld.sourcePlane})
                  </div>
                ) : null}
              </div>

              <div className="text-[10px] text-[var(--text-tertiary)]">
                Drag to draw a box on an input slice. When a box is set, <span className="text-[var(--text-secondary)]">Run SVR</span> will reconstruct only that box. Starting
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
                onClick={() => {
                  const paramsToRun: SvrParams = roiWorld
                    ? { ...params, roi: roiWorld, seriesRegistrationMode: 'roi-rigid', sliceDownsampleMode: 'voxel-aware' }
                    : { ...params, seriesRegistrationMode: 'roi-rigid', sliceDownsampleMode: 'voxel-aware' };
                  void run(selectedSeries, paramsToRun);
                }}
                className="px-4 py-2 text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {roiWorld ? 'Run SVR (box)' : 'Run SVR'}
              </button>
            </div>
          </div>

          {progress && (
            <div className="mt-2">
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="truncate">{progressMessage}</span>
                <span className="ml-auto tabular-nums">{percent}%</span>
              </div>
              <div className="mt-1 h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
                <div className="h-2 bg-[var(--accent)]" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {!result ? (
            <div className="text-xs text-[var(--text-tertiary)]">Run SVR to generate a 3D volume (uses a focus box when set).</div>
          ) : (
            <div className="text-xs text-[var(--text-secondary)]">
              Volume: {result.volume.dims[0]}×{result.volume.dims[1]}×{result.volume.dims[2]} @ {result.volume.voxelSizeMm[0]}mm
            </div>
          )}

          <div ref={sliceInspectorPortalRef} />
        </div>
        )}

        <div className="overflow-hidden relative">
          <button
            type="button"
            onClick={() => setGenerationCollapsed((v) => !v)}
            className="absolute left-2 top-2 z-30 p-1 rounded-full bg-black/50 border border-white/10 text-white/80 hover:bg-black/70"
            title={generationCollapsed ? 'Show SVR controls' : 'Hide SVR controls'}
          >
            {generationCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>

          <SvrVolume3DViewer volume={result ? result.volume : null} sliceInspectorPortalTarget={sliceInspectorPortalTarget} />
        </div>
      </div>
    </div>
  );
}
