import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ComparisonData, PanelSettings, SeriesRef } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
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
    setViewMode,
    setOverlayDateIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  } = navigation;

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

  const svr3dSeed = useMemo(() => {
    if (overlayDisplayedDate && overlayDisplayedRef) {
      return {
        defaultDateIso: overlayDisplayedDate,
        fallbackRoiSeriesUid: overlayDisplayedRef.series_uid,
        fallbackRoiSliceIndex: overlayDisplayedEffectiveSliceIndex,
      };
    }

    const first = columns.find((column) => column.ref);
    if (!first?.ref) {
      return {
        defaultDateIso: null,
        fallbackRoiSeriesUid: null,
        fallbackRoiSliceIndex: null,
      };
    }

    const settings = panelSettings.get(first.date) || DEFAULT_PANEL_SETTINGS;
    const sliceIndex = getSliceIndex(first.ref.instance_count, progress, settings.offset);

    return {
      defaultDateIso: first.date,
      fallbackRoiSeriesUid: first.ref.series_uid,
      fallbackRoiSliceIndex: getEffectiveInstanceIndex(
        sliceIndex,
        first.ref.instance_count,
        settings.reverseSliceOrder,
      ),
    };
  }, [
    columns,
    overlayDisplayedDate,
    overlayDisplayedEffectiveSliceIndex,
    overlayDisplayedRef,
    panelSettings,
    progress,
  ]);

  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const wheelNavContextRef = useRef<{ instanceCount: number; offset: number } | null>(null);
  useEffect(() => {
    if (viewMode === 'svr3d') {
      wheelNavContextRef.current = null;
      return;
    }

    let instanceCount = 1;
    let offset = DEFAULT_PANEL_SETTINGS.offset;

    if (viewMode === 'overlay' && overlaySelectedRef && overlaySelectedDate) {
      instanceCount = overlaySelectedRef.instance_count;
      offset = overlaySelectedSettings.offset;
    } else {
      const primaryGrid = columns.find((column) => column.ref);
      if (primaryGrid?.ref) {
        instanceCount = primaryGrid.ref.instance_count;
        offset = (panelSettings.get(primaryGrid.date) || DEFAULT_PANEL_SETTINGS).offset;
      } else {
        const anyOverlay = overlayColumns.find((column) => column.ref);
        if (anyOverlay?.ref) {
          instanceCount = anyOverlay.ref.instance_count;
          offset = (panelSettings.get(anyOverlay.date) || DEFAULT_PANEL_SETTINGS).offset;
        }
      }
    }

    wheelNavContextRef.current = instanceCount > 1 ? { instanceCount, offset } : null;
  }, [
    viewMode,
    overlaySelectedRef,
    overlaySelectedDate,
    overlaySelectedSettings.offset,
    columns,
    overlayColumns,
    panelSettings,
  ]);

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

  const playbackInstanceCount = useMemo(() => {
    const fromOverlay = overlayColumns[overlayDateIndex]?.ref?.instance_count;
    if (typeof fromOverlay === 'number' && fromOverlay > 1) return fromOverlay;

    const anyOverlay = overlayColumns.find((column) => column.ref)?.ref?.instance_count;
    if (typeof anyOverlay === 'number' && anyOverlay > 1) return anyOverlay;

    const anyGrid = columns.find((column) => column.ref)?.ref?.instance_count;
    if (typeof anyGrid === 'number' && anyGrid > 1) return anyGrid;

    return 1;
  }, [overlayColumns, overlayDateIndex, columns]);

  return {
    columns,
    overlayColumns,
    gridCols,
    gridCellSize,
    setCenterPaneRef,
    viewMode,
    setViewMode,
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
    playbackInstanceCount,
  };
}
