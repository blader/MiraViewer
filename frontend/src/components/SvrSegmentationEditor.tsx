import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Crosshair, Maximize2, Minimize2, Minus, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import type { SvrLabelVolume, SvrRoiPlane, SvrSelectionPlane, SvrVolume } from '../types/svr';
import { useSvrSelection } from '../hooks/useSvrSelection';
import { useSvrImaging } from './svrImagingContext';
import { REGION_DETAIL_SPACING_MM } from '../utils/svr/refineRegion';
import { volumeVoxelToPatient } from '../utils/svr/volumeGeometry';
import { hasNativeDetail, volumeDisplayRange, volumeSamplingLabel } from '../utils/svr/volumeDisplay';
import { physicalBrushIndices, SLICE_AXES, type SelectionPatch } from '../utils/segmentation/selectionEditing';
import { voxelIndex, type VoxelPoint } from '../utils/segmentation/seededVolume';
import { clamp } from '../utils/math';

type Tool = 'navigate' | 'include' | 'exclude';
type StrokeScope = {
  volume: SvrVolume;
  labels: SvrLabelVolume | null;
  plane: SvrRoiPlane;
  slice: number;
  tool: Tool;
  disabled: boolean;
};
const PLANES: SvrRoiPlane[] = ['axial', 'coronal', 'sagittal'];
const TISSUE_COLOR = [103, 207, 193] as const;
const EXCLUDED_COLOR = [212, 163, 91] as const;

type SliceProps = {
  plane: SvrRoiPlane;
  cursor: VoxelPoint;
  setCursor: (point: VoxelPoint) => void;
  marks: ReadonlyMap<number, number>;
  tool: Tool;
  radiusMm: number;
  zoom: number;
  disabled: boolean;
  showMask: boolean;
  windowRange: [number, number];
  expanded: boolean;
  onExpand: () => void;
  onStrokeStart: () => void;
  onStroke: (indices: Uint32Array, kind: 'include' | 'exclude', plane: SvrSelectionPlane) => void;
};

