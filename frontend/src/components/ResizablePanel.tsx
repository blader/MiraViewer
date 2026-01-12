import { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ResizablePanelProps {
  children: React.ReactNode;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  side: 'left' | 'right';
  storageKey?: string;
}

export function ResizablePanel({
  children,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
  storageKey,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(`panel-width-${storageKey}`);
      if (saved) return Math.max(minWidth, Math.min(maxWidth, parseInt(saved)));
    }
    return defaultWidth;
  });
  const [collapsed, setCollapsed] = useState(() => {
    if (storageKey) {
      return localStorage.getItem(`panel-collapsed-${storageKey}`) === 'true';
    }
    return false;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Save state to localStorage
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(`panel-width-${storageKey}`, width.toString());
      localStorage.setItem(`panel-collapsed-${storageKey}`, collapsed.toString());
    }
  }, [width, collapsed, storageKey]);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !panelRef.current) return;

      const rect = panelRef.current.getBoundingClientRect();
      let newWidth: number;

      if (side === 'left') {
        newWidth = e.clientX - rect.left;
      } else {
        newWidth = rect.right - e.clientX;
      }

      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(newWidth);
    },
    [isResizing, side, minWidth, maxWidth]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', resize);
      window.addEventListener('mouseup', stopResizing);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, resize, stopResizing]);

  const toggleCollapse = () => setCollapsed(!collapsed);

  const CollapseIcon = side === 'left' 
    ? (collapsed ? ChevronRight : ChevronLeft)
    : (collapsed ? ChevronLeft : ChevronRight);

  return (
    <div
      ref={panelRef}
      className={`relative flex-shrink-0 bg-[var(--bg-secondary)] ${
        side === 'left' ? 'border-r' : 'border-l'
      } border-[var(--border-color)] transition-[width] duration-200 ease-out`}
      style={{ width: collapsed ? 40 : width }}
    >
      {/* Collapse button */}
      <button
        onClick={toggleCollapse}
        className={`absolute top-2 ${
          side === 'left' ? 'right-2' : 'left-2'
        } z-10 p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors`}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <CollapseIcon className="w-4 h-4" />
      </button>

      {/* Content */}
      <div
        className={`h-full overflow-hidden transition-opacity duration-200 ${
          collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        {children}
      </div>

      {/* Resize handle */}
      {!collapsed && (
        <div
          className={`absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)] transition-colors ${
            side === 'left' ? 'right-0' : 'left-0'
          } ${isResizing ? 'bg-[var(--accent)]' : 'bg-transparent'}`}
          onMouseDown={startResizing}
        />
      )}
    </div>
  );
}
