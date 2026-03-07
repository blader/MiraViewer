import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
} from 'react';
import { getImageIdForInstance } from '../utils/localApi';
import cornerstone from 'cornerstone-core';
import { getEffectiveInstanceIndex } from '../utils/math';
import { CONTROL_LIMITS } from '../utils/constants';
import { isDebugAlignmentEnabled } from '../utils/debugAlignment';
import { getAlignmentSliceScore } from '../utils/alignmentSliceScoreStore';

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

  /** The content key (studyId:seriesUid:effectiveInstanceIndex) currently displayed by the viewer, if known. */
  getDisplayedContentKey: () => string | null;

  /**
   * Wait until the viewer is actually displaying the expected content key.
   * This is useful because Cornerstone keeps the previous image visible while the next slice loads.
   */
  waitForDisplayedContentKey: (expectedKey: string, timeoutMs?: number) => Promise<void>;
};

function parseDicomViewerContentKey(contentKey: string): { seriesUid: string; instanceIndex: number } | null {
  // Content key format: `${studyId}:${seriesUid}:${effectiveInstanceIndex}`
  //
  // We parse from the right so this keeps working even if study IDs ever contain ':' (unlikely).
  const parts = contentKey.split(':');
  if (parts.length < 3) return null;

  const indexStr = parts[parts.length - 1];
  const seriesUid = parts[parts.length - 2];
  const instanceIndex = Number(indexStr);
  if (!Number.isFinite(instanceIndex) || instanceIndex < 0) return null;

  return { seriesUid, instanceIndex };
}

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  /** Logical slice index in the viewer's order (0..instanceCount-1). */
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  /** If true, reverse through-plane order (logical 0 maps to last DICOM instance). */
  reverseSliceOrder?: boolean;
  /** If provided, this image URL will be displayed instead of the DICOM slice URL. */
  imageUrlOverride?: string;
  brightness?: number; // 0-200, 100 = normal
  contrast?: number; // 0-200, 100 = normal
  zoom?: number; // 1 = 100%
  rotation?: number; // degrees
  panX?: number; // normalized pan (-1 to 1, as fraction of viewport)
  panY?: number; // normalized pan (-1 to 1, as fraction of viewport)
  // Hidden affine residual (shear / anisotropic scale), row-major 2x2.
  affine00?: number;
  affine01?: number;
  affine10?: number;
  affine11?: number;
  onPanChange?: (panX: number, panY: number) => void;
  onZoomChange?: (zoom: number) => void;
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

  const handleLoad = useCallback(() => {
    setStatus('loaded');
  }, []);

  const handleError = useCallback(() => {
    setStatus('error');
  }, []);

  return (
    <>
      {status === 'loading' && <DelayedSpinnerOverlay delayMs={150} />}
      {status === 'error' && <ErrorOverlay message="Failed to load image" />}

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
    reverseSliceOrder = false,
    imageUrlOverride,
    brightness = 100,
    contrast = 100,
    zoom = 1,
    rotation = 0,
    panX = 0,
    panY = 0,
    affine00 = 1,
    affine01 = 0,
    affine10 = 0,
    affine11 = 1,
    onPanChange,
    onZoomChange,
  }: DicomViewerProps,
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Mouse wheel behavior:
  // - Inside the image viewport: zoom (so we can keep global wheel slice navigation active elsewhere).
  // - Fallback: if no onZoomChange callback is provided, use wheel for slice navigation.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      // Always prevent default so:
      // - The page doesn't scroll while the user is interacting with the viewer.
      // - The global slice-wheel nav doesn't double-apply (it checks e.defaultPrevented).
      e.preventDefault();

      // Zoom mode (preferred).
      if (onZoomChange) {
        const speed = (() => {
          // deltaMode: 0=pixels, 1=lines, 2=pages
          if (e.deltaMode === 1) return 0.08;
          if (e.deltaMode === 2) return 0.25;
          return 0.0015;
        })();

        const factor = Math.exp(-e.deltaY * speed);
        let nextZoom = zoom * factor;
        nextZoom = Math.max(CONTROL_LIMITS.ZOOM.MIN, Math.min(CONTROL_LIMITS.ZOOM.MAX, nextZoom));

        // Reduce churn from very small deltas.
        nextZoom = Math.round(nextZoom * 1000) / 1000;

        if (nextZoom !== zoom) {
          onZoomChange(nextZoom);
        }

        return;
      }

      // Fallback slice navigation.
      if (instanceCount <= 0) return;
      const delta = Math.sign(e.deltaY);
      const nextIndex = Math.max(0, Math.min(instanceCount - 1, instanceIndex + delta));
      if (nextIndex !== instanceIndex) {
        onInstanceChange(nextIndex);
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [instanceCount, instanceIndex, onInstanceChange, onZoomChange, zoom]);

  const effectiveInstanceIndex = getEffectiveInstanceIndex(instanceIndex, instanceCount, reverseSliceOrder);

  // Resolve imageId for Cornerstone (miradb:<sopInstanceUid>)
  const [imageId, setImageId] = useState<string | null>(null);

  // Track what slice is actually displayed in the viewer.
  // CornerstoneImage intentionally keeps the previous image visible while the next slice loads.
  const [displayedContentKey, setDisplayedContentKey] = useState<string | null>(null);
  const displayedContentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    displayedContentKeyRef.current = displayedContentKey;
  }, [displayedContentKey]);

  const debugSliceScores = isDebugAlignmentEnabled();

  // Only show the (very noisy) per-slice debug scores overlay while the user is holding 'Z'.
  // This keeps the UI clean while still making it easy to inspect values on demand.
  const [isZHeld, setIsZHeld] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const isZKey = (e: KeyboardEvent) => (e.key || '').toLowerCase() === 'z';

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore cmd/ctrl/alt modified combos (e.g. Cmd+Z) so we don't flash the overlay
      // during common shortcuts.
      if (!isZKey(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      setIsZHeld(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isZKey(e)) return;
      setIsZHeld(false);
    };

    const onBlur = () => {
      setIsZHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const displayedForScores = displayedContentKey ? parseDicomViewerContentKey(displayedContentKey) : null;
  const scoreSeriesUid = displayedForScores?.seriesUid ?? seriesUid;
  const scoreInstanceIndex = displayedForScores?.instanceIndex ?? effectiveInstanceIndex;
  const sliceScore = debugSliceScores ? getAlignmentSliceScore(scoreSeriesUid, scoreInstanceIndex) : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await getImageIdForInstance(seriesUid, effectiveInstanceIndex);
        if (!cancelled) setImageId(id);
      } catch (e) {
        console.error(e);
        if (!cancelled) setImageId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seriesUid, effectiveInstanceIndex]);

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
  
  // Combined transform
  //
  // Order matters. We apply the hidden affine matrix first (rightmost), then user rotation/zoom,
  // and finally pan translation in display space.
  const imageTransform = `translate(${panXPx}px, ${panYPx}px) scale(${zoom}) rotate(${rotation}deg) matrix(${affine00}, ${affine10}, ${affine01}, ${affine11}, 0, 0)`;

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

  const getDisplayedContentKey = useCallback((): string | null => {
    return displayedContentKeyRef.current;
  }, []);

  const waitForDisplayedContentKey = useCallback(async (expectedKey: string, timeoutMs = 2500): Promise<void> => {
    const t0 = performance.now();

    // Fast path.
    if (displayedContentKeyRef.current === expectedKey) return;

    while (performance.now() - t0 < timeoutMs) {
      if (displayedContentKeyRef.current === expectedKey) return;
      // Yield so we don't block the UI thread.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for displayed content: ${expectedKey}`);
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

      // Determine our render source:
      // - If ImageContent is used, we capture from the <img>
      // - If CornerstoneImage is used, we capture from its internal <canvas>
      const img = imgRef.current;
      const cornerstoneCanvas = container.querySelector('canvas') as HTMLCanvasElement | null;

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

      // Match the CSS transform applied in the DOM.
      //
      // Note: Canvas 2D uses post-multiplication for transforms, so the last call is applied first.
      // The order below mirrors:
      //   transform: translate(pan) scale(zoom) rotate(rotation) matrix(affine)
      const panXPx = panX * cssWidth;
      const panYPx = panY * cssHeight;

      ctx.save();
      ctx.translate(cssWidth / 2, cssHeight / 2);
      ctx.translate(panXPx, panYPx);
      ctx.scale(zoom, zoom);
      ctx.rotate((rotation * Math.PI) / 180);

      // JSDOM's mocked canvas context (used in tests) may not implement ctx.transform.
      // We only need this when the affine residual is non-identity.
      const isIdentityAffine = affine00 === 1 && affine01 === 0 && affine10 === 0 && affine11 === 1;
      if (!isIdentityAffine && typeof ctx.transform === 'function') {
        ctx.transform(affine00, affine10, affine01, affine11, 0, 0);
      }

      ctx.translate(-cssWidth / 2, -cssHeight / 2);

      // Apply brightness/contrast like CSS filters.
      ctx.filter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;

      if (img) {
        const loadedImg = await waitForImageLoad();

        // Draw the image with object-contain semantics inside the viewport.
        const iw = loadedImg.naturalWidth;
        const ih = loadedImg.naturalHeight;
        const scale = Math.min(cssWidth / iw, cssHeight / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        const dx = (cssWidth - dw) / 2;
        const dy = (cssHeight - dh) / 2;

        ctx.drawImage(loadedImg, dx, dy, dw, dh);
      } else if (cornerstoneCanvas) {
        // Cornerstone renders directly into a canvas sized to the viewport.
        // We draw it 1:1 into our capture canvas.
        ctx.drawImage(cornerstoneCanvas, 0, 0, cssWidth, cssHeight);
      } else {
        ctx.restore();
        throw new Error('No render source available for capture');
      }

      ctx.restore();

      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode capture'));
        }, 'image/png');
      });
    },
    [affine00, affine01, affine10, affine11, brightness, contrast, panX, panY, rotation, waitForImageLoad, zoom]
  );

  useImperativeHandle(
    ref,
    () => ({
      captureVisiblePng,
      getDisplayedContentKey,
      waitForDisplayedContentKey,
    }),
    [captureVisiblePng, getDisplayedContentKey, waitForDisplayedContentKey]
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
        {imageUrlOverride ? (
          <ImageContent
            key={imageUrlOverride}
            imageUrl={imageUrlOverride}
            imageFilter={imageFilter}
            imageTransform={imageTransform}
            alt={`Slice ${instanceIndex + 1}`}
            imgRef={imgRef}
          />
        ) : imageId ? (
          <CornerstoneImage
            imageId={imageId}
            contentKey={`${studyId}:${seriesUid}:${effectiveInstanceIndex}`}
            imageFilter={imageFilter}
            imageTransform={imageTransform}
            alt={`Slice ${instanceIndex + 1}`}
            onDisplayedContentKey={setDisplayedContentKey}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)]">
            Loading...
          </div>
        )}

        {debugSliceScores && isZHeld ? (
          <div className="absolute bottom-10 left-2 z-20 pointer-events-none">
            <div className="px-2 py-1 rounded bg-black/70 border border-white/10 text-white text-[10px] font-mono tabular-nums leading-snug">
              <div>SSIM: {sliceScore ? sliceScore.ssim.toFixed(6) : '—'}</div>
              <div>LNCC: {sliceScore ? sliceScore.lncc.toFixed(6) : '—'}</div>
              <div>ZNCC: {sliceScore ? sliceScore.zncc.toFixed(6) : '—'}</div>
              <div>NGF: {sliceScore ? sliceScore.ngf.toFixed(6) : '—'}</div>
              <div>Census: {sliceScore ? sliceScore.census.toFixed(6) : '—'}</div>
              <div>MIND: {sliceScore && sliceScore.mind != null ? sliceScore.mind.toFixed(6) : '—'}</div>
              <div>Phase: {sliceScore && sliceScore.phase != null ? sliceScore.phase.toFixed(6) : '—'}</div>
              <div>MI: {sliceScore ? sliceScore.mi.toFixed(6) : '—'}</div>
              <div>NMI: {sliceScore ? sliceScore.nmi.toFixed(6) : '—'}</div>
              <div>Score: {sliceScore ? sliceScore.score.toFixed(6) : '—'}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

interface CornerstoneImageProps {
  imageId: string;
  /**
   * Identity for the requested content (e.g. series+instance).
   *
   * This is intentionally separate from `imageId` because `imageId` is resolved asynchronously.
   * When navigating (e.g. swapping overlay dates), props like brightness/contrast/transform can
   * update immediately while the viewer is still showing the previous image.
   *
   * We use this key to keep the *previous* image rendered with the *previous* visual settings
   * until the new image has actually been displayed.
   */
  contentKey: string;
  imageFilter: string;
  imageTransform: string;
  alt: string;

  /** Called after Cornerstone actually displays the requested image. */
  onDisplayedContentKey?: (contentKey: string) => void;
}

function DelayedSpinnerOverlay({ delayMs = 150 }: { delayMs?: number }) {
  const [show, setShow] = useState(false);

  // We intentionally avoid setState() directly in the effect body to keep our
  // eslint rules happy (and to avoid cascading renders). The spinner only flips
  // on after a short delay, which prevents flicker when slices load quickly.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setShow(true);
    }, delayMs);

    return () => {
      clearTimeout(timeout);
    };
  }, [delayMs]);

  if (!show) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ErrorOverlay({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)] bg-black">
      {message}
    </div>
  );
}

