"""
MiraViewer Backend - Serves pre-exported images and metadata from SQLite
"""

import sqlite3
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi import Body

app = FastAPI(title="MiraViewer API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
DB_PATH = Path(__file__).parent.parent / "dicom_metadata.db"
EXPORTED_IMAGES_PATH = Path(__file__).parent.parent / "exported_images"


@contextmanager
def get_db():
    """Database connection context manager."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """Initialize auxiliary tables (idempotent)."""
    with get_db() as conn:
        cur = conn.cursor()
        # Per-panel settings for comparison view
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS panel_settings (
                combo_id TEXT NOT NULL,
                date_iso TEXT NOT NULL,
                offset INTEGER DEFAULT 0,
                zoom REAL DEFAULT 1.0,
                rotation REAL DEFAULT 0.0,
                brightness REAL DEFAULT 100.0,
                contrast REAL DEFAULT 100.0,
                pan_x REAL DEFAULT 0.0,
                pan_y REAL DEFAULT 0.0,
                progress REAL,
                PRIMARY KEY (combo_id, date_iso)
            )
            """
        )
        # Migration: add columns if missing
        cur.execute("PRAGMA table_info(panel_settings)")
        cols = {row[1] for row in cur.fetchall()}
        if "progress" not in cols:
            cur.execute("ALTER TABLE panel_settings ADD COLUMN progress REAL")
        if "brightness" not in cols:
            cur.execute("ALTER TABLE panel_settings ADD COLUMN brightness REAL DEFAULT 100.0")
        if "contrast" not in cols:
            cur.execute("ALTER TABLE panel_settings ADD COLUMN contrast REAL DEFAULT 100.0")
        if "pan_x" not in cols:
            cur.execute("ALTER TABLE panel_settings ADD COLUMN pan_x REAL DEFAULT 0.0")
        if "pan_y" not in cols:
            cur.execute("ALTER TABLE panel_settings ADD COLUMN pan_y REAL DEFAULT 0.0")
        conn.commit()


def format_study_date(date_str: Optional[str]) -> Optional[str]:
    """Convert YYYYMMDD to ISO format."""
    if not date_str or len(date_str) != 8:
        return date_str
    try:
        return f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T00:00:00"
    except:
        return date_str


def generate_study_id(study_uid: str) -> str:
    """Generate a short study ID from study instance UID."""
    return hashlib.md5(study_uid.encode()).hexdigest()[:12]


@app.on_event("startup")
async def on_startup():
    init_db()


@app.get("/")
async def root():
    return {"message": "MiraViewer API", "version": "2.0.0", "source": "sqlite"}


