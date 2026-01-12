import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { getImageUrl } from '../utils/api';
import { useWheelNavigation } from '../hooks/useStudies';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  windowCenter?: number;
  windowWidth?: number;
  label?: string;
}

export function DicomViewer({
  studyId,
  seriesUid,
  instanceIndex,
  instanceCount,
  onInstanceChange,
  windowCenter,
  windowWidth,
  label,
}: DicomViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [imageError, setImageError] = useState(false);
  const spinnerTimeoutRef = useRef<number | null>(null);

  // Mouse wheel navigation for slices
  useWheelNavigation(containerRef, instanceIndex, instanceCount, onInstanceChange);

  // Generate image URL
  const imageUrl = getImageUrl(studyId, seriesUid, instanceIndex, windowCenter, windowWidth);

  // Reset view state when series changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [seriesUid]);

  const handleImageLoad = useCallback(() => {
    setImageLoading(false);
    setShowSpinner(false);
    setImageError(false);
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
      spinnerTimeoutRef.current = null;
    }
  }, []);

  const handleImageError = useCallback(() => {
    setImageLoading(false);
    setShowSpinner(false);
    setImageError(true);
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
      spinnerTimeoutRef.current = null;
    }
  }, []);

  // Reset loading state when image changes - useLayoutEffect to run before onLoad can fire
  useLayoutEffect(() => {
    setImageLoading(true);
    setImageError(false);
    // Only show spinner if loading takes more than 150ms
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
    }
    spinnerTimeoutRef.current = window.setTimeout(() => {
      setShowSpinner(true);
    }, 150);
    
    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
      }
    };
  }, [studyId, seriesUid, instanceIndex]);

  // Mouse drag for panning
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.25, 5));
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.25, 0.25));
  const handleReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Prevent wheel events on slider from propagating
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    
    const stopWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    
    slider.addEventListener('wheel', stopWheel, { passive: true });
    return () => slider.removeEventListener('wheel', stopWheel);
  }, []);

  return (
    <div className="h-full flex flex-col bg-black">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        <div className="flex items-center gap-2">
          {label && (
            <span className="text-xs font-medium text-[var(--accent)] bg-[var(--bg-tertiary)] px-2 py-1 rounded">
              {label}
            </span>
          )}
          <span className="text-sm text-[var(--text-secondary)]">
            Slice {instanceIndex + 1} / {instanceCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleZoomOut}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-[var(--text-secondary)] w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-[var(--border-color)] mx-1" />
          <button
            onClick={handleReset}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Reset View"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing relative dicom-viewport"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {showSpinner && imageLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        
        {imageError && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)]">
            Failed to load image
          </div>
        )}

        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
        >
          <img
            src={imageUrl}
            alt={`Slice ${instanceIndex + 1}`}
            className="max-w-full max-h-full object-contain select-none"
            onLoad={handleImageLoad}
            onError={handleImageError}
            draggable={false}
          />
        </div>

        {/* Slice indicator */}
        <div 
          ref={sliderRef}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm rounded-full px-4 py-2"
        >
          <input
            type="range"
            min={0}
            max={instanceCount - 1}
            value={instanceIndex}
            onChange={(e) => onInstanceChange(parseInt(e.target.value))}
            className="w-48"
          />
        </div>
      </div>
    </div>
  );
}
