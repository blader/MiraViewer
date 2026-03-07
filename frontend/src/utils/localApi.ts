import { getDB } from '../db/db';
import type {
  DicomSeries,
  TumorSegmentationRow,
  TumorGroundTruthRow,
  TumorThreshold,
  TumorPolygon,
  NormalizedPoint,
  ViewerTransform,
  ViewportSize,
} from '../db/schema';
import type { ComparisonData, SequenceCombo, SeriesRef, PanelSettingsPartial, PanelSettings } from '../types/api';
import { parseSeriesDescription } from './dicomSeriesParsing';

function buildSeriesClassificationText(series: { seriesDescription: string; protocolName?: string; sequenceName?: string }): string {
  // Many datasets put the most informative string in ProtocolName or SequenceName.
  // Joining these aggressively reduces "Unknown" buckets without forcing defaults.
  return [series.seriesDescription, series.protocolName, series.sequenceName].filter(Boolean).join(' | ');
}

// Helper to generate a stable ID for the combo
function slugifyCombo(plane?: string, weight?: string, sequence?: string): string {
  const parts = [plane, weight, sequence].filter(Boolean);
  const slug = parts.join('-').toLowerCase().replace(/\s+/g, '-');
  return slug || 'unknown';
}

function labelCombo(plane?: string, weight?: string, sequence?: string): string {
  return [plane, weight, sequence].filter(Boolean).join(' ') || 'Unknown';
}

export async function getStudies() {
  const db = await getDB();
  const studies = await db.getAll('studies');
  const allSeries = await db.getAll('series');

  // Aggregate counts without loading instance Blob payloads.
  const seriesByStudy: Record<string, DicomSeries[]> = {};
  allSeries.forEach((s) => {
    if (!seriesByStudy[s.studyInstanceUid]) seriesByStudy[s.studyInstanceUid] = [];
    seriesByStudy[s.studyInstanceUid].push(s);
  });

  const instanceCountsBySeries: Record<string, number> = {};
  await Promise.all(
    allSeries.map(async (s) => {
      instanceCountsBySeries[s.seriesInstanceUid] = await db.countFromIndex(
        'instances',
        'by-series',
        s.seriesInstanceUid
      );
    })
  );

  return studies
    .map((study) => {
      const series = seriesByStudy[study.studyInstanceUid] || [];
      const seriesList = series
        .map((s) => {
          const parsed = parseSeriesDescription(buildSeriesClassificationText(s));
          return {
            series_uid: s.seriesInstanceUid,
            series_description: s.seriesDescription,
            series_number: s.seriesNumber,
            modality: s.modality,
            plane: s.plane || parsed.plane,
            weight: s.weight || parsed.weight,
            sequence_type: s.sequenceType || parsed.sequenceType,
            instance_count: instanceCountsBySeries[s.seriesInstanceUid] || 0,
          };
        })
        .filter((s) => s.instance_count > 0);

      const totalInstances = seriesList.reduce((acc, s) => acc + s.instance_count, 0);

      return {
        study_id: study.studyInstanceUid, // Use UID as ID
        study_instance_uid: study.studyInstanceUid,
        folder_name: study.studyDescription, // approximate mapping
        study_date: study.studyDate,
        scan_type: study.studyDescription || study.modality,
        series: seriesList.sort((a, b) => a.series_number - b.series_number),
        series_count: seriesList.length,
        total_instances: totalInstances,
      };
    })
    .sort((a, b) => b.study_date.localeCompare(a.study_date));
}

export async function getStudy(studyUid: string) {
  const db = await getDB();
  const study = await db.get('studies', studyUid);
  if (!study) throw new Error('Study not found');

  const series = await db.getAllFromIndex('series', 'by-study', studyUid);
  
  // For each series, get instances
  // We can't easily query instances by study, so we query by series
  const seriesList = [];
  let totalInstances = 0;

  for (const s of series) {
    const instances = await db.getAllFromIndex('instances', 'by-series', s.seriesInstanceUid);
    if (instances.length === 0) continue;

    instances.sort((a, b) => a.instanceNumber - b.instanceNumber);
    
    seriesList.push({
      series_uid: s.seriesInstanceUid,
      series_description: s.seriesDescription,
      series_number: s.seriesNumber,
      modality: s.modality,
      plane: s.plane,
      weight: s.weight,
      sequence_type: s.sequenceType,
      instance_count: instances.length,
      instances: instances.map(i => ({
        id: i.sopInstanceUid,
        instance_number: i.instanceNumber,
        slice_location: i.sliceLocation,
        file_path: 'miradb:' + i.sopInstanceUid, // placeholder, not used by cornerstone loader directly
      }))
    });
    totalInstances += instances.length;
  }
  
  return {
    study_id: study.studyInstanceUid,
    study_instance_uid: study.studyInstanceUid,
    folder_name: study.studyDescription,
    study_date: study.studyDate,
    scan_type: study.studyDescription || study.modality,
    patient_name: study.patientName,
    patient_id: study.patientId,
    series: seriesList.sort((a, b) => a.series_number - b.series_number),
    series_count: seriesList.length,
    total_instances: totalInstances,
  };
}

