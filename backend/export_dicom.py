"""
DICOM Export Script
Extracts DICOM images to PNGs and stores metadata in SQLite.

Usage:
  python export_dicom.py                 # scans ./mri_scans
  python export_dicom.py /path/to/dir    # scans a directory recursively
  python export_dicom.py /path/to/file.dcm
"""

import os
import sqlite3
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional

import numpy as np
import pydicom
from pydicom.pixel_data_handlers.util import apply_voi_lut, apply_modality_lut
from PIL import Image


# Configuration
MRI_SCANS_PATH = Path(__file__).parent.parent / "mri_scans"
OUTPUT_PATH = Path(__file__).parent.parent / "exported_images"
DB_PATH = Path(__file__).parent.parent / "dicom_metadata.db"


def init_database(db_path: Path) -> sqlite3.Connection:
    """Initialize SQLite database with schema for DICOM metadata."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS dicom_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            
            -- File info
            source_path TEXT NOT NULL,
            exported_jpeg_path TEXT,
            study_folder TEXT,
            
            -- Study level
            study_instance_uid TEXT,
            study_date TEXT,
            study_time TEXT,
            study_description TEXT,
            accession_number TEXT,
            
            -- Patient info
            patient_id TEXT,
            patient_name TEXT,
            patient_birth_date TEXT,
            patient_sex TEXT,
            patient_age TEXT,
            
            -- Series level
            series_instance_uid TEXT,
            series_number INTEGER,
            series_description TEXT,
            series_date TEXT,
            series_time TEXT,
            modality TEXT,
            body_part_examined TEXT,
            
            -- Instance level
            sop_instance_uid TEXT,
            instance_number INTEGER,
            acquisition_number INTEGER,
            slice_location REAL,
            slice_thickness REAL,
            image_position_patient TEXT,
            image_orientation_patient TEXT,
            
            -- Image properties
            rows INTEGER,
            columns INTEGER,
            bits_allocated INTEGER,
            bits_stored INTEGER,
            high_bit INTEGER,
            pixel_spacing TEXT,
            photometric_interpretation TEXT,
            samples_per_pixel INTEGER,
            
            -- Window settings
            window_center REAL,
            window_width REAL,
            rescale_intercept REAL,
            rescale_slope REAL,
            
            -- Equipment
            manufacturer TEXT,
            manufacturer_model_name TEXT,
            station_name TEXT,
            institution_name TEXT,
            
            -- MRI specific
            magnetic_field_strength REAL,
            sequence_name TEXT,
            scanning_sequence TEXT,
            repetition_time REAL,
            echo_time REAL,
            inversion_time REAL,
            flip_angle REAL,
            
            -- Parsed from series description
            plane TEXT,
            weight TEXT,
            sequence_type TEXT,
            
            -- Timestamps
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            
            UNIQUE(source_path)
        )
    """)
    
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_study_uid ON dicom_images(study_instance_uid)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_series_uid ON dicom_images(series_instance_uid)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_patient_id ON dicom_images(patient_id)")
    
    conn.commit()
    return conn


def safe_get(ds, attr: str, default=None):
    """Safely get a DICOM attribute, handling multi-value and special types."""
    try:
        value = getattr(ds, attr, default)
        if value is None or value == default:
            return default
        
        # Handle multi-value attributes
        if hasattr(value, '__iter__') and not isinstance(value, (str, bytes)):
            if len(value) == 1:
                value = value[0]
            else:
                return str(list(value))
        
        # Handle PersonName
        if hasattr(value, 'family_name'):
            return str(value)
        
        return value
    except Exception:
        return default


