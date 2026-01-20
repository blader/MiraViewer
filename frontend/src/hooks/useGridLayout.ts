import { useState, useEffect, useMemo, useCallback } from 'react';

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

  // Compute optimal grid dimensions for square cells
  const gridLayout = useMemo(() => {
    const n = itemCount;
    if (n === 0) return { cols: 1, cellSize: 300, gridSize };

    const { width, height } = gridSize;
    if (width === 0 || height === 0) return { cols: Math.min(n, 4), cellSize: 300, gridSize };
    
    const gap = 8; // gap-2 = 8px
    // Grid cell controls are overlaid on hover, so they don't take up layout height.
    const headerHeight = 0;

    // Reserve margins so grid isn't hugging edges
    const marginH = 24; // px on left+right total reserve is 2*marginH
    const marginV = 24; // px on top+bottom total reserve is 2*marginV
    
    const availableWidth = Math.max(0, width - 2 * marginH);
    const availableHeight = Math.max(0, height - 2 * marginV);
    
    // Try different column counts and find the one that maximizes cell size
    let bestCols = 1;
    let bestCellSize = 0;
    
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      
      // Calculate max cell size for this configuration
      // Total width needed: cols * cellSize + (cols - 1) * gap <= availableWidth
      const maxCellWidth = (availableWidth - (cols - 1) * gap) / cols;
      
      // Total height needed: rows * (cellSize + headerHeight) + (rows - 1) * gap <= availableHeight
      const maxCellHeight = (availableHeight - rows * headerHeight - (rows - 1) * gap) / rows;
      
      // Cell is square, so take the minimum
      const cellSize = Math.min(maxCellWidth, maxCellHeight);
      
      if (cellSize > bestCellSize) {
        bestCellSize = cellSize;
        bestCols = cols;
      }
    }
    
    // Floor it but allow large sizes, only enforce a small minimum for edge cases
    const minCellSize = 100;
    const maxCellSize = Math.min(availableWidth, availableHeight - headerHeight); // Don't exceed viewport
    const finalSize = Math.floor(Math.max(Math.min(bestCellSize, maxCellSize), minCellSize));
    
    return { cols: bestCols, cellSize: finalSize, gridSize }; // Return gridSize too for overlay sizing
  }, [itemCount, gridSize]);

  return { containerRef, ...gridLayout };
}
