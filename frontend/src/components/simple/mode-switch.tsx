"use client";

import { useSearchParams } from "next/navigation";
import { useLocalStore } from "@/hooks/use-local-store";
import { hrefFor, stickyQuery } from "@/lib/nav";
import { MODE_HOME, uiMode, type UiMode } from "@/lib/ui-mode";

/** Simple / Advanced. Remembers the choice and goes to that mode's home. */
export function ModeSwitch({ current, className = "" }: { current: UiMode; className?: string }) {
  const [, setMode] = useLocalStore(uiMode);
  const searchParams = useSearchParams();
  const go = (mode: UiMode) => {
    setMode(mode);
    if (mode === current) return;
    window.location.assign(hrefFor(MODE_HOME[mode], stickyQuery(new URLSearchParams(searchParams.toString()))));
  };
  return (
    <div className={`mode-switch ${className}`} role="group" aria-label="Trading mode" data-testid="mode-switch">
      {(["simple", "advanced"] as const).map((mode) => (
        <button key={mode} type="button" aria-pressed={current === mode} onClick={() => go(mode)} data-testid={`mode-${mode}`}>
          {mode === "simple" ? "Simple" : "Advanced"}
        </button>
      ))}
    </div>
  );
}
