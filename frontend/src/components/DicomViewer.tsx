import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { getImageUrl } from '../utils/api';
import { useWheelNavigation } from '../hooks/useStudies';

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  brightness?: number;  // 0-200, 100 = normal
  contrast?: number;    // 0-200, 100 = normal
  zoom?: number;        // 1 = 100%
  rotation?: number;    // degrees
  panX?: number;        // pan offset in pixels
  panY?: number;        // pan offset in pixels
  onPanChange?: (panX: number, panY: number) => void;
}

export function DicomViewer({
  studyId,
  seriesUid,
  instanceIndex,
  instanceCount,
  onInstanceChange,
  brightness = 100,
  contrast = 100,
  zoom = 1,
  rotation = 0,
  panX = 0,
  panY = 0,
  onPanChange,
}: DicomViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [imageError, setImageError] = useState(false);
  const spinnerTimeoutRef = useRef<number | null>(null);
  // Mouse wheel navigation for slices
  useWheelNavigation(containerRef, instanceIndex, instanceCount, onInstanceChange);

  // Generate image URL
  const imageUrl = getImageUrl(studyId, seriesUid, instanceIndex);

  // CSS filter for brightness/contrast adjustments
  const imageFilter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;
  
  // Combined transform - pan is applied to move the clicked point to center
  const imageTransform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotation}deg)`;

  // Click to set center - calculates offset to move clicked point to viewport center
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current || !onPanChange) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const viewportCenterX = rect.width / 2;
    const viewportCenterY = rect.height / 2;
    
    // Where user clicked relative to viewport
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // Calculate offset needed to move clicked point to center
    // Account for existing pan and zoom
    const offsetX = viewportCenterX - clickX + panX;
    const offsetY = viewportCenterY - clickY + panY;
    
    onPanChange(offsetX, offsetY);
  }, [onPanChange, panX, panY]);

  // Double-click to reset pan
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onPanChange) {
      onPanChange(0, 0);
    }
  }, [onPanChange]);

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

  return (
    <div className="h-full bg-black">
      {/* Viewport */}
      <div
        ref={containerRef}
        className="h-full overflow-hidden relative cursor-crosshair"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
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
          style={{ transform: imageTransform }}
        >
          <img
            src={imageUrl}
            alt={`Slice ${instanceIndex + 1}`}
            className="w-full h-full object-contain select-none"
            style={{ filter: imageFilter }}
            onLoad={handleImageLoad}
            onError={handleImageError}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
