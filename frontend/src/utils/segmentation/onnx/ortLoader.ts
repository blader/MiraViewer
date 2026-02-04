import type * as Ort from 'onnxruntime-web';

// We intentionally load ORT from:
// - dev: the installed `onnxruntime-web` module (Vite can serve wasm assets correctly)
// - prod: statically-copied assets under /onnxruntime/ (works fully offline)
let ortPromise: Promise<typeof Ort> | null = null;

export async function loadOrtAll(): Promise<typeof Ort> {
  if (ortPromise) return ortPromise;

  ortPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;

    if (import.meta.env.DEV) {
      // In dev, load from the package so Vite can handle wasm asset URLs.
      mod = await import('onnxruntime-web');
    } else {
      // In production builds, load from our vendored runtime assets.
      // IMPORTANT: keep the specifier non-literal so Vite/Vitest don't try to resolve it during import analysis.
      const bundleUrl = '/onnxruntime/' + 'ort.all.bundle.min.mjs';
      mod = await import(/* @vite-ignore */ bundleUrl);
    }

    // The ESM bundles export both named exports and a default export.
    const ort: typeof Ort = (mod?.default ?? mod) as typeof Ort;

    // Prefer stability: threads require COOP/COEP (crossOriginIsolated) which we don't assume.
    ort.env.wasm.numThreads = 1;

    if (!import.meta.env.DEV) {
      // Ensure ORT can locate its runtime assets.
      ort.env.wasm.wasmPaths = '/onnxruntime/';
    }

    return ort;
  })();

  return ortPromise;
}

export async function createOrtSessionFromModelBlob(params: {
  model: Blob;
  preferWebGpu?: boolean;
  logLevel?: Ort.Env['logLevel'];
}): Promise<Ort.InferenceSession> {
  const ort = await loadOrtAll();

  if (params.logLevel) {
    ort.env.logLevel = params.logLevel;
  }


  const bytes = await params.model.arrayBuffer();

  const baseOpts: Ort.InferenceSession.SessionOptions = {
    graphOptimizationLevel: 'all',
  };

  if (params.preferWebGpu) {
    // Try WebGPU first; if unavailable, ORT will pick the best available provider.
    // NOTE: this requires the /onnxruntime/ assets to be present in the build output.
    baseOpts.executionProviders = ['webgpu', 'wasm'];
  } else {
    baseOpts.executionProviders = ['wasm'];
  }

  return ort.InferenceSession.create(bytes, baseOpts);
}
