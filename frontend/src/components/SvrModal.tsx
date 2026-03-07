import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Layers3, Loader2, Download } from 'lucide-react';
import type { ComparisonData } from '../types/api';
import type { SvrParams, SvrRoi, SvrRoiPlane, SvrSelectedSeries } from '../types/svr';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { useSvrReconstruction } from '../hooks/useSvrReconstruction';
import { SvrVolume3DModal } from './SvrVolume3DModal';

export type SvrModalProps = {
  data: ComparisonData;
  defaultDateIso?: string | null;
  defaultSeqId?: string | null;
  onClose: () => void;
};

function sortedDatesDesc(dates: string[]): string[] {
  return [...dates].sort((a, b) => b.localeCompare(a));
}

function formatSeqLabel(seq: { plane: string | null; weight: string | null; sequence: string | null }): string {
  return [seq.plane, seq.weight, seq.sequence].filter(Boolean).join(' ') || 'Unknown';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Best-effort cleanup.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  // TS's DOM lib types require BlobParts to be backed by ArrayBuffer (not SharedArrayBuffer).
  // Copying also ensures the bytes match the view's byteOffset/byteLength.
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

type RoiRect01 = {
  plane: SvrRoiPlane;
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

function fitIntervalToBounds(params: { min: number; max: number; boundMin: number; boundMax: number }): { min: number; max: number } {
  let { min, max } = params;
  const { boundMin, boundMax } = params;

  const len = max - min;
  const boundLen = boundMax - boundMin;
  if (!(len > 0) || !(boundLen > 0)) {
    return { min: boundMin, max: boundMax };
  }

  // If the interval is larger than bounds, clamp (shrinks).
  if (len >= boundLen) {
    return { min: boundMin, max: boundMax };
  }

  // Otherwise, shift the interval so it fits without shrinking.
  if (min < boundMin) {
    max += boundMin - min;
    min = boundMin;
  }
  if (max > boundMax) {
    min -= max - boundMax;
    max = boundMax;
  }

  // Final safety clamp.
  if (min < boundMin) min = boundMin;
  if (max > boundMax) max = boundMax;

  return { min, max };
}

function computeCubeRoiFromRect01(rect: RoiRect01, volume: { dims: [number, number, number]; voxelSizeMm: [number, number, number]; originMm: [number, number, number] }): SvrRoi | null {
  const { dims, voxelSizeMm, originMm } = volume;
  const [nx, ny, nz] = dims;

  // SVR output is isotropic today.
  const vox = voxelSizeMm[0];
  if (!Number.isFinite(vox) || vox <= 0) return null;

  const [ox, oy, oz] = originMm;

  const fullX = { min: ox, max: ox + (nx - 1) * vox };
  const fullY = { min: oy, max: oy + (ny - 1) * vox };
  const fullZ = { min: oz, max: oz + (nz - 1) * vox };

  const r = normalizeRect01(rect);
  const w01 = r.right - r.left;
  const h01 = r.bottom - r.top;
  if (w01 <= 1e-4 || h01 <= 1e-4) return null;

  const midX = ox + Math.floor(nx / 2) * vox;
  const midY = oy + Math.floor(ny / 2) * vox;
  const midZ = oz + Math.floor(nz / 2) * vox;

  // Map the 2D rect to two world axes (A,B); then expand to a cube by making A/B square
  // and adding equal extent along the through-plane axis (C).
  let a0 = 0;
  let a1 = 0;
  let b0 = 0;
  let b1 = 0;

  // Centers for the through-plane axis.
  let cx = midX;
  let cy = midY;
  let cz = midZ;

  if (rect.plane === 'axial') {
    a0 = ox + r.left * (nx - 1) * vox;
    a1 = ox + r.right * (nx - 1) * vox;
    b0 = oy + r.top * (ny - 1) * vox;
    b1 = oy + r.bottom * (ny - 1) * vox;
    // through-plane is Z
    cz = midZ;
  } else if (rect.plane === 'coronal') {
    a0 = ox + r.left * (nx - 1) * vox;
    a1 = ox + r.right * (nx - 1) * vox;
    b0 = oz + r.top * (nz - 1) * vox;
    b1 = oz + r.bottom * (nz - 1) * vox;
    // through-plane is Y
    cy = midY;
  } else {
    // sagittal
    a0 = oy + r.left * (ny - 1) * vox;
    a1 = oy + r.right * (ny - 1) * vox;
    b0 = oz + r.top * (nz - 1) * vox;
    b1 = oz + r.bottom * (nz - 1) * vox;
    // through-plane is X
    cx = midX;
  }

  const aCenter = (a0 + a1) * 0.5;
  const bCenter = (b0 + b1) * 0.5;
  const sideMm = Math.max(Math.abs(a1 - a0), Math.abs(b1 - b0));
  if (!(sideMm > 1e-6)) return null;

  // Start with a cube centered on the drawn box (in-plane) and the mid-slice (through-plane).
  // Then shift it as needed to keep it inside the current volume bounds.
  let xMin = 0;
  let xMax = 0;
  let yMin = 0;
  let yMax = 0;
  let zMin = 0;
  let zMax = 0;

  const half = sideMm * 0.5;

  if (rect.plane === 'axial') {
    const xi = fitIntervalToBounds({ min: aCenter - half, max: aCenter + half, boundMin: fullX.min, boundMax: fullX.max });
    const yi = fitIntervalToBounds({ min: bCenter - half, max: bCenter + half, boundMin: fullY.min, boundMax: fullY.max });
    const zi = fitIntervalToBounds({ min: cz - half, max: cz + half, boundMin: fullZ.min, boundMax: fullZ.max });
    xMin = xi.min;
    xMax = xi.max;
    yMin = yi.min;
    yMax = yi.max;
    zMin = zi.min;
    zMax = zi.max;
  } else if (rect.plane === 'coronal') {
    const xi = fitIntervalToBounds({ min: aCenter - half, max: aCenter + half, boundMin: fullX.min, boundMax: fullX.max });
    const zi = fitIntervalToBounds({ min: bCenter - half, max: bCenter + half, boundMin: fullZ.min, boundMax: fullZ.max });
    const yi = fitIntervalToBounds({ min: cy - half, max: cy + half, boundMin: fullY.min, boundMax: fullY.max });
    xMin = xi.min;
    xMax = xi.max;
    yMin = yi.min;
    yMax = yi.max;
    zMin = zi.min;
    zMax = zi.max;
  } else {
    const yi = fitIntervalToBounds({ min: aCenter - half, max: aCenter + half, boundMin: fullY.min, boundMax: fullY.max });
    const zi = fitIntervalToBounds({ min: bCenter - half, max: bCenter + half, boundMin: fullZ.min, boundMax: fullZ.max });
    const xi = fitIntervalToBounds({ min: cx - half, max: cx + half, boundMin: fullX.min, boundMax: fullX.max });
    xMin = xi.min;
    xMax = xi.max;
    yMin = yi.min;
    yMax = yi.max;
    zMin = zi.min;
    zMax = zi.max;
  }

  return {
    mode: 'cube',
    sourcePlane: rect.plane,
    boundsMm: {
      min: [xMin, yMin, zMin],
      max: [xMax, yMax, zMax],
    },
  };
}

function RoiSelectablePreview(props: {
  plane: SvrRoiPlane;
  label: string;
  url: string | undefined;
  aspectW: number;
  aspectH: number;
  roiRect: RoiRect01 | null;
  setRoiRect: (next: RoiRect01 | null) => void;
  roiDragRef: { current: { plane: SvrRoiPlane; x0: number; y0: number } | null };
  disabled?: boolean;
}) {
  const { plane, label, url, aspectW, aspectH, roiRect, setRoiRect, roiDragRef, disabled } = props;

  const rect = roiRect?.plane === plane ? normalizeRect01(roiRect) : null;

  return (
    <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
      <div className="relative w-full bg-black" style={{ aspectRatio: `${aspectW} / ${aspectH}` }}>
        {url ? <img src={url} alt={label} className="absolute inset-0 w-full h-full object-contain" draggable={false} /> : null}

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

        {url ? (
          <div
            className={`absolute inset-0 ${disabled ? 'cursor-not-allowed' : 'cursor-crosshair'}`}
            onPointerDown={(e) => {
              if (disabled) return;
              const box = e.currentTarget.getBoundingClientRect();
              const x = clamp01((e.clientX - box.left) / box.width);
              const y = clamp01((e.clientY - box.top) / box.height);

              roiDragRef.current = { plane, x0: x, y0: y };
              setRoiRect({ plane, x0: x, y0: y, x1: x, y1: y });

              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerMove={(e) => {
              const drag = roiDragRef.current;
              if (disabled || !drag || drag.plane !== plane) return;

              const box = e.currentTarget.getBoundingClientRect();
              const x = clamp01((e.clientX - box.left) / box.width);
              const y = clamp01((e.clientY - box.top) / box.height);

              setRoiRect({ plane, x0: drag.x0, y0: drag.y0, x1: x, y1: y });
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              const drag = roiDragRef.current;
              if (drag?.plane === plane) {
                roiDragRef.current = null;
              }
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerCancel={(e) => {
              const drag = roiDragRef.current;
              if (drag?.plane === plane) {
                roiDragRef.current = null;
              }
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        ) : null}
      </div>

      <div className="px-2 py-1 text-[10px] text-white/70 bg-black/60 flex items-center justify-between">
        <span>{label}</span>
        {roiRect?.plane === plane ? <span className="text-[9px] text-[var(--accent)]">ROI</span> : null}
      </div>
    </div>
  );
}

export function SvrModal({ data, defaultDateIso, defaultSeqId, onClose }: SvrModalProps) {
  const dates = useMemo(() => sortedDatesDesc(data.dates), [data.dates]);
  const initialDate = defaultDateIso && dates.includes(defaultDateIso) ? defaultDateIso : dates[0] || null;

  const [dateIso, setDateIso] = useState<string | null>(initialDate);
  const [params, setParams] = useState<SvrParams>(DEFAULT_SVR_PARAMS);

  const { isRunning, progress, result, error, run, cancel, clear } = useSvrReconstruction();

  const [viewer3dOpen, setViewer3dOpen] = useState(false);

  const [roiRect, setRoiRect] = useState<RoiRect01 | null>(null);
  const roiDragRef = useRef<{ plane: SvrRoiPlane; x0: number; y0: number } | null>(null);

  const [lastRunMeta, setLastRunMeta] = useState<{ params: SvrParams; selectedSeries: SvrSelectedSeries[] } | null>(null);

  const roi = useMemo(() => {
    if (!roiRect || !result) return null;
    return computeCubeRoiFromRect01(roiRect, result.volume);
  }, [roiRect, result]);

  const roiSideMm = useMemo(() => {
    if (!roi) return null;
    const dx = roi.boundsMm.max[0] - roi.boundsMm.min[0];
    const dy = roi.boundsMm.max[1] - roi.boundsMm.min[1];
    const dz = roi.boundsMm.max[2] - roi.boundsMm.min[2];
    return Math.max(dx, dy, dz);
  }, [roi]);

  const optionsForDate: SvrSelectedSeries[] = useMemo(() => {
    if (!dateIso) return [];

    const out: SvrSelectedSeries[] = [];

    for (const seq of data.sequences) {
      const ref = data.series_map[seq.id]?.[dateIso];
      if (!ref) continue;

      out.push({
        seriesUid: ref.series_uid,
        studyId: ref.study_id,
        dateIso,
        instanceCount: ref.instance_count,
        label: formatSeqLabel(seq),
        plane: seq.plane,
        weight: seq.weight,
        sequence: seq.sequence,
      });
    }

    // Keep stable ordering: plane, then label.
    out.sort((a, b) => {
      const pa = a.plane || '';
      const pb = b.plane || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return a.label.localeCompare(b.label);
    });

    return out;
  }, [data.sequences, data.series_map, dateIso]);

  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());

  // Preselect: when opening, select all planes matching the current weight/sequence (not plane).
  const didInitSelectionRef = useRef(false);
  useEffect(() => {
    if (didInitSelectionRef.current) return;

    // Mark as initialized even if we don't end up selecting anything,
    // so we don't keep re-running this effect.
    didInitSelectionRef.current = true;

    if (!dateIso || !defaultSeqId) return;

    const currentSeq = data.sequences.find((s) => s.id === defaultSeqId);
    if (!currentSeq) return;

    const next = new Set<string>();
    for (const opt of optionsForDate) {
      if (opt.weight === currentSeq.weight && opt.sequence === currentSeq.sequence) {
        next.add(opt.seriesUid);
      }
    }

    if (next.size > 0) {
      setSelectedUids(next);
    }
  }, [data.sequences, dateIso, defaultSeqId, optionsForDate]);

  // Object URLs for previews
  const [previewUrls, setPreviewUrls] = useState<{ axial?: string; coronal?: string; sagittal?: string }>({});
  useEffect(() => {
    // Cleanup previous URLs.
    for (const url of Object.values(previewUrls)) {
      if (url) URL.revokeObjectURL(url);
    }

    if (!result) {
      setPreviewUrls({});
      return;
    }

    const next = {
      axial: URL.createObjectURL(result.previews.axial),
      coronal: URL.createObjectURL(result.previews.coronal),
      sagittal: URL.createObjectURL(result.previews.sagittal),
    };

    setPreviewUrls(next);

    return () => {
      for (const url of Object.values(next)) {
        if (url) URL.revokeObjectURL(url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const selectedSeries = useMemo(() => {
    const m = new Map(optionsForDate.map((o) => [o.seriesUid, o] as const));
    return Array.from(selectedUids)
      .map((uid) => m.get(uid))
      .filter((x): x is SvrSelectedSeries => !!x);
  }, [optionsForDate, selectedUids]);

  const canRun = !isRunning && selectedSeries.length >= 2;

  const percent = progress ? Math.round((progress.current / Math.max(1, progress.total)) * 100) : 0;

  return (
    <>
      {viewer3dOpen && result ? (
        <SvrVolume3DModal
          volume={result.volume}
          onClose={() => {
            setViewer3dOpen(false);
          }}
        />
      ) : null}

      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[720px] max-w-[92vw] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Layers3 className="w-4 h-4" />
            Slice-to-Volume Reconstruction (SVR)
          </h3>
          <button
            onClick={() => {
              if (!isRunning) onClose();
            }}
            className={`p-1 rounded-lg ${isRunning ? 'text-[var(--text-tertiary)] cursor-not-allowed' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
            title={isRunning ? 'Cancel SVR or wait for completion' : 'Close'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 grid grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="text-xs text-[var(--text-secondary)]">
              Select multiple series from different planes for a single date, then run iterative SVR (multi-plane fusion + refinement).
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--text-secondary)] w-14">Date</label>
              <select
                value={dateIso ?? ''}
                onChange={(e) => {
                  const nextDate = e.target.value || null;
                  setDateIso(nextDate);
                  setSelectedUids(new Set());
                  setViewer3dOpen(false);
                  setRoiRect(null);
                  roiDragRef.current = null;
                  setLastRunMeta(null);
                  clear();
                }}
                disabled={isRunning}
                className="flex-1 px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
              >
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {d.slice(0, 10)}
                  </option>
                ))}
              </select>
            </div>

            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
              <div className="px-3 py-2 text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                Series on this date (pick 2+ across planes)
              </div>
              <div className="max-h-[320px] overflow-auto">
                {optionsForDate.length === 0 ? (
                  <div className="p-3 text-xs text-[var(--text-tertiary)]">No series found for this date.</div>
                ) : (
                  <div className="divide-y divide-[var(--border-color)]">
                    {optionsForDate.map((opt) => {
                      const checked = selectedUids.has(opt.seriesUid);
                      return (
                        <label
                          key={opt.seriesUid}
                          className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isRunning}
                            onChange={(e) => {
                              const next = new Set(selectedUids);
                              if (e.target.checked) next.add(opt.seriesUid);
                              else next.delete(opt.seriesUid);
                              setSelectedUids(next);
                            }}
                          />
                          <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                          <span className="text-[var(--text-tertiary)] shrink-0">{opt.instanceCount} slices</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

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
                Slice downsample max
                <input
                  type="number"
                  step={16}
                  min={32}
                  max={256}
                  value={params.sliceDownsampleMaxSize}
                  disabled={isRunning}
                  onChange={(e) => setParams((p) => ({ ...p, sliceDownsampleMaxSize: Number(e.target.value) }))}
                  className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                />
              </label>
              <label className="text-xs text-[var(--text-secondary)]">
                Max volume dim
                <input
                  type="number"
                  step={16}
                  min={64}
                  max={256}
                  value={params.maxVolumeDim}
                  disabled={isRunning}
                  onChange={(e) => setParams((p) => ({ ...p, maxVolumeDim: Number(e.target.value) }))}
                  className="mt-1 w-full px-2 py-1.5 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => {
                  setSelectedUids(new Set());
                  setViewer3dOpen(false);
                  setRoiRect(null);
                  roiDragRef.current = null;
                  setLastRunMeta(null);
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
                    setViewer3dOpen(false);
                    setRoiRect(null);
                    roiDragRef.current = null;
                    setLastRunMeta({ params, selectedSeries: [...selectedSeries] });
                    void run(selectedSeries, params);
                  }}
                  className="px-4 py-2 text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Run SVR
                </button>
              </div>
            </div>

            {progress && (
              <div className="mt-2">
                <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="truncate">{progress.message}</span>
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
          </div>

          <div className="space-y-3">
            <div className="text-xs font-medium text-[var(--text-secondary)]">Result</div>

            {!result ? (
              <div className="text-xs text-[var(--text-tertiary)]">
                Run SVR to generate a reconstructed volume and orthogonal previews.
              </div>
            ) : (
              <>
                <div className="text-xs text-[var(--text-secondary)]">
                  Volume: {result.volume.dims[0]}×{result.volume.dims[1]}×{result.volume.dims[2]} @ {result.volume.voxelSizeMm[0]}mm
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <RoiSelectablePreview
                    plane="axial"
                    label="Axial"
                    url={previewUrls.axial}
                    aspectW={result.volume.dims[0]}
                    aspectH={result.volume.dims[1]}
                    roiRect={roiRect}
                    setRoiRect={setRoiRect}
                    roiDragRef={roiDragRef}
                  />
                  <RoiSelectablePreview
                    plane="coronal"
                    label="Coronal"
                    url={previewUrls.coronal}
                    aspectW={result.volume.dims[0]}
                    aspectH={result.volume.dims[2]}
                    roiRect={roiRect}
                    setRoiRect={setRoiRect}
                    roiDragRef={roiDragRef}
                  />
                  <RoiSelectablePreview
                    plane="sagittal"
                    label="Sagittal"
                    url={previewUrls.sagittal}
                    aspectW={result.volume.dims[1]}
                    aspectH={result.volume.dims[2]}
                    roiRect={roiRect}
                    setRoiRect={setRoiRect}
                    roiDragRef={roiDragRef}
                  />
                </div>

                <div className="text-[10px] text-[var(--text-tertiary)]">
                  Drag a box on a preview to define a cube ROI (the box is expanded to a cube automatically), then run SVR in ROI.
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isRunning || !roiRect}
                    onClick={() => {
                      setRoiRect(null);
                      roiDragRef.current = null;
                    }}
                    className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    Clear ROI
                  </button>

                  <button
                    type="button"
                    disabled={!canRun || !roi}
                    onClick={() => {
                      if (!roi) return;

                      setViewer3dOpen(false);
                      setRoiRect(null);
                      roiDragRef.current = null;

                      const paramsWithRoi: SvrParams = { ...params, roi };
                      setLastRunMeta({ params: paramsWithRoi, selectedSeries: [...selectedSeries] });
                      void run(selectedSeries, { ...params, roi });
                    }}
                    className="px-3 py-2 text-xs rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Run SVR in ROI
                  </button>

                  {roi && roiSideMm ? (
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                      ROI: ~{roiSideMm.toFixed(1)}mm cube ({roi.sourcePlane})
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setViewer3dOpen(true);
                    }}
                    className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    Open 3D viewer
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const metaParams = lastRunMeta?.params ?? params;
                      const metaSelectedSeries = lastRunMeta?.selectedSeries ?? selectedSeries;

                      const meta = {
                        dims: result.volume.dims,
                        voxelSizeMm: result.volume.voxelSizeMm,
                        originMm: result.volume.originMm,
                        boundsMm: result.volume.boundsMm,
                        params: metaParams,
                        selectedSeries: metaSelectedSeries,
                      };
                      downloadBlob(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), `svr_${dateIso?.slice(0, 10) ?? 'unknown'}.json`);
                    }}
                    className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex items-center gap-2"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download metadata (JSON)
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      // Float32 raw bytes (little-endian on typical platforms).
                      const buf = toArrayBuffer(result.volume.data);
                      downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), `svr_${dateIso?.slice(0, 10) ?? 'unknown'}.f32`);
                    }}
                    className="px-3 py-2 text-xs rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 flex items-center gap-2"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download volume (.f32)
                  </button>
                </div>

                <div className="text-[10px] text-[var(--text-tertiary)]">
                  Note: .f32 is raw Float32 voxels in x-fastest order. Use the JSON sidecar for dims/spacing/origin.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
