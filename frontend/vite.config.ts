import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import checker from 'vite-plugin-checker'
import type { PluginOption } from 'vite'

// https://vite.dev/config/
export default defineConfig(() => {
  const isVitest = process.env.VITEST === 'true';
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (!isVitest) {
    plugins.push(
      checker({
        typescript: true,
        eslint: {
          lintCommand: 'eslint "src/**/*.{ts,tsx}"',
          useFlatConfig: true,
        },
      })
    );
  }
  return {
    plugins,
    // Expose only the specific env vars we need to the client.
    // Note: this still means the API key is available in the browser when using client-side AI.
    envPrefix: ['VITE_', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    server: {
      // Keep a stable dev URL and avoid Vite auto-incrementing to 43125/43126 if 43124 is already in use.
      port: 43124,
      strictPort: true,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
      clearMocks: true,
      threads: false,
    },
  };
});