function CornerstoneImage({
  imageId,
  contentKey,
  imageFilter,
  imageTransform,
  alt,
  onDisplayedContentKey,
}: CornerstoneImageProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(false);

  const enabledDeferredRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (enabledDeferredRef.current == null) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    enabledDeferredRef.current = { promise, resolve };
  }

  // Track which imageId has been loaded to derive status.
  // Note: we intentionally do NOT clear `loadedImageId` when navigating so the previous
  // slice stays visible until the next slice is ready. This avoids "black flashes"
  // while scrubbing quickly with the mouse wheel.
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [errorImageId, setErrorImageId] = useState<string | null>(null);

  // Track which contentKey the currently-loaded image corresponds to.
  // This lets us avoid applying the *new* settings/transform to the *old* image
  // during async navigation (e.g. switching overlay dates).
  const [loadedContentKey, setLoadedContentKey] = useState<string | null>(null);

  // Store the last-applied visual settings so we can keep the previous image stable
  // until the newly-requested image is actually displayed.
  const [frozenImageFilter, setFrozenImageFilter] = useState(imageFilter);
  const [frozenImageTransform, setFrozenImageTransform] = useState(imageTransform);

  // Keep a ref of the latest requested key so the imageId load effect can associate
  // a loaded imageId with the correct contentKey without re-running on every key change.
  const contentKeyRef = useRef(contentKey);
  useEffect(() => {
    contentKeyRef.current = contentKey;
  }, [contentKey]);

  const onDisplayedContentKeyRef = useRef(onDisplayedContentKey);
  useEffect(() => {
    onDisplayedContentKeyRef.current = onDisplayedContentKey;
  }, [onDisplayedContentKey]);

  // Derive status from comparison
  const status: 'loading' | 'loaded' | 'error' =
    errorImageId === imageId ? 'error' :
    loadedImageId === imageId ? 'loaded' :
    'loading';

  const isContentInSync = loadedImageId === imageId && loadedContentKey === contentKey;

  // Update the frozen visual settings only when we're "in sync".
  //
  // We intentionally schedule the update to avoid calling setState synchronously
  // inside an effect body (our lint rules disallow that).
  useEffect(() => {
    if (!isContentInSync) return;

    const timeout = window.setTimeout(() => {
      setFrozenImageFilter(imageFilter);
      setFrozenImageTransform(imageTransform);
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [imageFilter, imageTransform, isContentInSync]);

  // While navigating, keep rendering the previous image with the previous settings.
  const appliedImageFilter = isContentInSync ? imageFilter : frozenImageFilter;
  const appliedImageTransform = isContentInSync ? imageTransform : frozenImageTransform;

  // Enable cornerstone once on mount.
  //
  // This must be fast and non-blocking: we avoid polling loops (which can stall in tests
  // and in slow layouts) and instead gate image loading on a one-time "enabled" promise.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    try {
      cornerstone.enable(element);
    } catch {
      // already enabled
    }

    enabledRef.current = true;
    enabledDeferredRef.current?.resolve();

    return () => {
      try {
        cornerstone.disable(element);
        enabledRef.current = false;
      } catch {
        // ignore
      }
    };
  }, []);

  // Load image when imageId changes
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const keyForThisLoad = contentKeyRef.current;

    let cancelled = false;

    const load = async () => {
      try {
        await enabledDeferredRef.current!.promise;
        if (cancelled) return;

        const image = await cornerstone.loadImage(imageId);
        if (cancelled) return;

        const viewport = cornerstone.getDefaultViewportForImage(element, image);
        cornerstone.displayImage(element, image, viewport);
        setLoadedImageId(imageId);
        setLoadedContentKey(keyForThisLoad);
        setErrorImageId(null);
        onDisplayedContentKeyRef.current?.(keyForThisLoad);
      } catch (err) {
        console.error('Failed to load DICOM image:', err);
        if (!cancelled) {
          setErrorImageId(imageId);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [imageId]);

  // Handle resize
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const handleResize = () => {
      if (enabledRef.current) {
        try {
          cornerstone.resize(element, true);
        } catch {
          // ignore
        }
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="w-full h-full relative"
      style={{ transform: appliedImageTransform, filter: appliedImageFilter }}
    >
      <div
        ref={elementRef}
        className="w-full h-full"
        style={{ minWidth: '100px', minHeight: '100px' }}
        aria-label={alt}
      />
      {status === 'loading' && <DelayedSpinnerOverlay delayMs={loadedImageId ? 350 : 150} />}
      {status === 'error' && <ErrorOverlay message="Failed to load image" />}
    </div>
  );
}
