import type { DicomSeries, DicomStudy } from './schema';
import type { SequenceCombo } from '../types/api';
import { parseSeriesDescription } from '../utils/dicomSeriesParsing';

/** Display metadata only. Durable work belongs to Study/Series Instance UIDs. */
export function formatStudyDate(study: DicomStudy): string {
  const date = study.studyDate;
  if (date.length !== 8) return date || `unknown#${study.studyInstanceUid}`;
  const time = (study.studyTime ?? '').replace(/\D/g, '').slice(0, 6).padEnd(6, '0');
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

export function getSeriesSequenceCombo(series: DicomSeries): SequenceCombo {
  const parsed = parseSeriesDescription(
    [series.seriesDescription, series.protocolName, series.sequenceName].filter(Boolean).join(' | '),
  );
  const plane = series.plane || parsed.plane || null;
  const weight = series.weight || parsed.weight || null;
  const sequence = series.sequenceType || parsed.sequenceType || null;
  const label = [plane, weight, sequence].filter(Boolean).join(' ') || 'Unknown';
  return { id: label.toLowerCase().replace(/\s+/g, '-'), plane, weight, sequence, label, date_count: 0 };
}

export const acquisitionChoiceKey = (studyUid: string, comboId: string) =>
  `acquisition:${encodeURIComponent(studyUid)}:${encodeURIComponent(comboId)}`;
export const sourceSettingsKey = (seriesUid: string) => `source:${encodeURIComponent(seriesUid)}`;
