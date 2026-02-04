import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import checker from 'vite-plugin-checker'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import type { PluginOption } from 'vite'

// https://vite.dev/config/
export default defineConfig(() => {
  const isVitest = process.env.VITEST === 'true';
  const plugins: PluginOption[] = [react(), tailwindcss()];

  if (!isVitest) {
    // ITK-Wasm pipelines are lazy-loaded assets (JS + Wasm). We vendor them into
    // the output directory so runtime fetches are same-origin and predictable.
    plugins.push(
      viteStaticCopy({
        targets: [
          {
            src: 'node_modules/@itk-wasm/elastix/dist/pipelines/*.{js,wasm,wasm.zst}',
            dest: 'pipelines/',
          },
          // onnxruntime-web dynamically loads helper .mjs modules + .wasm binaries at runtime.
          // We vendor these into the output so segmentation can run fully offline.
          {
            src: 'node_modules/onnxruntime-web/dist/ort*.{mjs,wasm}',
            dest: 'onnxruntime/',
          },
        ],
      })
    );

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
    // Avoid pre-bundling ITK-Wasm packages. These rely on lazy-loaded web workers
    // and Emscripten modules that can break when optimized.
    optimizeDeps: {
      exclude: ['itk-wasm', '@itk-wasm/elastix', '@thewtex/zstddec', 'onnxruntime-web'],
    },
    // Expose only Vite-prefixed env vars to the client.
    envPrefix: ['VITE_'],
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
