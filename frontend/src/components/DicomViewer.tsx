import { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react';
import { getImageUrl } from '../utils/api';
import { useWheelNavigation } from '../hooks/useWheelNavigation';

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  brightness?: number; // 0-200, 100 = normal
  contrast?: number; // 0-200, 100 = normal
  zoom?: number; // 1 = 100%
  rotation?: number; // degrees
  panX?: number; // normalized pan (-1 to 1, as fraction of viewport)
  panY?: number; // normalized pan (-1 to 1, as fraction of viewport)
  onPanChange?: (panX: number, panY: number) => void;
}

interface ImageContentProps {
  imageUrl: string;
  imageFilter: string;
  imageTransform: string;
  alt: string;
}

function ImageContent({ imageUrl, imageFilter, imageTransform, alt }: ImageContentProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimeoutRef = useRef<number | null>(null);

  // Delay the spinner slightly to avoid flicker for fast loads.
  useEffect(() => {
    spinnerTimeoutRef.current = window.setTimeout(() => {
      setShowSpinner(true);
    }, 150);

    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
      }
    };
  }, []);

  const handleLoad = useCallback(() => {
    setStatus('loaded');
    setShowSpinner(false);
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
      spinnerTimeoutRef.current = null;
    }
  }, []);

  const handleError = useCallback(() => {
    setStatus('error');
    setShowSpinner(false);
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
      spinnerTimeoutRef.current = null;
    }
  }, []);

  return (
    <>
      {showSpinner && status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)]">
          Failed to load image
        </div>
      )}

      <div className="w-full h-full flex items-center justify-center" style={{ transform: imageTransform }}>
        <img
          src={imageUrl}
          alt={alt}
          className="w-full h-full object-contain select-none"
          style={{ filter: imageFilter }}
          onLoad={handleLoad}
          onError={handleError}
          draggable={false}
        />
      </div>
    </>
  );
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
  // Mouse wheel navigation for slices
  useWheelNavigation(containerRef, instanceIndex, instanceCount, onInstanceChange);

  // Generate image URL
  const imageUrl = getImageUrl(studyId, seriesUid, instanceIndex);

  // CSS filter for brightness/contrast adjustments
  const imageFilter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;
  
  // Convert normalized pan to pixels for transform
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  
  // Track viewport size
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        setViewportSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  
  // Convert normalized pan to pixels
  const panXPx = panX * viewportSize.width;
  const panYPx = panY * viewportSize.height;
  
  // Combined transform - pan is applied to move the clicked point to center
  const imageTransform = `translate(${panXPx}px, ${panYPx}px) scale(${zoom}) rotate(${rotation}deg)`;

  // Click to set center - calculates offset to move clicked point to viewport center
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current || !onPanChange) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const viewportCenterX = rect.width / 2;
    const viewportCenterY = rect.height / 2;
    
    // Where user clicked relative to viewport
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // Current pan in pixels
    const currentPanXPx = panX * rect.width;
    const currentPanYPx = panY * rect.height;
    
    // Calculate offset needed to move clicked point to center (in pixels)
    const offsetXPx = viewportCenterX - clickX + currentPanXPx;
    const offsetYPx = viewportCenterY - clickY + currentPanYPx;
    
    // Convert back to normalized values
    const normalizedX = offsetXPx / rect.width;
    const normalizedY = offsetYPx / rect.height;
    
    onPanChange(normalizedX, normalizedY);
  }, [onPanChange, panX, panY]);

  // Double-click to reset pan
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onPanChange) {
      onPanChange(0, 0);
    }
  }, [onPanChange]);


  return (
    <div className="h-full bg-black">
      {/* Viewport */}
      <div
        ref={containerRef}
        className="h-full overflow-hidden relative cursor-crosshair"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <ImageContent
          key={imageUrl}
          imageUrl={imageUrl}
          imageFilter={imageFilter}
          imageTransform={imageTransform}
          alt={`Slice ${instanceIndex + 1}`}
        />
      </div>
    </div>
  );
}
