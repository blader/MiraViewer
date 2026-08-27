import { Check, Loader2, Pause, Play, RotateCw } from 'lucide-react';

export function AutomaticAlignmentStatus({
  enabled,
  busy,
  aligned,
  targets,
  manual,
  onToggle,
  onRealign,
}: {
  enabled: boolean;
  busy: boolean;
  aligned: number;
  targets: number;
  manual: boolean;
  onToggle: () => void;
  onRealign: () => void;
}) {
  const complete = targets > 0 && aligned === targets;
  const ToggleIcon = enabled ? Pause : Play;
  const label = !enabled
    ? 'Alignment paused'
    : busy
      ? 'Aligning scans…'
      : complete
        ? 'Scans aligned'
        : manual
          ? 'Manual adjustments kept'
          : 'Automatic alignment';
  return (
    <div className="instrument-alignment-status" aria-label="Automatic alignment controls">
      <span
        role="status"
        aria-live="polite"
        aria-label="Automatic alignment status"
        title="Scans align to the first visible examination using anatomy-rich neighboring slices. No region selection is needed."
      >
        {busy && enabled ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : complete && enabled ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : null}
        <span className="instrument-alignment-label">{label}</span>
      </span>
      <button
        type="button"
        className="instrument-icon-button"
        onClick={onToggle}
        title={enabled ? 'Pause automatic alignment' : 'Resume automatic alignment'}
        aria-label={enabled ? 'Pause automatic alignment' : 'Resume automatic alignment'}
      >
        <ToggleIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="instrument-icon-button"
        onClick={onRealign}
        title="Realign visible scans, replacing manual overrides"
        aria-label="Realign visible scans"
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
