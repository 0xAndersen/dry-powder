"use client";

import { useSearchParams } from "next/navigation";
import { Sheet } from "@/components/ui/sheet";
import { useLocalStore } from "@/hooks/use-local-store";
import { hrefFor, stickyQuery } from "@/lib/nav";
import { uiMode, type UiMode } from "@/lib/ui-mode";

const OPTIONS: readonly { mode: UiMode; title: string; body: string; action: string }[] = [
  {
    mode: "simple",
    title: "Simple",
    body: "Pick a market, up or down, how much. Plain words, what you can win or lose before you tap, one tap to cash out.",
    action: "Use Simple",
  },
  {
    mode: "advanced",
    title: "Advanced",
    body: "The full terminal: limit, stop, scale, TWAP and trailing orders, charts side by side, and agents that trade a strategy for you.",
    action: "Use Advanced",
  },
];

/** First visit: choose how to trade. Either mode is one tap away later, at the top of the screen. */
export function ModeChooser() {
  const [, setMode] = useLocalStore(uiMode);
  const searchParams = useSearchParams();
  const choose = (mode: UiMode) => {
    setMode(mode);
    if (mode === "advanced") window.location.assign(hrefFor("trade", stickyQuery(new URLSearchParams(searchParams.toString()))));
  };
  return (
    <Sheet title="How do you want to trade?" description="You can switch any time at the top of the screen." onClose={() => setMode("simple")} testId="mode-chooser">
      <div className="grid gap-3 sm:grid-cols-2">
        {OPTIONS.map((o) => (
          <button
            key={o.mode}
            type="button"
            className="flex flex-col items-start gap-2 rounded-[16px] border border-line bg-raised p-4 text-left hover:border-line-strong"
            onClick={() => choose(o.mode)}
            data-testid={`choose-${o.mode}`}
          >
            <span className="s-display text-[1.6rem]">{o.title}</span>
            <span className="text-[0.8125rem] text-muted">{o.body}</span>
            <span className="mt-1 inline-flex h-9 items-center rounded-full bg-text px-4 text-[0.8125rem] font-semibold text-panel">{o.action}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
