# MiraViewer Frontend

This package contains the React/TypeScript UI for MiraViewer.

## Development

```bash
npm install
npm run dev
```

## Downloadable ZIP (offline)

Build a “download-and-run” ZIP:

```bash
npm run package:zip
```

Output:
- `release/MiraViewer.zip`

End-user instructions are included inside the ZIP as `README.txt`.

## Scripts

- `npm run dev` — start the frontend dev server
- `npm run build` — typecheck and build production assets
- `npm run lint` — run ESLint
- `npm run preview` — serve the production build locally

## Where to look in the code

- `src/components/ComparisonMatrix.tsx` — main UI (grid + overlay views)
- `src/components/DicomViewer.tsx` — DICOM slice rendering + interactions
- `src/components/UploadModal.tsx` — DICOM import (folder/ZIP)
- `src/components/ExportModal.tsx` — export backups
- `src/hooks/usePanelSettings.ts` — per-date panel settings persistence
- `src/services/dicomIngestion.ts` — parse/store DICOMs into IndexedDB
- `src/services/exportBackup.ts` — build ZIP backups from IndexedDB
- `src/utils/localApi.ts` — local data access layer (IndexedDB)