function useSelectionSlice({
  plane,
  cursor,
  setCursor,
  marks,
  tool,
  radiusMm,
  zoom,
  disabled,
  showMask,
  windowRange,
  onStroke,
}: SliceProps) {
  const { volume, labels = null } = useSvrImaging();
  if (!volume) throw new Error('Reconstruct a volume before opening its slice views.');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 400, height: 320 });
  const [draftState, setDraft] = useState<{ scope: StrokeScope; indices: ReadonlySet<number> } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const strokeRef = useRef<{
    pointer: number;
    previous: VoxelPoint;
    indices: Set<number>;
    kind: Tool;
    scope: StrokeScope;
  } | null>(null);
  const axes = SLICE_AXES[plane];
  const dimensions = { x: volume.dims[0], y: volume.dims[1], z: volume.dims[2] };
  const spacing = { x: volume.voxelSizeMm[0], y: volume.voxelSizeMm[1], z: volume.voxelSizeMm[2] };
  const columns = dimensions[axes.column],
    rows = dimensions[axes.row];
  const slice = cursor[axes.slice];
  // An unfinished stroke is invalid outside the exact image/tool it began on.
  const strokeLabels = tool === 'navigate' ? null : labels;
  const scope = useMemo(
    () => ({ volume, labels: strokeLabels, plane, slice, tool, disabled }),
    [volume, strokeLabels, plane, slice, tool, disabled],
  );
  const draft = draftState?.scope === scope ? draftState.indices : null;
  const maxSlice = dimensions[axes.slice] - 1;
  const rowCursor = axes.flipRows ? rows - 1 - cursor[axes.row] : cursor[axes.row];
  const fit = Math.min(size.width / (columns * spacing[axes.column]), size.height / (rows * spacing[axes.row]));
  const pixelWidth = spacing[axes.column] * fit * zoom;
  const pixelHeight = spacing[axes.row] * fit * zoom;
  const left =
    (size.width - columns * pixelWidth) / 2 +
    (columns / 2 - cursor[axes.column] - 0.5) * spacing[axes.column] * fit * (zoom - 1);
  const top =
    (size.height - rows * pixelHeight) / 2 + (rows / 2 - rowCursor - 0.5) * spacing[axes.row] * fit * (zoom - 1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSize((previous) =>
          previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#000';
    context.fillRect(0, 0, size.width, size.height);
    const source = document.createElement('canvas');
    source.width = columns;
    source.height = rows;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) return;
    const image = sourceContext.createImageData(columns, rows);
    const strides = { x: 1, y: volume.dims[0], z: volume.dims[0] * volume.dims[1] };
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const point = { ...cursor, [axes.column]: column, [axes.row]: axes.flipRows ? rows - 1 - row : row };
        const index = voxelIndex(point, volume.dims);
        const offset = (row * columns + column) * 4;
        const supported = !volume.observedSupport || Boolean(volume.observedSupport[index]);
        const width = windowRange[1] - windowRange[0];
        const normalized =
          width > 0
            ? clamp((volume.data[index]! - windowRange[0]) / width, 0, 1)
            : volume.data[index]! > windowRange[0]
              ? 1
              : 0;
        const gray =
          supported && Number.isFinite(volume.data[index])
            ? Math.round((volume.displayInvert ? 1 - normalized : normalized) * 255)
            : 0;
        let color: readonly number[] | null = null;
        let alpha = 0;
        if (showMask && labels?.data[index]) {
          const edge =
            column === 0 ||
            column === columns - 1 ||
            row === 0 ||
            row === rows - 1 ||
            !labels.data[index - strides[axes.column]] ||
            !labels.data[index + strides[axes.column]] ||
            !labels.data[index - strides[axes.row]] ||
            !labels.data[index + strides[axes.row]];
          color = TISSUE_COLOR;
          alpha = edge ? 0.9 : 0.1;
        }
        const mark = draft?.has(index) ? (tool === 'include' ? 1 : 2) : marks.get(index);
        if (mark) {
          color = mark === 1 ? TISSUE_COLOR : EXCLUDED_COLOR;
          alpha = 0.85;
        }
        if (!supported && (row + column) % 22 === 0) {
          color = EXCLUDED_COLOR;
          alpha = 0.06;
        }
        for (let channel = 0; channel < 3; channel++)
          image.data[offset + channel] = color ? Math.round(gray * (1 - alpha) + color[channel]! * alpha) : gray;
        image.data[offset + 3] = 255;
      }
    sourceContext.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = true;
    context.drawImage(source, left, top, columns * pixelWidth, rows * pixelHeight);
    const crossX = left + (cursor[axes.column] + 0.5) * pixelWidth;
    const crossY = top + (rowCursor + 0.5) * pixelHeight;
    context.strokeStyle = 'rgba(225,230,220,0.35)';
    context.lineWidth = 1;
    context.setLineDash([3, 5]);
    context.beginPath();
    context.moveTo(0, crossY);
    context.lineTo(crossX - 8, crossY);
    context.moveTo(crossX + 8, crossY);
    context.lineTo(size.width, crossY);
    context.moveTo(crossX, 0);
    context.lineTo(crossX, crossY - 8);
    context.moveTo(crossX, crossY + 8);
    context.lineTo(crossX, size.height);
    context.stroke();
  }, [
    axes,
    columns,
    cursor,
    draft,
    labels,
    left,
    marks,
    pixelHeight,
    pixelWidth,
    rowCursor,
    rows,
    showMask,
    size,
    tool,
    top,
    volume,
    windowRange,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let accumulated = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || strokeRef.current?.scope === scope) return;
      event.preventDefault();
      accumulated += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      const steps = Math.trunc(accumulated / 30);
      if (steps) {
        accumulated -= steps * 30;
        setCursor({ ...cursor, [axes.slice]: clamp(slice + steps, 0, maxSlice) });
      }
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [axes.slice, cursor, maxSlice, scope, setCursor, size.height, slice]);

  const pointAt = (event: PointerEvent<HTMLCanvasElement>): VoxelPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left - left) / pixelWidth);
    const row = Math.floor((event.clientY - rect.top - top) / pixelHeight);
    if (column < 0 || row < 0 || column >= columns || row >= rows) return null;
    return { ...cursor, [axes.column]: column, [axes.row]: axes.flipRows ? rows - 1 - row : row };
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointer !== event.pointerId || stroke.scope !== scope) return;
    const point = pointAt(event);
    if (!point) return;
    if (stroke.kind === 'navigate') setCursor(point);
    else {
      for (const index of physicalBrushIndices(volume, plane, stroke.previous, point, radiusMm))
        stroke.indices.add(index);
      setDraft({ scope, indices: new Set(stroke.indices) });
    }
    stroke.previous = point;
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointer !== event.pointerId) return;
    if (!cancelled) move(event);
    strokeRef.current = null;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && stroke.scope === scope && stroke.kind !== 'navigate')
      onStroke(Uint32Array.from(stroke.indices), stroke.kind, { plane: stroke.scope.plane, slice: stroke.scope.slice });
  };
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Escape' && strokeRef.current) {
      const pointer = strokeRef.current.pointer;
      strokeRef.current = null;
      setDraft(null);
      if (event.currentTarget.hasPointerCapture?.(pointer)) event.currentTarget.releasePointerCapture(pointer);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const point = { ...cursor };
    if (event.key === '[' || event.key === ']' || event.key === 'PageUp' || event.key === 'PageDown')
      point[axes.slice] = clamp(slice + (event.key === '[' || event.key === 'PageUp' ? -1 : 1), 0, maxSlice);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      point[axes.column] = clamp(point[axes.column] + (event.key === 'ArrowLeft' ? -1 : 1), 0, columns - 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      point[axes.row] = clamp(
        point[axes.row] + (event.key === 'ArrowUp' ? -1 : 1) * (axes.flipRows ? -1 : 1),
        0,
        rows - 1,
      );
    else return;
    event.preventDefault();
    event.stopPropagation();
    setCursor(point);
  };
  return {
    axes,
    canvasRef,
    containerRef,
    slice,
    maxSlice,
    strokeRef,
    scope,
    pointAt,
    move,
    finish,
    keyDown,
    hover,
    setHover,
    fit,
  };
}

