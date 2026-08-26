import { describe, expect, it } from 'vitest';
import { formatDate } from '../src/utils/format';

describe('examination date presentation', () => {
  it('keeps an acquisition time visible so same-day examinations remain distinguishable', () => {
    expect(formatDate('2024-03-12T09:30:00')).toMatch(/Mar 12, 2024.*9:30/i);
  });

  it('formats duplicate-time examination keys without exposing raw study UIDs', () => {
    const first = formatDate('2024-03-12T00:00:00#1.2.840.100');
    const second = formatDate('2024-03-12T00:00:00#1.2.840.101');

    expect(first).toMatch(/Mar 12, 2024.*exam/i);
    expect(second).toMatch(/Mar 12, 2024.*exam/i);
    expect(first).not.toBe(second);
    expect(first).not.toContain('1.2.840');
  });
});
