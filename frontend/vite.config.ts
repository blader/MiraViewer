import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import checker from 'vite-plugin-checker';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import type { PluginOption } from 'vite';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const privateArtifactsDirectory = fileURLToPath(new URL('./tmp/', import.meta.url)).replace(/\/$/, '');

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isVitest = process.env.VITEST === 'true';
  const usePolling = /^(1|true)$/i.test(process.env.CHOKIDAR_USEPOLLING ?? '');
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
          // The production loader imports ort.all.bundle.min.mjs. Its complete dynamic
          // closure is the JSEP helper and its WASM binary; other ORT entrypoints and
          // asyncify/base binaries are unused and add over 50 MB to every offline build.
          {
            src: [
              'node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs',
              'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
              'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
            ],
            dest: 'onnxruntime/',
          },
        ],
      }),
    );

    plugins.push(
      checker({
        typescript: true,
        eslint: {
          lintCommand: 'eslint "src/**/*.{ts,tsx}"',
          useFlatConfig: true,
          watchPath: 'src',
        },
      }),
    );
  }

  return {
    plugins,
    // Acceptance-only entrypoints are excluded from normal and offline builds.
    ...(mode === 'browser-test'
      ? {
          build: {
            rollupOptions: {
              input: {
                app: fileURLToPath(new URL('./index.html', import.meta.url)),
                probes: fileURLToPath(new URL('./tests/browser/probes.html', import.meta.url)),
              },
            },
          },
        }
      : {}),
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
      // On macOS Chokidar chooses FSEvents before reading the polling env var.
      // Set both options so opt-in polling actually refreshes edited worktrees.
      watch: {
        ...(usePolling ? { usePolling: true, useFsEvents: false } : {}),
        // Private MRI benchmarks include their own Python environment. They are
        // served on demand, never application source: polling tens of thousands
        // of these files can otherwise consume several CPU cores while idle.
        ignored: [privateArtifactsDirectory, `${privateArtifactsDirectory}/**`],
      },
      // Cross-origin isolation unlocks multithreaded WASM for ONNX inference (see
      // ortLoader.ts, which keys off crossOriginIsolated). Safe here because every runtime
      // asset (ORT, ITK pipelines, DICOM data) is same-origin. The offline launcher sends
      // the same headers as Vercel; unisolated custom hosts safely fall back to one WASM thread.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
      clearMocks: true,
      // Native-grid tests own large buffers; bound the worker pool on shared machines.
      maxWorkers: Math.min(4, availableParallelism()),
    },
  };
});