def extract_metadata(ds, source_path: str, study_folder: str) -> dict:
    """Extract all relevant metadata from a DICOM dataset."""
    
    # Handle window center/width which can be multi-valued
    wc = safe_get(ds, 'WindowCenter')
    ww = safe_get(ds, 'WindowWidth')
    if isinstance(wc, (list, tuple)):
        wc = wc[0] if wc else None
    if isinstance(ww, (list, tuple)):
        ww = ww[0] if ww else None
    
    return {
        'source_path': source_path,
        'study_folder': study_folder,
        
        # Study level
        'study_instance_uid': safe_get(ds, 'StudyInstanceUID'),
        'study_date': safe_get(ds, 'StudyDate'),
        'study_time': safe_get(ds, 'StudyTime'),
        'study_description': safe_get(ds, 'StudyDescription'),
        'accession_number': safe_get(ds, 'AccessionNumber'),
        
        # Patient info
        'patient_id': safe_get(ds, 'PatientID'),
        'patient_name': str(safe_get(ds, 'PatientName', '')),
        'patient_birth_date': safe_get(ds, 'PatientBirthDate'),
        'patient_sex': safe_get(ds, 'PatientSex'),
        'patient_age': safe_get(ds, 'PatientAge'),
        
        # Series level
        'series_instance_uid': safe_get(ds, 'SeriesInstanceUID'),
        'series_number': safe_get(ds, 'SeriesNumber'),
        'series_description': safe_get(ds, 'SeriesDescription'),
        'series_date': safe_get(ds, 'SeriesDate'),
        'series_time': safe_get(ds, 'SeriesTime'),
        'modality': safe_get(ds, 'Modality'),
        'body_part_examined': safe_get(ds, 'BodyPartExamined'),
        
        # Instance level
        'sop_instance_uid': safe_get(ds, 'SOPInstanceUID'),
        'instance_number': safe_get(ds, 'InstanceNumber'),
        'acquisition_number': safe_get(ds, 'AcquisitionNumber'),
        'slice_location': safe_get(ds, 'SliceLocation'),
        'slice_thickness': safe_get(ds, 'SliceThickness'),
        'image_position_patient': str(safe_get(ds, 'ImagePositionPatient', '')),
        'image_orientation_patient': str(safe_get(ds, 'ImageOrientationPatient', '')),
        
        # Image properties
        'rows': safe_get(ds, 'Rows'),
        'columns': safe_get(ds, 'Columns'),
        'bits_allocated': safe_get(ds, 'BitsAllocated'),
        'bits_stored': safe_get(ds, 'BitsStored'),
        'high_bit': safe_get(ds, 'HighBit'),
        'pixel_spacing': str(safe_get(ds, 'PixelSpacing', '')),
        'photometric_interpretation': safe_get(ds, 'PhotometricInterpretation'),
        'samples_per_pixel': safe_get(ds, 'SamplesPerPixel'),
        
        # Window settings
        'window_center': float(wc) if wc is not None else None,
        'window_width': float(ww) if ww is not None else None,
        'rescale_intercept': safe_get(ds, 'RescaleIntercept'),
        'rescale_slope': safe_get(ds, 'RescaleSlope'),
        
        # Equipment
        'manufacturer': safe_get(ds, 'Manufacturer'),
        'manufacturer_model_name': safe_get(ds, 'ManufacturerModelName'),
        'station_name': safe_get(ds, 'StationName'),
        'institution_name': safe_get(ds, 'InstitutionName'),
        
        # MRI specific
        'magnetic_field_strength': safe_get(ds, 'MagneticFieldStrength'),
        'sequence_name': safe_get(ds, 'SequenceName'),
        'scanning_sequence': str(safe_get(ds, 'ScanningSequence', '')),
        'repetition_time': safe_get(ds, 'RepetitionTime'),
        'echo_time': safe_get(ds, 'EchoTime'),
        'inversion_time': safe_get(ds, 'InversionTime'),
        'flip_angle': safe_get(ds, 'FlipAngle'),
        
        # Parsed from series description
        'plane': parse_plane(safe_get(ds, 'SeriesDescription')),
        'weight': parse_weight(safe_get(ds, 'SeriesDescription')),
        'sequence_type': parse_sequence_type(safe_get(ds, 'SeriesDescription')),
    }


def parse_plane(description: str) -> Optional[str]:
    """Extract imaging plane from series description."""
    if not description:
        return None
    desc_upper = description.upper()
    
    if ' AX ' in desc_upper or desc_upper.startswith('AX ') or '_AX_' in desc_upper or 'AXIAL' in desc_upper:
        return 'Axial'
    elif ' COR ' in desc_upper or desc_upper.startswith('COR ') or '_COR_' in desc_upper or 'CORONAL' in desc_upper:
        return 'Coronal'
    elif ' SAG ' in desc_upper or desc_upper.startswith('SAG ') or '_SAG_' in desc_upper or 'SAGITTAL' in desc_upper:
        return 'Sagittal'
    return None


def parse_weight(description: str) -> Optional[str]:
    """Extract T1/T2 weighting from series description."""
    if not description:
        return None
    desc_upper = description.upper()
    
    # Check for T1 (but not T10, T11, etc.)
    if 'T1_' in desc_upper or 'T1 ' in desc_upper or '_T1' in desc_upper or desc_upper.endswith('T1'):
        return 'T1'
    # Check for T2
    if 'T2_' in desc_upper or 'T2 ' in desc_upper or '_T2' in desc_upper or desc_upper.endswith('T2'):
        return 'T2'
    return None


