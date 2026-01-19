import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initCornerstone } from './utils/cornerstoneInit'
import { initStoragePersistence } from './db/db'

// Initialize services
initCornerstone();
initStoragePersistence();

// ITK-Wasm packages lazy-load their WebAssembly pipelines from a base URL.
// We vendor those assets into the Vite build output at /pipelines.
//
// Note: @itk-wasm/elastix has separate Node and browser entrypoints.
// In vitest (Node) we don't need pipeline initialization, and the Node entry
// does not export setPipelinesBaseUrl.
(async () => {
  try {
    const m: unknown = await import('@itk-wasm/elastix');
    const maybe = m as { setPipelinesBaseUrl?: (baseUrl: string | URL) => void };
    if (typeof maybe.setPipelinesBaseUrl !== 'function') return;

    const viteBaseUrl = import.meta.env.BASE_URL || '/';
    const pipelinesBaseUrl = new URL(`${viteBaseUrl}pipelines`, document.location.origin).href;
    maybe.setPipelinesBaseUrl(pipelinesBaseUrl);
  } catch {
    // Ignore: pipeline setup is an optional optimization at startup.
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
