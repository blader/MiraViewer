import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAiAnnotation } from '../src/hooks/useAiAnnotation';

vi.mock('../src/utils/aiClient', () => ({
  runAcpAnnotateClient: vi.fn().mockResolvedValue({
    blob: new Blob([new Uint8Array([1])]),
    mimeType: 'image/png',
    analysisText: 'ok',
    nanoBananaPrompt: 'prompt',
  }),
}));

describe('useAiAnnotation', () => {
  it('sets error when viewer handle is missing', async () => {
    const { result } = renderHook(() => useAiAnnotation());
    await act(async () => {
      await result.current.runAnalysis(
        { date: '2024-01-01', studyId: 's', seriesUid: 'u', instanceIndex: 0 },
        null,
        {}
      );
    });
    expect(result.current.status).toBe('error');
  });

  it('runs analysis successfully', async () => {
    const { result } = renderHook(() => useAiAnnotation());
    const viewer = {
      captureVisiblePng: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1])], { type: 'image/png' })),
    };

    await act(async () => {
      await result.current.runAnalysis(
        { date: '2024-01-01', studyId: 's', seriesUid: 'u', instanceIndex: 0 },
        viewer,
        {}
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.imageUrl).toBeTruthy();
    expect(result.current.prompt).toBe('prompt');
  });

  it('clear resets state', async () => {
    const { result } = renderHook(() => useAiAnnotation());
    act(() => result.current.clear());
    expect(result.current.status).toBe('idle');
    expect(result.current.imageUrl).toBeNull();
  });
});
