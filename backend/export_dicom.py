"""
DICOM Export Script
Extracts all DICOM images to high-resolution JPEGs and stores metadata in SQLite.
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
    }


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
    use_16bit: bool = True
) -> bool:
    """Process a single DICOM file: extract metadata and export image."""
    try:
        ds = pydicom.dcmread(str(dcm_path))
        
        # Extract metadata
        metadata = extract_metadata(ds, str(dcm_path), study_folder)
        
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
    scans_path: Path = MRI_SCANS_PATH,
    output_path: Path = OUTPUT_PATH,
    db_path: Path = DB_PATH,
    upscale_factor: int = 1,
    use_16bit: bool = True
) -> dict:
    """
    Export all DICOM images to high-quality images and store metadata in database.
    
    Args:
        scans_path: Path to DICOM scans
        output_path: Path for exported images
        db_path: Path for SQLite database
        upscale_factor: Upscale images by this factor using Lanczos interpolation (default 4x)
        use_16bit: Preserve 16-bit depth for grayscale images (default True)
    
    Returns dict with statistics about the export.
    """
    print(f"Scanning DICOM files in: {scans_path}")
    print(f"Exporting JPEGs to: {output_path}")
    print(f"Database path: {db_path}")
    
    # Initialize database
    conn = init_database(db_path)
    
    stats = {
        'total_files': 0,
        'processed': 0,
        'failed': 0,
        'studies': set(),
        'series': set(),
    }
    
    if not scans_path.exists():
        print(f"Scans path does not exist: {scans_path}")
        return stats
    
    # Find all DICOM files
    for study_folder in sorted(scans_path.iterdir()):
        if not study_folder.is_dir() or study_folder.name.startswith('.'):
            continue
        if study_folder.suffix == '.zip':
            continue
        
        print(f"\nProcessing study: {study_folder.name}")
        stats['studies'].add(study_folder.name)
        
        # Find DICOM directory
        for subdir in study_folder.iterdir():
            if not subdir.is_dir() or subdir.name.startswith('.'):
                continue
            
            dcm_files = list(subdir.glob("*.DCM")) + list(subdir.glob("*.dcm"))
            
            for dcm_file in sorted(dcm_files):
                stats['total_files'] += 1
                
                if process_dicom_file(dcm_file, study_folder.name, conn, output_path, upscale_factor, use_16bit):
                    stats['processed'] += 1
                    if stats['processed'] % 100 == 0:
                        print(f"  Processed {stats['processed']} files...")
                else:
                    stats['failed'] += 1
    
    conn.close()
    
    # Convert sets to counts for return
    stats['studies'] = len(stats['studies'])
    
    print(f"\n{'='*50}")
    print(f"Export complete!")
    print(f"  Total files: {stats['total_files']}")
    print(f"  Processed: {stats['processed']}")
    print(f"  Failed: {stats['failed']}")
    print(f"  Studies: {stats['studies']}")
    print(f"\nJPEGs saved to: {output_path}")
    print(f"Database saved to: {db_path}")
    
    return stats


if __name__ == "__main__":
    export_all_dicoms()
