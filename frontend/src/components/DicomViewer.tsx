import { useEffect, useRef, useState, useLayoutEffect, useCallback, useContext, useSyncExternalStore } from 'react';
import { getImageIdForInstance } from '../utils/localApi';
import cornerstone from 'cornerstone-core';
import { getEffectiveInstanceIndex } from '../utils/math';
import { CONTROL_LIMITS } from '../utils/constants';
import {
  isDebugAlignmentEnabled,
  isDebugAlignmentKeyHeld,
  subscribeToDebugAlignmentKey,
} from '../utils/debugAlignment';
import { getAlignmentSliceScore } from '../utils/alignmentSliceScoreStore';
import { loadCornerstoneImage } from '../utils/decodedFrame';
import { IMAGE_ID_LOOKUP_TIMEOUT_MS, IMAGE_LOAD_TIMEOUT_MS, waitForBoundedOperation } from '../utils/imageLoadDeadline';
import type { DerivedAlignmentFrame } from '../utils/derivedAlignmentFrame';
import { useAlignedFrame } from '../hooks/useAlignedFrame';
import { SharpSliceDisplayContext, useSharpSliceDisplay } from '../hooks/useSharpSliceDisplay';
import type { SharpSliceDisplay } from '../hooks/useSharpSliceDisplay';
import {
  createDerivedImagePresentation,
  getDerivedAlignmentContent,
  sameDerivedAlignmentContent,
} from '../utils/derivedImagePresentation';
import type { DerivedImagePresentation } from '../utils/derivedImagePresentation';

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

function formatDebugRank(rank: number | undefined, active: boolean | undefined): string {
  if (active === false) return 'flat';
  if (active !== true || rank == null) return '—';
  return rank.toFixed(4);
}

function useViewportPan({
  contentKey,
  panX,
  panY,
  onPanChange,
  interactionBlocked,
  contentPending,
}: {
  contentKey: string;
  panX: number;
  panY: number;
  onPanChange?: (panX: number, panY: number) => void;
  interactionBlocked: boolean;
  contentPending: boolean;
}) {
  const [drag, setDrag] = useState<{
    origin: {
      contentKey: string;
      element: HTMLDivElement;
      pointerId: number;
      clientX: number;
      clientY: number;
      width: number;
      height: number;
      panX: number;
      panY: number;
    };
    panX: number;
    panY: number;
  } | null>(null);
  const canPan = !interactionBlocked && !!onPanChange;
  const origin = drag?.origin;

  // A gesture belongs to one image and one starting transform, not the next slice or tool.
  if (
    origin &&
    (!canPan || contentPending || origin.contentKey !== contentKey || origin.panX !== panX || origin.panY !== panY)
  ) {
    setDrag(null);
  }

  useEffect(() => {
    if (!origin) return;
    const cancel = () => setDrag(null);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      if (origin.element.hasPointerCapture?.(origin.pointerId)) {
        origin.element.releasePointerCapture(origin.pointerId);
      }
    };
  }, [origin]);

  const moveOrFinish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin || !canPan || contentPending || event.pointerId !== origin.pointerId) return;
    const nextX = origin.panX + (event.clientX - origin.clientX) / origin.width;
    const nextY = origin.panY + (event.clientY - origin.clientY) / origin.height;
    if (event.type === 'pointerup') {
      setDrag(null);
      // Preview locally while dragging; persist and record one undo entry on release.
      if (nextX !== panX || nextY !== panY) onPanChange?.(nextX, nextY);
    } else if (nextX !== drag?.panX || nextY !== drag?.panY) {
      setDrag({ origin, panX: nextX, panY: nextY });
    }
  };

  const cancelPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === origin?.pointerId) setDrag(null);
  };

  const resetPan = () => {
    setDrag(null);
    onPanChange?.(0, 0);
  };

  return {
    panX: drag?.panX ?? panX,
    panY: drag?.panY ?? panY,
    canPan,
    isPanning: !!drag,
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (!canPan || contentPending || origin || event.defaultPrevented || !event.isPrimary || event.button !== 0)
          return;
        const element = event.currentTarget;
        const { width, height } = element.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        event.preventDefault();
        element.focus({ preventScroll: true });
        element.setPointerCapture?.(event.pointerId);
        setDrag({
          origin: {
            contentKey,
            element,
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            width,
            height,
            panX,
            panY,
          },
          panX,
          panY,
        });
      },
      onPointerMove: moveOrFinish,
      onPointerUp: moveOrFinish,
      onPointerCancel: cancelPointer,
      onLostPointerCapture: cancelPointer,
      onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => {
        if (!canPan || contentPending) return;
        event.stopPropagation();
        resetPan();
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Escape' && drag) {
          event.preventDefault();
          event.stopPropagation();
          setDrag(null);
        } else if (canPan && !contentPending && event.key === 'Enter') {
          event.preventDefault();
          resetPan();
        }
      },
    },
  };
}

