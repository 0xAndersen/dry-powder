"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Open sheets, oldest first. Only the newest one answers Escape and traps Tab, so closing an approval opened over
 *  another sheet leaves the one underneath open. */
const openSheets: symbol[] = [];

/**
 * A modal surface: a bottom sheet on phones (thumb-reachable, slides up, respects the home indicator) and a centred
 * dialog from the `sm` breakpoint up. Escape and the backdrop close it; focus moves in and stays in while open.
 */
export function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Sticky action area at the bottom of the sheet. */
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus], input, select, button:not([data-sheet-close])");
    (first ?? panel)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const token = Symbol("sheet");
    openSheets.push(token);
    const onKey = (event: KeyboardEvent) => {
      if (openSheets[openSheets.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const head = focusable[0];
      const tail = focusable[focusable.length - 1];
      if (!head || !tail) return;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openSheets.indexOf(token);
      if (at !== -1) openSheets.splice(at, 1);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="sheet-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={`sheet-panel ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
        data-testid={testId}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3 px-4 pt-3 sm:pt-4">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="wide text-base">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-desc`} className="mt-1 text-[0.8125rem] text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm -mr-2 shrink-0" onClick={onClose} aria-label="Close" data-sheet-close>
            {"✕"}
          </button>
        </div>
        <div className="sheet-body px-4 pb-4 pt-3">{children}</div>
        {footer ? <div className="sheet-footer px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