@app.get("/api/studies")
async def get_studies():
    """Get all available studies with their series."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Get unique studies - use GROUP BY to avoid duplicates
        cursor.execute("""
            SELECT
                study_instance_uid,
                MAX(study_date) as study_date,
                MAX(study_description) as study_description,
                MAX(study_folder) as study_folder,
                MAX(modality) as modality
            FROM dicom_images
            WHERE study_instance_uid IS NOT NULL
            GROUP BY study_instance_uid
            ORDER BY study_date DESC
        """)
        
        studies = []
        for row in cursor.fetchall():
            study_uid = row['study_instance_uid']
            study_id = generate_study_id(study_uid)
            
            # Get series for this study
            cursor.execute("""
                SELECT
                    series_instance_uid,
                    MAX(series_description) as series_description,
                    MAX(series_number) as series_number,
                    MAX(modality) as modality,
                    MAX(plane) as plane,
                    MAX(weight) as weight,
                    MAX(sequence_type) as sequence_type,
                    COUNT(*) as instance_count
                FROM dicom_images
                WHERE study_instance_uid = ?
                    AND exported_jpeg_path IS NOT NULL
                GROUP BY series_instance_uid
                ORDER BY series_number
            """, (study_uid,))
            
            series_list = []
            total_instances = 0
            for s in cursor.fetchall():
                series_list.append({
                    "series_uid": s['series_instance_uid'],
                    "series_description": s['series_description'] or "Unknown Series",
                    "series_number": s['series_number'] or 0,
                    "modality": s['modality'] or "MR",
                    "plane": s['plane'],
                    "weight": s['weight'],
                    "sequence_type": s['sequence_type'],
                    "instance_count": s['instance_count'],
                })
                total_instances += s['instance_count']
            
            if series_list:  # Only add studies with exportable images
                studies.append({
                    "study_id": study_id,
                    "study_instance_uid": study_uid,
                    "folder_name": row['study_folder'],
                    "study_date": format_study_date(row['study_date']),
                    "scan_type": row['study_description'] or row['modality'] or "Unknown",
                    "series": series_list,
                    "series_count": len(series_list),
                    "total_instances": total_instances,
                })
        
        return studies


@app.get("/api/studies/{study_id}")
async def get_study(study_id: str):
    """Get detailed information about a specific study."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Find the study by checking generated IDs
        cursor.execute("SELECT DISTINCT study_instance_uid FROM dicom_images")
        study_uid = None
        for row in cursor.fetchall():
            if generate_study_id(row['study_instance_uid']) == study_id:
                study_uid = row['study_instance_uid']
                break
        
        if not study_uid:
            raise HTTPException(status_code=404, detail="Study not found")
        
        # Get study info
        cursor.execute("""
            SELECT DISTINCT
                study_instance_uid,
                study_date,
                study_description,
                study_folder,
                modality,
                patient_name,
                patient_id
            FROM dicom_images
            WHERE study_instance_uid = ?
            LIMIT 1
        """, (study_uid,))
        
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Study not found")
        
        # Get series with instances
        cursor.execute("""
            SELECT
                series_instance_uid,
                MAX(series_description) as series_description,
                MAX(series_number) as series_number,
                MAX(modality) as modality,
                MAX(plane) as plane,
                MAX(weight) as weight,
                MAX(sequence_type) as sequence_type
            FROM dicom_images
            WHERE study_instance_uid = ?
                AND exported_jpeg_path IS NOT NULL
            GROUP BY series_instance_uid
            ORDER BY series_number
        """, (study_uid,))
        
        series_list = []
        total_instances = 0
        for s in cursor.fetchall():
            # Get instances for this series
            cursor.execute("""
                SELECT
                    id,
                    instance_number,
                    slice_location,
                    exported_jpeg_path
                FROM dicom_images
                WHERE study_instance_uid = ?
                    AND series_instance_uid = ?
                    AND exported_jpeg_path IS NOT NULL
                ORDER BY instance_number, slice_location
            """, (study_uid, s['series_instance_uid']))
            
            instances = []
            for inst in cursor.fetchall():
                instances.append({
                    "id": inst['id'],
                    "instance_number": inst['instance_number'],
                    "slice_location": inst['slice_location'],
                    "file_path": inst['exported_jpeg_path'],
                })
            
            series_list.append({
                "series_uid": s['series_instance_uid'],
                "series_description": s['series_description'] or "Unknown Series",
                "series_number": s['series_number'] or 0,
                "modality": s['modality'] or "MR",
                "plane": s['plane'],
                "weight": s['weight'],
                "sequence_type": s['sequence_type'],
                "instance_count": len(instances),
                "instances": instances,
            })
            total_instances += len(instances)
        
        return {
            "study_id": study_id,
            "study_instance_uid": study_uid,
            "folder_name": row['study_folder'],
            "study_date": format_study_date(row['study_date']),
            "scan_type": row['study_description'] or row['modality'] or "Unknown",
            "patient_name": row['patient_name'],
            "patient_id": row['patient_id'],
            "series": series_list,
            "series_count": len(series_list),
            "total_instances": total_instances,
        }


@app.get("/api/studies/{study_id}/series/{series_uid}")
async def get_series(study_id: str, series_uid: str):
    """Get series information including all instances."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Get series info
        cursor.execute("""
            SELECT
                series_instance_uid,
                MAX(series_description) as series_description,
                MAX(series_number) as series_number,
                MAX(modality) as modality,
                MAX(plane) as plane,
                MAX(weight) as weight,
                MAX(sequence_type) as sequence_type
            FROM dicom_images
            WHERE series_instance_uid = ?
            GROUP BY series_instance_uid
        """, (series_uid,))
        
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Series not found")
        
        # Get instances
        cursor.execute("""
            SELECT
                id,
                instance_number,
                slice_location,
                exported_jpeg_path
            FROM dicom_images
            WHERE series_instance_uid = ?
                AND exported_jpeg_path IS NOT NULL
            ORDER BY instance_number, slice_location
        """, (series_uid,))
        
        instances = []
        for inst in cursor.fetchall():
            instances.append({
                "id": inst['id'],
                "instance_number": inst['instance_number'],
                "slice_location": inst['slice_location'],
                "file_path": inst['exported_jpeg_path'],
            })
        
        return {
            "series_uid": row['series_instance_uid'],
            "series_description": row['series_description'] or "Unknown Series",
            "series_number": row['series_number'] or 0,
            "modality": row['modality'] or "MR",
            "plane": row['plane'],
            "weight": row['weight'],
            "sequence_type": row['sequence_type'],
            "instance_count": len(instances),
            "instances": instances,
        }


@app.get("/api/image/{study_id}/{series_uid}/{instance_index}")
async def get_image(study_id: str, series_uid: str, instance_index: int):
    """Get a pre-exported image."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Get instances for this series, ordered
        cursor.execute("""
            SELECT exported_jpeg_path
            FROM dicom_images
            WHERE series_instance_uid = ?
                AND exported_jpeg_path IS NOT NULL
            ORDER BY instance_number, slice_location
        """, (series_uid,))
        
        instances = cursor.fetchall()
        
        if not instances or instance_index < 0 or instance_index >= len(instances):
            raise HTTPException(status_code=404, detail="Image not found")
        
        image_path = Path(instances[instance_index]['exported_jpeg_path'])
        
        if not image_path.exists():
            raise HTTPException(status_code=404, detail=f"Image file not found: {image_path}")
        
        return FileResponse(
            image_path,
            media_type="image/png",
            headers={"Cache-Control": "max-age=86400"}  # Cache for 24 hours
        )


