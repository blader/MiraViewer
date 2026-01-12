import { useState, useEffect, useRef } from 'react';
import type { Study, Series } from '../types/api';
import { fetchStudies, fetchStudy, fetchSeries } from '../utils/api';

export function useStudies() {
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        setLoading(true);
        const data = await fetchStudies();
        if (mounted) {
          setStudies(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load studies');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  return { studies, loading, error };
}

export function useStudy(studyId: string | null) {
  const [study, setStudy] = useState<Study | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!studyId) {
      setStudy(null);
      return;
    }

    let mounted = true;

    async function load() {
      try {
        setLoading(true);
        const data = await fetchStudy(studyId!);
        if (mounted) {
          setStudy(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load study');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [studyId]);

  return { study, loading, error };
}

export function useSeries(studyId: string | null, seriesUid: string | null) {
  const [series, setSeries] = useState<Series | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!studyId || !seriesUid) {
      setSeries(null);
      return;
    }

    let mounted = true;

    async function load() {
      try {
        setLoading(true);
        const data = await fetchSeries(studyId!, seriesUid!);
        if (mounted) {
          setSeries(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load series');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [studyId, seriesUid]);

  return { series, loading, error };
}

export function useKeyboardNavigation(
  instanceIndex: number,
  maxIndex: number,
  setInstanceIndex: (index: number) => void,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          setInstanceIndex(Math.max(0, instanceIndex - 1));
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          setInstanceIndex(Math.min(maxIndex - 1, instanceIndex + 1));
          break;
        case 'Home':
          e.preventDefault();
          setInstanceIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setInstanceIndex(maxIndex - 1);
          break;
        case 'PageUp':
          e.preventDefault();
          setInstanceIndex(Math.max(0, instanceIndex - 10));
          break;
        case 'PageDown':
          e.preventDefault();
          setInstanceIndex(Math.min(maxIndex - 1, instanceIndex + 10));
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [instanceIndex, maxIndex, setInstanceIndex, enabled]);
}

export function useWheelNavigation(
  ref: React.RefObject<HTMLElement | null>,
  instanceIndex: number,
  maxIndex: number,
  setInstanceIndex: (index: number) => void,
  enabled: boolean = true
) {
  const callbackRef = useRef<((e: WheelEvent) => void) | null>(null);
  
  // Update callback when dependencies change
  callbackRef.current = (e: WheelEvent) => {
    if (!enabled || maxIndex <= 0) return;
    
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    const newIndex = Math.max(0, Math.min(maxIndex - 1, instanceIndex + delta));
    if (newIndex !== instanceIndex) {
      setInstanceIndex(newIndex);
    }
  };

  useEffect(() => {
    if (!ref.current) return;

    const element = ref.current;
    
    function handleWheel(e: WheelEvent) {
      callbackRef.current?.(e);
    }

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, [ref]);
}