export async function getSeries(studyUid: string, seriesUid: string) {
  const db = await getDB();
  const series = await db.get('series', seriesUid);
  if (!series) throw new Error('Series not found');
  if (series.studyInstanceUid !== studyUid) {
    throw new Error('Series not found');
  }

  const instances = await db.getAllFromIndex('instances', 'by-series', seriesUid);
  instances.sort((a, b) => a.instanceNumber - b.instanceNumber);

  return {
    series_uid: series.seriesInstanceUid,
    series_description: series.seriesDescription,
    series_number: series.seriesNumber,
    modality: series.modality,
    plane: series.plane,
    weight: series.weight,
    sequence_type: series.sequenceType,
    instance_count: instances.length,
    instances: instances.map(i => ({
      id: i.sopInstanceUid,
      instance_number: i.instanceNumber,
      slice_location: i.sliceLocation,
      file_path: 'miradb:' + i.sopInstanceUid,
    })),
  };
}

export async function getComparisonData(): Promise<ComparisonData> {
  const db = await getDB();
  const allSeries = await db.getAll('series');
  const allStudies = await db.getAll('studies');

  // Create lookup for study date
  const studyDateMap: Record<string, string> = {};
  allStudies.forEach((s) => (studyDateMap[s.studyInstanceUid] = s.studyDate));

  // Instance counts without loading instance Blob payloads.
  const instanceCounts: Record<string, number> = {};
  await Promise.all(
    allSeries.map(async (s) => {
      instanceCounts[s.seriesInstanceUid] = await db.countFromIndex('instances', 'by-series', s.seriesInstanceUid);
    })
  );

  const planes = new Set<string>();
  const dates = new Set<string>();
  const sequences: Record<string, SequenceCombo> = {};
  const seriesMap: Record<string, Record<string, SeriesRef>> = {};

  for (const s of allSeries) {
    const instanceCount = instanceCounts[s.seriesInstanceUid] || 0;
    if (instanceCount === 0) continue;

    const parsed = parseSeriesDescription(buildSeriesClassificationText(s));
    const plane = s.plane || parsed.plane || null;
    const weight = s.weight || parsed.weight || null;
    const sequenceType = s.sequenceType || parsed.sequenceType || null;

    if (plane) planes.add(plane);

    const date = studyDateMap[s.studyInstanceUid];
    if (!date) continue;

    // Format date to ISO-like if it's YYYYMMDD
    let dateIso = date;
    if (date.length === 8) {
      dateIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00`;
    }
    dates.add(dateIso);

    const comboId = slugifyCombo(plane ?? undefined, weight ?? undefined, sequenceType ?? undefined);

    if (!sequences[comboId]) {
      sequences[comboId] = {
        id: comboId,
        plane,
        weight,
        sequence: sequenceType,
        label: labelCombo(plane ?? undefined, weight ?? undefined, sequenceType ?? undefined),
        date_count: 0,
      };
      seriesMap[comboId] = {};
    }

    const prev = seriesMap[comboId][dateIso];

    if (!prev) {
      seriesMap[comboId][dateIso] = {
        study_id: s.studyInstanceUid,
        series_uid: s.seriesInstanceUid,
        instance_count: instanceCount,
      };
      sequences[comboId].date_count++;
      continue;
    }

    // If multiple series map to the same (plane, weight, sequenceType) combo for a given date,
    // prefer the one with the most instances.
    //
    // Why:
    // - In real-world DICOM exports it's common to have "extra" image series (e.g. screenshots,
    //   localizers, reformats) that would otherwise get picked arbitrarily based on ingestion order.
    // - Auto-alignment relies on having a full through-plane stack; choosing a tiny series can make
    //   alignment look "broken" even though the real series exists.
    if (instanceCount > prev.instance_count) {
      seriesMap[comboId][dateIso] = {
        study_id: s.studyInstanceUid,
        series_uid: s.seriesInstanceUid,
        instance_count: instanceCount,
      };
    }
  }

  return {
    planes: Array.from(planes).sort(),
    dates: Array.from(dates).sort(),
    sequences: Object.values(sequences).sort((a, b) => (a.plane || '').localeCompare(b.plane || '')),
    series_map: seriesMap,
  };
}

export async function getPanelSettings(comboId: string): Promise<Record<string, PanelSettingsPartial>> {
  const db = await getDB();
  const row = await db.get('panel_settings', comboId);
  if (!row) return {};
  
  // Convert stored settings to a partial shape (callers treat missing fields as defaults).
  const result: Record<string, PanelSettingsPartial> = {};
  for (const [date, settings] of Object.entries(row.settings)) {
    // idb's inferred types for Object.entries can degrade to `unknown` under strict settings.
    // The stored value is a subset of PanelSettings (numbers), which is safe to treat as partial.
    result[date] = settings as PanelSettingsPartial;
  }
  return result;
}

export async function savePanelSettings(comboId: string, dateIso: string, settings: PanelSettings): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('panel_settings', 'readwrite');
  const store = tx.objectStore('panel_settings');
  
  let row = await store.get(comboId);
  if (!row) {
    row = { comboId, settings: {} };
  }
  
  row.settings[dateIso] = {
    ...row.settings[dateIso],
    ...settings,
  };
  
  await store.put(row);
  await tx.done;
}

/**
 * Resolve the Cornerstone imageId for a given series + instance index.
 * Returns an ID like `miradb:<sopInstanceUid>`.
 */
type SeriesInstanceOrderCacheEntry = {
  // Sorted by instanceNumber (ascending).
  uids: string[];
};

const SERIES_INSTANCE_ORDER_CACHE_MAX = 64;
const seriesInstanceOrderCache = new Map<string, SeriesInstanceOrderCacheEntry>();

function cacheSeriesInstanceOrder(seriesUid: string, uids: string[]) {
  // Refresh LRU ordering.
  if (seriesInstanceOrderCache.has(seriesUid)) {
    seriesInstanceOrderCache.delete(seriesUid);
  }
  seriesInstanceOrderCache.set(seriesUid, { uids });

  // Simple LRU eviction.
  while (seriesInstanceOrderCache.size > SERIES_INSTANCE_ORDER_CACHE_MAX) {
    const oldest = seriesInstanceOrderCache.keys().next().value as string | undefined;
    if (!oldest) break;
    seriesInstanceOrderCache.delete(oldest);
  }
}

export async function getSortedSopInstanceUidsForSeries(seriesUid: string): Promise<string[]> {
  const cached = seriesInstanceOrderCache.get(seriesUid);
  if (cached) {
    // Touch LRU.
    cacheSeriesInstanceOrder(seriesUid, cached.uids);
    return cached.uids;
  }

  const db = await getDB();

  // Fast path: use the compound ordering index to fetch SOPInstanceUIDs in slice order
  // without loading full instance records (which include Blob payloads).
  try {
    const range = IDBKeyRange.bound(
      [seriesUid, -Number.MAX_SAFE_INTEGER, ''],
      [seriesUid, Number.MAX_SAFE_INTEGER, '\uffff']
    );
    const keys = await db.getAllKeysFromIndex('instances', 'by-series-instanceNumber-uid', range);
    const uids = keys.map((k) => String(k));

    if (uids.length === 0) {
      throw new Error('No instances for series');
    }

    cacheSeriesInstanceOrder(seriesUid, uids);
    return uids;
  } catch {
    // Fallback (older DB / missing index): load values and sort.
    const instances = await db.getAllFromIndex('instances', 'by-series', seriesUid);
    if (!instances || instances.length === 0) {
      throw new Error('No instances for series');
    }

    instances.sort((a, b) => {
      const diff = a.instanceNumber - b.instanceNumber;
      if (diff !== 0) return diff;
      // Stable tie-breaker for weird/duplicate instance numbers.
      return a.sopInstanceUid.localeCompare(b.sopInstanceUid);
    });

    const uids = instances.map((i) => i.sopInstanceUid);
    cacheSeriesInstanceOrder(seriesUid, uids);
    return uids;
  }
}

export async function getSopInstanceUidForInstanceIndex(seriesUid: string, instanceIndex: number): Promise<string> {
  const uids = await getSortedSopInstanceUidsForSeries(seriesUid);
  const uid = uids[instanceIndex];
  if (!uid) throw new Error('Instance index out of range');
  return uid;
}

export async function getImageIdForInstance(seriesUid: string, instanceIndex: number): Promise<string> {
  const uid = await getSopInstanceUidForInstanceIndex(seriesUid, instanceIndex);
  return `miradb:${uid}`;
}

function tumorSegmentationId(seriesUid: string, sopInstanceUid: string): string {
  // Keep this stable and URL-safe. Series UID can contain dots.
  return `${seriesUid}::${sopInstanceUid}`;
}

export async function getTumorSegmentationForInstance(
  seriesUid: string,
  sopInstanceUid: string
): Promise<TumorSegmentationRow | null> {
  const db = await getDB();
  const id = tumorSegmentationId(seriesUid, sopInstanceUid);
  const row = await db.get('tumor_segmentations', id);
  return row ?? null;
}

export async function getTumorSegmentationsForSeries(seriesUid: string): Promise<TumorSegmentationRow[]> {
  const db = await getDB();
  return db.getAllFromIndex('tumor_segmentations', 'by-series', seriesUid);
}

export type SaveTumorSegmentationInput = {
  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;
  polygon: TumorPolygon;
  threshold: TumorThreshold;
  seed?: NormalizedPoint;
  meta?: TumorSegmentationRow['meta'];
  algorithmVersion?: string;
};

export async function saveTumorSegmentation(input: SaveTumorSegmentationInput): Promise<void> {
  const db = await getDB();
  const now = Date.now();

  const id = tumorSegmentationId(input.seriesUid, input.sopInstanceUid);
  const existing = await db.get('tumor_segmentations', id);

  const row: TumorSegmentationRow = {
    id,
    comboId: input.comboId,
    dateIso: input.dateIso,
    studyId: input.studyId,
    seriesUid: input.seriesUid,
    sopInstanceUid: input.sopInstanceUid,
    algorithmVersion: input.algorithmVersion ?? 'v1-display-domain-threshold',
    polygon: input.polygon,
    threshold: input.threshold,
    seed: input.seed,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    meta: input.meta,
  };

  await db.put('tumor_segmentations', row);
}

export async function deleteTumorSegmentation(seriesUid: string, sopInstanceUid: string): Promise<void> {
  const db = await getDB();
  await db.delete('tumor_segmentations', tumorSegmentationId(seriesUid, sopInstanceUid));
}

function tumorGroundTruthId(seriesUid: string, sopInstanceUid: string): string {
  return `${seriesUid}::${sopInstanceUid}`;
}

export async function getTumorGroundTruthForInstance(
  seriesUid: string,
  sopInstanceUid: string
): Promise<TumorGroundTruthRow | null> {
  const db = await getDB();
  const id = tumorGroundTruthId(seriesUid, sopInstanceUid);
  const row = await db.get('tumor_ground_truth', id);
  return row ?? null;
}

export async function getAllTumorGroundTruth(): Promise<TumorGroundTruthRow[]> {
  const db = await getDB();
  return db.getAll('tumor_ground_truth');
}

export type SaveTumorGroundTruthInput = {
  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;
  polygon: TumorPolygon;
  viewTransform?: ViewerTransform;
  viewportSize?: ViewportSize;
};

export async function saveTumorGroundTruth(input: SaveTumorGroundTruthInput): Promise<void> {
  const db = await getDB();
  const now = Date.now();

  const id = tumorGroundTruthId(input.seriesUid, input.sopInstanceUid);
  const existing = await db.get('tumor_ground_truth', id);

  const row: TumorGroundTruthRow = {
    id,
    comboId: input.comboId,
    dateIso: input.dateIso,
    studyId: input.studyId,
    seriesUid: input.seriesUid,
    sopInstanceUid: input.sopInstanceUid,
    polygon: input.polygon,
    viewTransform: input.viewTransform,
    viewportSize: input.viewportSize,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  };

  await db.put('tumor_ground_truth', row);
}

export async function deleteTumorGroundTruth(seriesUid: string, sopInstanceUid: string): Promise<void> {
  const db = await getDB();
  await db.delete('tumor_ground_truth', tumorGroundTruthId(seriesUid, sopInstanceUid));
}
