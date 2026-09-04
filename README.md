# MiraViewer

A browser-based DICOM viewer for MRI brain scans, optimized for comparing the same sequence across multiple dates. Processes scans entirely in the browser with local IndexedDB storage. A web host or the offline local HTTP launcher serves the application; no imaging backend receives your scans.

![MiraViewer](https://img.shields.io/badge/React-19-blue) ![License](https://img.shields.io/badge/License-Private-red)

## Features

- **Local Storage**: Imported scans and saved work stay in browser IndexedDB
- **DICOM Import**: Import folders or ZIP archives of DICOM files directly in the browser
- **Export/Backup**: Download your data as a ZIP for backup or transfer
- **Comparison Matrix**: View the selected sequence across multiple dates in a synchronized grid
- **Overlay Mode**: Flip between dates quickly for visual comparison (including hold-to-compare)
- **Synchronized Slice Navigation**: Browse panels together; accepted physical alignments map corresponding planes
- **Per-date Panel Settings**: Persist slice offset, zoom, rotation, brightness/contrast, and pan per date
- **Cornerstone.js Rendering**: Native DICOM rendering with pan, zoom, and window/level controls

## Quick Start

```bash
git lfs install
git lfs pull
cd frontend
npm ci
npm run dev
```

Pinned public ONNX weights use Git LFS. Builds verify their byte counts and hashes;
an unresolved pointer produces an actionable error. For Vercel Git deployments,
enable **Git LFS** in the project's Git settings before deploying this branch.

Independent-2D reconstructions support manual brush editing but do not offer
Auto-fill; learned proposals require an accepted native source. The 3D source plane
defaults to **Exact source pixels**; **Blend with anatomy** is an explicit display option.

Then open http://localhost:43124 in your browser.

## Downloadable ZIP (offline)

This repo can produce a “download-and-run” ZIP for non-technical users.

### Build the ZIP (developer)

```bash
cd frontend
npm install
npm run package:zip
```

Output:

- `frontend/release/MiraViewer.zip`

### Run from the ZIP (end user)

1. Download `MiraViewer.zip` and unzip it.
2. Start MiraViewer:
   - macOS: double-click `start.command`
   - Windows: double-click `start.bat`
   - Linux: run `start.sh`
3. Your browser should open automatically. Keep the Terminal/Command Prompt window open while using MiraViewer.

Notes:

- The app still runs entirely in your browser; the launcher only starts a tiny local HTTP server.
- Data is stored locally in your browser (IndexedDB). Use **Application menu → Export backup (ZIP)** to create a backup.

## Importing DICOMs

Click **Import scans** in the empty workspace or **Import additional scans** in the populated header:

- Select a folder containing DICOM files
- Or select a ZIP archive

Files are parsed in-browser and stored in IndexedDB.

## Exporting/Backup

Open **Application menu → Export backup (ZIP)**. A versioned snapshot includes the selected patient's DICOM files, saved panel settings, outlines, volume labels, derived alignment frames, app preferences and model records.

To restore, open Import and choose **Choose backup / ZIP**, review the contents and confirm restoration. Restore can overwrite matching saved work and preferences.

**Current capacity limit:** full-backup restore accepts at most 512 MiB of declared payloads; export can still create a larger archive. Keep original DICOM files and verify a backup can be restored before relying on it. Large streaming backups remain active work.

## Storage Warning

⚠️ Data is stored in browser IndexedDB. Clearing site data will erase all scans.

Storage belongs to the exact browser profile and origin (hostname and port). The app requests persistent storage to reduce the chance of data loss, but browser behavior varies. Use the export feature to back up important data.

## Project Structure

See the [architecture and validation guide](agent_docs/design-docs/miraviewer-architecture.md) for current ownership boundaries, browser/model checks and known limits.

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
