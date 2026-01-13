import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PanelSettings } from '../types/api';
import { RepeatButton } from './RepeatButton';
import { CONTROL_LIMITS } from '../utils/constants';

function normalizeRotationDegrees(degrees: number): number {
  // Wrap into [-180, 180]
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

interface ImageControlsProps {
  settings: PanelSettings;
  instanceIndex: number;
  instanceCount: number;
  onUpdate: (update: Partial<PanelSettings>) => void;
}

export function ImageControls({ settings, instanceIndex, instanceCount, onUpdate }: ImageControlsProps) {
  return (
    <div className="flex items-center">
      {/* Slice offset */}
      <div className="flex items-center" title="Slice">
        <RepeatButton
          onAction={() => onUpdate({ offset: settings.offset - 1 })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </RepeatButton>
        <span className="text-[var(--text-primary)] text-[10px] w-8 text-center font-mono">
          {instanceIndex + 1}/{instanceCount}
        </span>
        <RepeatButton
          onAction={() => onUpdate({ offset: settings.offset + 1 })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronRight className="w-3 h-3" />
        </RepeatButton>
      </div>
      
      <div className="w-px h-3 bg-[var(--border-color)] mx-1" />
      
      {/* Zoom */}
      <div className="flex items-center" title="Zoom">
        <RepeatButton
          onAction={() => onUpdate({ zoom: Math.max(CONTROL_LIMITS.ZOOM.MIN, settings.zoom - CONTROL_LIMITS.ZOOM.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </RepeatButton>
        <span className="text-[var(--text-primary)] text-[10px] w-8 text-center font-mono">
          {Math.round(settings.zoom * 100)}%
        </span>
        <RepeatButton
          onAction={() => onUpdate({ zoom: Math.min(CONTROL_LIMITS.ZOOM.MAX, settings.zoom + CONTROL_LIMITS.ZOOM.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronRight className="w-3 h-3" />
        </RepeatButton>
      </div>
      
      {/* Rotation */}
      <div className="flex items-center" title="Rotation">
        <RepeatButton
          onAction={() => {
            const val = normalizeRotationDegrees(settings.rotation - CONTROL_LIMITS.ROTATION.STEP);
            onUpdate({ rotation: val });
          }}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </RepeatButton>
        <span className="text-[var(--text-primary)] text-[10px] w-7 text-center font-mono">
          {settings.rotation}°
        </span>
        <RepeatButton
          onAction={() => {
            const val = normalizeRotationDegrees(settings.rotation + CONTROL_LIMITS.ROTATION.STEP);
            onUpdate({ rotation: val });
          }}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronRight className="w-3 h-3" />
        </RepeatButton>
      </div>
      
      <div className="w-px h-3 bg-[var(--border-color)] mx-1" />
      
      {/* Brightness */}
      <div className="flex items-center" title="Brightness">
        <span className="text-[var(--text-secondary)] text-[10px]">B</span>
        <RepeatButton
          onAction={() => onUpdate({ brightness: Math.max(CONTROL_LIMITS.BRIGHTNESS.MIN, settings.brightness - CONTROL_LIMITS.BRIGHTNESS.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </RepeatButton>
        <span className="text-[var(--text-primary)] text-[10px] w-6 text-center font-mono">
          {settings.brightness}
        </span>
        <RepeatButton
          onAction={() => onUpdate({ brightness: Math.min(CONTROL_LIMITS.BRIGHTNESS.MAX, settings.brightness + CONTROL_LIMITS.BRIGHTNESS.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronRight className="w-3 h-3" />
        </RepeatButton>
      </div>
      
      {/* Contrast */}
      <div className="flex items-center" title="Contrast">
        <span className="text-[var(--text-secondary)] text-[10px] ml-1">C</span>
        <RepeatButton
          onAction={() => onUpdate({ contrast: Math.max(CONTROL_LIMITS.CONTRAST.MIN, settings.contrast - CONTROL_LIMITS.CONTRAST.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </RepeatButton>
        <span className="text-[var(--text-primary)] text-[10px] w-6 text-center font-mono">
          {settings.contrast}
        </span>
        <RepeatButton
          onAction={() => onUpdate({ contrast: Math.min(CONTROL_LIMITS.CONTRAST.MAX, settings.contrast + CONTROL_LIMITS.CONTRAST.STEP) })}
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
          <ChevronRight className="w-3 h-3" />
        </RepeatButton>
      </div>
    </div>
  );
}
