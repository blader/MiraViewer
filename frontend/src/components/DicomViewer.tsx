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
}: DicomViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [imageError, setImageError] = useState(false);
  const spinnerTimeoutRef = useRef<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Mouse wheel navigation for slices
  useWheelNavigation(containerRef, instanceIndex, instanceCount, onInstanceChange);

  // Generate image URL
  const imageUrl = getImageUrl(studyId, seriesUid, instanceIndex);

  // CSS filter for brightness/contrast adjustments
  const imageFilter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;
  
  // Combined transform
  const imageTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`;

  // Mouse handlers for panning
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setPan({ x: dragStartRef.current.panX + dx, y: dragStartRef.current.panY + dy });
    }
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Double-click to reset pan
  const handleDoubleClick = useCallback(() => {
    setPan({ x: 0, y: 0 });
  }, []);

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
        className={`h-full overflow-hidden relative ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
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
          style={{ transform: imageTransform, transition: isDragging ? 'none' : 'transform 0.1s ease-out' }}
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
