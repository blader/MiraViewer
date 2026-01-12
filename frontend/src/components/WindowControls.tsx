import { Sun, Contrast, RotateCcw } from 'lucide-react';

interface WindowControlsProps {
  windowCenter: number;
  windowWidth: number;
  onWindowCenterChange: (value: number) => void;
  onWindowWidthChange: (value: number) => void;
  onReset: () => void;
}

// Common brain MRI window presets
const PRESETS = [
  { name: 'Brain', wc: 40, ww: 80 },
  { name: 'Subdural', wc: 75, ww: 215 },
  { name: 'Stroke', wc: 32, ww: 8 },
  { name: 'Bone', wc: 600, ww: 2800 },
  { name: 'Soft Tissue', wc: 50, ww: 350 },
];

export function WindowControls({
  windowCenter,
  windowWidth,
  onWindowCenterChange,
  onWindowWidthChange,
  onReset,
}: WindowControlsProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          Window/Level
        </h3>
        <button
          onClick={onReset}
          className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          title="Reset to Auto"
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
              onWindowCenterChange(preset.wc);
              onWindowWidthChange(preset.ww);
            }}
            className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* Window Center (Level) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
            <Sun className="w-3.5 h-3.5" />
            Level (Center)
          </label>
          <span className="text-xs text-[var(--text-primary)] tabular-nums">{windowCenter}</span>
        </div>
        <input
          type="range"
          min={-1000}
          max={3000}
          value={windowCenter}
          onChange={(e) => onWindowCenterChange(parseInt(e.target.value))}
          className="w-full"
        />
      </div>

      {/* Window Width */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
            <Contrast className="w-3.5 h-3.5" />
            Window (Width)
          </label>
          <span className="text-xs text-[var(--text-primary)] tabular-nums">{windowWidth}</span>
        </div>
        <input
          type="range"
          min={1}
          max={4000}
          value={windowWidth}
          onChange={(e) => onWindowWidthChange(parseInt(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}
