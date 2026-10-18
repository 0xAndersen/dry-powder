"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ConfirmLine = { label: string; value: string };

/** Modal confirmation. Enter confirms, Escape cancels; focus starts on the confirm button and stays inside. */
export function ConfirmDialog({
  title,
  lines,
  note,
  confirmLabel,
  tone,
  allowSkip,
  onSkipChange,
  onConfirm,
  onCancel,
}: {
  title: string;
  lines: ConfirmLine[];
  note?: string;
  confirmLabel: string;
  tone?: "long" | "short";
  /** Offers "do not ask again", which turns on one-click trading. */
  allowSkip?: boolean;
  onSkipChange?: (skip: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button, input");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rendered at the document root: the ticket is sticky, which would otherwise trap the dialog below the chart.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[rgba(6,10,16,0.72)] p-3 sm:items-center" onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="panel w-full max-w-sm bg-raised p-4 shadow-[0_24px_60px_rgba(4,8,14,0.7)]" data-testid="confirm-dialog">
        <h2 id={`${id}-title`} className="wide text-base font-semibold">
          {title}
        </h2>
        <dl className="mt-3 grid gap-1.5 text-[0.8125rem]">
          {lines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">{line.label}</dt>
              <dd className="num text-right">{line.value}</dd>
            </div>
          ))}
        </dl>
        {note ? <p className="mt-3 text-xs text-muted">{note}</p> : null}
        {allowSkip ? (
          <label className="mt-3 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" className="check" checked={skip} onChange={(event) => setSkip(event.target.checked)} />
            Do not ask again (one-click trading; change it in the ticket settings)
          </label>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${tone === "long" ? "btn-long" : tone === "short" ? "btn-short" : "btn-primary"}`}
            data-testid="confirm-yes"
            onClick={() => {
              if (skip) onSkipChange?.(true);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
