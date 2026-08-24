import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type AccessibleDialogProps = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  closeDisabled?: boolean;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AccessibleDialog({
  title,
  description,
  onClose,
  children,
  className,
  closeOnBackdrop = true,
  closeOnEscape = true,
  closeDisabled = false,
}: AccessibleDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById('root');
    const wasInert = appRoot?.hasAttribute('inert') ?? false;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';

    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (panel.querySelector<HTMLElement>('[data-dialog-autofocus]') ?? focusable()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (!wasInert) appRoot?.removeAttribute('inert');
      previouslyFocused?.focus();
    };
  }, [closeOnEscape]);

  return createPortal(
    <div
      className="instrument-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-6"
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={
          className ??
          'instrument-dialog flex max-h-[min(88vh,48rem)] w-full max-w-xl flex-col overflow-hidden ' +
            'rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)]'
        }
      >
        <div className="flex min-h-[4.25rem] shrink-0 items-center justify-between gap-5 border-b border-[var(--border-color)] px-5 py-3 sm:px-7">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-[family-name:var(--font-display)] text-[1.05rem] font-medium tracking-[-0.025em] text-[var(--text-primary)]"
            >
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-[0.8rem] leading-relaxed text-[var(--text-secondary)]">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            disabled={closeDisabled}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[3px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
