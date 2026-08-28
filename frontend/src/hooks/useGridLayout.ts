import { useState, useEffect, useMemo, useCallback } from 'react';
import { GRID_CELL_METADATA_HEIGHT } from '../utils/constants';

export function useGridLayout(itemCount: number) {
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);

  // Use a callback ref so we can attach the observer even if the container is rendered later
  // (e.g. after a loading state).
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);

  // Track grid container size
  useEffect(() => {
    const node = containerNode;
    if (!node) return;

    const updateSize = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setGridSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);

    return () => observer.disconnect();
  }, [containerNode]);

  // Optimize square diagnostic-image dimensions, budgeting metadata outside the image.
  const gridLayout = useMemo(() => {
    const n = itemCount;
    if (n === 0) return { cols: 1, cellSize: 300, gridSize };

    const { width, height } = gridSize;
    if (width === 0 || height === 0) return { cols: Math.min(n, 4), cellSize: 300, gridSize };
    const gap = 8; // gap-2 = 8px
    const margin = 24;
    const availableWidth = Math.max(0, width - 2 * margin);
    const availableHeight = Math.max(0, height - 2 * margin);

    if (width <= 640) {
      return {
        cols: 1,
        cellSize: Math.max(1, Math.floor(Math.min(availableWidth, availableHeight - GRID_CELL_METADATA_HEIGHT))),
        gridSize,
      };
    }

    let bestCols = 1;
    let bestCellSize = 0;

    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const maxCellWidth = (availableWidth - (cols - 1) * gap) / cols;
      const maxCellHeight = (availableHeight - rows * GRID_CELL_METADATA_HEIGHT - (rows - 1) * gap) / rows;
      const cellSize = Math.min(maxCellWidth, maxCellHeight);

      if (cellSize > bestCellSize) {
        bestCellSize = cellSize;
        bestCols = cols;
      }
    }

    const maxCellSize = Math.max(0, Math.min(availableWidth, availableHeight - GRID_CELL_METADATA_HEIGHT));
    const finalSize = Math.max(1, Math.floor(Math.min(bestCellSize, maxCellSize)));

    return { cols: bestCols, cellSize: finalSize, gridSize };
  }, [itemCount, gridSize]);

  return { containerRef, ...gridLayout };
}
