"""
MiraViewer Backend - Serves pre-exported images and metadata from SQLite
"""

import sqlite3
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

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
            SELECT DISTINCT
                series_instance_uid,
                series_description,
                series_number,
                modality
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
            SELECT DISTINCT
                series_instance_uid,
                series_description,
                series_number,
                modality
            FROM dicom_images
            WHERE series_instance_uid = ?
            LIMIT 1
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