def parse_sequence_type(description: str) -> Optional[str]:
    """Extract sequence type from series description."""
    if not description:
        return None
    desc_upper = description.upper()
    
    # Order matters - check more specific sequences first
    sequences = [
        ('FLAIR', 'FLAIR'),
        ('SSFSE', 'SSFSE'),
        ('SWI', 'SWI'),
        ('SWAN', 'SWAN'),
        ('DWI', 'DWI'),
        ('DTI', 'DTI'),
        ('ASL', 'ASL'),
        ('ADC', 'ADC'),
        ('GRE', 'GRE'),
        ('SE', 'SE'),  # Spin Echo - check last as it's common substring
        ('LOC', 'Localizer'),
        ('LOCALIZER', 'Localizer'),
    ]
    
    for pattern, name in sequences:
        if pattern in desc_upper:
            return name
    return None


def sanitize_filename(name: str) -> str:
    """Sanitize a string to be safe for use as a filename."""
    if not name:
        return "unknown"
    # Replace problematic characters
    for char in ['/', '\\', ':', '*', '?', '"', '<', '>', '|']:
        name = name.replace(char, '_')
    return name.strip()[:50]  # Limit length


def dicom_to_image(ds, output_path: Path, upscale_factor: int = 1, use_16bit: bool = True) -> bool:
    """
    Convert DICOM pixel data to high-quality image.
    
    Args:
        ds: pydicom dataset
        output_path: Path for output file (extension will be adjusted)
        upscale_factor: Factor to upscale image (e.g., 4 means 512->2048)
        use_16bit: If True, preserve 16-bit depth for grayscale images
    """
    try:
        # Check if pixel data exists
        if 'PixelData' not in ds and 'FloatPixelData' not in ds and 'DoubleFloatPixelData' not in ds:
            return False
        
        pixel_array = ds.pixel_array
        photometric = getattr(ds, 'PhotometricInterpretation', 'MONOCHROME2')
        
        # Handle based on photometric interpretation
        if photometric in ('MONOCHROME1', 'MONOCHROME2'):
            # Grayscale images - apply modality LUT but preserve bit depth
            pixel_array = pixel_array.astype(np.float64)
            pixel_array = apply_modality_lut(pixel_array, ds)
            
            # Apply VOI LUT (windowing)
            pixel_array = apply_voi_lut(pixel_array, ds, index=0)
            
            # Normalize to full range
            min_val = pixel_array.min()
            max_val = pixel_array.max()
            
            if max_val > min_val:
                if use_16bit:
                    # Normalize to 16-bit range (0-65535)
                    pixel_array = ((pixel_array - min_val) / (max_val - min_val) * 65535)
                    pixel_array = pixel_array.astype(np.uint16)
                else:
                    # Normalize to 8-bit range (0-255)
                    pixel_array = ((pixel_array - min_val) / (max_val - min_val) * 255)
                    pixel_array = pixel_array.astype(np.uint8)
            else:
                if use_16bit:
                    pixel_array = np.zeros_like(pixel_array, dtype=np.uint16)
                else:
                    pixel_array = np.zeros_like(pixel_array, dtype=np.uint8)
            
            # Invert for MONOCHROME1
            if photometric == "MONOCHROME1":
                if use_16bit:
                    pixel_array = 65535 - pixel_array
                else:
                    pixel_array = 255 - pixel_array
            
            # Create image - PIL needs special handling for 16-bit
            if use_16bit:
                img = Image.fromarray(pixel_array, mode='I;16')
            else:
                img = Image.fromarray(pixel_array, mode='L')
        else:
            # Color images (RGB, YBR_FULL, etc.) - no windowing needed
            pixel_array = pixel_array.astype(np.uint8)
            
            if len(pixel_array.shape) == 3 and pixel_array.shape[2] == 3:
                img = Image.fromarray(pixel_array, mode='RGB')
            else:
                img = Image.fromarray(pixel_array)
        
        # Upscale with Lanczos interpolation
        if upscale_factor > 1:
            new_width = img.width * upscale_factor
            new_height = img.height * upscale_factor
            img = img.resize((new_width, new_height), Image.LANCZOS)
        
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save as PNG (lossless)
        png_path = output_path.with_suffix('.png')
        img.save(png_path, 'PNG', compress_level=6)
        return True
            
    except Exception as e:
        print(f"Error converting to image: {e}")
        return False


