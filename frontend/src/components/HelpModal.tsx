import { X } from 'lucide-react';

interface HelpModalProps {
  onClose: () => void;
}

export function HelpModal({ onClose }: HelpModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div 
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts & Controls</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm">
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">Navigation</h3>
            <ul className="space-y-1 text-[var(--text-secondary)]">
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">Scroll</kbd> on image — Navigate slices</li>
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">Click</kbd> on image — Center on point</li>
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">Double-click</kbd> — Reset pan</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">Overlay Mode</h3>
            <ul className="space-y-1 text-[var(--text-secondary)]">
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">1-9</kbd> — Jump to date by number</li>
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">←</kbd> <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">→</kbd> — Previous / next date</li>
              <li><kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">Hold Space</kbd> — Quick compare (previous date if available; otherwise nearest)</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">Controls</h3>
            <ul className="space-y-1 text-[var(--text-secondary)]">
              <li><span className="text-[var(--text-primary)]">Slice</span> — Offset from synchronized position</li>
              <li><span className="text-[var(--text-primary)]">Zoom %</span> — Magnification level</li>
              <li><span className="text-[var(--text-primary)]">Rotation °</span> — Image rotation</li>
              <li><span className="text-[var(--text-primary)]">B</span> — Brightness (0-200)</li>
              <li><span className="text-[var(--text-primary)]">C</span> — Contrast (0-200)</li>
              <li className="text-xs italic">Hold arrows for rapid adjustment</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">Auto-Alignment (Overlay Mode)</h3>
            <ul className="space-y-1 text-[var(--text-secondary)]">
              <li><span className="text-[var(--text-primary)]">Align All</span> — Use the currently visible overlay image as the reference and align all other dates</li>
              <li>• Finds best matching slice for each date</li>
              <li>• Adjusts brightness/contrast to match intensity</li>
              <li>• Copies zoom, rotation, and pan from the reference view</li>
              <li className="text-xs italic">Progress appears over the center viewer while aligning</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] mb-2">Tips</h3>
            <ul className="space-y-1 text-[var(--text-secondary)]">
              <li>• Hover over sequence names for clinical descriptions</li>
              <li>• Slice slider syncs anatomical position across dates</li>
              <li>• All settings persist automatically</li>
              <li>• Use <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">Cmd/Ctrl+Z</kbd> to undo alignment</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
