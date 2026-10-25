"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useConfig } from "wagmi";
import type { Address } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { useAccountData } from "@/hooks/use-account-data";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useAccountStrategies, useStrategyActivity, type StrategyEvent, type StrategyRow } from "@/hooks/use-strategies";
import { useTx } from "@/hooks/use-tx";
import { USDC_DECIMALS, fmtAge, fmtClock, fmtDateTime, fmtDuration, fmtPrice, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";
import { valuePosition } from "@/lib/position";
import { KEEP_FOR_PRESETS, actionOf, configLine, fromConfig, kindOf, sideOf, statusOf, templateOf, warmupReadings, type StrategyAction } from "@/lib/strategies";
import { pauseStrategy, resumeStrategy, setDailyBudget, setStrategiesPolicy, stopStrategy, type OwnerContext } from "@/lib/strategy-actions";

const SIDE_TONE = { long: "text-long", short: "text-short", flat: "text-muted" } as const;
const SIDE_WORD = { long: "Long", short: "Short", flat: "Flat" } as const;
const VERB: Record<StrategyAction, string> = { open: "open", increase: "add to the position", close: "close", reduce: "reduce the position", cancel: "cancel its order" };

function StatusTag({ row, now }: { row: StrategyRow; now: number }) {
  const status = statusOf(row.state.status);
  if (status === "active") {
    const warm = kindOf(row.config.kind) === "copy" ? 0 : warmupReadings(fromConfig(row.config));
    const samples = Number(row.state.samples);
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="status-dot" data-tone="ok" aria-hidden="true" />
        <span className="text-text">Active</span>
        {warm > 0 && samples < warm ? (
          <span className="num text-2xs text-faint" title="Readings taken before its first trade">
            warming up {samples}/{warm}
          </span>
        ) : Number(row.state.nextAt) > now ? (
          <span className="num text-2xs text-faint" title="Next reading">
            next in {fmtDuration(Number(row.state.nextAt) - now)}
          </span>
        ) : null}
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="status-dot" data-tone="warn" aria-hidden="true" />
        <span className="text-warn">Paused</span>
      </span>
    );
  }
  return <span className="text-faint">Stopped</span>;
}

function eventText(e: StrategyEvent, instrument: Instrument | undefined, sym: string): { text: string; tone?: string } {
  const a = e.args;
  const px = (v: unknown) => (typeof v === "bigint" && instrument ? fmtPrice(v, instrument.priceDecimals) : "");
  switch (e.name) {
    case "StrategyCreated":
      return { text: "Started" };
    case "TargetChanged": {
      const to = sideOf(Number(a.to));
      const from = sideOf(Number(a.from));
      return { text: `Signal turned ${to}${from !== "flat" ? ` (was ${from})` : ""}`, tone: SIDE_TONE[to] };
    }
    case "OrderPlaced": {
      const action = actionOf(Number(a.action));
      const size = typeof a.size === "bigint" ? a.size : 0n;
      const what = action === "open" || action === "increase" ? `${VERB[action]} ${fmtUsdc(size)} ${sym}` : action === "close" ? (size === 0n ? "close the position" : `close ${fmtUsdc(size)} ${sym}`) : action === "reduce" ? `cut ${fmtUsdc(size)} ${sym}` : VERB[action];
      return { text: `Placed an order to ${what}, limit ${px(a.price)}` };
    }
    case "OrderSettled":
      return a.filled ? { text: "Order filled", tone: "text-long" } : { text: "Order left the book without filling", tone: "text-warn" };
    case "OrderDropped":
      return { text: "Cancelled an order that went stale" };
    case "ActionRefused":
      return { text: `The account refused an order to ${VERB[actionOf(Number(a.action))]}: approval, daily budget, funds or market`, tone: "text-warn" };
    case "ExitedElsewhere":
      return { text: `Its ${sideOf(Number(a.side))} position was closed by something else (a stop, a liquidation or you)` };
    case "StrategyPaused":
      return a.afterRefusals ? { text: "Paused after three refusals in a row", tone: "text-warn" } : { text: "Paused" };
    case "StrategyResumed":
      return { text: "Resumed" };
    case "StrategyStopped":
      return { text: "Stopped" };
  }
}

