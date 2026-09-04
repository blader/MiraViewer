const MIB = 1024 * 1024;
export const LEARNED_IMAGING_MAX_BUDGET_BYTES = 3072 * MIB;

/**
 * Learned-operation envelope, separate from native assembly's 512 MiB limit.
 * Browser RAM reporting is coarse, not available-memory telemetry: reserve at
 * most one quarter of reported RAM, cap at 3 GiB, and use 1.5 GiB if unknown.
 */
export function learnedImagingBudgetBytes(deviceMemoryGiB?: number): number {
  return typeof deviceMemoryGiB === 'number' && Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0
    ? Math.floor(Math.min(LEARNED_IMAGING_MAX_BUDGET_BYTES, (deviceMemoryGiB * 1024 * MIB) / 4))
    : 1536 * MIB;
}
