import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { SelectionProposer, SelectionProposalResult } from '../../src/utils/segmentation/selectionProposal';

/** Explicit test capability; no second production solver or worker protocol. */
export const testSelectionProposer = vi.fn<SelectionProposer>();

export function proposedRegion(indices: Iterable<number> = [30, 31, 32], voxels = 12 ** 3): SelectionProposalResult {
  const data = new Uint8Array(voxels);
  for (const index of indices) data[index] = 1;
  return { data, contextLimited: false, boundaryCount: 0 };
}

export function setAutoFill(enabled: boolean) {
  const checkbox = screen.getByRole('checkbox', { name: 'Auto-fill' }) as HTMLInputElement;
  if (checkbox.checked !== enabled) fireEvent.click(checkbox);
}

export function paint(x = 5, y = 6, kind: 'Add' | 'Remove' = 'Add', cancel = false) {
  fireEvent.click(screen.getByRole('button', { name: kind }));
  fireEvent.change(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' }), {
    target: { value: '0.5' },
  });
  const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
  const point = {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 40 + ((x + 0.5) * 320) / 12,
    clientY: ((y + 0.5) * 320) / 12,
  };
  fireEvent.pointerDown(canvas, point);
  if (cancel) fireEvent.pointerCancel(canvas, point);
  else fireEvent.pointerUp(canvas, point);
}
