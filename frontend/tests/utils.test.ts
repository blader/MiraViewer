import { describe, it, expect } from 'vitest';
import { clamp, clampInt, getSliceIndex, getProgressFromSlice, normalizeRotation } from '../src/utils/math';
import { formatDate, formatRotation } from '../src/utils/format';
import { formatSequenceLabel, getSequenceTooltip } from '../src/utils/clinicalData';
import { base64ToBlob, blobToBase64Data } from '../src/utils/base64';
import { getImageUrl, fetchNanoBananaProAcpAnnotation, uploadDicomArchive } from '../src/utils/api';

describe('math utils', () => {
  it('clamps values', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });

  it('clamps integers', () => {
    expect(clampInt(4.9, 0, 4)).toBe(4);
    expect(clampInt(-2.2, 0, 4)).toBe(0);
  });

  it('maps progress to slice and back', () => {
    const idx = getSliceIndex(10, 0.5, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    const progress = getProgressFromSlice(idx, 10, 0);
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(1);
  });

  it('normalizes rotation', () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
  });
});

describe('format utils', () => {
  it('formats date', () => {
    expect(formatDate('2024-01-01T00:00:00')).toMatch(/Jan/);
  });

  it('formats rotation', () => {
    expect(formatRotation(0)).toBe('0');
    expect(formatRotation(12.5)).toBe('12.5');
    expect(formatRotation(12.25)).toBe('12.25');
  });
});

describe('clinicalData utils', () => {
  it('formats sequence label', () => {
    expect(formatSequenceLabel({ id: 'a', plane: 'Axial', weight: 'T1', sequence: 'SE', label: '', date_count: 0 })).toBe('T1 SE');
  });

  it('returns tooltip text', () => {
    const text = getSequenceTooltip('T1', 'SE');
    expect(text).toMatch(/T1/i);
  });
});

describe('base64 utils', () => {
  it('converts base64 to blob and back', async () => {
    const base64 = btoa('hello');
    const blob = base64ToBlob(base64, 'text/plain');
    const out = await blobToBase64Data(blob);
    expect(out).toBe(base64);
  });
});

describe('api utils (offline)', () => {
  it('getImageUrl returns a placeholder imageId', () => {
    const url = getImageUrl('study', 'series', 1);
    expect(url).toMatch(/^miradb:/);
  });

  it('AI and upload APIs throw in offline mode', async () => {
    await expect(fetchNanoBananaProAcpAnnotation()).rejects.toThrow(/disabled/i);
    await expect(uploadDicomArchive()).rejects.toThrow(/offline/i);
  });
});
