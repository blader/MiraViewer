import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
} from 'react';
import { getImageUrl } from '../utils/api';
import { useWheelNavigation } from '../hooks/useWheelNavigation';

export type DicomViewerCaptureOptions = {
  /** Max dimension (in CSS pixels) used for the capture output. Defaults to 512 for speed. */
  maxSize?: number;
};

export type DicomViewerHandle = {
  /**
   * Capture exactly what's visible inside the viewer viewport (including zoom/rotation/pan + brightness/contrast).
   * The returned image is cropped to the viewport.
   */
  captureVisiblePng: (options?: DicomViewerCaptureOptions) => Promise<Blob>;
};

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  /** If provided, this image URL will be displayed instead of the DICOM slice URL. */
  imageUrlOverride?: string;
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
  imgRef: React.RefObject<HTMLImageElement | null>;
}

function ImageContent({ imageUrl, imageFilter, imageTransform, alt, imgRef }: ImageContentProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [showSpinner, setShowSpinner] = useState(false);
  const spinnerTimeoutRef = useRef<number | null>(null);

  // Reset loading state on URL change; delay the spinner slightly to avoid flicker for fast loads.
  useEffect(() => {
    setStatus('loading');
    setShowSpinner(false);

    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
      spinnerTimeoutRef.current = null;
    }

    spinnerTimeoutRef.current = window.setTimeout(() => {
      setShowSpinner(true);
    }, 150);

    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
        spinnerTimeoutRef.current = null;
      }
    };
  }, [imageUrl]);

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
          ref={imgRef}
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

export const DicomViewer = forwardRef<DicomViewerHandle, DicomViewerProps>(function DicomViewer(
  {
    studyId,
    seriesUid,
    instanceIndex,
    instanceCount,
    onInstanceChange,
    imageUrlOverride,
    brightness = 100,
    contrast = 100,
    zoom = 1,
    rotation = 0,
    panX = 0,
    panY = 0,
    onPanChange,
  }: DicomViewerProps,
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Mouse wheel navigation for slices
  useWheelNavigation(containerRef, instanceIndex, instanceCount, onInstanceChange);

  // Generate image URL
  const imageUrl = imageUrlOverride ?? getImageUrl(studyId, seriesUid, instanceIndex);

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

  const waitForImageLoad = useCallback(async (): Promise<HTMLImageElement> => {
    const img = imgRef.current;
    if (!img) {
      throw new Error('Image element not available');
    }

    if (img.complete && img.naturalWidth > 0) {
      return img;
    }

    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        reject(new Error('Failed to load image'));
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });

    return img;
  }, []);

  const captureVisiblePng = useCallback(
    async (options?: DicomViewerCaptureOptions): Promise<Blob> => {
      const container = containerRef.current;
      if (!container) {
        throw new Error('Viewer not mounted');
      }

      const cssWidth = container.clientWidth;
      const cssHeight = container.clientHeight;
      if (cssWidth <= 0 || cssHeight <= 0) {
        throw new Error('Viewer has zero size');
      }

      const img = await waitForImageLoad();

      const maxSize = options?.maxSize ?? 512;
      const maxCssDim = Math.max(cssWidth, cssHeight);
      const deviceScale = window.devicePixelRatio || 1;
      const renderScale = Math.min(deviceScale, maxSize / maxCssDim);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cssWidth * renderScale));
      canvas.height = Math.max(1, Math.round(cssHeight * renderScale));

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to create canvas context');
      }

      // Draw in CSS pixel units; scale up to device pixels.
      ctx.scale(renderScale, renderScale);

      // Background (matches viewer)
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      // Match the CSS transform applied in the DOM:
      // transform: translate(pan) scale(zoom) rotate(rotation)
      const panXPx = panX * cssWidth;
      const panYPx = panY * cssHeight;

      ctx.save();
      ctx.translate(cssWidth / 2, cssHeight / 2);
      ctx.translate(panXPx, panYPx);
      ctx.scale(zoom, zoom);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-cssWidth / 2, -cssHeight / 2);

      // Apply brightness/contrast like CSS filters.
      ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;

      // Draw the image with object-contain semantics inside the viewport.
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const scale = Math.min(cssWidth / iw, cssHeight / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (cssWidth - dw) / 2;
      const dy = (cssHeight - dh) / 2;

      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();

      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode capture'));
        }, 'image/png');
      });
    },
    [brightness, contrast, panX, panY, rotation, waitForImageLoad, zoom]
  );

  useImperativeHandle(
    ref,
    () => ({
      captureVisiblePng,
    }),
    [captureVisiblePng]
  );

  // Click to set center - calculates offset to move clicked point to viewport center
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [onPanChange, panX, panY]
  );

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
          imageUrl={imageUrl}
          imageFilter={imageFilter}
          imageTransform={imageTransform}
          alt={`Slice ${instanceIndex + 1}`}
          imgRef={imgRef}
        />
      </div>
    </div>
  );
});