function SelectionSlice(props: SliceProps) {
  const { volume } = useSvrImaging();
  const { plane, cursor, setCursor, tool, radiusMm, zoom, disabled, expanded, onExpand } = props;
  const {
    axes,
    canvasRef,
    containerRef,
    slice,
    maxSlice,
    strokeRef,
    scope,
    pointAt,
    move,
    finish,
    keyDown,
    hover,
    setHover,
    fit,
  } = useSelectionSlice(props);
  return (
    <section className="svr-selection-pane" data-view={plane} aria-label={`${axes.label} selection view`}>
      <header className="svr-selection-pane-heading">
        <span
          title={
            volume?.nativeVoxelSizeMm
              ? 'Slice through the source-aligned volume grid. For an exact original DICOM image, use Original MRI in the 3D view.'
              : undefined
          }
        >
          {axes.label}
          {volume?.direction ? <small className="ml-2 text-[var(--text-tertiary)]">source-aligned</small> : null}
        </span>
        <div className="svr-selection-pane-actions">
          <label className="svr-selection-slice-number">
            <span className="sr-only">{axes.label} slice</span>
            <input
              aria-label={`${axes.label} slice`}
              type="number"
              min={1}
              max={maxSlice + 1}
              value={slice + 1}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isInteger(value)) setCursor({ ...cursor, [axes.slice]: clamp(value - 1, 0, maxSlice) });
              }}
            />
            <span>/ {maxSlice + 1}</span>
          </label>
          <button
            type="button"
            aria-label={expanded ? 'Show all views' : `Expand ${axes.label.toLowerCase()} view`}
            onClick={onExpand}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </header>
      <div className="svr-selection-image" ref={containerRef}>
        <canvas
          ref={canvasRef}
          role="application"
          tabIndex={0}
          aria-label={`${axes.label} reconstructed slice ${slice + 1}`}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight [ ] PageUp PageDown Escape"
          data-plane={plane}
          style={{
            cursor: tool === 'navigate' ? 'crosshair' : disabled ? 'not-allowed' : 'cell',
            touchAction: tool === 'navigate' ? 'pan-y' : 'none',
          }}
          onPointerDown={(event) => {
            if (strokeRef.current?.scope !== scope) strokeRef.current = null;
            if (
              event.button !== 0 ||
              event.isPrimary === false ||
              strokeRef.current ||
              (disabled && tool !== 'navigate')
            )
              return;
            const point = pointAt(event);
            if (!point) return;
            if (tool !== 'navigate') props.onStrokeStart();
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            strokeRef.current = { pointer: event.pointerId, previous: point, indices: new Set(), kind: tool, scope };
            move(event);
          }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHover(pointAt(event) ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
            move(event);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(event) => finish(event)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => finish(event, true)}
          onKeyDown={keyDown}
          onContextMenu={(event) => event.preventDefault()}
        />
        {hover && tool !== 'navigate' && !disabled ? (
          <div
            className="svr-brush-cursor"
            aria-hidden="true"
            data-mark={tool}
            style={{ left: hover.x, top: hover.y, width: radiusMm * fit * zoom * 2, height: radiusMm * fit * zoom * 2 }}
          />
        ) : null}
        <span className="svr-orientation-left">{axes.horizontal[0]}</span>
        <span className="svr-orientation-right">{axes.horizontal[1]}</span>
        <span className="svr-orientation-top">{axes.vertical[0]}</span>
        <span className="svr-orientation-bottom">{axes.vertical[1]}</span>
      </div>
      <input
        className="svr-selection-slice-slider"
        type="range"
        aria-label={`${axes.label} slice position`}
        min={0}
        max={maxSlice}
        step={1}
        value={slice}
        onChange={(event) => setCursor({ ...cursor, [axes.slice]: Number(event.currentTarget.value) })}
      />
    </section>
  );
}

