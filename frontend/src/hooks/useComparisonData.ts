import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComparisonData } from '../types/api';
import { getComparisonData, setSelectedPatientKey } from '../utils/localApi';

export function useComparisonData() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const reload = useCallback(async (patientKey?: string, options?: { background?: boolean }) => {
    const generation = ++requestGeneration.current;
    const background = options?.background === true;
    try {
      if (!background) setLoading(true);
      setError(null);
      if (patientKey !== undefined) {
        await setSelectedPatientKey(patientKey);
        if (generation !== requestGeneration.current) return;
      }
      const d = await getComparisonData(patientKey);
      if (generation !== requestGeneration.current) return;
      setData(d);
    } catch (e) {
      if (generation !== requestGeneration.current) return;
      const fallback = patientKey === undefined ? 'Failed to load comparison data' : 'Failed to select patient';
      if (background) throw e instanceof Error ? e : new Error(fallback);
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      requestGeneration.current += 1;
    };
  }, [reload]);

  return { data, loading, error, reload, selectPatient: reload };
}
