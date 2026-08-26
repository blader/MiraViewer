import { AccessibleDialog } from './ui/AccessibleDialog';

interface HelpModalProps {
  onClose: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[2px] border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-primary)]">
      {children}
    </kbd>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-[var(--text-primary)]">{children}</span>;
}

export function HelpModal({ onClose }: HelpModalProps) {
  return (
    <AccessibleDialog title="Help" description="Controls, comparison tools, and keyboard shortcuts." onClose={onClose}>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-6 text-sm leading-relaxed text-[var(--text-secondary)] sm:px-7">
        {/* Viewing */}
        <section className="border-b border-[var(--border-color)] pb-5">
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
            Viewing
          </h3>
          <ul className="space-y-2">
            <li>
              <Kbd>⌘</Kbd> + <Kbd>Scroll</Kbd> over an image to zoom.
            </li>
            <li>
              <Kbd>Scroll</Kbd> in the center pane to navigate slices.
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
        <section className="border-b border-[var(--border-color)] pb-5">
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
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
        <section className="border-b border-[var(--border-color)] pb-5">
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
            Aligning scans
          </h3>
          <ul className="space-y-2">
            <li>
              <Label>Drag a rectangle</Label> on any image (Grid or Overlay), then choose an action:
              <Label>Align All</Label> (exclude the selected region), <Label>Align Tumor</Label> (match its tumor
              slice), or <Label>Segment</Label> (start a tumor segmentation).
            </li>
            <li>
              <Label>Align All</Label> ignores pixels inside the selected region when matching scans.
            </li>
            <li>
              <Label>Align Tumor</Label> still aligns pose using surrounding healthy anatomy, then uses pixels inside
              the selected region only to match the tumor slice.
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
        <section className="border-b border-[var(--border-color)] pb-5">
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
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
        <section className="border-b border-[var(--border-color)] pb-5">
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
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
          <h3 className="mb-3 font-[family-name:var(--font-mono)] text-[0.68rem] uppercase tracking-[0.12em] text-[var(--signal-metal)]">
            Tips
          </h3>
          <ul className="space-y-1.5 list-disc list-inside">
            <li>The global slice slider syncs anatomical position across all dates.</li>
            <li>All settings persist automatically in your browser.</li>
          </ul>
        </section>
      </div>
    </AccessibleDialog>
  );
}
