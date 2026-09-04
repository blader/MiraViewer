import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ComparisonData, PanelSettings, SeriesRef } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
import { comparisonReference } from '../utils/comparisonReference';
import { useGlobalSliceWheelNavigation } from './useGlobalSliceWheelNavigation';
import { useGridLayout } from './useGridLayout';
import { useOverlayNavigation } from './useOverlayNavigation';

type ComparisonWorkspaceNavigationOptions = {
  data: ComparisonData | null;
  selectedSeqId: string | null;
  enabledDates: Set<string>;
  panelSettings: Map<string, PanelSettings>;
  progress: number;
  setProgress: (progress: number) => void;
  interactionBlocked: boolean;
};

function getOverlayViewerSize(gridSize: { width: number; height: number }) {
  if (gridSize.width <= 0 || gridSize.height <= 0) return 300;

  const maxSize = Math.min(Math.max(0, gridSize.width - 48), Math.max(0, gridSize.height - 120));
  return Math.max(1, maxSize);
}

export function useComparisonWorkspaceNavigation({
  data,
  selectedSeqId,
  enabledDates,
  panelSettings,
  progress,
  setProgress,
  interactionBlocked,
}: ComparisonWorkspaceNavigationOptions) {
  const columns = useMemo(() => {
    if (!data || !selectedSeqId) return [] as { date: string; ref: SeriesRef }[];

    const seriesByDate = data.series_map[selectedSeqId] || {};
    return [...enabledDates]
      .sort((first, second) => second.localeCompare(first))
      .flatMap((date) => {
        const ref = seriesByDate[date];
        return ref ? [{ date, ref }] : [];
      });
  }, [data, selectedSeqId, enabledDates]);

  const overlayColumns = useMemo(() => [...columns].reverse(), [columns]);
  const {
    containerRef: gridLayoutContainerRef,
    cols: gridCols,
    cellSize: gridCellSize,
    gridSize,
  } = useGridLayout(columns.length);
  const centerPaneRef = useRef<HTMLDivElement | null>(null);
  const setCenterPaneRef = useCallback(
    (node: HTMLDivElement | null) => {
      centerPaneRef.current = node;
      gridLayoutContainerRef(node);
    },
    [gridLayoutContainerRef],
  );

  const navigation = useOverlayNavigation(overlayColumns, { interactionBlocked });
  const {
    viewMode,
    overlayDateIndex,
    compareTargetIndex,
    displayedOverlayIndex,
    setViewMode: setNavigationViewMode,
    setOverlayDateIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  } = navigation;

  const setViewMode = useCallback(
    (next: 'grid' | 'overlay' | 'svr3d') => {
      if (viewMode === 'grid' && next === 'svr3d' && overlayColumns.length > 0) {
        setOverlayDateIndex(overlayColumns.length - 1);
      }
      setNavigationViewMode(next);
    },
    [overlayColumns.length, setNavigationViewMode, setOverlayDateIndex, viewMode],
  );

  const positionAt = (index: number) => {
    const column = overlayColumns[index];
    const ref = column?.ref;
    const date = column?.date;
    const settings = date ? panelSettings.get(date) || DEFAULT_PANEL_SETTINGS : DEFAULT_PANEL_SETTINGS;
    const sliceIndex = ref ? getSliceIndex(ref.instance_count, progress, settings.offset) : 0;
    const effectiveSliceIndex = ref
      ? getEffectiveInstanceIndex(sliceIndex, ref.instance_count, settings.reverseSliceOrder)
      : 0;

    return { ref, date, settings, sliceIndex, effectiveSliceIndex };
  };

  const displayed = positionAt(displayedOverlayIndex);
  const selected = positionAt(overlayDateIndex);
  const compare = positionAt(compareTargetIndex);
  const {
    ref: overlayDisplayedRef,
    date: overlayDisplayedDate,
    settings: overlayDisplayedSettings,
    sliceIndex: overlayDisplayedSliceIndex,
    effectiveSliceIndex: overlayDisplayedEffectiveSliceIndex,
  } = displayed;
  const {
    ref: overlaySelectedRef,
    date: overlaySelectedDate,
    settings: overlaySelectedSettings,
    sliceIndex: overlaySelectedSliceIndex,
  } = selected;
  const {
    ref: overlayCompareRef,
    date: overlayCompareDate,
    settings: overlayCompareSettings,
    sliceIndex: overlayCompareSliceIndex,
  } = compare;

  const svr3dSeed = useMemo(
    () => ({
      defaultDateIso: overlayDisplayedDate ?? null,
      fallbackRoiSeriesUid: overlayDisplayedRef?.series_uid ?? null,
      fallbackRoiSliceIndex: overlayDisplayedRef ? overlayDisplayedEffectiveSliceIndex : null,
    }),
    [overlayDisplayedDate, overlayDisplayedEffectiveSliceIndex, overlayDisplayedRef],
  );

  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const navigationReference = useMemo(() => {
    const selected = viewMode === 'overlay' ? overlayColumns[overlayDateIndex] : undefined;
    const column = selected && selected.ref.instance_count > 1 ? selected : comparisonReference(columns);
    if (!column || viewMode === 'svr3d') return null;
    const settings = panelSettings.get(column.date) ?? DEFAULT_PANEL_SETTINGS;
    return {
      date: column.date,
      ref: column.ref,
      instanceCount: column.ref.instance_count,
      offset: settings.offset,
      reverseSliceOrder: settings.reverseSliceOrder,
    };
  }, [viewMode, overlayColumns, overlayDateIndex, columns, panelSettings]);

  const wheelNavContextRef = useRef<{ instanceCount: number; offset: number } | null>(null);
  useEffect(() => {
    wheelNavContextRef.current =
      navigationReference && navigationReference.instanceCount > 1 ? navigationReference : null;
  }, [navigationReference]);

  const setProgressRef = useRef(setProgress);
  useEffect(() => {
    setProgressRef.current = setProgress;
  }, [setProgress]);

  useGlobalSliceWheelNavigation({
    centerPaneRef,
    contextRef: wheelNavContextRef,
    interactionBlocked,
    progressRef,
    setProgressRef,
  });

  const playbackInstanceCount = navigationReference?.instanceCount ?? 1;

  return {
    columns,
    overlayColumns,
    gridCols,
    gridCellSize,
    setCenterPaneRef,
    viewMode,
    setViewMode,
    selectionFallback: navigation.selectionFallback,
    overlayDateIndex,
    setOverlayDateIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
    overlayDisplayedRef,
    overlayDisplayedDate,
    overlayDisplayedSettings,
    overlayDisplayedSliceIndex,
    overlayDisplayedEffectiveSliceIndex,
    overlaySelectedRef,
    overlaySelectedDate,
    overlaySelectedSettings,
    overlaySelectedSliceIndex,
    overlayCompareRef,
    overlayCompareDate,
    overlayCompareSettings,
    overlayCompareSliceIndex,
    isOverlayComparing: displayedOverlayIndex !== overlayDateIndex,
    hasOverlayCompareTarget: overlayColumns.length > 1 && compareTargetIndex !== overlayDateIndex,
    overlayViewerSize: getOverlayViewerSize(gridSize),
    svr3dSeed,
    progressRef,
    navigationReference,
    playbackInstanceCount,
  };
}
