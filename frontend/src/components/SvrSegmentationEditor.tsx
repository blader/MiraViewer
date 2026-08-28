import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Crosshair, Maximize2, Minimize2, Minus, Plus, Redo2, Undo2 } from 'lucide-react';
import type { SvrLabelVolume, SvrRoiPlane, SvrVolume } from '../types/svr';
import { useSvrSelection } from '../hooks/useSvrSelection';
import { useSvrImaging } from './svrImagingContext';
import { REGION_DETAIL_SPACING_MM } from '../utils/svr/refineRegion';
import { volumeVoxelToPatient } from '../utils/svr/volumeGeometry';
import { hasNativeDetail, volumeDisplayRange, volumeSamplingLabel } from '../utils/svr/volumeDisplay';
import { physicalBrushIndices, SLICE_AXES, type SelectionPatch } from '../utils/segmentation/selectionEditing';
import { voxelIndex, type VoxelPoint } from '../utils/segmentation/seededVolume';
import { clamp } from '../utils/math';

type Tool = 'navigate' | 'include' | 'exclude';
type StrokeScope = { volume: SvrVolume; plane: SvrRoiPlane; slice: number; tool: Tool; disabled: boolean };
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
  onStroke: (indices: Uint32Array, kind: 'include' | 'exclude') => void;
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
  const scope = useMemo(() => ({ volume, plane, slice, tool, disabled }), [volume, plane, slice, tool, disabled]);
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
      onStroke(Uint32Array.from(stroke.indices), stroke.kind);
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

