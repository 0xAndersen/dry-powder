"use client";

import { FundingOiPanel } from "@/components/market-history/funding-oi-panel";
import { useLocalStore } from "@/hooks/use-local-store";
import { createLocalStore } from "@/lib/storage";

/** Whether the trade screen shows funding and open-interest history under the chart. Remembered per browser. */
const historyOpen = createLocalStore<boolean>("dp:trade-history-open:v1", false, (stored) => (typeof stored === "boolean" ? stored : null));

/**
 * Funding and open interest under the price chart, folded away until asked for. The panel is only mounted while it is
 * open, so a closed one costs nothing and its chart is never drawn at zero width.
 */
export function FundingOiToggle({ marketId }: { marketId: string }) {
  const [open, setOpen] = useLocalStore(historyOpen);
  return (
    <section className="panel mt-2 min-w-0" aria-label="Funding and open interest">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[0.8125rem] font-semibold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="trade-history-toggle"
      >
        <span>Funding and open interest</span>
        <span className="text-xs font-normal text-muted">{open ? "Hide" : "Show history"}</span>
      </button>
      {open ? <FundingOiPanel key={marketId} marketId={marketId} className="border-t border-line pb-2" /> : null}
    </section>
  );
}
