import type { DicomInstance } from '../db/schema';
import { downsampledSliceOriginMm, getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { cross, dot, norm, v3, type Vec3 } from './svr/vec3';

export const MAX_OUTPUT_GRID_PIXELS = 1024 * 1024;

export type OutputGridMode = 'native' | 'fixed-256' | 'fixed-512' | 'fixed-1024' | 'longest-edge' | 'isotropic';

const OUTPUT_GRID_MODES: ReadonlySet<OutputGridMode> = new Set([
  'native',
  'fixed-256',
  'fixed-512',
  'fixed-1024',
  'longest-edge',
  'isotropic',
]);

export function isOutputGridMode(value: unknown): value is OutputGridMode {
  return typeof value === 'string' && OUTPUT_GRID_MODES.has(value as OutputGridMode);
}

type VectorTuple = [number, number, number];

/** The sole physical authority for every displayed, stored, or exported derived plane. */
export interface OutputPlaneGrid {
  version: 1;
  mode: OutputGridMode;
  rows: number;
  columns: number;
  /** Distance between adjacent row-index centers, in millimeters. */
  rowSpacingMm: number;
  /** Distance between adjacent column-index centers, in millimeters. */
  columnSpacingMm: number;
  /** DICOM ImagePositionPatient: the center of output pixel [0, 0]. */
  originMm: VectorTuple;
  /** First DICOM IOP triplet; advances with the column index. */
  rowDirection: VectorTuple;
  /** Second DICOM IOP triplet; advances with the row index. */
  columnDirection: VectorTuple;
  normalDirection: VectorTuple;
  /** Complete pixel-footprint extent [row extent, column extent], in millimeters. */
  fieldOfViewMm: [number, number];
  sourceRows: number;
  sourceColumns: number;
  acquiredRowSpacingMm: number;
  acquiredColumnSpacingMm: number;
  frameOfReferenceUid?: string;
  referenceSopInstanceUid?: string;
}

type OutputPlaneSource = Pick<
  DicomInstance,
  'rows' | 'columns' | 'imagePositionPatient' | 'imageOrientationPatient' | 'pixelSpacing'
> &
  Partial<Pick<DicomInstance, 'frameOfReferenceUid' | 'sopInstanceUid'>>;

export type OutputGridOptions = {
  mode?: OutputGridMode;
  longestEdge?: number;
  isotropicSpacingMm?: number;
  frameOfReferenceUid?: string;
  maxPixels?: number;
};

function tuple(point: Vec3): VectorTuple {
  return [point.x, point.y, point.z];
}

/** Preserve the acquired pixel footprint and pixel-center convention at every output resolution. */
export function buildOutputPlaneGrid(source: OutputPlaneSource, options: OutputGridOptions = {}): OutputPlaneGrid {
  const geometry = getSliceGeometryFromInstance(source);
  const mode = options.mode ?? 'native';
  const rowExtentMm = geometry.rows * geometry.rowSpacingMm;
  const columnExtentMm = geometry.cols * geometry.colSpacingMm;
  let rows = geometry.rows;
  let columns = geometry.cols;

  if (mode === 'fixed-256' || mode === 'fixed-512' || mode === 'fixed-1024') {
    rows = columns = Number(mode.slice('fixed-'.length));
  } else if (mode === 'longest-edge') {
    const requested = options.longestEdge ?? 512;
    if (!Number.isSafeInteger(requested) || requested < 2 || requested > 1024) {
      throw new Error('An aspect-preserving output grid requires a longest edge between 2 and 1024 pixels');
    }
    const scale = requested / Math.max(geometry.rows, geometry.cols);
    rows = Math.max(2, Math.round(geometry.rows * scale));
    columns = Math.max(2, Math.round(geometry.cols * scale));
  } else if (mode === 'isotropic') {
    const requested = options.isotropicSpacingMm ?? Math.max(geometry.rowSpacingMm, geometry.colSpacingMm);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('An isotropic output grid requires a positive physical pixel spacing');
    }
    rows = Math.max(2, Math.round(rowExtentMm / requested));
    columns = Math.max(2, Math.round(columnExtentMm / requested));
  }

  const origin = downsampledSliceOriginMm(geometry, rows, columns);
  const grid: OutputPlaneGrid = {
    version: 1,
    mode,
    rows,
    columns,
    rowSpacingMm: rowExtentMm / rows,
    columnSpacingMm: columnExtentMm / columns,
    originMm: tuple(origin),
    rowDirection: tuple(geometry.rowDir),
    columnDirection: tuple(geometry.colDir),
    normalDirection: tuple(geometry.normalDir),
    fieldOfViewMm: [rowExtentMm, columnExtentMm],
    sourceRows: geometry.rows,
    sourceColumns: geometry.cols,
    acquiredRowSpacingMm: geometry.rowSpacingMm,
    acquiredColumnSpacingMm: geometry.colSpacingMm,
    frameOfReferenceUid: options.frameOfReferenceUid ?? source.frameOfReferenceUid,
    referenceSopInstanceUid: source.sopInstanceUid,
  };
  validateOutputPlaneGrid(grid, options.maxPixels);
  return grid;
}