interface DicomViewerProps {
  studyId: string;
  seriesUid: string;
  /** Logical slice index in the viewer's order (0..instanceCount-1). */
  instanceIndex: number;
  instanceCount: number;
  onInstanceChange: (index: number) => void;
  /** Prevent any viewer-local scrolling or zoom from mutating an in-flight alignment reference. */
  interactionBlocked?: boolean;
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
  /** Image-space annotations use committed settings and follow the live pan preview together. */
  children?: React.ReactNode;
}

interface ImageContentProps {
  imageUrl: string;
  imageFilter: string;
  imageTransform: string;
  alt: string;
}

type DicomImageSource = {
  imageId: string;
  derivedFrame: DerivedAlignmentFrame | null;
  contentKey: string;
  presentationKey: string;
};

function ImageContent({ imageUrl, imageFilter, imageTransform, alt }: ImageContentProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (status !== 'loading') return;
    const timeout = window.setTimeout(() => setStatus('error'), IMAGE_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [attempt, status]);

  const handleLoad = useCallback(() => {
    setStatus('loaded');
  }, []);

  const handleError = useCallback(() => {
    setStatus('error');
  }, []);

  return (
    <>
      {status === 'loading' && <DelayedSpinnerOverlay delayMs={150} />}
      {status === 'error' && (
        <ErrorOverlay
          message="Unable to load this image."
          onRetry={() => {
            setStatus('loading');
            setAttempt((value) => value + 1);
          }}
        />
      )}

      <div className="w-full h-full flex items-center justify-center" style={{ transform: imageTransform }}>
        <img
          key={attempt}
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

function DicomAlignmentDiagnostics({ sliceScore }: { sliceScore: ReturnType<typeof getAlignmentSliceScore> }) {
  return (
    <div className="absolute bottom-10 left-2 z-20 pointer-events-none">
      <div className="rounded-[2px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 font-[family-name:var(--font-mono)] text-[10px] tabular-nums leading-snug text-[var(--text-primary)]">
        {sliceScore?.coverage != null ? (
          <>
            <div>
              Stage: {sliceScore.stage ?? '—'}
              {sliceScore.selected ? ' · selected' : sliceScore.retainedForFine ? ' · shortlisted' : ''}
            </div>
            <div>Coverage: {sliceScore.coverage.toFixed(4)}</div>
            <div>CS: {sliceScore.ssim.toFixed(6)}</div>
            <div>LNCC: {sliceScore.lncc.toFixed(6)}</div>
            <div>MIND: {sliceScore.mind != null ? sliceScore.mind.toFixed(6) : '—'}</div>
            <div>MIND rank: {formatDebugRank(sliceScore.mindRank, sliceScore.mindActive)}</div>
            <div>NGF: {sliceScore.ngf.toFixed(6)}</div>
            <div>Boundary rank: {formatDebugRank(sliceScore.boundaryRank, sliceScore.boundaryActive)}</div>
            <div>Structural rank: {formatDebugRank(sliceScore.structuralRank, sliceScore.structuralActive)}</div>
            <div>Appearance rank: {formatDebugRank(sliceScore.appearanceRank, sliceScore.appearanceActive)}</div>
            <div>Perceptual rank: {sliceScore.perceptualRank?.toFixed(4) ?? '—'}</div>
            <div>Phase input: {sliceScore.phaseInput?.replaceAll('-', ' ') ?? '—'}</div>
            {sliceScore.finalAffineSelected != null ? (
              <div>Final affine: {sliceScore.finalAffineSelected.replaceAll('-', ' ')}</div>
            ) : null}
            {sliceScore.finalAffineStructuralScore != null && sliceScore.finalAffineSeedStructuralScore != null ? (
              <div>
                Final affine structure: {sliceScore.finalAffineStructuralScore.toFixed(6)} (seed{' '}
                {sliceScore.finalAffineSeedStructuralScore.toFixed(6)})
              </div>
            ) : null}
            {sliceScore.coarseStage && sliceScore.fineStage ? (
              <div>
                Rank coarse→fine: {sliceScore.coarseStage.perceptualRank.toFixed(4)}→
                {sliceScore.fineStage.perceptualRank.toFixed(4)}
              </div>
            ) : null}
            <div>
              Phase δ: {sliceScore.correctionX?.toFixed(2) ?? '—'}, {sliceScore.correctionY?.toFixed(2) ?? '—'}
            </div>
            <div>
              Peak / PSR: {sliceScore.phase?.toFixed(4) ?? '—'} /{' '}
              {sliceScore.phasePeakToSidelobeRatio?.toFixed(2) ?? '—'}
            </div>
          </>
        ) : (
          <>
            <div>SSIM: {sliceScore ? sliceScore.ssim.toFixed(6) : '—'}</div>
            <div>LNCC: {sliceScore ? sliceScore.lncc.toFixed(6) : '—'}</div>
            <div>ZNCC: {sliceScore ? sliceScore.zncc.toFixed(6) : '—'}</div>
            <div>NGF: {sliceScore ? sliceScore.ngf.toFixed(6) : '—'}</div>
            <div>Census: {sliceScore ? sliceScore.census.toFixed(6) : '—'}</div>
            <div>Phase: {sliceScore && sliceScore.phase != null ? sliceScore.phase.toFixed(6) : '—'}</div>
            <div>MI: {sliceScore ? sliceScore.mi.toFixed(6) : '—'}</div>
            <div>NMI: {sliceScore ? sliceScore.nmi.toFixed(6) : '—'}</div>
            <div>Score: {sliceScore ? sliceScore.score.toFixed(6) : '—'}</div>
          </>
        )}
      </div>
    </div>
  );
}

export function DicomViewer({
  studyId,
  seriesUid,
  instanceIndex,
  instanceCount,
  onInstanceChange,
  interactionBlocked = false,
  reverseSliceOrder = false,
  imageUrlOverride,
  onPanChange,
  onZoomChange,
  children,
  ...requestedPresentation
}: DicomViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveInstanceIndex = getEffectiveInstanceIndex(instanceIndex, instanceCount, reverseSliceOrder);
  const {
    frame: derivedFrame,
    pending: alignmentPending,
    status: alignmentStatus,
    settings: acceptedSettings,
  } = useAlignedFrame(seriesUid, effectiveInstanceIndex);
  const {
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
  } = acceptedSettings ?? requestedPresentation;

  const [imageSource, setImageSource] = useState<DicomImageSource | null>(null);
  const contentKey = `${studyId}:${seriesUid}:${derivedFrame?.instanceIndex ?? effectiveInstanceIndex}`;
  const presentationKey = derivedFrame?.imageId ?? `${studyId}:${seriesUid}:${effectiveInstanceIndex}:native`;
  // This is the renderer's accepted content, not the requested slice number.
  const [displayedContentKey, setDisplayedContentKey] = useState<string | null>(null);
  const imagePending = !imageUrlOverride && displayedContentKey !== contentKey;
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [lookupFailure, setLookupFailure] = useState<{
    contentKey: string;
    presentationKey: string;
    message: string;
  } | null>(null);
  const lookupError =
    lookupFailure?.contentKey === contentKey && lookupFailure.presentationKey === presentationKey
      ? lookupFailure.message
      : null;

  // Mouse wheel behavior:
  // - Plain wheel events advance slices, matching the center-pane global wheel behavior.
  // - Cmd+wheel zooms the hovered image when zoom control is available.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || interactionBlocked) return;

    const handleWheel = (e: WheelEvent) => {
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      if (e.metaKey) {
        e.preventDefault();
        if (!onZoomChange || alignmentPending || imagePending) return;

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

      // Trackpad pinch-zoom sends ctrlKey wheel events; don't interpret that as slice scrolling.
      if (e.ctrlKey) return;

      if (instanceCount <= 0) return;
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      const nextIndex = Math.max(0, Math.min(instanceCount - 1, instanceIndex + delta));
      if (nextIndex !== instanceIndex) {
        onInstanceChange(nextIndex);
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [
    alignmentPending,
    imagePending,
    instanceCount,
    instanceIndex,
    interactionBlocked,
    onInstanceChange,
    onZoomChange,
    zoom,
  ]);

  const viewportPan = useViewportPan({
    contentKey: `${studyId}:${seriesUid}:${effectiveInstanceIndex}:${imageUrlOverride ?? derivedFrame?.imageId ?? ''}`,
    panX,
    panY,
    onPanChange,
    interactionBlocked,
    contentPending: alignmentPending || imagePending,
  });
  const sharpPreference = useContext(SharpSliceDisplayContext);
  const suspendImageSwap = sharpPreference.suspended || interactionBlocked || alignmentPending || viewportPan.isPanning;
  const sharpDisplay = useSharpSliceDisplay(imageUrlOverride ? null : derivedFrame, {
    enabled: sharpPreference.enabled,
    suspended: suspendImageSwap,
  });

  const debugSliceScores = isDebugAlignmentEnabled();

  const subscribeToVisibleDebugKey = useCallback(
    (listener: () => void) => {
      if (!debugSliceScores || interactionBlocked) return () => undefined;
      return subscribeToDebugAlignmentKey(listener);
    },
    [debugSliceScores, interactionBlocked],
  );
  const isZHeld = useSyncExternalStore(
    subscribeToVisibleDebugKey,
    () => debugSliceScores && !interactionBlocked && isDebugAlignmentKeyHeld(),
    () => false,
  );

  const displayedForScores = displayedContentKey ? parseDicomViewerContentKey(displayedContentKey) : null;
  const scoreSeriesUid = displayedForScores?.seriesUid ?? seriesUid;
  const scoreInstanceIndex = displayedForScores?.instanceIndex ?? effectiveInstanceIndex;
  const sliceScore = debugSliceScores ? getAlignmentSliceScore(scoreSeriesUid, scoreInstanceIndex) : null;

  useEffect(() => {
    if (imageUrlOverride) return;
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const id =
          derivedFrame?.imageId ??
          (await waitForBoundedOperation(getImageIdForInstance(seriesUid, effectiveInstanceIndex), {
            signal,
            timeoutMs: IMAGE_ID_LOOKUP_TIMEOUT_MS,
            label: 'Image lookup',
          }));
        if (!signal.aborted) {
          setImageSource((previous) =>
            previous?.imageId === id &&
            sameDerivedAlignmentContent(previous.derivedFrame, derivedFrame) &&
            previous.contentKey === contentKey &&
            previous.presentationKey === presentationKey
              ? previous
              : { imageId: id, derivedFrame, contentKey, presentationKey },
          );
          setLookupFailure(null);
        }
      } catch (e) {
        if (!signal.aborted) {
          setLookupFailure({
            contentKey,
            presentationKey,
            message: e instanceof Error ? e.message : 'Image lookup failed.',
          });
          controller.abort();
        }
      }
    })();
    return () => controller.abort();
  }, [contentKey, derivedFrame, effectiveInstanceIndex, imageUrlOverride, lookupAttempt, presentationKey, seriesUid]);

  // CSS filter for brightness/contrast adjustments
  const imageFilter = `brightness(${brightness / 100}) contrast(${contrast / 100})`;

  // Convert normalized pan to pixels for transform
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  // Track viewport size
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth;
        const height = containerRef.current.clientHeight;
        setViewportSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Convert normalized pan to pixels
  const panXPx = viewportPan.panX * viewportSize.width;
  const panYPx = viewportPan.panY * viewportSize.height;

  // Combined transform
  //
  // Order matters. We apply the hidden affine matrix first (rightmost), then user rotation/zoom,
  // and finally pan translation in display space.
  const imageTransform = `translate(${panXPx}px, ${panYPx}px) scale(${zoom}) rotate(${rotation}deg) matrix(${affine00}, ${affine10}, ${affine01}, ${affine11}, 0, 0)`;

  return (
    <div className="relative h-full overflow-hidden bg-black">
      {/* Viewport */}
      <div
        ref={containerRef}
        className={`h-full overflow-hidden relative select-none ${viewportPan.canPan ? 'touch-none' : ''}`}
        style={{ cursor: viewportPan.canPan ? (viewportPan.isPanning ? 'grabbing' : 'grab') : 'inherit' }}
        role="group"
        tabIndex={viewportPan.canPan ? 0 : -1}
        aria-label={`Pan MRI slice ${instanceIndex + 1}`}
        aria-description="Drag to pan. Double-click or press Enter to reset pan."
        aria-busy={imagePending || alignmentStatus === 'updating' || sharpDisplay.status === 'loading' || undefined}
        {...viewportPan.handlers}
      >
        {imageUrlOverride ? (
          <ImageContent
            key={imageUrlOverride}
            imageUrl={imageUrlOverride}
            imageFilter={imageFilter}
            imageTransform={imageTransform}
            alt={`Slice ${instanceIndex + 1}`}
          />
        ) : imageSource ? (
          <CornerstoneImage
            imageSource={imageSource}
            derivedFrame={derivedFrame}
            contentKey={contentKey}
            presentationKey={presentationKey}
            imageFilter={imageFilter}
            imageTransform={imageTransform}
            alt={`Slice ${(derivedFrame?.instanceIndex ?? effectiveInstanceIndex) + 1}`}
            onDisplayedContentKey={setDisplayedContentKey}
            sharpDisplay={sharpDisplay}
            suspendImageSwap={suspendImageSwap}
          />
        ) : !lookupError ? (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)]">
            Loading...
          </div>
        ) : null}

        {lookupError && !imageUrlOverride ? (
          <ErrorOverlay
            message={`Unable to open slice ${effectiveInstanceIndex + 1}. ${lookupError}${displayedForScores ? ` Showing slice ${displayedForScores.instanceIndex + 1}.` : ''}`}
            onRetry={() => {
              setLookupFailure(null);
              setLookupAttempt((value) => value + 1);
            }}
          />
        ) : null}

        {derivedFrame && !imageUrlOverride ? (
          <div className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded-[2px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--signal-metal)]">
            {alignmentPending
              ? `Showing aligned slice ${derivedFrame.instanceIndex + 1} · ${alignmentStatus === 'unavailable' ? 'Aligned slice unavailable' : alignmentStatus === 'paused' ? 'Alignment paused' : 'Updating aligned slice…'}`
              : 'Derived 3D-aligned plane'}
            {derivedFrame.nativeSliceSpacingMm
              ? ` · ${derivedFrame.nativeSliceSpacingMm.toFixed(1)} mm native slices`
              : ''}
            {derivedFrame.outputGrid &&
            (derivedFrame.outputGrid.rows > derivedFrame.outputGrid.sourceRows ||
              derivedFrame.outputGrid.columns > derivedFrame.outputGrid.sourceColumns)
              ? ` · ${derivedFrame.outputGrid.rows} × ${derivedFrame.outputGrid.columns} interpolated from ${derivedFrame.outputGrid.sourceRows} × ${derivedFrame.outputGrid.sourceColumns} acquisition`
              : ''}
          </div>
        ) : null}

        {debugSliceScores && isZHeld ? <DicomAlignmentDiagnostics sliceScore={sliceScore} /> : null}
      </div>
      {children ? (
        <div
          className="absolute inset-0 pointer-events-none"
          inert={imagePending || alignmentPending}
          aria-busy={imagePending || alignmentPending}
          style={{
            transform: `translate(${panXPx - panX * viewportSize.width}px, ${panYPx - panY * viewportSize.height}px)`,
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface CornerstoneImageProps {
  imageSource: DicomImageSource;
  derivedFrame: DerivedAlignmentFrame | null;
  /** Known before asynchronous ID resolution, so new settings never reach old pixels. */
  presentationKey?: string;
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
  sharpDisplay?: SharpSliceDisplay;
  suspendImageSwap?: boolean;
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
      <div className="h-5 w-5 animate-spin rounded-full border border-[var(--signal-metal)] border-t-transparent" />
    </div>
  );
}

function ErrorOverlay({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between gap-3 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <span>{message}</span>
      <button
        type="button"
        className="shrink-0 rounded border border-[var(--border-color)] px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        onClick={onRetry}
      >
        Retry image
      </button>
    </div>
  );
}

function CornerstoneImage({
  imageSource,
  derivedFrame,
  contentKey,
  presentationKey = contentKey,
  imageFilter,
  imageTransform,
  alt,
  onDisplayedContentKey,
  sharpDisplay,
  suspendImageSwap = false,
}: CornerstoneImageProps) {
  const { imageId } = imageSource;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(false);

  const [enabledDeferred] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  });

  // Track which imageId has been loaded to derive status.
  // Note: we intentionally do NOT clear `loadedImageId` when navigating so the previous
  // slice stays visible until the next slice is ready. This avoids "black flashes"
  // while scrubbing quickly with the mouse wheel.
  type LoadedImage = DicomImageSource & {
    image: Awaited<ReturnType<typeof loadCornerstoneImage>>;
  };
  const [available, setAvailable] = useState<LoadedImage | null>(null);
  const [displayed, setDisplayed] = useState<{
    source: LoadedImage;
    sharpImage?: DerivedImagePresentation;
    failedImage?: DerivedImagePresentation;
  } | null>(null);
  const loadedImageId = displayed?.sharpImage?.imageId ?? displayed?.source.imageId ?? null;
  const [failure, setFailure] = useState<{ source: DicomImageSource; message: string } | null>(null);
  // A deadline stops waiting, not decoding. Retry the same promise while it is
  // pending; a rejected load may be evicted, never a still-running shared job.
  const sourceLoadRef = useRef<{
    imageId: string;
    promise: ReturnType<typeof loadCornerstoneImage>;
    rejected: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Track which contentKey the currently-loaded image corresponds to.
  // This lets us avoid applying the *new* settings/transform to the *old* image
  // during async navigation (e.g. switching overlay dates).
  const loadedContent = displayed?.source;

  // Resolved source IDs carry their producing keys and frame together; a newer
  // request must never relabel an older asynchronous native lookup.

  const onDisplayedContentKeyRef = useRef(onDisplayedContentKey);
  useEffect(() => {
    onDisplayedContentKeyRef.current = onDisplayedContentKey;
  }, [onDisplayedContentKey]);

  const isContentInSync =
    loadedContent?.imageId === imageId &&
    sameDerivedAlignmentContent(loadedContent.derivedFrame, derivedFrame) &&
    loadedContent?.contentKey === contentKey &&
    loadedContent.presentationKey === presentationKey;
  const status: 'loading' | 'loaded' | 'error' =
    failure?.source === imageSource ? 'error' : isContentInSync ? 'loaded' : 'loading';

  // While navigating, keep rendering the previous image with the previous in-sync settings.
  // We snapshot the latest in-sync filter/transform so they only update once the new image is
  // actually displayed — without this, brightness/zoom/etc would jump for one frame.
  // Schedule the update via setTimeout(0) to comply with the project lint rule that disallows
  // calling setState synchronously inside an effect body.
  const [frozen, setFrozen] = useState({ filter: imageFilter, transform: imageTransform });
  useEffect(() => {
    if (!isContentInSync) return;
    const t = window.setTimeout(() => setFrozen({ filter: imageFilter, transform: imageTransform }), 0);
    return () => clearTimeout(t);
  }, [isContentInSync, imageFilter, imageTransform]);

  const appliedImageFilter = isContentInSync ? imageFilter : frozen.filter;
  const appliedImageTransform = isContentInSync ? imageTransform : frozen.transform;

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
    enabledDeferred.resolve();

    return () => {
      try {
        cornerstone.disable(element);
        enabledRef.current = false;
      } catch {
        // ignore
      }
    };
  }, [enabledDeferred]);

  // Load image when imageId changes
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const controller = new AbortController();
    const { signal } = controller;

    const loading = enabledDeferred.promise
      .then(() => {
        signal.throwIfAborted();
        let sourceLoad = sourceLoadRef.current;
        if (!sourceLoad || sourceLoad.imageId !== imageSource.imageId || sourceLoad.rejected) {
          if (
            sourceLoad?.imageId === imageSource.imageId &&
            sourceLoad.rejected &&
            cornerstone.imageCache?.getImageLoadObject?.(imageSource.imageId)
          ) {
            cornerstone.imageCache.removeImageLoadObject(imageSource.imageId);
          }
          sourceLoad = {
            imageId: imageSource.imageId,
            promise: loadCornerstoneImage(imageSource.imageId),
            rejected: false,
          };
          sourceLoadRef.current = sourceLoad;
          const owner = sourceLoad;
          void owner.promise.catch(() => {
            owner.rejected = true;
          });
        }
        return sourceLoad.promise;
      })
      .then((cached) => {
        signal.throwIfAborted();
        const original = imageSource.derivedFrame;
        const cachedSource = cached.derivedSource?.deref?.();
        // A rerun may reuse a derived ID with different pixels or tone. Refresh
        // only changed content, not an exact replay's new request wrapper.
        return original &&
          (!cachedSource || getDerivedAlignmentContent(cachedSource) !== getDerivedAlignmentContent(original))
          ? createDerivedImagePresentation(
              original,
              `${imageSource.imageId}:original:${crypto.randomUUID()}`,
              undefined,
              signal,
            )
          : cached;
      });
    void waitForBoundedOperation(loading, { signal, timeoutMs: IMAGE_LOAD_TIMEOUT_MS, label: 'DICOM image load' })
      .then((image) => {
        signal.throwIfAborted();
        setAvailable({ ...imageSource, image });
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (!signal.aborted) {
          console.error('Failed to load DICOM image:', err);
          setFailure({ source: imageSource, message: err instanceof Error ? err.message : 'Image decode failed.' });
          controller.abort();
        }
      });

    return () => {
      controller.abort();
    };
  }, [attempt, enabledDeferred, imageSource]);

  const replacement = sharpDisplay?.sourceKey === imageId ? sharpDisplay.image : undefined;
  // One canvas commit owns both variants. Keep the loaded original for immediate
  // comparison; a display toggle never starts a new source lookup or changes pan.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (
      !element ||
      !available ||
      available.imageId !== imageId ||
      !sameDerivedAlignmentContent(available.derivedFrame, derivedFrame) ||
      available.contentKey !== contentKey ||
      available.presentationKey !== presentationKey
    )
      return;
    // Suspending enhancement must not freeze normal slice browsing or the first image.
    if (suspendImageSwap && displayed?.source === available) return;
    const sharpImage =
      suspendImageSwap || (displayed?.source === available && displayed.failedImage === replacement)
        ? undefined
        : replacement;
    if (displayed?.source === available && displayed.sharpImage === sharpImage) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !enabledRef.current) return;
      try {
        const image = sharpImage ?? available.image;
        const viewport = cornerstone.getDefaultViewportForImage(element, image);
        cornerstone.displayImage(element, image, viewport);
        setDisplayed({ source: available, sharpImage });
        onDisplayedContentKeyRef.current?.(available.contentKey);
      } catch (error) {
        if (sharpImage) {
          try {
            const viewport = cornerstone.getDefaultViewportForImage(element, available.image);
            cornerstone.displayImage(element, available.image, viewport);
            setDisplayed({ source: available, failedImage: sharpImage });
            onDisplayedContentKeyRef.current?.(available.contentKey);
            return;
          } catch {
            // If the original also fails, use the established image-load error surface.
          }
        }
        console.error('Failed to display DICOM image:', error);
        setFailure({ source: imageSource, message: error instanceof Error ? error.message : 'Image display failed.' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    available,
    contentKey,
    derivedFrame,
    displayed,
    imageId,
    imageSource,
    presentationKey,
    replacement,
    suspendImageSwap,
  ]);

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

  const originalShown = displayed && !displayed.sharpImage ? ' · Original shown' : '';
  const shown = loadedContent ? parseDicomViewerContentKey(loadedContent.contentKey) : null;
  const displayedAlt = shown ? `Slice ${shown.instanceIndex + 1}` : alt;
  return (
    <>
      <div className="w-full h-full relative" style={{ transform: appliedImageTransform, filter: appliedImageFilter }}>
        <div
          ref={elementRef}
          className="w-full h-full"
          style={{ minWidth: '100px', minHeight: '100px' }}
          role="img"
          aria-label={displayedAlt}
          data-image-id={loadedImageId ?? undefined}
        />
        {status === 'loading' && <DelayedSpinnerOverlay delayMs={loadedImageId ? 350 : 150} />}
      </div>
      {status === 'error' &&
      imageSource.contentKey === contentKey &&
      imageSource.presentationKey === presentationKey ? (
        <ErrorOverlay
          message={`Unable to load ${alt.toLowerCase()}. ${failure?.message}${shown ? ` Showing slice ${shown.instanceIndex + 1}.` : ''}`}
          onRetry={() => {
            setFailure(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
      {displayed?.sharpImage || (sharpDisplay && sharpDisplay.status !== 'original') ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded-[2px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
          title={
            displayed?.sharpImage
              ? 'Experimental synthesized detail, not acquired MRI. Alignment and measurements always use the original image.'
              : sharpDisplay?.message
          }
          data-sharp-slice={displayed?.sharpImage ? 'synthesized' : 'original'}
        >
          {displayed?.sharpImage
            ? 'Synthesized detail · Experimental'
            : displayed?.failedImage || sharpDisplay?.status === 'error'
              ? `Sharp slice unavailable${originalShown}`
              : sharpDisplay?.status === 'loading'
                ? `${sharpDisplay.message ?? 'Preparing sharp slice…'}${originalShown}`
                : sharpDisplay?.status === 'ready'
                  ? `Sharp slice ready${originalShown}`
                  : displayed
                    ? 'Original acquired slice'
                    : 'Loading original slice…'}
        </div>
      ) : null}
    </>
  );
}
