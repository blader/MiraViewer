import type { InteractiveSelectionMemoryError } from '../utils/segmentation/interactiveAdmission';

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;

export function SelectionMemoryDetails({ error }: { error: InteractiveSelectionMemoryError }) {
  const { estimate, counts } = error;
  const phases = [
    ['Preparing MRI samples', estimate.sourcePeakBytes],
    ['Suggesting boundaries', estimate.trackingPeakBytes],
    ['Saving the selection', estimate.publicationPeakBytes],
  ] as const;
  const tracking = [
    ['Existing MRI, viewers and history', estimate.retainedBytes],
    ['Native MRI region and output mask', estimate.contextBytes + estimate.contextMaskBytes],
    ['Model and runtime reserve', estimate.runtimeAllowanceBytes],
    [
      'Cross-slice tracking',
      estimate.retainedStateBytes + estimate.packedMemoryBytes + estimate.temporalAttentionBytes,
    ],
    ['Busiest slice’s prompts', estimate.promptAttentionBytes],
    ['Working buffers', estimate.frameScratchBytes],
  ] as const;
  return (
    <details className="svr-selection-memory">
      <summary>Memory estimate details</summary>
      <p>Estimated peak by stage. Stages do not run together; only the largest counts toward the safety budget.</p>
      <dl>
        {phases.map(([label, bytes]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{mib(bytes)}</dd>
          </div>
        ))}
      </dl>
      <p>Boundary-suggestion breakdown</p>
      <dl>
        {tracking.map(([label, bytes]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{mib(bytes)}</dd>
          </div>
        ))}
      </dl>
      <p>
        {counts.conditioningFrames} marked {counts.conditioningFrames === 1 ? 'slice' : 'slices'} ·{' '}
        {counts.maximumFramePrompts} maximum {counts.maximumFramePrompts === 1 ? 'prompt' : 'prompts'} per slice ·{' '}
        {counts.literalMarkCount.toLocaleString()} literal marks kept
      </p>
      <p>The runtime reserve is conservative. These figures are estimates, not measured RAM usage.</p>
    </details>
  );
}
