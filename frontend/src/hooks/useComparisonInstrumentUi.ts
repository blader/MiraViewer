import { useCallback, useEffect, useRef, useState } from 'react';
import { isOutputGridMode, type OutputGridMode } from '../utils/outputPlaneGrid';
import { COMPARISON_UI_STORAGE_KEY } from '../utils/storageKeys';
import { usePersistedState } from './usePersistedState';

type PersistedComparisonUiState = {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  alignmentOutputMode: OutputGridMode;
  automaticAlignment: boolean;
};

type InstrumentDialog = 'help' | 'upload' | 'export' | 'clear' | null;

const DEFAULT_COMPARISON_UI_STATE: PersistedComparisonUiState = {
  sidebarOpen: true,
  rightSidebarOpen: false,
  alignmentOutputMode: 'native',
  automaticAlignment: true,
};

function validateComparisonUiState(raw: unknown): PersistedComparisonUiState | null {
  if (!raw || typeof raw !== 'object') return null;

  const value = raw as Record<string, unknown>;
  return {
    sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : DEFAULT_COMPARISON_UI_STATE.sidebarOpen,
    rightSidebarOpen:
      typeof value.rightSidebarOpen === 'boolean'
        ? value.rightSidebarOpen
        : DEFAULT_COMPARISON_UI_STATE.rightSidebarOpen,
    alignmentOutputMode: isOutputGridMode(value.alignmentOutputMode)
      ? value.alignmentOutputMode
      : DEFAULT_COMPARISON_UI_STATE.alignmentOutputMode,
    automaticAlignment: typeof value.automaticAlignment === 'boolean' ? value.automaticAlignment : true,
  };
}

export function useComparisonInstrumentUi() {
  const [uiState, setUiState] = usePersistedState(
    COMPARISON_UI_STORAGE_KEY,
    DEFAULT_COMPARISON_UI_STATE,
    validateComparisonUiState,
  );
  const { sidebarOpen, rightSidebarOpen, alignmentOutputMode } = uiState;
  const [activeDialog, setActiveDialog] = useState<InstrumentDialog>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const compactNavigationInitialized = useRef(false);

  const setSidebarOpen = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      const nextOpen = typeof value === 'function' ? value(uiState.sidebarOpen) : value;
      setUiState({
        ...uiState,
        sidebarOpen: nextOpen,
        rightSidebarOpen: nextOpen && window.innerWidth < 1440 ? false : uiState.rightSidebarOpen,
      });
    },
    [setUiState, uiState],
  );

  const setRightSidebarOpen = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      const nextOpen = typeof value === 'function' ? value(uiState.rightSidebarOpen) : value;
      setUiState({
        ...uiState,
        sidebarOpen: nextOpen && window.innerWidth < 1440 ? false : uiState.sidebarOpen,
        rightSidebarOpen: nextOpen,
      });
    },
    [setUiState, uiState],
  );

  useEffect(() => {
    const closeCompactNavigation = () => {
      if (window.innerWidth > 760 || (!uiState.sidebarOpen && !uiState.rightSidebarOpen)) return;
      setUiState({ ...uiState, sidebarOpen: false, rightSidebarOpen: false });
    };

    if (!compactNavigationInitialized.current) {
      compactNavigationInitialized.current = true;
      closeCompactNavigation();
    }

    window.addEventListener('resize', closeCompactNavigation);
    return () => window.removeEventListener('resize', closeCompactNavigation);
  }, [setUiState, uiState]);

  useEffect(() => {
    if (!headerMenuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeaderMenuOpen(false);
    };
    const closeOutsideMenu = (event: MouseEvent) => {
      const menu = headerMenuRef.current;
      if (!menu || (event.target instanceof Node && menu.contains(event.target))) return;
      setHeaderMenuOpen(false);
    };

    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('mousedown', closeOutsideMenu);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('mousedown', closeOutsideMenu);
    };
  }, [headerMenuOpen]);

  const interactionBlocked = activeDialog !== null;
  useEffect(() => {
    if (interactionBlocked || headerMenuOpen || (!sidebarOpen && !rightSidebarOpen)) return;

    const closeDrawerOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || window.innerWidth >= 1440) return;
      const closeFilters = sidebarOpen && window.innerWidth <= 1024;
      if (!closeFilters && !rightSidebarOpen) return;
      setUiState({
        ...uiState,
        sidebarOpen: closeFilters ? false : sidebarOpen,
        rightSidebarOpen: false,
      });
    };

    window.addEventListener('keydown', closeDrawerOnEscape);
    return () => window.removeEventListener('keydown', closeDrawerOnEscape);
  }, [headerMenuOpen, interactionBlocked, rightSidebarOpen, setUiState, sidebarOpen, uiState]);

  return {
    uiState,
    setUiState,
    sidebarOpen,
    rightSidebarOpen,
    alignmentOutputMode,
    setSidebarOpen,
    setRightSidebarOpen,
    activeDialog,
    setActiveDialog,
    headerMenuOpen,
    setHeaderMenuOpen,
    headerMenuRef,
    interactionBlocked,
  };
}