def process_dicom_file(
    dcm_path: Path,
    study_folder: str,
    conn: sqlite3.Connection,
    output_base: Path,
    upscale_factor: int = 1,
    use_16bit: bool = True,
    stats: Optional[dict] = None,
) -> bool:
    """Process a single DICOM file: extract metadata and export image."""
    try:
        # force=True allows reading datasets that are missing the DICOM preamble.
        ds = pydicom.dcmread(str(dcm_path), force=True)
        
        # Extract metadata
        metadata = extract_metadata(ds, str(dcm_path), study_folder)

        if stats is not None:
            study_uid = metadata.get('study_instance_uid')
            series_uid = metadata.get('series_instance_uid')
            if study_uid:
                stats['studies'].add(study_uid)
            if series_uid:
                stats['series'].add(series_uid)
        
        # Build organized output path:
        # output_base/YYYY-MM-DD_StudyDescription/SeriesNumber_SeriesDescription/InstanceNumber.png
        
        # Study folder: date + description
        study_date = metadata['study_date'] or 'unknown_date'
        if len(study_date) == 8:  # YYYYMMDD format
            study_date = f"{study_date[:4]}-{study_date[4:6]}-{study_date[6:8]}"
        study_desc = sanitize_filename(metadata['study_description'] or metadata['modality'] or 'study')
        study_dir = f"{study_date}_{study_desc}"
        
        # Series folder: number + description
        series_num = metadata['series_number'] or 0
        series_desc = sanitize_filename(metadata['series_description'] or 'series')
        series_dir = f"{series_num:02d}_{series_desc}"
        
        # Instance filename
        instance_num = metadata['instance_number'] or 0
        slice_loc = metadata['slice_location']
        if slice_loc is not None:
            img_filename = f"{instance_num:04d}_loc{slice_loc:.1f}"
        else:
            img_filename = f"{instance_num:04d}"
        
        img_path = output_base / study_dir / series_dir / img_filename
        
        # Export to image
        if dicom_to_image(ds, img_path, upscale_factor, use_16bit):
            metadata['exported_jpeg_path'] = str(img_path.with_suffix('.png'))
        else:
            metadata['exported_jpeg_path'] = None
        
        # Insert into database
        columns = ', '.join(metadata.keys())
        placeholders = ', '.join(['?' for _ in metadata])
        
        cursor = conn.cursor()
        cursor.execute(
            f"INSERT OR REPLACE INTO dicom_images ({columns}) VALUES ({placeholders})",
            list(metadata.values())
        )
        conn.commit()
        
        return True
        
    except Exception as e:
        print(f"Error processing {dcm_path}: {e}")
        return False