function SelectionNativeDetail({
  disabled,
  hasSelection,
  running,
  prepareMemory,
}: {
  disabled: boolean;
  hasSelection: boolean;
  running: boolean;
  prepareMemory: () => number;
}) {
  const { volume, labels, refineRegion, busy } = useSvrImaging();
  if (!volume?.nativeVoxelSizeMm || hasNativeDetail(volume)) return null;
  const unavailable = disabled || busy || running || !labels || !refineRegion;
  return (
    <div className="svr-selection-native-detail">
      <div>
        <span className="svr-selection-sampling">{volumeSamplingLabel(volume)}</span>
        <span>
          {hasSelection
            ? 'Loads original MRI samples, not inferred enhancement.'
            : 'Select a region to load its original detail.'}
        </span>
      </div>
      {hasSelection ? (
        <button
          type="button"
          disabled={unavailable}
          onClick={() => {
            if (!unavailable && labels) refineRegion?.(labels, prepareMemory);
          }}
          title={
            refineRegion
              ? 'Load the selected region at the original stored sample spacing, without averaging or inverse reconstruction. Your selection transfers as a draft for review.'
              : 'Original-detail loading is unavailable in this view.'
          }
        >
          Use original detail
        </button>
      ) : null}
    </div>
  );
}

function SelectionDisplayControls({
  disabled,
  hasSelection,
  running,
  cursor,
  windowRange,
  setWindowRange,
  cutaway,
  setCutaway,
  zoom,
  setZoom,
}: {
  disabled: boolean;
  hasSelection: boolean;
  running: boolean;
  cursor: VoxelPoint;
  windowRange: [number, number];
  setWindowRange: (range: [number, number]) => void;
  cutaway: boolean;
  setCutaway: (enabled: boolean) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
}) {
  const { volume, labels = null, refineRegion } = useSvrImaging();
  if (!volume) return null;
  const windowWidth = windowRange[1] - windowRange[0];
  const windowLevel = (windowRange[0] + windowRange[1]) / 2;
  const [intensityLow, intensityHigh] = volumeDisplayRange(volume);
  const intensitySpan = intensityHigh - intensityLow;
  const crosshairIndex = voxelIndex(cursor, volume.dims);
  const crosshairSupported =
    (!volume.observedSupport || Boolean(volume.observedSupport[crosshairIndex])) &&
    Number.isFinite(volume.data[crosshairIndex]);
  const patientPosition = volumeVoxelToPatient(volume, [cursor.x, cursor.y, cursor.z]).map((value) => value.toFixed(2));
  return (
    <details className="svr-selection-display-controls">
      <summary>Slice settings</summary>
      <p>This is an editable selection, not automatic tumor detection.</p>
      <div>
        <div className="svr-selection-zoom" role="group" aria-label="Slice zoom">
          <button
            type="button"
            aria-label="Zoom out slice views"
            disabled={zoom <= 1}
            onClick={() => setZoom(Math.max(1, zoom - 0.5))}
          >
            −
          </button>
          <span>{zoom.toFixed(1)}×</span>
          <button
            type="button"
            aria-label="Zoom in slice views"
            disabled={zoom >= 4}
            onClick={() => setZoom(Math.min(4, zoom + 0.5))}
          >
            +
          </button>
        </div>
        <label>
          Window{' '}
          <input
            aria-label="MRI window width"
            type="range"
            min={intensitySpan * 0.005}
            max={intensitySpan * 2}
            step={intensitySpan * 0.0025}
            value={windowWidth}
            onChange={(event) => {
              const width = Number(event.currentTarget.value);
              setWindowRange([windowLevel - width / 2, windowLevel + width / 2]);
            }}
          />
        </label>
        <label>
          Level{' '}
          <input
            aria-label="MRI window level"
            type="range"
            min={intensityLow}
            max={intensityHigh}
            step={intensitySpan * 0.0025}
            value={windowLevel}
            onChange={(event) => {
              const level = Number(event.currentTarget.value);
              setWindowRange([level - windowWidth / 2, level + windowWidth / 2]);
            }}
          />
        </label>
        <button type="button" onClick={() => setWindowRange(volume.displayWindow ?? [0, 1])}>
          Reset contrast
        </button>
        <button
          type="button"
          aria-pressed={cutaway}
          onClick={() => setCutaway(!cutaway)}
          title="Cut the volume grid at the current axial crosshair. This section is interpolated from the volume, not an original DICOM image."
        >
          Interpolated cutaway
        </button>
        {refineRegion && !volume.nativeVoxelSizeMm ? (
          <button
            type="button"
            disabled={
              disabled || !hasSelection || running || Math.max(...volume.voxelSizeMm) <= REGION_DETAIL_SPACING_MM * 1.05
            }
            onClick={() => {
              if (labels) refineRegion(labels);
            }}
            title="Request a 0.50 mm grid within the browser memory limit. Reconstruct from acquired MRI and transfer your selection as a draft for review."
          >
            Refine region · {REGION_DETAIL_SPACING_MM.toFixed(2)} mm
          </button>
        ) : null}
        <span>
          Shared window / level ·{' '}
          {!volume.nativeVoxelSizeMm || hasNativeDetail(volume) ? `${volumeSamplingLabel(volume)} · ` : ''}
          source values unchanged
        </span>
      </div>
      <div role="status" aria-label="Crosshair position" aria-live="off">
        {crosshairSupported ? 'Acquired support' : 'No acquired support'} · Patient position: (
        {patientPosition.join(', ')}) mm
      </div>
    </details>
  );
}

