import { useCallback, useEffect, useState } from 'react';
import type { ComparisonData } from '../types/api';
import { getComparisonData, setSelectedPatientKey } from '../utils/localApi';

export function useComparisonData() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (patientKey?: string) => {
    try {
      setLoading(true);
      setError(null);
      if (patientKey !== undefined) await setSelectedPatientKey(patientKey);
      const d = await getComparisonData(patientKey);
      setData(d);
    } catch (e) {
      const fallback = patientKey === undefined ? 'Failed to load comparison data' : 'Failed to select patient';
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const d = await getComparisonData();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load comparison data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error, reload, selectPatient: reload };
}
