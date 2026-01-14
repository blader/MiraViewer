import { useState, useRef, useCallback } from 'react';
import type { DicomViewerHandle } from '../components/DicomViewer';
import { blobToBase64Data } from '../utils/base64';
import { runAcpAnnotateClient, type AiSeriesContext } from '../utils/aiClient';

export type AiAnnotationState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progressText: string | null;
  imageUrl: string | null;
  prompt: string | null;
  error: string | null;
  target: {
    date: string;
    studyId: string;
    seriesUid: string;
    instanceIndex: number;
  } | null;
};

export function useAiAnnotation() {
  const [state, setState] = useState<AiAnnotationState>({
    status: 'idle',
    progressText: null,
    imageUrl: null,
    prompt: null,
    error: null,
    target: null,
  });

  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const requestIdRef = useRef(0);

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    setIsPromptOpen(false);
    setState((prev) => {
      if (prev.imageUrl) URL.revokeObjectURL(prev.imageUrl);
      return {
        status: 'idle',
        progressText: null,
        imageUrl: null,
        prompt: null,
        error: null,
        target: null,
      };
    });
  }, []);

  const runAnalysis = async (
    target: NonNullable<AiAnnotationState['target']>,
    viewerHandle: DicomViewerHandle | null,
    seriesContext: AiSeriesContext
  ) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const setProgress = (text: string | null) => {
      if (requestIdRef.current === requestId) {
        setState((prev) => ({ ...prev, progressText: text }));
      }
    };

    setIsPromptOpen(false);
    setState((prev) => {
      if (prev.imageUrl) URL.revokeObjectURL(prev.imageUrl);
      return {
        status: 'loading',
        progressText: 'Capturing viewport…',
        imageUrl: null,
        prompt: null,
        error: null,
        target,
      };
    });

    try {
      if (!viewerHandle) {
        throw new Error('AI capture unavailable (viewer not mounted)');
      }

      // Capture exactly what's visible (512px max for speed)
      const captureBlob = await viewerHandle.captureVisiblePng({ maxSize: 512 });

      if (requestIdRef.current !== requestId) return;

      setProgress('Encoding image…');
      const captureBase64 = await blobToBase64Data(captureBlob);

      if (requestIdRef.current !== requestId) return;

      setProgress('Preparing prompts…');
      const result = await runAcpAnnotateClient({
        imageBase64: captureBase64,
        imageMimeType: captureBlob.type || 'image/png',
        seriesContext,
        onProgress: setProgress,
      });

      if (requestIdRef.current !== requestId) return;

      setProgress('Finalizing…');
      const url = URL.createObjectURL(result.blob);
      
      setState({
        status: 'ready',
        progressText: null,
        imageUrl: url,
        prompt: result.nanoBananaPrompt,
        error: null,
        target,
      });
    } catch (e) {
      if (requestIdRef.current !== requestId) return;
      const message = e instanceof Error ? e.message : String(e);
      setState((prev) => ({
        ...prev,
        status: 'error',
        progressText: null,
        error: message,
      }));
    }
  };

  const togglePrompt = useCallback(() => setIsPromptOpen((o) => !o), []);

  const isTarget = useCallback(
    (date?: string | null, seriesUid?: string | null, instanceIndex?: number | null) => {
      return (
        !!state.target &&
        state.target.date === date &&
        state.target.seriesUid === seriesUid &&
        state.target.instanceIndex === instanceIndex
      );
    },
    [state.target]
  );

  return {
    ...state,
    isPromptOpen,
    setIsPromptOpen, // exposed for manual close
    togglePrompt,
    runAnalysis,
    clear,
    isTarget,
  };
}
