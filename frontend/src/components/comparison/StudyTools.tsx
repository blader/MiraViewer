import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, X } from 'lucide-react';

const StudyToolsContext = createContext<{
  activeId: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  target: HTMLDivElement | null;
} | null>(null);

/** One inspector for the workspace; its controls remain owned by the selected image. */
export function StudyToolsWorkspace({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const context = useMemo(() => ({ activeId, setActiveId, target }), [activeId, target]);

  return (
    <StudyToolsContext.Provider value={context}>
      <div className="study-workspace" data-tools-open={activeId !== null}>
        {children}
        <aside
          id="study-image-inspector"
          className="study-inspector"
          aria-label="Image adjustments"
          hidden={activeId === null}
        >
          <div ref={setTarget} />
        </aside>
      </div>
    </StudyToolsContext.Provider>
  );
}

export function StudyTools({
  children,
  disabled = false,
  examinationLabel,
}: {
  children: ReactNode;
  disabled?: boolean;
  examinationLabel: string;
}) {
  const context = useContext(StudyToolsContext);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!context) throw new Error('StudyTools must be rendered inside StudyToolsWorkspace');
  const { activeId, setActiveId, target } = context;
  const open = activeId === id;

  useEffect(() => () => setActiveId((current) => (current === id ? null : current)), [id, setActiveId]);

  const close = () => {
    setActiveId(null);
    buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="study-tools-trigger"
        aria-label="Adjust image"
        aria-expanded={open}
        aria-controls="study-image-inspector"
        disabled={disabled}
        title={`Adjust ${examinationLabel}`}
        onClick={() => setActiveId(open ? null : id)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !open) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        <span>Adjust</span>
      </button>
      {open && target
        ? createPortal(
            <div
              className="study-tools-panel"
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || disabled) return;
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
            >
              <div className="study-tools-heading">
                <h2>Image adjustments</h2>
                <button
                  type="button"
                  className="instrument-icon-button"
                  aria-label="Close image adjustments"
                  disabled={disabled}
                  onClick={close}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <p className="study-tools-examination">{examinationLabel}</p>
              <div inert={disabled}>{children}</div>
            </div>,
            target,
          )
        : null}
    </>
  );
}
