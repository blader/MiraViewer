import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';

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
