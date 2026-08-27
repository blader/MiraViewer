import type { Dispatch, SetStateAction } from 'react';
import { ArrowDownUp, Pencil, RotateCcw, ScanLine } from 'lucide-react';
import type { PanelSettings } from '../types/api';
import { StepControl } from './StepControl';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { normalizeRotation } from '../utils/math';
import { formatRotation } from '../utils/format';

interface ImageControlsProps {
  settings: PanelSettings;
  instanceIndex: number;
  instanceCount: number;
  onUpdate: (update: Partial<PanelSettings>) => void;
  /** If false, omit the slice selector control (useful when rendering it on a separate row). */
  showSliceControl?: boolean;
}

export const VerifiedAlignmentBadge = () => (
  <span
    data-registration-datum="verified"
    aria-label="Verified aligned presentation"
    className="flex items-center gap-1.5 text-xs text-[var(--signal-metal)]"
  >
    <span aria-hidden="true" className="h-3 w-px bg-[var(--signal-metal)]" />
    <span className="hidden lg:inline">Aligned</span>
  </span>
);

export function StudyAnnotationControls({
  showSavedTumor,
  tumorToolOpen,
  gtPolygonToolOpen,
  nativeAnnotationsAvailable,
  setShowSavedTumor,
  setTumorToolOpen,
  setGtPolygonToolOpen,
}: {
  showSavedTumor: boolean;
  tumorToolOpen: boolean;
  gtPolygonToolOpen: boolean;
  nativeAnnotationsAvailable: boolean;
  setShowSavedTumor: Dispatch<SetStateAction<boolean>>;
  setTumorToolOpen: Dispatch<SetStateAction<boolean>>;
  setGtPolygonToolOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="study-annotation-controls">
      <button
        type="button"
        onClick={() => setShowSavedTumor((value) => !value)}
        disabled={tumorToolOpen || !nativeAnnotationsAvailable}
        aria-pressed={showSavedTumor}
        className={`flex min-h-8 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-xs transition-colors ${
          tumorToolOpen || !nativeAnnotationsAvailable
            ? 'text-[var(--text-tertiary)]'
            : showSavedTumor
              ? 'bg-[var(--bg-tertiary)] text-[var(--signal-metal)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
        title={
          !nativeAnnotationsAvailable
            ? 'Native annotations are unavailable on a derived alignment plane'
            : tumorToolOpen
              ? 'Close segmentation tool to view saved tumor overlay'
              : 'Toggle saved tumor segmentation overlay'
        }
      >
        <ScanLine className="h-3.5 w-3.5" />
        Saved tumor
      </button>

      <button
        type="button"
        aria-pressed={gtPolygonToolOpen}
        disabled={!nativeAnnotationsAvailable}
        onClick={() => {
          setGtPolygonToolOpen((value) => {
            const next = !value;
            if (next) setTumorToolOpen(false);
            return next;
          });
        }}
        className={`flex min-h-8 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-xs transition-colors ${
          gtPolygonToolOpen
            ? 'bg-[var(--bg-tertiary)] text-[var(--signal-metal)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
        title={
          nativeAnnotationsAvailable
            ? 'Draw a manual tumor outline'
            : 'Native annotations are unavailable on a derived alignment plane'
        }
      >
        <Pencil className="h-3.5 w-3.5" />
        Outline
      </button>
    </div>
  );
}

export function ImageControls({
  settings,
  instanceIndex,
  instanceCount,
  onUpdate,
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
    <div className="image-adjustment-controls">
      {showSliceControl && (
        <StepControl
          label="Slice"
          title="Slice offset"
          value={`${instanceIndex + 1}/${instanceCount}`}
          valueWidth="w-16"
          tabular
          accent
          onDecrement={() => onUpdate({ offset: settings.offset - 1 })}
          onIncrement={() => onUpdate({ offset: settings.offset + 1 })}
        />
      )}

      <StepControl
        label="Zoom"
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

      <StepControl
        label="Rotation"
        title="Rotation"
        value={`${formatRotation(settings.rotation)}°`}
        valueWidth="w-12"
        tabular
        onDecrement={() => onUpdate({ rotation: normalizeRotation(settings.rotation - CONTROL_LIMITS.ROTATION.STEP) })}
        onIncrement={() => onUpdate({ rotation: normalizeRotation(settings.rotation + CONTROL_LIMITS.ROTATION.STEP) })}
      />

      <StepControl
        label="Brightness"
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

      <StepControl
        label="Contrast"
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

      <button
        type="button"
        onClick={toggleReverseSliceOrder}
        disabled={!canReverse}
        aria-pressed={isReversed}
        className={`flex min-h-8 items-center gap-1 rounded-[3px] px-2 text-xs font-medium transition-colors ${
          !canReverse
            ? 'text-[var(--text-tertiary)]'
            : isReversed
              ? 'bg-[var(--bg-tertiary)] text-[var(--signal-metal)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
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
        Reverse slice order
      </button>
      <button
        type="button"
        className="study-reset-tone"
        onClick={() =>
          onUpdate({ brightness: DEFAULT_PANEL_SETTINGS.brightness, contrast: DEFAULT_PANEL_SETTINGS.contrast })
        }
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Reset brightness &amp; contrast
      </button>
    </div>
  );
}