function SelectionDisplayControls({
  disabled,
  hasSelection,
  running,
  cursor,
  windowRange,
  setWindowRange,
  cutaway,
  setCutaway,
}: {
  disabled: boolean;
  hasSelection: boolean;
  running: boolean;
  cursor: VoxelPoint;
  windowRange: [number, number];
  setWindowRange: (range: [number, number]) => void;
  cutaway: boolean;
  setCutaway: (enabled: boolean) => void;
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
      <summary>
        Image detail <span>Shared window / level · {volumeSamplingLabel(volume)}</span>
      </summary>
      <div>
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
        {refineRegion ? (
          <button
            type="button"
            disabled={
              disabled ||
              !hasSelection ||
              running ||
              (volume.nativeVoxelSizeMm
                ? hasNativeDetail(volume)
                : Math.max(...volume.voxelSizeMm) <= REGION_DETAIL_SPACING_MM * 1.05)
            }
            onClick={() => {
              if (labels) refineRegion(labels);
            }}
            title={
              volume.nativeVoxelSizeMm
                ? 'Load the selected region at the original stored sample spacing, without averaging or inverse reconstruction. Your selection transfers as a draft for review.'
                : 'Request a 0.50 mm grid within the browser memory limit. Reconstruct from acquired MRI and transfer your selection as a draft for review.'
            }
          >
            {volume.nativeVoxelSizeMm
              ? 'Load native detail'
              : `Refine region · ${REGION_DETAIL_SPACING_MM.toFixed(2)} mm`}
          </button>
        ) : null}
        <span>Display only · source values are unchanged</span>
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
            ['navigate', 'Navigate', Crosshair, 'Move through the reconstruction without changing the selection.'],
            ['include', 'Mark inside', Plus, 'Paint tissue that every suggestion must keep.'],
            ['exclude', 'Mark outside', Minus, 'Optional: paint tissue that every suggestion must exclude.'],
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
    </>
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
  selectionNotice?: ReactNode;
  children: ReactNode | ((selectionRunning: boolean, retainedBytes: number) => ReactNode);
}) {
  const { volume, labels = null } = useSvrImaging();
  if (!volume) throw new Error('Reconstruct a volume before editing a selection.');
  const selection = useSvrSelection(volume, labels, onChange);
  const [tool, setTool] = useState<Tool>('navigate');
  const [radiusMm, setRadiusMm] = useState(2);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState<SvrRoiPlane | 'volume' | null>(null);
  const expand = (view: SvrRoiPlane | 'volume') => setExpanded((current) => (current === view ? null : view));
  const hasSelection = selectedVolumeMl > 0;
  const reviewed = labels?.reviewState === 'reviewed';
  return (
    <section
      className="svr-selection-workbench"
      aria-label="Region selection workspace"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
        if (event.key === 'Escape') {
          if (selection.status.running) {
            event.preventDefault();
            event.stopPropagation();
            selection.cancel();
          } else if (expanded) {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(null);
          }
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !disabled) {
          event.preventDefault();
          event.stopPropagation();
          selection.travel(event.shiftKey ? 'redo' : 'undo');
        } else if (['1', '2', '3'].includes(event.key)) {
          event.currentTarget
            .querySelector<HTMLCanvasElement>(`canvas[data-plane="${PLANES[Number(event.key) - 1]}"]`)
            ?.focus();
        }
      }}
    >
      <div className="svr-selection-toolbar">
        <div className="svr-selection-title-row">
          <h2>Tumor region</h2>
          <span className="svr-selection-review-state" data-reviewed={reviewed}>
            {reviewed
              ? `Reviewed selection · ${selectedVolumeMl.toFixed(2)} mL`
              : hasSelection
                ? 'Draft · review the boundaries'
                : 'Mark the tissue you want to isolate'}
          </span>
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
                disabled={mode !== 'anatomy' && !hasSelection}
                onClick={() => onVisualizationModeChange(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="svr-selection-actions">
          <SelectionBrushControls
            tool={tool}
            onToolChange={(nextTool) => {
              setTool(nextTool);
              if (nextTool !== 'navigate') onVisualizationModeChange('overlay');
            }}
            radiusMm={radiusMm}
            onRadiusChange={setRadiusMm}
            disabled={disabled}
          />
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
          </div>
          <div className="svr-selection-zoom">
            <button
              type="button"
              aria-label="Zoom out slice views"
              disabled={zoom <= 1}
              onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
            >
              −
            </button>
            <span>{zoom.toFixed(1)}×</span>
            <button
              type="button"
              aria-label="Zoom in slice views"
              disabled={zoom >= 4}
              onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
            >
              +
            </button>
          </div>
          <div className="svr-selection-commit-actions">
            {selection.status.running ? (
              <button type="button" onClick={selection.cancel}>
                Cancel suggestion
              </button>
            ) : (
              <button
                type="button"
                className="svr-selection-suggest"
                disabled={disabled || !selection.included}
                title={
                  disabled
                    ? disabledReason
                    : !selection.included
                      ? 'Mark inside first. Outside marks are optional.'
                      : 'Suggest a draft boundary from your marks, then review it in all three planes.'
                }
                onClick={() => void selection.grow()}
              >
                Suggest boundary
              </button>
            )}
            <button
              type="button"
              disabled={disabled || !hasSelection || selection.status.running || reviewed}
              onClick={selection.accept}
            >
              Confirm selection
            </button>
            <button
              type="button"
              className="svr-selection-clear"
              disabled={disabled || (!hasSelection && !selection.marks.size)}
              onClick={selection.clear}
            >
              Clear
            </button>
          </div>
        </div>
        <div className="svr-selection-guidance" role="status" aria-live="polite">
          {disabled
            ? (disabledReason ?? 'Editing is temporarily unavailable.')
            : selection.status.running
              ? `Finding boundary${selection.status.progress ? ` · ${Math.round(selection.status.progress * 100)}%` : '…'}`
              : !selection.included
                ? 'Mark inside the tissue you want to keep, then choose Suggest boundary. Outside marks are optional. This is an editable selection, not automatic tumor detection.'
                : reviewed
                  ? 'Selection confirmed. Further marks or a new suggestion return it to a draft for review.'
                  : 'Suggest boundary keeps your inside marks and proposes the surrounding tissue. Outside marks are optional. Review all three planes before confirming.'}
        </div>
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
        <SelectionDisplayControls
          disabled={disabled}
          hasSelection={hasSelection}
          running={selection.status.running}
          cursor={cursor}
          windowRange={windowRange}
          setWindowRange={setWindowRange}
          cutaway={cutaway}
          setCutaway={setCutaway}
        />
        {selection.status.error ? (
          <div className="svr-selection-warning" role="alert">
            {selection.status.error}
          </div>
        ) : null}
        {selection.status.boundaryCount ? (
          <div className="svr-selection-warning" role="status">
            The selection reaches the search boundary. Check its extent and add marks near any missing tissue before
            confirming.
          </div>
        ) : null}
        {selection.status.contextLimited ? (
          <div className="svr-selection-warning" role="status">
            This suggestion used a memory-limited region around your marks, not the entire reconstruction. Check its
            extent before confirming.
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
            {typeof children === 'function' ? children(selection.status.running, selection.retainedBytes) : children}
          </div>
        </section>
      </div>
    </section>
  );
}
