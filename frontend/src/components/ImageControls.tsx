import { ArrowDownUp, Sparkles } from 'lucide-react';
import type { PanelSettings } from '../types/api';
import { StepControl } from './StepControl';
import { CONTROL_LIMITS } from '../utils/constants';
import { normalizeRotation } from '../utils/math';
import { formatRotation } from '../utils/format';

interface ImageControlsProps {
  settings: PanelSettings;
  instanceIndex: number;
  instanceCount: number;
  onUpdate: (update: Partial<PanelSettings>) => void;
  onAcpAnalyze?: () => void;
  acpAnalyzeLoading?: boolean;
  acpAnalyzeDisabled?: boolean;
  /** If false, omit the slice selector control (useful when rendering it on a separate row). */
  showSliceControl?: boolean;
}

const Divider = ({ wide = false }: { wide?: boolean }) => (
  <div className={`w-px h-3 bg-[var(--border-color)] ${wide ? 'mx-3' : 'mx-2'}`} />
);

export function ImageControls({
  settings,
  instanceIndex,
  instanceCount,
  onUpdate,
  onAcpAnalyze,
  acpAnalyzeLoading = false,
  acpAnalyzeDisabled = false,
  showSliceControl = true,
}: ImageControlsProps) {
  const canReverse = instanceCount > 1;
  const isReversed = !!settings.reverseSliceOrder;

  const toggleReverseSliceOrder = () => {
    if (!canReverse) return;

    const max = instanceCount - 1;
    const currentIndex = instanceIndex;

    // Keep the physical slice stable while flipping the logical order.
    const currentPhysicalIndex = isReversed ? max - currentIndex : currentIndex;
    const nextReversed = !isReversed;
    const nextIndex = nextReversed ? max - currentPhysicalIndex : currentPhysicalIndex;

    // displayedIndex = base + offset, so we can preserve base by adjusting offset by delta.
    const nextOffset = settings.offset + (nextIndex - currentIndex);

    onUpdate({ reverseSliceOrder: nextReversed, offset: nextOffset });
  };

  return (
    <div className="flex items-center">
      {showSliceControl && (
        <>
          <StepControl
            title="Slice offset"
            value={`${instanceIndex + 1}/${instanceCount}`}
            valueWidth="w-16"
            tabular
            accent
            onDecrement={() => onUpdate({ offset: settings.offset - 1 })}
            onIncrement={() => onUpdate({ offset: settings.offset + 1 })}
          />

          <Divider wide />
        </>
      )}

      <StepControl
        title="Zoom"
        value={`${Math.round(settings.zoom * 100)}%`}
        valueWidth="w-8"
        onDecrement={() =>
          onUpdate({ zoom: Math.max(CONTROL_LIMITS.ZOOM.MIN, settings.zoom - CONTROL_LIMITS.ZOOM.STEP) })
        }
        onIncrement={() =>
          onUpdate({ zoom: Math.min(CONTROL_LIMITS.ZOOM.MAX, settings.zoom + CONTROL_LIMITS.ZOOM.STEP) })
        }
      />

      <Divider />

      <StepControl
        title="Rotation"
        value={`${formatRotation(settings.rotation)}°`}
        valueWidth="w-12"
        tabular
        onDecrement={() =>
          onUpdate({ rotation: normalizeRotation(settings.rotation - CONTROL_LIMITS.ROTATION.STEP) })
        }
        onIncrement={() =>
          onUpdate({ rotation: normalizeRotation(settings.rotation + CONTROL_LIMITS.ROTATION.STEP) })
        }
      />

      <Divider />

      <StepControl
        label="B"
        title="Brightness"
        value={String(settings.brightness)}
        onDecrement={() =>
          onUpdate({
            brightness: Math.max(CONTROL_LIMITS.BRIGHTNESS.MIN, settings.brightness - CONTROL_LIMITS.BRIGHTNESS.STEP),
          })
        }
        onIncrement={() =>
          onUpdate({
            brightness: Math.min(CONTROL_LIMITS.BRIGHTNESS.MAX, settings.brightness + CONTROL_LIMITS.BRIGHTNESS.STEP),
          })
        }
      />

      <Divider />

      <StepControl
        label="C"
        title="Contrast"
        value={String(settings.contrast)}
        onDecrement={() =>
          onUpdate({
            contrast: Math.max(CONTROL_LIMITS.CONTRAST.MIN, settings.contrast - CONTROL_LIMITS.CONTRAST.STEP),
          })
        }
        onIncrement={() =>
          onUpdate({
            contrast: Math.min(CONTROL_LIMITS.CONTRAST.MAX, settings.contrast + CONTROL_LIMITS.CONTRAST.STEP),
          })
        }
      />

      <Divider />

      <button
        type="button"
        onClick={toggleReverseSliceOrder}
        disabled={!canReverse}
        className={`px-2 py-1 rounded-md text-[10px] font-medium flex items-center gap-1 transition-colors ${
          !canReverse
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
            : isReversed
            ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        title={
          !canReverse
            ? 'Not enough slices to reverse'
            : isReversed
            ? 'Slice order reversed (click to restore)'
            : 'Reverse slice order'
        }
      >
        <ArrowDownUp className="w-3 h-3" />
        Rev
      </button>

      {onAcpAnalyze && (
        <>
          <Divider />
          <button
            type="button"
            onClick={onAcpAnalyze}
            disabled={acpAnalyzeDisabled || acpAnalyzeLoading}
            className={`px-2 py-1 rounded-md text-[10px] font-medium flex items-center gap-1 transition-colors ${
              acpAnalyzeDisabled || acpAnalyzeLoading
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="AI: analyze/segment/annotate this slice (not persisted)"
          >
            <Sparkles className="w-3 h-3" />
            AI
          </button>
        </>
      )}
    </div>
  );
}
