import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAcpAnnotateClient } from '../src/utils/aiClient';

describe('aiClient', () => {

  beforeEach(() => {
    // Prevent real network calls if any.
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('throws when API key is missing', async () => {
    const hasKey = Boolean(
      import.meta.env.VITE_GOOGLE_API_KEY ||
        import.meta.env.VITE_GEMINI_API_KEY ||
        import.meta.env.GOOGLE_API_KEY ||
        import.meta.env.GEMINI_API_KEY
    );

    if (!hasKey) {
      await expect(
        runAcpAnnotateClient({
          imageBase64: 'abc',
          imageMimeType: 'image/png',
          seriesContext: {},
        })
      ).rejects.toThrow(/API key/i);
      return;
    }

    // If a key exists in this environment, mock the network calls and verify success path.
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '{"nano_banana_prompt": "prompt"}' }] } },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: btoa('x') } }] } },
          ],
        }),
      });

    const result = await runAcpAnnotateClient({
      imageBase64: 'abc',
      imageMimeType: 'image/png',
      seriesContext: {},
    });
    expect(result.nanoBananaPrompt).toContain('prompt');
  });
});