/** The account's strategies: what each holds and wants, pause, resume and stop, the shared approval and the activity. */
export function StrategyList({ account, owner }: { account: Address; owner: Address | undefined }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const { byId, prices, params } = useMarketData();
  const now = Math.floor(useChainNow(1_000));
  const data = useAccountStrategies(account);
  const positions = useAccountData(data.rows.length > 0 ? account : undefined);
  const tx = useTx();
  const id = useId();
  const sym = cfg.collateralSymbol;
  const [showStopped, setShowStopped] = useState(false);
  const [confirmStop, setConfirmStop] = useState<bigint | null>(null);
  useEffect(() => {
    if (confirmStop === null) return;
    const t = setTimeout(() => setConfirmStop(null), 5_000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const ids = useMemo(() => data.rows.map((r) => r.id), [data.rows]);
  const activity = useStrategyActivity(ids);
  const marketOf = (r: StrategyRow) => byId.get(r.marketId) ?? [...byId.values()].find((i) => i.id.toLowerCase() === r.marketId.toLowerCase());
  const ctx = (api: OwnerContext["api"]): OwnerContext => ({ wagmi: wagmiConfig, cfg, api, owner: owner! });

  if (!cfg.strategies || (data.rows.length === 0 && !data.loading)) return null;

  const live = data.rows.filter((r) => statusOf(r.state.status) !== "stopped");
  const stopped = data.rows.filter((r) => statusOf(r.state.status) === "stopped");
  const shown = showStopped ? data.rows : live;

  const act = (row: StrategyRow, what: "pause" | "resume" | "stop") => {
    if (!owner) return;
    const name = `Strategy #${row.id}`;
    setConfirmStop(null);
    void tx.run(async (api) => {
      if (what === "pause") {
        await pauseStrategy(ctx(api), row.id, `Pause strategy #${row.id}`);
        data.refetch();
        return `${name} is paused: no readings, no orders. Its position stays; any entry order of its own still on the book was cancelled.`;
      }
      if (what === "resume") {
        await resumeStrategy(ctx(api), row.id, `Resume strategy #${row.id}`);
        data.refetch();
        return `${name} is running again from the next keeper check${kindOf(row.config.kind) === "copy" ? "" : "; its averages start over"}.`;
      }
      await stopStrategy(ctx(api), row.id, `Stop strategy #${row.id} for good`);
      data.refetch();
      return `${name} is stopped for good and its market is free. Its position stays on the account: close it from the trade page if you want out.`;
    });
  };

  // The approval all strategies share, and its daily budget.
  const policy = data.policy;
  const expiry = policy ? Number(policy.expiry) : 0;
  const lapsed = live.length > 0 && expiry <= now;
  const soon = !lapsed && expiry > 0 && expiry - now < 3 * 86_400;
  const today = Math.floor(now / 86_400);
  const spent = data.budget && data.budget.day === today ? data.budget.spent : 0n;

  return (
    <section className="panel min-w-0 scroll-mt-16" id="running" aria-labelledby={`${id}-t`} data-testid="strategies">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id={`${id}-t`} className="panel-title">
          Running strategies <span className="num ml-1 text-faint">{live.length}</span>
        </h2>
        <AppLink route="trade" params={{ account }} className="link text-xs">
          Positions on the trade page
        </AppLink>
      </div>

      <PolicyStrip
        account={account}
        owner={owner}
        policy={policy}
        lapsed={lapsed}
        soon={soon}
        budget={data.budget?.perDay ?? 0n}
        spent={spent}
        hasLive={live.length > 0}
        sym={sym}
        now={now}
        onDone={data.refetch}
      />

      {shown.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="data-table card-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Status</th>
                <th>Signal</th>
                <th className="r">Position</th>
                <th className="r">PnL ({sym})</th>
                <th className="r">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const instrument = marketOf(row);
                const status = statusOf(row.state.status);
                const kind = kindOf(row.config.kind);
                const target = sideOf(row.state.target);
                const view = positions.data?.positions.find((p) => p.position.priceId.toLowerCase() === row.marketId.toLowerCase());
                const mark = instrument ? (prices.get(instrument.id)?.mark ?? null) : null;
                const value = view && params ? valuePosition(view, mark, params.maxProfitMultiple) : null;
                const pending = BigInt(row.state.pendingOrder) !== 0n;
                return (
                  <tr key={String(row.id)} data-testid="strategy-row" data-id={String(row.id)} data-status={status} data-kind={kind}>
                    <td data-cell="market">
                      <div className="flex flex-col">
                        <span className="text-text">
                          {templateOf(kind).title} <span className="num text-faint">#{String(row.id)}</span>{" "}
                          <span className="text-muted">on {instrument?.symbol ?? "…"}</span>
                        </span>
                        <span className="max-w-[46ch] truncate text-2xs text-faint" title={configLine(fromConfig(row.config))}>
                          {kind === "copy" ? `Copies ${row.config.leader.slice(0, 6)}…${row.config.leader.slice(-4)}: ` : ""}
                          {configLine(fromConfig(row.config))}
                        </span>
                      </div>
                    </td>
                    <td data-label="Status">
                      <StatusTag row={row} now={now} />
                    </td>
                    <td data-label="Signal">
                      <span className={SIDE_TONE[target]} data-testid="strategy-target">
                        {SIDE_WORD[target]}
                      </span>
                      {pending ? <span className="ml-1.5 text-2xs text-accent">order working</span> : null}
                      {row.state.refusals > 0 ? <span className="ml-1.5 text-2xs text-warn">{row.state.refusals}× refused</span> : null}
                    </td>
                    <td className="r num" data-label="Position" data-testid="strategy-position">
                      {view ? (
                        <>
                          <span className={view.position.isLong ? "text-long" : "text-short"}>{view.position.isLong ? "Long" : "Short"}</span> {fmtUsdc(view.position.size)}
                        </>
                      ) : (
                        <span className="text-faint">None</span>
                      )}
                    </td>
                    <td className={`r num ${value?.pnl ? (value.pnl > 0n ? "text-long" : "text-short") : ""}`} data-cell="pnl">
                      <span>{value?.pnl !== null && value?.pnl !== undefined ? fmtUsdc(value.pnl, 2, { sign: true }) : "—"}</span>
                    </td>
                    <td className="r" data-cell="actions">
                      {owner && status !== "stopped" ? (
                        <span className="inline-flex gap-1.5 max-md:flex max-md:w-full">
                          {status === "active" ? (
                            <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => act(row, "pause")} data-testid="strategy-pause">
                              Pause
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => act(row, "resume")} data-testid="strategy-resume">
                              Resume
                            </button>
                          )}
                          {confirmStop === row.id ? (
                            <button type="button" className="btn btn-sm border-short text-short" disabled={tx.busy} onClick={() => act(row, "stop")} data-testid="strategy-stop-confirm">
                              Stop for good
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm btn-ghost" disabled={tx.busy} onClick={() => setConfirmStop(row.id)} data-testid="strategy-stop" title="Stops it for good and frees the market; its position stays">
                              Stop
                            </button>
                          )}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : data.loading ? (
        <p className="px-4 py-6 text-center text-muted">Reading your strategies…</p>
      ) : (
        <p className="px-4 py-6 text-center text-[0.8125rem] text-muted">Nothing running. Launch one from the studio above.</p>
      )}
      {stopped.length > 0 ? (
        <button type="button" className="link mx-4 my-2 text-xs" onClick={() => setShowStopped((v) => !v)}>
          {showStopped ? "Hide stopped strategies" : `Show ${stopped.length} stopped`}
        </button>
      ) : null}
      {tx.state.phase !== "idle" ? (
        <div className="px-4 pb-3">
          <TxStatus state={tx.state} onDismiss={tx.reset} />
        </div>
      ) : null}

      <div className="border-t border-line" data-testid="strategy-activity">
        <h3 className="px-4 pb-1 pt-3 text-xs font-semibold text-text">Activity</h3>
        {activity.events.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-faint">{activity.status === "loading" ? "Reading the strategies' events…" : activity.status === "error" ? "Event logs are unavailable right now." : "Nothing yet: orders and signal changes show up here."}</p>
        ) : (
          <ol className="feed-scroll max-h-64 overflow-y-auto pb-2">
            {activity.events.map((e) => {
              const row = data.rows.find((r) => r.id === e.id);
              const instrument = row ? marketOf(row) : undefined;
              const { text, tone } = eventText(e, instrument, sym);
              return (
                <li key={e.key} className="flex items-baseline gap-3 px-4 py-1 text-xs" data-testid="activity-item" data-event={e.name}>
                  <span className="num w-[4.5rem] flex-none text-faint" title={e.time ? fmtDateTime(e.time) : undefined}>
                    {e.time ? (now - e.time < 86_400 ? fmtClock(e.time) : fmtAge(now - e.time)) : "…"}
                  </span>
                  <span className="num w-8 flex-none text-faint">#{String(e.id)}</span>
                  <span className={`min-w-0 ${tone ?? "text-muted"}`}>{text}</span>
                  <a className="link ml-auto flex-none text-faint" href={`${cfg.explorerUrl}/tx/${e.tx}`} target="_blank" rel="noreferrer" aria-label="Transaction in the explorer">
                    tx
                  </a>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function PolicyStrip({
  account,
  owner,
  policy,
  lapsed,
  soon,
  budget,
  spent,
  hasLive,
  sym,
  now,
  onDone,
}: {
  account: Address;
  owner: Address | undefined;
  policy: { expiry: bigint; maxLeverage: number; maxMargin: bigint } | null;
  lapsed: boolean;
  soon: boolean;
  budget: bigint;
  spent: bigint;
  hasLive: boolean;
  sym: string;
  now: number;
  onDone: () => void;
}) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const tx = useTx({ autoDismissMs: 8_000 });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const amount = text.trim() === "" ? 0n : parseAmount(text, USDC_DECIMALS);
  const strategies = cfg.strategies!;
  const ctx = (api: OwnerContext["api"]): OwnerContext => ({ wagmi: wagmiConfig, cfg, api, owner: owner! });
  const approved = policy !== null && policy.expiry > BigInt(now);

  const renew = () => {
    if (!owner || !policy) return;
    const keep = KEEP_FOR_PRESETS[1]!.seconds;
    const next = { expiry: BigInt(now + keep), maxLeverage: Math.max(1, policy.maxLeverage), maxMargin: policy.maxMargin > 0n ? policy.maxMargin : 1n };
    void tx.run(async (api) => {
      await setStrategiesPolicy(ctx(api), account, next, "Renew the strategies' approval for 30 days");
      onDone();
      return `Strategies may trade the account until ${fmtDateTime(Number(next.expiry))}. A strategy paused after refusals needs Resume.`;
    });
  };
  const saveBudget = () => {
    if (!owner || amount === null) return;
    void tx.run(async (api) => {
      await setDailyBudget(ctx(api), account, strategies, amount, amount === 0n ? "Remove the strategies' daily budget" : `Cap the strategies at ${fmtUsdc(amount)} ${sym} a day`);
      setEditing(false);
      onDone();
      return amount === 0n ? "No daily budget: strategies are held only by the per-order limits." : `Strategies may put up at most ${fmtUsdc(amount)} ${sym} of new margin per UTC day.`;
    });
  };

  if (!policy || (policy.expiry === 0n && !hasLive)) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-4 py-2.5 text-xs" data-testid="strategies-policy">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {lapsed ? (
          <span className="text-short">
            The approval for strategies lapsed {policy.expiry > 0n ? `on ${fmtDateTime(Number(policy.expiry))}` : ""}: their orders are refused, and three refusals in a row pause
            them.
          </span>
        ) : approved ? (
          <span className={soon ? "text-warn" : "text-muted"}>
            Strategies may trade this account until <span className="num text-text">{fmtDateTime(Number(policy.expiry))}</span>: up to{" "}
            <span className="num text-text">{policy.maxLeverage}x</span> and <span className="num text-text">{fmtUsdc(policy.maxMargin)}</span> {sym} of margin per order.
          </span>
        ) : (
          <span className="text-muted">Strategies are not approved on this account.</span>
        )}
        {owner && (lapsed || soon || (approved && hasLive)) ? (
          <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={renew} data-testid="strategies-renew">
            Renew for 30 days
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-muted">
          Daily budget:{" "}
          {budget > 0n ? (
            <>
              <span className="num text-text">{fmtUsdc(budget)}</span> {sym}, <span className="num">{fmtUsdc(spent)}</span> used today (UTC)
            </>
          ) : (
            "no daily limit"
          )}
        </span>
        {owner && approved ? (
          editing ? (
            <form className="inline-flex items-center gap-1.5" onSubmit={(e) => (e.preventDefault(), saveBudget())}>
              <input className="mini-input num w-24" inputMode="decimal" placeholder="no limit" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Daily budget in ${sym}`} aria-invalid={amount === null || undefined} autoFocus />
              <button type="submit" className="btn btn-sm" disabled={tx.busy || amount === null}>
                Save
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="link" onClick={() => (setText(budget > 0n ? toInputString(budget, USDC_DECIMALS, 2) : ""), setEditing(true))}>
              Change
            </button>
          )
        ) : null}
      </div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </div>
  );
}
