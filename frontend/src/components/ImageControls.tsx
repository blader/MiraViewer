import { Sparkles } from 'lucide-react';
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
}: ImageControlsProps) {
  return (
    <div className="flex items-center">
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
