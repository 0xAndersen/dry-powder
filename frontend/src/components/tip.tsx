import type { ReactNode } from "react";

/** A small "what is this" marker. The explanation opens on hover and on keyboard focus. */
export function Tip({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  return (
    <span className="tip">
      <button type="button" className="tip-mark" aria-label={label}>
        ?
      </button>
      <span role="tooltip" className="tip-body" data-align={align}>
        {children}
      </span>
    </span>
  );
}
