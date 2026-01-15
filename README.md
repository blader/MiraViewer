# MiraViewer

A web-based DICOM viewer for MRI brain scans, optimized for comparing the same sequence across multiple dates.

![MiraViewer](https://img.shields.io/badge/React-19-blue) ![Python](https://img.shields.io/badge/Python-3.11+-green) ![License](https://img.shields.io/badge/License-Private-red)

## Features

- **Comparison Matrix**: View the selected sequence across multiple dates in a synchronized grid.
- **Overlay Mode**: Flip between dates quickly for visual comparison (including hold-to-compare).
- **Synchronized Slice Navigation**: Use the bottom slider (or scroll) to keep anatomical position aligned across dates.
- **Per-date Panel Settings**: Persist slice offset, zoom, rotation, brightness/contrast, and pan per date.
- **Interaction**: Scroll to change slices, click to center on a point, double-click to reset pan.
- **Clinical Tooltips**: Hover sequence names for concise sequence descriptions.

## Quick Start

```bash
./start.sh
```

This will:
1. Create a Python virtual environment (if needed)
2. Install Python dependencies
3. Install Node.js dependencies (if needed)
4. Start the backend server on port 9000
5. Start the frontend dev server on port 6173

Then open http://localhost:6173 in your browser.

## Manual Setup

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Importing DICOMs

MiraViewer serves **pre-exported PNG images** and reads metadata from a local SQLite database (`dicom_metadata.db`).

To use your own DICOMs, run the exporter to scan your DICOM files, extract metadata, and render per-slice PNGs.

Make sure backend dependencies are installed first (e.g. run `./start.sh` once, or follow the Backend steps above).

```bash
# From the repo root (recommended: use the project venv)
backend/venv/bin/python backend/export_dicom.py
```

This will:
- Scan `mri_scans/` recursively
- Write images to `exported_images/`
- Write/update metadata in `dicom_metadata.db`

### Import a folder (any structure)

You can point the exporter at any directory containing DICOMs (it will scan recursively):

```bash
backend/venv/bin/python backend/export_dicom.py /path/to/dicom_folder
```

### Import one or more files

```bash
backend/venv/bin/python backend/export_dicom.py /path/to/image1.dcm /path/to/image2.dcm
```

### Tips

- If your DICOMs have unusual/no extensions and aren’t being picked up, try:

```bash
backend/venv/bin/python backend/export_dicom.py --scan-all-files /path/to/dicom_folder
```

- If you want the `study_folder` label to come from the first directory under the scan root (useful when importing a directory containing multiple studies):

```bash
backend/venv/bin/python backend/export_dicom.py --group-by-top-level-folder /path/to/dicom_root
```

- To completely reset your local dataset, delete `exported_images/` and `dicom_metadata.db` and rerun the exporter.

## Project Structure

```
MiraViewer/
├── backend/
│   ├── main.py           # FastAPI server (serves pre-exported images + metadata)
│   ├── export_dicom.py   # Offline exporter/indexer (DICOM -> PNG + SQLite)
│   └── requirements.txt  # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── hooks/        # Custom React hooks
│   │   ├── types/        # TypeScript type definitions
│   │   └── utils/        # Utility functions
│   └── ...
├── mri_scans/            # Place DICOMs here (optional; exporter can also scan arbitrary paths)
├── exported_images/      # Generated (ignored by git)
├── dicom_metadata.db     # Generated (ignored by git)
└── start.sh              # Startup script
```

## Keyboard Shortcuts

- **Scroll** on image — navigate slices
- **Click** on image — center on point
- **Double-click** — reset pan

Overlay mode:
- **1-9** — jump to date by number
- **← / →** — previous / next date
- **Hold Space** — quick compare with previously viewed date

## API Endpoints

- `GET /api/comparison-data` - Sequences/dates + mapping for the comparison matrix
- `GET /api/panel-settings/{combo_id}` - Load per-date panel settings for a sequence combo
- `POST /api/panel-settings` - Save per-date panel settings
- `GET /api/image/{study_id}/{series_uid}/{instance_index}` - Fetch a pre-exported image
- `GET /api/stats` - Basic DB stats

Legacy endpoints still exist in the backend (e.g. `/api/studies`) but are not currently used by the main UI.

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Backend**: Python, FastAPI, pydicom, NumPy, Pillow
- **Icons**: Lucide React
