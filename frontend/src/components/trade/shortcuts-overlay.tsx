"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export const SHORTCUTS: readonly { keys: string[]; action: string }[] = [
  { keys: ["B"], action: "Side: buy / long" },
  { keys: ["S"], action: "Side: sell / short" },
  { keys: ["M"], action: "Order type: market" },
  { keys: ["L"], action: "Order type: limit" },
  { keys: ["Q"], action: "Focus the size field" },
  { keys: ["Enter"], action: "Submit the order (asks to confirm unless one-click trading is on)" },
  { keys: ["X"], action: "Close the position in this market" },
  { keys: ["["], action: "Previous market" },
  { keys: ["]"], action: "Next market" },
  { keys: ["/"], action: "Search markets" },
  { keys: ["I"], action: "Show or hide chart indicators" },
  { keys: ["T"], action: "Pick a limit price on the chart" },
  { keys: ["?"], action: "Show this list" },
  { keys: ["Esc"], action: "Close dialogs, leave chart pick mode" },
];

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(6,10,16,0.72)] p-3" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="panel w-full max-w-md bg-raised p-4 shadow-[0_24px_60px_rgba(4,8,14,0.7)]">
        <div className="flex items-center justify-between">
          <h2 id="shortcuts-title" className="wide text-base font-semibold">
            Keyboard shortcuts
          </h2>
          <button ref={closeRef} type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">Active on the trading screen whenever you are not typing in a field.</p>
        <dl className="mt-3 grid gap-1.5 text-[0.8125rem]">
          {SHORTCUTS.map((s) => (
            <div key={s.action} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">{s.action}</dt>
              <dd className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body,
  );
}
