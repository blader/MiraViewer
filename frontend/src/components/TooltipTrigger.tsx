import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode, MouseEvent } from 'react';

// Tooltip uses direct DOM manipulation for instant mouse tracking.
const TOOLTIP_ID = 'mira-tooltip';
const TOOLTIP_WIDTH = 420;
const TOOLTIP_MARGIN = 20;
const TOOLTIP_OFFSET = 8;
const TOOLTIP_DELAY_MS = 150;

function getOrCreateTooltipElement(): HTMLDivElement {
  let el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = TOOLTIP_ID;
    el.className = 'fixed z-50 pointer-events-none opacity-0 transition-opacity duration-150';
    el.style.maxWidth = `${TOOLTIP_WIDTH}px`;
    el.style.maxHeight = '80vh';
    el.style.overflow = 'hidden';
    el.innerHTML = `
      <div class="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-xl shadow-2xl px-5 py-4 max-h-[80vh] overflow-y-auto">
        <p class="text-[var(--text-primary)] text-sm leading-6 whitespace-pre-wrap"></p>
      </div>
    `;
    document.body.appendChild(el);
  }
  return el;
}

function positionTooltip(el: HTMLElement, x: number, y: number) {
  const tooltipHeight = Math.min(el.scrollHeight, window.innerHeight * 0.8);
  el.style.left = `${Math.min(x + TOOLTIP_OFFSET, window.innerWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN)}px`;
  el.style.top = `${Math.min(y + TOOLTIP_OFFSET, window.innerHeight - tooltipHeight - TOOLTIP_MARGIN)}px`;
}

function showTooltip(content: string, x: number, y: number) {
  const el = getOrCreateTooltipElement();
  const p = el.querySelector('p');
  if (p) p.textContent = content;
  positionTooltip(el, x, y);
  el.classList.remove('opacity-0');
  el.classList.add('opacity-100');
}

function updateTooltipPosition(x: number, y: number) {
  const el = document.getElementById(TOOLTIP_ID);
  if (el && el.classList.contains('opacity-100')) {
    positionTooltip(el, x, y);
  }
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) {
    el.classList.remove('opacity-100');
    el.classList.add('opacity-0');
  }
}

export interface TooltipTriggerProps {
  content: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function TooltipTrigger({ content, children, className, onClick }: TooltipTriggerProps) {
  const timeoutRef = useRef<number | null>(null);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        showTooltip(content, e.clientX, e.clientY);
      }, TOOLTIP_DELAY_MS);
    },
    [content]
  );

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    updateTooltipPosition(e.clientX, e.clientY);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    hideTooltip();
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      hideTooltip();
    };
  }, []);

  return (
    <div
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
