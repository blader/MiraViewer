"""
MiraViewer Backend - Serves pre-exported images and metadata from SQLite
"""

import sqlite3
import hashlib
import os
import json
import base64
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
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

# Optional external AI integration (Gemini)
# - Analysis: Gemini 3 Pro (text) produces a detailed description + a segmentation/annotation prompt
# - Annotation: Nano Banana Pro model (image) returns an annotated image
NANO_BANANA_PRO_MODEL = os.environ.get("NANO_BANANA_PRO_MODEL", "nano-banana-pro-preview")
GEMINI_ANALYSIS_MODEL = os.environ.get("GEMINI_ANALYSIS_MODEL", "gemini-3-pro-preview")


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


def _get_exported_image_path(series_uid: str, instance_index: int) -> Path:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT exported_jpeg_path
            FROM dicom_images
            WHERE series_instance_uid = ?
                AND exported_jpeg_path IS NOT NULL
            ORDER BY instance_number, slice_location
            """,
            (series_uid,),
        )
        instances = cursor.fetchall()

        if not instances or instance_index < 0 or instance_index >= len(instances):
            raise HTTPException(status_code=404, detail="Image not found")

        image_path = Path(instances[instance_index]["exported_jpeg_path"])
        if not image_path.exists():
            raise HTTPException(status_code=404, detail=f"Image file not found: {image_path}")

        return image_path


def _guess_image_mime_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".png":
        return "image/png"
    # Conservative default.
    return "image/png"


def _normalize_model_name(model: str) -> str:
    m = (model or "").strip()
    if m.startswith("models/"):
        return m[len("models/"):]
    return m


def _get_google_api_key() -> str:
    # Support either env var name.
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="External AI is not configured (missing GEMINI_API_KEY or GOOGLE_API_KEY env var)",
        )
    return api_key


def _extract_text_response(raw_json: str) -> str:
    data = json.loads(raw_json)
    candidates = data.get("candidates") or []
    texts: list[str] = []
    for cand in candidates:
        parts = ((cand.get("content") or {}).get("parts") or [])
        for part in parts:
            text = part.get("text")
            if text:
                texts.append(text)
    return "\n".join(texts).strip()


def _try_parse_json_object(text: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
        return None
    except json.JSONDecodeError:
        # Best-effort extraction if the model wraps JSON in extra prose.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                return None
        return None


def _call_gemini_analysis(image_bytes: bytes, image_mime_type: str, prompt: str) -> str:
    api_key = _get_google_api_key()

    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{_normalize_model_name(GEMINI_ANALYSIS_MODEL)}:generateContent"

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inlineData": {
                            "mimeType": image_mime_type,
                            "data": base64.b64encode(image_bytes).decode("utf-8"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
        },
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8")
        except Exception:
            body = ""
        raise HTTPException(status_code=502, detail=f"Gemini analysis error: {body or e.reason}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"Gemini analysis connection error: {e.reason}")

    text = _extract_text_response(raw)
    if not text:
        raise HTTPException(status_code=502, detail="Gemini analysis returned no text")
    return text


def _build_acp_analysis_prompt(
    *,
    plane: Optional[str],
    weight: Optional[str],
    sequence_type: Optional[str],
    series_description: Optional[str],
    is_viewport_capture: bool,
) -> str:
    context_lines: list[str] = []
    if plane:
        context_lines.append(f"- Plane: {plane}")
    if weight:
        context_lines.append(f"- Weighting: {weight}")
    if sequence_type:
        context_lines.append(f"- Sequence type: {sequence_type}")
    if series_description:
        context_lines.append(f"- Series description: {series_description}")

    context_block = "\n".join(context_lines) if context_lines else "(none)"
    viewport_note = (
        "The provided image is a capture of the viewer viewport (it may already include zoom/rotation/pan, "
        "brightness/contrast adjustments, and cropping to what is visible in the cell). The capture is capped at ~512 px on its longest side for speed; keep output around this resolution (≈512 px max dimension)."
        if is_viewport_capture
        else "The provided image is the raw exported slice image."
    )

    return (
        "You are analyzing a single MRI brain slice image. "
        + viewport_note
        + "\n\n"
        "Series context (use as a hint; if metadata conflicts with image appearance, trust the image):\n"
        + context_block
        + "\n\n"
        "Your goal is to help an image-editing model (Nano Banana Pro) create a subtle, clinically legible overlay annotation focused on "
        "ACP (Adamantinomatous Craniopharyngioma) / craniopharyngioma-related findings in the sellar/suprasellar region.\n\n"
        "Prioritize assessment of tumor impact on critical/eloquent structures when visible: pituitary gland, pituitary stalk, hypothalamus, optic chiasm, optic nerves/tracts, third ventricle floor, cavernous sinus and adjacent internal carotid arteries. "
        "Describe mass effect, displacement, compression, encasement, or effacement, and explicitly state uncertainty when needed.\n\n"
        "Return ONLY valid JSON (no markdown, no code fences) with these keys:\n"
        "- detailed_description: a detailed description of what is visible in the slice (sequence/orientation if inferable, key anatomy, and the series context if relevant)\n"
        "- suspected_findings: any possible findings suggestive of craniopharyngioma/ACP (e.g., cystic components, solid nodules, calcification/hemorrhage cues), but be explicit about uncertainty\n"
        "- segmentation_guide: step-by-step segmentation and annotation guidance. Make it HIGHLY SPECIFIC and LOCALIZING: "
        "use concrete anatomical landmarks (sella turcica/pituitary fossa, pituitary stalk, optic chiasm, third ventricle, midline). "
        "State where in the image to search (e.g., center/inferior midline vs superior midline), expected shapes, and what to trace first. "
        "Include how to distinguish cystic vs solid components and how to mark calcification/hemorrhage cues when visible. "
        "Also include guidance for assessing/marking involvement of critical structures (e.g., stalk/chiasm/hypothalamus displacement or compression).\n"
        "- nano_banana_prompt: a single prompt string to send to Nano Banana Pro. It MUST: "
        "(1) explicitly mention 'Adamantinomatous Craniopharyngioma (ACP)' and must NOT refer to the anterior clinoid process; "
        "(2) include localizing instructions (where to look and which landmarks to use); "
        "(3) include explicit segmentation instructions (what boundaries/components to outline); "
        "(4) ALWAYS include labeling instructions: add small text labels (at least 2 labels) with arrows/leader lines, even if findings are subtle or absent; "
        "(5) for every label, include a concise clinical-impact annotation in a smaller font beneath the label (e.g., direction/degree of mass effect or compression/encasement, obstruction risk, cystic vs solid, uncertainty); "
        "(6) if visible/relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus, third ventricle) and indicate any displacement/compression; "
        "(7) use separate outlines/contours for each element/component (do not merge into one outline) and use DISTINCT COLORS per element (e.g., different colors for tumor boundary vs cystic component vs solid nodule vs calcification markers vs critical structures); "
        "(8) keep the output image around 512 px on its longest side (match input aspect as best you can); "
        "(9) request ONLY the edited/annotated image as output.\\n\\n"
        "Constraints:\\n"
        "- Do not hallucinate anatomy: only label structures you can reasonably localize on the slice; if uncertain, say so.\\n"
        "- Keep annotations subtle: thin outlines, small labels, avoid obscuring anatomy.\\n"
    )


def _call_nano_banana_pro(image_bytes: bytes, image_mime_type: str, prompt: str) -> tuple[bytes, str]:
    api_key = _get_google_api_key()

    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{_normalize_model_name(NANO_BANANA_PRO_MODEL)}:generateContent"

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inlineData": {
                            "mimeType": image_mime_type,
                            "data": base64.b64encode(image_bytes).decode("utf-8"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
        },
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8")
        except Exception:
            body = ""
        raise HTTPException(status_code=502, detail=f"Nano Banana Pro error: {body or e.reason}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"Nano Banana Pro connection error: {e.reason}")

    data = json.loads(raw)
    candidates = data.get("candidates") or []
    for cand in candidates:
        parts = ((cand.get("content") or {}).get("parts") or [])
        for part in parts:
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                mime = inline.get("mimeType") or "image/png"
                out_bytes = base64.b64decode(inline["data"])
                return out_bytes, mime

    raise HTTPException(status_code=502, detail="Nano Banana Pro did not return an image")


def _get_series_context(series_uid: str) -> dict:
    """Fetch best-effort metadata for a series to help guide the AI prompt."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                MAX(plane) AS plane,
                MAX(weight) AS weight,
                MAX(sequence_type) AS sequence_type,
                MAX(series_description) AS series_description
            FROM dicom_images
            WHERE series_instance_uid = ?
            """,
            (series_uid,),
        )
        row = cursor.fetchone()
        if not row:
            return {}

        def _clean(val: Any) -> Optional[str]:
            if val is None:
                return None
            s = str(val).strip()
            return s if s else None

        return {
            "plane": _clean(row["plane"]),
            "weight": _clean(row["weight"]),
            "sequence_type": _clean(row["sequence_type"]),
            "series_description": _clean(row["series_description"]),
        }


@app.post("/api/nano-banana-pro/acp-annotate")
def nano_banana_pro_acp_annotate(payload: dict = Body(...)):
    """Analyze/segment/annotate a single slice.

    Flow:
      1) Gemini 3 Pro produces a detailed description + segmentation/annotation prompt.
      2) Nano Banana Pro generates an annotated image using that prompt.

    This endpoint is intentionally non-persistent: it does not write the generated output to disk or the DB.

    Body:
      {
        study_id: str,
        series_uid: str,
        instance_index: int,
        image_base64?: str,        # optional base64 image bytes (no data: prefix)
        image_mime_type?: str,     # optional mime type (e.g., image/png)
      }

    Returns:
      JSON containing the analysis + the annotated image (base64).
    """

    series_uid = payload.get("series_uid")
    instance_index = payload.get("instance_index")

    if not isinstance(series_uid, str) or not series_uid:
        raise HTTPException(status_code=400, detail="Missing field: series_uid")
    if not isinstance(instance_index, int):
        raise HTTPException(status_code=400, detail="Missing field: instance_index")

    series_ctx = _get_series_context(series_uid)

    supplied_b64 = payload.get("image_base64")
    supplied_mime = payload.get("image_mime_type")

    image_bytes: bytes
    image_mime_type: str

    if supplied_b64 is not None:
        if not isinstance(supplied_b64, str) or not supplied_b64:
            raise HTTPException(status_code=400, detail="Invalid field: image_base64")

        image_mime_type = (
            supplied_mime.strip() if isinstance(supplied_mime, str) and supplied_mime.strip() else "image/png"
        )

        try:
            image_bytes = base64.b64decode(supplied_b64)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 in image_base64")
    else:
        image_path = _get_exported_image_path(series_uid, instance_index)
        image_bytes = image_path.read_bytes()
        image_mime_type = _guess_image_mime_type(image_path)

    # 1) Analyze with Gemini (text)
    analysis_text = _call_gemini_analysis(
        image_bytes,
        image_mime_type,
        _build_acp_analysis_prompt(
            plane=series_ctx.get("plane"),
            weight=series_ctx.get("weight"),
            sequence_type=series_ctx.get("sequence_type"),
            series_description=series_ctx.get("series_description"),
            is_viewport_capture=supplied_b64 is not None,
        ),
    )
    analysis_obj = _try_parse_json_object(analysis_text)

    nano_banana_prompt: str
    if analysis_obj and isinstance(analysis_obj.get("nano_banana_prompt"), str) and analysis_obj.get("nano_banana_prompt").strip():
        nano_banana_prompt = analysis_obj.get("nano_banana_prompt").strip()
    else:
        # Fallback prompt (should be rare).
        nano_banana_prompt = (
            "Analyze this MRI slice for ACP (adamantinomatous craniopharyngioma) / craniopharyngioma-related findings. "
            "If a lesion is suspected, segment the tumor boundary and visible components (cystic vs solid, calcification foci if visible). "
            "Outline each element separately with distinct colors (do not merge into one outline): e.g., tumor boundary vs cystic component vs solid nodule vs calcification markers vs critical structures. "
            "Add subtle outlines and small text labels with arrows/leader lines for each element, and include a concise clinical-impact annotation in a smaller font beneath each label (e.g., direction/degree of mass effect or compression/encasement, obstruction risk, cystic vs solid, or uncertainty). "
            "If visible or relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus, third ventricle) and indicate displacement/compression. "
            "If no lesion is evident, add a small note indicating no clear ACP lesion on this slice, and still label at least two relevant anatomical landmarks if visible (each with distinct color/outline). "
            "Keep the output image around 512 px on its longest side (match input aspect as best you can). "
            "Return only the edited/annotated image."
        )

    # Ensure the downstream prompt is unambiguous and sufficiently directive.
    prompt_lc = nano_banana_prompt.lower()

    if "craniopharyngioma" not in prompt_lc and "adamantinomatous" not in prompt_lc:
        nano_banana_prompt = (
            "Focus on ACP (adamantinomatous craniopharyngioma) / craniopharyngioma findings. "
            + nano_banana_prompt
        )
        prompt_lc = nano_banana_prompt.lower()

    # Always require labels.
    if "label" not in prompt_lc:
        nano_banana_prompt = (
            "Always add small text labels (at least 2) with arrows/leader lines (e.g., 'Cystic component', 'Solid nodule', 'Calcification' if visible). "
            + nano_banana_prompt
        )
        prompt_lc = nano_banana_prompt.lower()
    # Require concise clinical-impact annotation under each label (small font).
    if "annotation" not in prompt_lc and "clinical" not in prompt_lc:
        nano_banana_prompt = (
            "Add a concise clinical-impact annotation in a smaller font beneath each label (e.g., direction/degree of displacement/compression/encasement, obstruction risk, cystic vs solid, or uncertainty). "
            + nano_banana_prompt
        )
        prompt_lc = nano_banana_prompt.lower()

    # Encourage more localizing guidance if missing.
    if "sella" not in prompt_lc and "suprasellar" not in prompt_lc and "optic" not in prompt_lc:
        nano_banana_prompt = (
            "Localize using landmarks: midline sellar/suprasellar region (sella turcica/pituitary fossa), pituitary stalk, optic chiasm. "
            + nano_banana_prompt
        )
        prompt_lc = nano_banana_prompt.lower()

    # Encourage explicit mention of critical structures.
    if (
        "pituitary" not in prompt_lc
        and "stalk" not in prompt_lc
        and "optic" not in prompt_lc
        and "chiasm" not in prompt_lc
        and "hypothalam" not in prompt_lc
    ):
        nano_banana_prompt = (
            "If visible/relevant, label critical structures (pituitary stalk, optic chiasm, hypothalamus) and indicate any displacement/compression. "
            + nano_banana_prompt
        )
        prompt_lc = nano_banana_prompt.lower()

    # Encourage separate, color-coded outlines.
    color_ok = ("color" in prompt_lc) or ("colour" in prompt_lc)
    separate_ok = ("separate" in prompt_lc) or ("distinct" in prompt_lc) or ("different" in prompt_lc)
    outline_ok = ("outline" in prompt_lc) or ("contour" in prompt_lc) or ("boundary" in prompt_lc)

    if not (color_ok and separate_ok and outline_ok):
        nano_banana_prompt = (
            "Use separate outlines/contours for each element/component and use DISTINCT COLORS per element (do not merge into one outline). "
            "For example: tumor boundary = cyan, cystic component = magenta, solid component = orange, calcification markers = yellow, critical structures = green. "
            "Add matching labels with leader lines for each element. "
            + nano_banana_prompt
        )

    # 2) Annotate with Nano Banana Pro (image)
    out_bytes, mime = _call_nano_banana_pro(image_bytes, image_mime_type, nano_banana_prompt)

    return JSONResponse(
        {
            "analysis_text": analysis_text,
            "analysis_json": analysis_obj,
            "nano_banana_prompt": nano_banana_prompt,
            "mime_type": mime,
            "image_base64": base64.b64encode(out_bytes).decode("utf-8"),
        },
        headers={"Cache-Control": "no-store"},
    )


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