function SelectionBrushControls({
  tool,
  onToolChange,
  radiusMm,
  onRadiusChange,
  disabled,
}: {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  radiusMm: number;
  onRadiusChange: (radiusMm: number) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="svr-selection-tool-group" role="group" aria-label="Selection tools">
        {(
          [
            ['navigate', 'Browse', Crosshair, 'Move through the reconstruction without changing the selection.'],
            ['include', 'Add', Plus, 'Paint tissue to keep. Auto-fill must preserve these inside marks.'],
            ['exclude', 'Remove', Minus, 'Paint tissue to exclude. Auto-fill must preserve these outside marks.'],
          ] as const
        ).map(([mode, label, Icon, hint]) => (
          <button
            key={mode}
            type="button"
            title={hint}
            data-mark={mode === 'navigate' ? undefined : mode}
            disabled={mode !== 'navigate' && disabled}
            aria-pressed={tool === mode}
            onClick={() => onToolChange(mode)}
          >
            <Icon size={15} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>
      {tool !== 'navigate' ? (
        <label className="svr-selection-brush">
          Brush{' '}
          <input
            aria-label="Selection brush radius in millimeters"
            type="range"
            min={0.5}
            max={8}
            step={0.5}
            value={radiusMm}
            onChange={(event) => onRadiusChange(Number(event.currentTarget.value))}
          />
          <span>{radiusMm.toFixed(1)} mm</span>
        </label>
      ) : null}
    </>
  );
}

function SelectionHistoryControls({
  selection,
  disabled,
  hasSelection,
}: {
  selection: ReturnType<typeof useSvrSelection>;
  disabled: boolean;
  hasSelection: boolean;
}) {
  if (!hasSelection && !selection.marks.size && !selection.canUndo && !selection.canRedo) return null;
  return (
    <div className="svr-selection-history">
      <button
        type="button"
        aria-label="Undo selection edit"
        title="Undo selection edit (⌘Z)"
        disabled={disabled || !selection.canUndo}
        onClick={() => selection.travel('undo')}
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        aria-label="Redo selection edit"
        title="Redo selection edit (⇧⌘Z)"
        disabled={disabled || !selection.canRedo}
        onClick={() => selection.travel('redo')}
      >
        <Redo2 size={16} />
      </button>
      <button
        type="button"
        className="svr-selection-clear"
        aria-label="Clear selection"
        title="Clear selection (undoable)"
        disabled={disabled || (!hasSelection && !selection.marks.size)}
        onClick={selection.clear}
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function SelectionActions({
  selection,
  editing,
  disabled,
  hasSelection,
  tool,
  onToolChange,
  radiusMm,
  onRadiusChange,
  autoFill,
  onAutoFillChange,
  onStopAutoFill,
}: {
  selection: ReturnType<typeof useSvrSelection>;
  editing: boolean;
  disabled: boolean;
  hasSelection: boolean;
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  radiusMm: number;
  onRadiusChange: (radiusMm: number) => void;
  autoFill: boolean;
  onAutoFillChange: (enabled: boolean) => void;
  onStopAutoFill: () => void;
}) {
  if (!editing && !selection.status.running) return null;
  return (
    <div className="svr-selection-actions">
      {editing ? (
        <>
          <SelectionBrushControls
            tool={tool}
            onToolChange={onToolChange}
            radiusMm={radiusMm}
            onRadiusChange={onRadiusChange}
            disabled={disabled}
          />
          <SelectionHistoryControls selection={selection} disabled={disabled} hasSelection={hasSelection} />
        </>
      ) : null}
      <div className="svr-selection-commit-actions">
        {editing ? (
          <label
            className="svr-selection-autofill"
            title="Fill nearby tissue after a brush stroke, keeping every Add and Remove mark. Turn off to edit only what you paint."
          >
            <input
              type="checkbox"
              checked={autoFill}
              disabled={disabled}
              onChange={(event) => onAutoFillChange(event.currentTarget.checked)}
            />
            Auto-fill
          </label>
        ) : null}
        {selection.status.running ? (
          <button type="button" onClick={onStopAutoFill}>
            Stop
          </button>
        ) : editing && selection.status.error && selection.included > 0 && autoFill ? (
          <button type="button" disabled={disabled} onClick={() => void selection.grow()}>
            Retry boundary
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SvrSegmentationEditor({
  onChange,
  disabled = false,
  disabledReason,
  storageError,
  retryStorage,
  selectedVolumeMl,
  visualizationMode,
  onVisualizationModeChange,
  cursor,
  setCursor,
  windowRange,
  setWindowRange,
  cutaway,
  setCutaway,
  onShow3D,
  selectionNotice,
  children,
}: {
  onChange: (labels: SvrLabelVolume | null, patch?: SelectionPatch, previousData?: Uint8Array) => void;
  disabled?: boolean;
  disabledReason?: string;
  storageError?: 'load' | 'save' | null;
  retryStorage?: () => void;
  selectedVolumeMl: number;
  visualizationMode: 'anatomy' | 'overlay' | 'tumor';
  onVisualizationModeChange: (mode: 'anatomy' | 'overlay' | 'tumor') => void;
  cursor: VoxelPoint;
  setCursor: (point: VoxelPoint) => void;
  windowRange: [number, number];
  setWindowRange: (range: [number, number]) => void;
  cutaway: boolean;
  setCutaway: (enabled: boolean) => void;
  onShow3D?: () => void;
  selectionNotice?: ReactNode;
  children: ReactNode | ((selectionRunning: boolean, prepareEnhancement: () => number) => ReactNode);
}) {
  const { volume, labels = null, proposeSelection } = useSvrImaging();
  if (!volume) throw new Error('Reconstruct a volume before editing a selection.');
  const [tool, setTool] = useState<Tool>('navigate');
  const [autoFill, setAutoFill] = useState(true);
  const [radiusMm, setRadiusMm] = useState(2);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState<SvrRoiPlane | 'volume' | null>('volume');
  const workspaceRef = useRef<HTMLElement>(null);
  const hasSelection = selectedVolumeMl > 0;
  const reviewed = labels?.reviewState === 'reviewed';
  const editing = expanded !== 'volume';
  const selection = useSvrSelection(volume, labels, onChange, editing && !disabled && autoFill, proposeSelection);
  const show3D = () => {
    setTool('navigate');
    setExpanded('volume');
    onShow3D?.();
    workspaceRef.current?.querySelector<HTMLButtonElement>('.svr-selection-workflow-action')?.focus();
  };
  const editSelection = () => {
    setExpanded(null);
    setTool(disabled ? 'navigate' : 'include');
    onVisualizationModeChange('overlay');
  };
  const stopAutoFill = () => {
    selection.cancel();
    setAutoFill(false);
  };
  const expand = (view: SvrRoiPlane | 'volume') => {
    if (view === 'volume') {
      if (editing) show3D();
      else editSelection();
    } else setExpanded((current) => (current === view ? null : view));
  };
  return (
    <section
      ref={workspaceRef}
      className="svr-selection-workbench"
      aria-label="Region selection workspace"
      data-editing={editing}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (selection.status.running) stopAutoFill();
          else if (expanded === null) show3D();
          else if (expanded !== 'volume') setExpanded(null);
        } else if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
          return;
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !disabled) {
          event.preventDefault();
          event.stopPropagation();
          selection.travel(event.shiftKey ? 'redo' : 'undo');
        } else if (['1', '2', '3'].includes(event.key)) {
          const plane = PLANES[Number(event.key) - 1];
          if (expanded === null || expanded === plane)
            event.currentTarget.querySelector<HTMLCanvasElement>(`canvas[data-plane="${plane}"]`)?.focus();
        }
      }}
    >
      <div className="svr-selection-toolbar">
        <div className="svr-selection-title-row">
          <h2>{editing ? 'Select tissue' : '3D volume'}</h2>
          <span className="svr-selection-review-state" data-reviewed={reviewed}>
            {reviewed
              ? `Reviewed selection · ${selectedVolumeMl.toFixed(2)} mL`
              : hasSelection
                ? 'Draft · review the boundaries'
                : 'No tissue selected'}
          </span>
          {hasSelection ? (
            <div className="svr-selection-view-modes" role="group" aria-label="Region visualization">
              {(
                [
                  ['anatomy', 'Anatomy'],
                  ['overlay', 'Overlay'],
                  ['tumor', 'Selection only'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={visualizationMode === mode}
                  onClick={() => onVisualizationModeChange(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="svr-selection-workflow-action"
            disabled={editing && !disabled && selection.status.running}
            onClick={() => {
              if (!editing) editSelection();
              else {
                if (!disabled) selection.accept();
                show3D();
              }
            }}
          >
            {editing
              ? disabled
                ? 'Back to 3D'
                : 'Done'
              : disabled
                ? 'View slices'
                : hasSelection
                  ? 'Edit selection'
                  : 'Select tissue'}
          </button>
        </div>
        <SelectionActions
          selection={selection}
          editing={editing}
          disabled={disabled}
          hasSelection={hasSelection}
          tool={tool}
          onToolChange={(nextTool) => {
            setTool(nextTool);
            if (nextTool !== 'navigate') onVisualizationModeChange('overlay');
          }}
          radiusMm={radiusMm}
          onRadiusChange={setRadiusMm}
          autoFill={autoFill}
          onAutoFillChange={(enabled) => {
            if (disabled) return;
            setAutoFill(enabled);
            if (!enabled) selection.cancel();
            else if (selection.included > 0 && !reviewed) void selection.grow();
          }}
          onStopAutoFill={stopAutoFill}
        />
        <div className="svr-selection-guidance" role="status" aria-live="polite">
          {disabled
            ? (disabledReason ?? 'Editing is temporarily unavailable.')
            : selection.status.running
              ? `Auto-filling boundaries${selection.status.progress ? ` · ${Math.round(selection.status.progress * 100)}%` : '…'}`
              : !editing
                ? reviewed
                  ? 'Selection confirmed. Edit it at any time.'
                  : hasSelection
                    ? 'Draft selection. Review all three planes before confirming.'
                    : 'Browse the MRI in 3D, or select tissue to inspect a region.'
                : autoFill
                  ? 'Add tissue to keep; remove tissue to exclude. Auto-fill follows your brush. Review all three planes, then choose Done.'
                  : 'Brush-only editing. Only the tissue you paint changes. Review all three planes, then choose Done.'}
        </div>
        {editing ? (
          <SelectionNativeDetail
            disabled={disabled}
            hasSelection={hasSelection}
            running={selection.status.running}
            prepareMemory={selection.prepareEnhancement}
          />
        ) : null}
        {storageError ? (
          <div className="svr-selection-warning" role="alert">
            {storageError === 'load'
              ? 'Could not restore the saved selection. Editing is paused to protect it.'
              : 'Could not save this selection. Keep this view open; your current edits remain in memory.'}{' '}
            <button type="button" onClick={retryStorage}>
              Retry {storageError === 'load' ? 'loading' : 'saving'}
            </button>
          </div>
        ) : null}
        {selectionNotice}
        {editing ? (
          <SelectionDisplayControls
            disabled={disabled}
            hasSelection={hasSelection}
            running={selection.status.running}
            cursor={cursor}
            windowRange={windowRange}
            setWindowRange={setWindowRange}
            cutaway={cutaway}
            setCutaway={setCutaway}
            zoom={zoom}
            setZoom={setZoom}
          />
        ) : null}
        {selection.status.error ? (
          <div className="svr-selection-warning" role="alert">
            {selection.status.error}
          </div>
        ) : null}
        {selection.status.boundaryCount ? (
          <div className="svr-selection-warning" role="status">
            The initial prediction reached the edge of the analyzed region. Check the retained selection’s extent before
            confirming.
          </div>
        ) : null}
        {labels?.contextLimited ? (
          <div className="svr-selection-warning" role="status">
            This selection was suggested from a limited source region. Check its extent before confirming.
          </div>
        ) : null}
        {labels?.clippedNativeVoxels ? (
          <div className="svr-selection-warning" role="status">
            Only part of the predicted tissue is retained in this selection. The prediction extended beyond its viewing
            region or included unavailable samples. Enlarge or clear the focus region in Sources, reconstruct, then
            suggest the boundary again to review its full extent.
          </div>
        ) : null}
      </div>
      <div className="svr-selection-grid" data-expanded={expanded ?? undefined}>
        {PLANES.map((plane) => (
          <SelectionSlice
            key={plane}
            plane={plane}
            cursor={cursor}
            setCursor={setCursor}
            marks={selection.marks}
            tool={tool}
            radiusMm={radiusMm}
            zoom={zoom}
            disabled={disabled}
            showMask={visualizationMode !== 'anatomy'}
            windowRange={windowRange}
            expanded={expanded === plane}
            onExpand={() => expand(plane)}
            onStrokeStart={selection.cancel}
            onStroke={selection.stroke}
          />
        ))}
        <section
          className="svr-selection-pane svr-selection-volume"
          data-view="volume"
          aria-label="Three-dimensional selection preview"
        >
          <header className="svr-selection-pane-heading">
            <span>3D preview</span>
            <div className="svr-selection-pane-actions">
              <span>
                {reviewed
                  ? 'Reviewed selection'
                  : hasSelection
                    ? 'Unreviewed selection'
                    : volume.nativeVoxelSizeMm
                      ? 'Original-source anatomy'
                      : 'Reconstructed anatomy'}
              </span>
              <button
                type="button"
                aria-label={expanded === 'volume' ? 'Show all views' : 'Expand 3D view'}
                onClick={() => expand('volume')}
              >
                {expanded === 'volume' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </header>
          <div className="svr-selection-volume-content">
            {typeof children === 'function'
              ? children(selection.status.running, selection.prepareEnhancement)
              : children}
          </div>
        </section>
      </div>
    </section>
  );
}