/** Reject forged, inconsistent, or unsupported geometry before rendering or restoring anatomy. */
export function validateOutputPlaneGrid(grid: OutputPlaneGrid, maxPixels = MAX_OUTPUT_GRID_PIXELS): void {
  if (grid.version !== 1) throw new Error('A derived output grid has an unsupported geometry version');
  if (!isOutputGridMode(grid.mode)) throw new Error('A derived output grid has an unsupported resolution mode');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) {
    throw new Error('A derived output grid has an invalid pixel budget');
  }
  if (
    !Number.isSafeInteger(grid.rows) ||
    !Number.isSafeInteger(grid.columns) ||
    grid.rows < 2 ||
    grid.columns < 2 ||
    grid.rows * grid.columns > Math.min(MAX_OUTPUT_GRID_PIXELS, maxPixels)
  ) {
    throw new Error('A derived output grid exceeds its safe pixel budget');
  }
  if (
    (grid.mode === 'native' && (grid.rows !== grid.sourceRows || grid.columns !== grid.sourceColumns)) ||
    (grid.mode.startsWith('fixed-') &&
      (grid.rows !== Number(grid.mode.slice('fixed-'.length)) ||
        grid.columns !== Number(grid.mode.slice('fixed-'.length))))
  ) {
    throw new Error('A derived output grid does not match its requested resolution mode');
  }
  if (
    !Number.isFinite(grid.rowSpacingMm) ||
    !Number.isFinite(grid.columnSpacingMm) ||
    grid.rowSpacingMm <= 0 ||
    grid.columnSpacingMm <= 0 ||
    !Number.isFinite(grid.acquiredRowSpacingMm) ||
    !Number.isFinite(grid.acquiredColumnSpacingMm) ||
    grid.acquiredRowSpacingMm <= 0 ||
    grid.acquiredColumnSpacingMm <= 0 ||
    !Number.isSafeInteger(grid.sourceRows) ||
    !Number.isSafeInteger(grid.sourceColumns) ||
    grid.sourceRows < 2 ||
    grid.sourceColumns < 2
  ) {
    throw new Error('A derived output grid has invalid physical dimensions or spacing');
  }
  const vectors = [grid.originMm, grid.rowDirection, grid.columnDirection, grid.normalDirection];
  if (
    vectors.some(
      (point) => !Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error('A derived output grid has invalid patient-space coordinates');
  }
  const row = v3(...grid.rowDirection);
  const column = v3(...grid.columnDirection);
  const normal = v3(...grid.normalDirection);
  if (
    Math.abs(norm(row) - 1) > 1e-5 ||
    Math.abs(norm(column) - 1) > 1e-5 ||
    Math.abs(norm(normal) - 1) > 1e-5 ||
    Math.abs(dot(row, column)) > 1e-5 ||
    dot(cross(row, column), normal) < 1 - 1e-5
  ) {
    throw new Error('A derived output grid has inconsistent acquisition axes');
  }
  if (
    !Array.isArray(grid.fieldOfViewMm) ||
    grid.fieldOfViewMm.length !== 2 ||
    grid.fieldOfViewMm.some((extent) => !Number.isFinite(extent) || extent <= 0) ||
    Math.abs(grid.fieldOfViewMm[0] - grid.rows * grid.rowSpacingMm) > 1e-6 ||
    Math.abs(grid.fieldOfViewMm[1] - grid.columns * grid.columnSpacingMm) > 1e-6 ||
    Math.abs(grid.fieldOfViewMm[0] - grid.sourceRows * grid.acquiredRowSpacingMm) > 1e-6 ||
    Math.abs(grid.fieldOfViewMm[1] - grid.sourceColumns * grid.acquiredColumnSpacingMm) > 1e-6
  ) {
    throw new Error('A derived output grid does not preserve its acquired physical field of view');
  }
}

