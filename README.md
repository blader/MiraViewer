# MiraViewer

A modern web-based DICOM viewer for MRI brain scans with timeline comparison capabilities.

![MiraViewer](https://img.shields.io/badge/React-18-blue) ![Python](https://img.shields.io/badge/Python-3.11+-green) ![License](https://img.shields.io/badge/License-Private-red)

## Features

- **Timeline View**: Navigate through scan history organized by date
- **Series Navigation**: Browse different MRI sequences within each study
- **Slice Navigation**: Scroll through slices using mouse wheel or keyboard
- **Window/Level Controls**: Adjust brightness and contrast with medical imaging presets
- **Compare Mode**: Side-by-side comparison of scans from different dates with synchronized scrolling
- **Zoom & Pan**: Interactive image manipulation
- **Keyboard Shortcuts**: Efficient navigation with arrow keys, Page Up/Down, Home/End

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

| Action | Shortcut |
|--------|----------|
| Previous slice | ↑ or ← |
| Next slice | ↓ or → |
| First slice | Home |
| Last slice | End |
| Jump 10 slices back | Page Up |
| Jump 10 slices forward | Page Down |
| Scroll through slices | Mouse wheel |

## API Endpoints

- `GET /api/studies` - List all studies
- `GET /api/studies/{study_id}` - Get study details
- `GET /api/studies/{study_id}/series/{series_uid}` - Get series details
- `GET /api/image/{study_id}/{series_uid}/{instance_index}` - Get image as PNG
- `GET /api/image-metadata/{study_id}/{series_uid}/{instance_index}` - Get image DICOM metadata

## Window Presets

| Preset | Window Center | Window Width |
|--------|--------------|--------------|
| Brain | 40 | 80 |
| Subdural | 75 | 215 |
| Stroke | 32 | 8 |
| Bone | 600 | 2800 |
| Soft Tissue | 50 | 350 |

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Backend**: Python, FastAPI, pydicom, NumPy, Pillow
- **Icons**: Lucide React
