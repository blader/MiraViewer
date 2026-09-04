import type { SeriesRef } from '../types/api';

/** One reference policy for alignment and global navigation; localizers cannot own a stack's range. */
export function comparisonReference<T extends { date: string; ref?: SeriesRef }>(columns: readonly T[]): T | undefined {
  return columns.find((column) => column.ref && column.ref.instance_count > 1) ?? columns.find((column) => column.ref);
}
