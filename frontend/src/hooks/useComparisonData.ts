import { useCallback, useEffect, useState } from 'react';
import type { ComparisonData } from '../types/api';
import { getComparisonData } from '../utils/localApi';

export function useComparisonData() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const d = await getComparisonData();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load comparison data');
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
    return () => { cancelled = true; };
  }, []);

  return { data, loading, error, reload };
}
