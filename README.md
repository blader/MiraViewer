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
4. Start the backend server on port 8000
5. Start the frontend dev server on port 5173

Then open http://localhost:5173 in your browser.

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

## Project Structure

```
MiraViewer/
├── backend/
│   ├── main.py           # FastAPI server for DICOM processing
│   └── requirements.txt  # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── hooks/        # Custom React hooks
│   │   ├── types/        # TypeScript type definitions
│   │   └── utils/        # Utility functions
│   └── ...
├── mri_scans/            # DICOM data directory
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