@app.get("/api/image-metadata/{study_id}/{series_uid}/{instance_index}")
async def get_image_metadata(study_id: str, series_uid: str, instance_index: int):
    """Get metadata for a specific image."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Get instances for this series, ordered
        cursor.execute("""
            SELECT *
            FROM dicom_images
            WHERE series_instance_uid = ?
                AND exported_jpeg_path IS NOT NULL
            ORDER BY instance_number, slice_location
        """, (series_uid,))
        
        instances = cursor.fetchall()
        
        if not instances or instance_index < 0 or instance_index >= len(instances):
            raise HTTPException(status_code=404, detail="Image not found")
        
        row = instances[instance_index]
        
        return {
            "series_uid": row['series_instance_uid'],
            "series_description": row['series_description'],
            "series_number": row['series_number'],
            "instance_number": row['instance_number'],
            "slice_location": row['slice_location'],
            "rows": row['rows'],
            "columns": row['columns'],
            "patient_name": row['patient_name'],
            "study_date": row['study_date'],
            "modality": row['modality'],
            "window_center": row['window_center'],
            "window_width": row['window_width'],
            "slice_thickness": row['slice_thickness'],
            "pixel_spacing": row['pixel_spacing'],
            "manufacturer": row['manufacturer'],
            "institution_name": row['institution_name'],
            "magnetic_field_strength": row['magnetic_field_strength'],
            "repetition_time": row['repetition_time'],
            "echo_time": row['echo_time'],
            "flip_angle": row['flip_angle'],
        }


def slugify_combo(plane: Optional[str], weight: Optional[str], sequence: Optional[str]) -> str:
    parts = [p for p in [(plane or ""), (weight or ""), (sequence or "")] if p]
    slug = "-".join(parts).lower().replace(" ", "-")
    return slug or "unknown"


def label_combo(plane: Optional[str], weight: Optional[str], sequence: Optional[str]) -> str:
    parts = []
    if plane:
        parts.append(plane)
    if weight:
        parts.append(weight)
    if sequence:
        parts.append(sequence)
    return " ".join(parts) if parts else "Unknown"


@app.get("/api/comparison-data")
async def get_comparison_data():
    """Return grouping info for plane/weight/sequence across all dates and studies.

    Response shape:
    {
      "planes": ["Axial", "Coronal", "Sagittal"],
      "dates": ["2024-09-23T00:00:00", ...],
      "sequences": [
        {"id": "axial-t2-flair", "plane": "Axial", "weight": "T2", "sequence": "FLAIR", "label": "Axial T2 FLAIR", "date_count": 10}
      ],
      "series_map": {
        "axial-t2-flair": {
          "2024-09-23T00:00:00": {"study_id": "abc123def456", "series_uid": "...", "instance_count": 120},
          ...
        }
      }
    }
    """
    with get_db() as conn:
        cur = conn.cursor()

        # Planes
        cur.execute("SELECT DISTINCT plane FROM dicom_images WHERE plane IS NOT NULL ORDER BY plane")
        planes = [r[0] for r in cur.fetchall()]

        # Dates derived from studies (unique by study UID)
        cur.execute(
            """
            SELECT study_instance_uid, MAX(study_date) as study_date
            FROM dicom_images
            WHERE study_instance_uid IS NOT NULL
            GROUP BY study_instance_uid
            ORDER BY study_date
            """
        )
        date_rows = cur.fetchall()
        # list of iso strings
        all_dates_iso = []
        study_uid_by_iso: Dict[str, str] = {}
        study_id_by_uid: Dict[str, str] = {}
        for r in date_rows:
            iso = format_study_date(r[1])
            if not iso:
                continue
            all_dates_iso.append(iso)
            study_uid_by_iso[iso] = r[0]
            study_id_by_uid[r[0]] = generate_study_id(r[0])

        # Build combinations and mapping
        cur.execute(
            """
            SELECT plane, weight, sequence_type, study_instance_uid, series_instance_uid,
                   COUNT(*) as instance_count, MAX(study_date) as study_date
            FROM dicom_images
            WHERE exported_jpeg_path IS NOT NULL
            GROUP BY plane, weight, sequence_type, study_instance_uid, series_instance_uid
            """
        )
        rows = cur.fetchall()

        sequences: Dict[str, Dict[str, Any]] = {}
        series_map: Dict[str, Dict[str, Any]] = {}

        for r in rows:
            plane, weight, sequence, study_uid, series_uid, instance_count, study_date = (
                r[0], r[1], r[2], r[3], r[4], r[5], r[6]
            )
            iso = format_study_date(study_date)
            if not iso:
                continue
            combo_id = slugify_combo(plane, weight, sequence)
            if combo_id not in sequences:
                sequences[combo_id] = {
                    "id": combo_id,
                    "plane": plane,
                    "weight": weight,
                    "sequence": sequence,
                    "label": label_combo(plane, weight, sequence),
                    "date_count": 0,
                }
            # map entry
            if combo_id not in series_map:
                series_map[combo_id] = {}
            if iso not in series_map[combo_id]:
                series_map[combo_id][iso] = {
                    "study_id": study_id_by_uid.get(study_uid, generate_study_id(study_uid)),
                    "series_uid": series_uid,
                    "instance_count": instance_count,
                }
                sequences[combo_id]["date_count"] += 1

        # Sort sequences by plane, then label
        seq_list = sorted(
            sequences.values(),
            key=lambda s: (s.get("plane") or "", s.get("weight") or "", s.get("sequence") or "")
        )

        return {
            "planes": planes,
            "dates": sorted(set(all_dates_iso)),
            "sequences": seq_list,
            "series_map": series_map,
        }


@app.get("/api/panel-settings/{combo_id}")
async def get_panel_settings(combo_id: str):
    """Return all saved panel settings for a given combo (sequence id).
    Response: { "combo_id": str, "settings": { date_iso: {offset, zoom, rotation, brightness, contrast, panX, panY, progress} } }
    """
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT date_iso, offset, zoom, rotation, brightness, contrast, pan_x, pan_y, progress FROM panel_settings WHERE combo_id = ?",
            (combo_id,)
        )
        settings = {}
        for row in cur.fetchall():
            settings[row[0]] = {
                "offset": row[1],
                "zoom": row[2],
                "rotation": row[3],
                "brightness": row[4],
                "contrast": row[5],
                "panX": row[6],
                "panY": row[7],
                "progress": row[8],
            }
        return {"combo_id": combo_id, "settings": settings}


@app.post("/api/panel-settings")
async def upsert_panel_settings(payload: dict = Body(...)):
    """Upsert a single panel setting.
    Body: { combo_id: str, date_iso: str, offset?: int, zoom?: float, rotation?: float, brightness?: float, contrast?: float, panX?: float, panY?: float, progress?: float }
    """
    required = ["combo_id", "date_iso"]
    for k in required:
        if k not in payload:
            raise HTTPException(status_code=400, detail=f"Missing field: {k}")
    combo_id = payload["combo_id"]
    date_iso = payload["date_iso"]
    offset = int(payload.get("offset", 0))
    zoom = float(payload.get("zoom", 1.0))
    rotation = float(payload.get("rotation", 0.0))
    brightness = float(payload.get("brightness", 100.0))
    contrast = float(payload.get("contrast", 100.0))
    pan_x = float(payload.get("panX", 0.0))
    pan_y = float(payload.get("panY", 0.0))
    progress = payload.get("progress")
    progress_val = float(progress) if progress is not None else None

    with get_db() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO panel_settings (combo_id, date_iso, offset, zoom, rotation, brightness, contrast, pan_x, pan_y, progress)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(combo_id, date_iso) DO UPDATE SET
                offset=excluded.offset,
                zoom=excluded.zoom,
                rotation=excluded.rotation,
                brightness=excluded.brightness,
                contrast=excluded.contrast,
                pan_x=excluded.pan_x,
                pan_y=excluded.pan_y,
                progress=COALESCE(excluded.progress, panel_settings.progress)
            """,
            (combo_id, date_iso, offset, zoom, rotation, brightness, contrast, pan_x, pan_y, progress_val)
        )
        conn.commit()
        return {"status": "ok"}


@app.get("/api/stats")
async def get_stats():
    """Get database statistics."""
    with get_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT COUNT(*) FROM dicom_images")
        total_images = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM dicom_images WHERE exported_jpeg_path IS NOT NULL")
        exported_images = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(DISTINCT study_instance_uid) FROM dicom_images")
        total_studies = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(DISTINCT series_instance_uid) FROM dicom_images")
        total_series = cursor.fetchone()[0]
        
        return {
            "total_images": total_images,
            "exported_images": exported_images,
            "total_studies": total_studies,
            "total_series": total_series,
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
