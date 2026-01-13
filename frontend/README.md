# MiraViewer Frontend

This package contains the React/TypeScript UI for MiraViewer.

## Development

```bash
npm install
npm run dev
```

Vite proxies all `/api/*` requests to the backend (see `vite.config.ts`).

## Scripts

- `npm run dev` — start the frontend dev server
- `npm run build` — typecheck and build production assets
- `npm run lint` — run ESLint
- `npm run preview` — serve the production build locally

## Where to look in the code

- `src/components/ComparisonMatrix.tsx` — main UI (grid + overlay views)
- `src/components/DicomViewer.tsx` — image display + interactions (scroll, click-to-center)
- `src/hooks/usePanelSettings.ts` — per-date panel settings persistence
- `src/utils/api.ts` — API client for the backend
