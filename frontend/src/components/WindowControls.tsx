import { Sun, Contrast, RotateCcw } from 'lucide-react';

interface WindowControlsProps {
  brightness: number;  // 0-200, 100 = normal
  contrast: number;    // 0-200, 100 = normal
  onBrightnessChange: (value: number) => void;
  onContrastChange: (value: number) => void;
  onReset: () => void;
}

// Presets as brightness/contrast percentages
const PRESETS = [
  { name: 'Normal', brightness: 100, contrast: 100 },
  { name: 'Bright', brightness: 130, contrast: 100 },
  { name: 'High Contrast', brightness: 100, contrast: 150 },
  { name: 'Dark', brightness: 70, contrast: 100 },
  { name: 'Soft', brightness: 110, contrast: 80 },
];

export function WindowControls({
  brightness,
  contrast,
  onBrightnessChange,
  onContrastChange,
  onReset,
}: WindowControlsProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Adjustments
        </h3>
        <button
          onClick={onReset}
          className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          title="Reset to Default"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => {
              onBrightnessChange(preset.brightness);
              onContrastChange(preset.contrast);
            }}
            className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* Brightness */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
            <Sun className="w-3.5 h-3.5" />
            Brightness
          </label>
          <span className="text-xs text-[var(--text-primary)] tabular-nums">{brightness}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          value={brightness}
          onChange={(e) => onBrightnessChange(parseInt(e.target.value))}
          className="w-full"
        />
      </div>

      {/* Contrast */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
            <Contrast className="w-3.5 h-3.5" />
            Contrast
          </label>
          <span className="text-xs text-[var(--text-primary)] tabular-nums">{contrast}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          value={contrast}
          onChange={(e) => onContrastChange(parseInt(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}
