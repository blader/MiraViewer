import { useCallback, useEffect, useState } from 'react';
import type { ComparisonData } from '../types/api';
import { getComparisonData, setSelectedPatientKey } from '../utils/localApi';

export function useComparisonData() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const d = await getComparisonData();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load comparison data');
    } finally {
      setLoading(false);
    }
  }, []);

  const selectPatient = useCallback(async (patientKey: string) => {
    try {
      setLoading(true);
      setError(null);
      await setSelectedPatientKey(patientKey);
      setData(await getComparisonData(patientKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to select patient');
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

  return { data, loading, error, reload, selectPatient };
}
