import { X } from 'lucide-react';

interface HelpModalProps {
  onClose: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded text-[11px] font-mono text-[var(--text-primary)]">
      {children}
    </kbd>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-[var(--text-primary)]">{children}</span>;
}

export function HelpModal({ onClose }: HelpModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl w-full max-w-xl mx-4 max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)] shrink-0">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Help</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 text-sm text-[var(--text-secondary)]">
          {/* Viewing */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">Viewing</h3>
            <ul className="space-y-2">
              <li>
                <Kbd>Scroll</Kbd> anywhere in the center pane to navigate slices.
              </li>
              <li>
                <Kbd>Click</Kbd> on an image to center that point.
              </li>
              <li>
                <Kbd>Double-click</Kbd> to reset pan.
              </li>
            </ul>
          </section>

          {/* Comparing dates (Overlay mode) */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">
              Comparing dates (Overlay)
            </h3>
            <ul className="space-y-2">
              <li>
                <Kbd>1</Kbd>–<Kbd>9</Kbd> jump directly to that date.
              </li>
              <li>
                <Kbd>←</Kbd> <Kbd>→</Kbd> step through dates.
              </li>
              <li>
                Hold <Kbd>Space</Kbd> for a quick A/B comparison with the previous date.
              </li>
              <li>
                <Label>Play</Label> button auto-cycles through dates; change speed in the header dropdown.
              </li>
            </ul>
          </section>

          {/* Alignment */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">
              Aligning scans
            </h3>
            <ul className="space-y-2">
              <li>
                <Label>Drag a rectangle</Label> on any image (Grid or Overlay) to define an exclusion region, then click
                the <Label>Align All</Label> button that appears.
              </li>
              <li>
                The exclusion region tells the algorithm to ignore that area (e.g. a tumor) when matching slices.
              </li>
              <li>
                Press <Kbd>Esc</Kbd> or the <Label>X</Label> button to clear the selection.
              </li>
              <li>
                Click <Label>Cancel</Label> to abort alignment while running.
              </li>
            </ul>
          </section>

          {/* Image adjustments */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">
              Image adjustments
            </h3>
            <p className="mb-2">Hover over an image to reveal controls:</p>
            <ul className="space-y-1.5 ml-3">
              <li>
                <Label>Slice</Label> — per-date offset from the global position
              </li>
              <li>
                <Label>Zoom</Label>, <Label>Rotation</Label> — geometry
              </li>
              <li>
                <Label>B</Label> (brightness) &amp; <Label>C</Label> (contrast) — window/level
              </li>
              <li>
                <Label>Rev</Label> — reverse slice order for that date
              </li>
            </ul>
            <p className="mt-2 text-xs italic">Hold arrow buttons for rapid adjustment.</p>
          </section>

          {/* Slice loop */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">
              Slice loop (bottom bar)
            </h3>
            <ul className="space-y-2">
              <li>
                Press <Label>Play</Label> to ping-pong through slices within the loop window.
              </li>
              <li>
                Drag the <Label>loop handles</Label> to set start/end bounds.
              </li>
              <li>
                <Label>1x / 2x / 4x</Label> controls loop speed.
              </li>
            </ul>
          </section>

          {/* Tips */}
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)] mb-3">Tips</h3>
            <ul className="space-y-1.5 list-disc list-inside">
              <li>Hover over sequence names for clinical descriptions.</li>
              <li>The global slice slider syncs anatomical position across all dates.</li>
              <li>All settings persist automatically in your browser.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
