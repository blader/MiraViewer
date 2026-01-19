# MiraViewer

A browser-based DICOM viewer for MRI brain scans, optimized for comparing the same sequence across multiple dates. Runs entirely in the browser with local IndexedDB storage—no server required.

![MiraViewer](https://img.shields.io/badge/React-19-blue) ![License](https://img.shields.io/badge/License-Private-red)

## Features

- **Local Storage**: All data stored in browser IndexedDB—no server needed
- **DICOM Upload**: Upload folders or ZIP archives of DICOM files directly in the browser
- **Export/Backup**: Download your data as a ZIP for backup or transfer
- **Comparison Matrix**: View the selected sequence across multiple dates in a synchronized grid
- **Overlay Mode**: Flip between dates quickly for visual comparison (including hold-to-compare)
- **Synchronized Slice Navigation**: Use the bottom slider (or scroll) to keep anatomical position aligned across dates
- **Per-date Panel Settings**: Persist slice offset, zoom, rotation, brightness/contrast, and pan per date
- **Cornerstone.js Rendering**: Native DICOM rendering with pan, zoom, and window/level controls
- **Clinical Tooltips**: Hover sequence names for concise sequence descriptions

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:43124 in your browser.

## Importing DICOMs

Click the **Upload** button in the header to import DICOM files:
- Select a folder containing DICOM files
- Or upload a ZIP archive

Files are parsed in-browser and stored in IndexedDB.

## Exporting/Backup

Click the **Download** button in the header to export your data as a ZIP file containing:
- All DICOM files
- Metadata JSON for each study

This can be used for backup or to transfer data to another browser/device.

## Storage Warning

⚠️ Data is stored in browser IndexedDB. Clearing site data will erase all scans.

The app requests persistent storage to reduce the chance of data loss, but browser behavior varies. Use the export feature to back up important data.

## Project Structure

```
MiraViewer/
└── frontend/
    ├── src/
    │   ├── components/   # React components
    │   ├── db/           # IndexedDB schema and helpers
    │   ├── hooks/        # Custom React hooks
    │   ├── services/     # DICOM ingestion, export
    │   ├── types/        # TypeScript type definitions
    │   └── utils/        # Utility functions, Cornerstone init
    ├── tests/            # Vitest tests
    └── ...
```

## Keyboard Shortcuts

- **Scroll** on image — navigate slices
- **Click** on image — center on point
- **Double-click** — reset pan

Overlay mode:
- **1-9** — jump to date by number
- **← / →** — previous / next date
- **Hold Space** — quick compare with previously viewed date

## Development

```bash
cd frontend
npm install
npm run dev      # Start dev server
npm run check    # Lint + tests
npm run build    # Production build
```

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **DICOM Parsing**: dicom-parser
- **Medical Imaging**: Cornerstone.js
- **Local Storage**: IndexedDB via idb
- **Icons**: Lucide React