/** Bind an otherwise well-formed output lattice to its real native reference image. */
export function validateOutputGridReference(
  grid: OutputPlaneGrid,
  source: OutputPlaneSource,
  frameOfReferenceUid?: string,
): void {
  validateOutputPlaneGrid(grid);
  const geometry = getSliceGeometryFromInstance(source);
  const origin = downsampledSliceOriginMm(geometry, grid.rows, grid.columns);
  const expectedFrame = source.frameOfReferenceUid ?? frameOfReferenceUid;
  if (
    grid.sourceRows !== geometry.rows ||
    grid.sourceColumns !== geometry.cols ||
    Math.abs(grid.acquiredRowSpacingMm - geometry.rowSpacingMm) > 1e-6 ||
    Math.abs(grid.acquiredColumnSpacingMm - geometry.colSpacingMm) > 1e-6 ||
    (source.sopInstanceUid !== undefined && grid.referenceSopInstanceUid !== source.sopInstanceUid) ||
    (expectedFrame !== undefined && grid.frameOfReferenceUid !== expectedFrame) ||
    Math.hypot(grid.originMm[0] - origin.x, grid.originMm[1] - origin.y, grid.originMm[2] - origin.z) > 1e-6 ||
    dot(v3(...grid.rowDirection), geometry.rowDir) < 1 - 1e-6 ||
    dot(v3(...grid.columnDirection), geometry.colDir) < 1 - 1e-6 ||
    dot(v3(...grid.normalDirection), geometry.normalDir) < 1 - 1e-6
  ) {
    throw new Error('The physical output grid does not match its selected reference image');
  }
}

export function outputGridPixelToWorld(grid: OutputPlaneGrid, row: number, column: number): Vec3 {
  return v3(
    grid.originMm[0] +
      grid.columnDirection[0] * row * grid.rowSpacingMm +
      grid.rowDirection[0] * column * grid.columnSpacingMm,
    grid.originMm[1] +
      grid.columnDirection[1] * row * grid.rowSpacingMm +
      grid.rowDirection[1] * column * grid.columnSpacingMm,
    grid.originMm[2] +
      grid.columnDirection[2] * row * grid.rowSpacingMm +
      grid.rowDirection[2] * column * grid.columnSpacingMm,
  );
}

/** Compare complete validated geometry without making serialization order another authority. */
export function outputGridFingerprint(grid: OutputPlaneGrid): string {
  validateOutputPlaneGrid(grid);
  return JSON.stringify([
    grid.version,
    grid.mode,
    grid.rows,
    grid.columns,
    grid.rowSpacingMm,
    grid.columnSpacingMm,
    grid.originMm,
    grid.rowDirection,
    grid.columnDirection,
    grid.normalDirection,
    grid.fieldOfViewMm,
    grid.sourceRows,
    grid.sourceColumns,
    grid.acquiredRowSpacingMm,
    grid.acquiredColumnSpacingMm,
    grid.frameOfReferenceUid ?? null,
    grid.referenceSopInstanceUid ?? null,
  ]);
}