def export_all_dicoms(
    inputs: Optional[list[Path]] = None,
    scans_path: Path = MRI_SCANS_PATH,
    output_path: Path = OUTPUT_PATH,
    db_path: Path = DB_PATH,
    upscale_factor: int = 1,
    use_16bit: bool = True,
    scan_all_files: bool = False,
    group_by_top_level_folder: bool = False,
) -> dict:
    """Export DICOM images to PNGs and store metadata in database.

    - If `inputs` is omitted, scans `scans_path` (defaults to ./mri_scans) and uses the first path
      segment under it as `study_folder`.
    - If `inputs` is provided, each input path can be a file or directory. Directories are scanned
      recursively.

    Args:
        inputs: File and/or directory paths to scan.
        scans_path: Default scan root (used only when inputs is None).
        output_path: Directory for exported images.
        db_path: Path for SQLite database.
        upscale_factor: Upscale images by this factor.
        use_16bit: Preserve 16-bit depth for grayscale images.
        scan_all_files: If True, attempt to read every file (slower, but may catch odd extensions).
        group_by_top_level_folder: If True (and scanning a directory), use the first path component
            under the directory as the "study_folder" label.

    Returns dict with statistics about the export.
    """

    allowed_suffixes = {'.dcm', '.dicom', '.ima'}

    # Fast header-based detection (helps when scanning directories with many non-DICOM files).
    try:
        from pydicom.misc import is_dicom  # type: ignore
    except Exception:  # pragma: no cover
        is_dicom = None

    if inputs is None:
        inputs = [scans_path]
        group_by_top_level_folder = True

    print("Scanning DICOM inputs:")
    for p in inputs:
        print(f"  - {p}")
    print(f"Exporting PNGs to: {output_path}")
    print(f"Database path: {db_path}")

    # Initialize database
    conn = init_database(db_path)

    stats = {
        'total_files': 0,
        'processed': 0,
        'failed': 0,
        'skipped': 0,
        'studies': set(),
        'series': set(),
    }

    def should_consider_file(path: Path) -> bool:
        if scan_all_files:
            return True

        suffix = path.suffix.lower()
        if suffix in allowed_suffixes:
            return True

        if suffix == '':
            # Only consider extensionless files if they look like DICOM.
            if is_dicom is None:
                return False
            try:
                return bool(is_dicom(str(path)))
            except Exception:
                return False

        return False

    def derive_study_folder_for_file(scan_root: Path, file_path: Path) -> str:
        if group_by_top_level_folder:
            try:
                rel = file_path.relative_to(scan_root)
                if len(rel.parts) > 1:
                    return rel.parts[0]
            except Exception:
                pass
        return scan_root.name

    for input_path in inputs:
        if not input_path.exists():
            print(f"Input path does not exist: {input_path}")
            continue

        if input_path.is_file():
            stats['total_files'] += 1
            if not should_consider_file(input_path):
                stats['skipped'] += 1
                continue

            study_folder = input_path.parent.name
            if process_dicom_file(input_path, study_folder, conn, output_path, upscale_factor, use_16bit, stats=stats):
                stats['processed'] += 1
            else:
                stats['failed'] += 1
            continue

        # Directory scan (recursive)
        scan_root = input_path

        for file_path in scan_root.rglob('*'):
            if not file_path.is_file():
                continue

            # Skip hidden files/dirs
            rel_parts = file_path.relative_to(scan_root).parts
            if any(part.startswith('.') for part in rel_parts):
                continue

            # Skip zip archives (unzip first)
            if file_path.suffix.lower() == '.zip':
                continue

            stats['total_files'] += 1

            if not should_consider_file(file_path):
                stats['skipped'] += 1
                continue

            study_folder = derive_study_folder_for_file(scan_root, file_path)

            if process_dicom_file(file_path, study_folder, conn, output_path, upscale_factor, use_16bit, stats=stats):
                stats['processed'] += 1
                if stats['processed'] % 200 == 0:
                    print(f"  Processed {stats['processed']} files...")
            else:
                stats['failed'] += 1

    conn.close()

    # Convert sets to counts for return
    stats['studies'] = len(stats['studies'])
    stats['series'] = len(stats['series'])

    print(f"\n{'='*50}")
    print("Export complete!")
    print(f"  Total candidate files: {stats['total_files']}")
    print(f"  Processed: {stats['processed']}")
    print(f"  Skipped: {stats['skipped']}")
    print(f"  Failed: {stats['failed']}")
    print(f"  Studies: {stats['studies']}")
    print(f"  Series: {stats['series']}")
    print(f"\nPNGs saved to: {output_path}")
    print(f"Database saved to: {db_path}")

    return stats


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Export DICOM images to PNGs and build/update dicom_metadata.db for MiraViewer."
    )
    parser.add_argument(
        'inputs',
        nargs='*',
        help="One or more DICOM files or directories. If omitted, scans ./mri_scans.",
    )
    parser.add_argument(
        '--scan-all-files',
        action='store_true',
        help="Try reading every file (slower; useful when DICOMs have unusual extensions).",
    )
    parser.add_argument(
        '--group-by-top-level-folder',
        action='store_true',
        help="When scanning directories, label study_folder by the first path component under the directory.",
    )
    parser.add_argument(
        '--output',
        default=str(OUTPUT_PATH),
        help=f"Output directory for exported images (default: {OUTPUT_PATH}).",
    )
    parser.add_argument(
        '--db',
        default=str(DB_PATH),
        help=f"SQLite DB path (default: {DB_PATH}).",
    )
    parser.add_argument(
        '--upscale',
        type=int,
        default=1,
        help="Upscale exported images by this factor (default: 1).",
    )
    parser.add_argument(
        '--use-8bit',
        action='store_true',
        help="Export grayscale images as 8-bit (default is 16-bit).",
    )

    args = parser.parse_args()

    input_paths = [Path(p).expanduser() for p in args.inputs] if args.inputs else None

    export_all_dicoms(
        inputs=input_paths,
        output_path=Path(args.output).expanduser(),
        db_path=Path(args.db).expanduser(),
        upscale_factor=args.upscale,
        use_16bit=not args.use_8bit,
        scan_all_files=args.scan_all_files,
        group_by_top_level_folder=args.group_by_top_level_folder,
    )
