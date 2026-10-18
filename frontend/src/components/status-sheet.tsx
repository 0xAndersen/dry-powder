"use client";

import { useBlockNumber } from "wagmi";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import { useKeeperStatus } from "@/hooks/use-keeper-status";
import { useMarketData } from "@/hooks/use-market-data";
import { fmtAge } from "@/lib/format";

/** Venue health in one place: chain, the hosted keeper, and how fresh each market's on-chain price is. */
export function StatusSheet({ onClose }: { onClose: () => void }) {
  const { config: cfg, chain, rpcUrls } = useApp();
  const { instruments, prices, params, feedStatus } = useMarketData();
  const block = useBlockNumber({ chainId: chain.id, query: { refetchInterval: 3_000 } });
  const keeper = useKeeperStatus();
  const tone = (t: "ok" | "warn" | "bad" | "idle") => (t === "idle" ? undefined : t);

  return (
    <Sheet title="Venue status" description="Live health of the chain, the keeper and the price feeds." onClose={onClose} wide testId="status-sheet">
      <div className="grid gap-4">
        <dl className="grid gap-1.5">
          <div className="kv">
            <dt>Chain</dt>
            <dd className="flex items-center justify-end gap-2">
              <span className="status-dot" data-tone={block.isError ? "bad" : block.data !== undefined ? "ok" : undefined} aria-hidden="true" />
              <span className="num">{block.isError ? "RPC unreachable" : block.data !== undefined ? `${chain.name}, block ${block.data.toLocaleString("en-US")}` : "Connecting"}</span>
            </dd>
          </div>
          <div className="kv">
            <dt>RPCs (failover order)</dt>
            <dd className="num text-xs text-muted">{rpcUrls.map((u) => new URL(u).host).join(", ")}</dd>
          </div>
          <div className="kv">
            <dt>Keeper (fills, liquidations, settlement)</dt>
            <dd className="flex items-center justify-end gap-2">
              <span className="status-dot" data-tone={tone(keeper.tone)} aria-hidden="true" />
              <span>
                {keeper.text}
                {keeper.ageMin !== null ? <span className="num text-faint"> · {keeper.ageMin} min ago</span> : null}
              </span>
            </dd>
          </div>
          {keeper.data?.stats ? (
            <div className="kv">
              <dt>This keeper run</dt>
              <dd className="num">
                {keeper.data.stats.executed ?? 0} orders filled, {keeper.data.stats.liquidated ?? 0} liquidations, {keeper.data.stats.pushes ?? 0} price pushes
              </dd>
            </div>
          ) : null}
          <div className="kv">
            <dt>Price tape (charts)</dt>
            <dd>{cfg.oracleMode === "publisher" ? `Kraken, ${feedStatus}` : `Pyth, ${feedStatus}`}</dd>
          </div>
          {cfg.oracleMode === "publisher" ? (
            <div className="kv">
              <dt>On-chain prices</dt>
              <dd className="text-right">
                {keeper.data?.sources && keeper.data.sources.length > 1
                  ? `Median of ${keeper.data.sources.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(", ")}: one venue cannot move it`
                  : keeper.data?.sources?.length === 1
                    ? `${keeper.data.sources[0]![0]!.toUpperCase()}${keeper.data.sources[0]!.slice(1)}, signed by the keeper`
                    : "Signed by the keeper from exchange prices"}
              </dd>
            </div>
          ) : null}
          {keeper.data?.sponsor ? (
            <div className="kv">
              <dt>Instant-trading gas</dt>
              <dd className="num">
                Topped up by the venue: {keeper.data.sponsor.sponsored ?? 0} top-ups for {keeper.data.sponsor.keys ?? 0} keys this run
              </dd>
            </div>
          ) : null}
          <div className="kv">
            <dt>Engine</dt>
            <dd>{params ? (params.paused ? <span className="text-warn">Paused: closes only</span> : "Open") : "…"}</dd>
          </div>
        </dl>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Price</th>
                <th className="r">On-chain price age</th>
              </tr>
            </thead>
            <tbody>
              {instruments.map((i) => {
                const p = prices.get(i.id);
                const status = p?.status ?? "unavailable";
                return (
                  <tr key={i.id}>
                    <td className="wide">{i.symbol}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className="status-dot" data-tone={status === "live" || status === "settled" ? "ok" : status === "awaiting" ? "warn" : "bad"} aria-hidden="true" />
                        {status === "live" ? "Live" : status === "settled" ? "Settled" : status === "awaiting" ? "Awaiting a fresh on-chain price" : "No price"}
                      </span>
                    </td>
                    <td className="r num">{p?.age !== null && p?.age !== undefined ? fmtAge(p.age) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-faint">
          The keeper pushes a price when a market moves, on a heartbeat, and with every fill, so &ldquo;awaiting&rdquo; between pushes is normal: keeper orders
          always fill at a newer price.
        </p>
      </div>
    </Sheet>
  );
}
