"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useApp } from "@/components/providers";
import type { PositionView } from "@/hooks/use-account-data";
import { useLocalStore } from "@/hooks/use-local-store";
import type { ClosedTrade } from "@/lib/aggregate";
import { CHALLENGES, challengeAttempts, challengeById, evaluateChallenge, type Attempt, type ChallengeDef, type RuleCheck } from "@/lib/challenges";
import { fmtDateTime, fmtDuration, fmtUsdc } from "@/lib/format";
import { tradeStats } from "@/lib/trade-stats";

type Valued = { view: PositionView; value: { pnl: bigint | null } };
export type ChallengeShare = { net: bigint; roi: number | null; trades: number; winRate: number | null; volume: bigint; liquidations: number };

function rulesText(def: ChallengeDef): string[] {
  const r = def.rules;
  const out: string[] = [];
  if (r.target !== null) out.push(r.target === 0 ? "finish ahead" : `+${Math.round(r.target * 100)}%`);
  if (r.maxDrawdown !== null) out.push(`drawdown under ${Math.round(r.maxDrawdown * 100)}%`);
  if (r.maxDailyLoss !== null) out.push(`no day worse than ${(r.maxDailyLoss * 100).toFixed(1)}%`);
  if (r.minWinRate !== null) out.push(`${Math.round(r.minWinRate * 100)}% winners`);
  if (r.minProfitFactor !== null) out.push(`profit factor ${r.minProfitFactor}`);
  if (r.noLiquidations) out.push("no liquidation");
  out.push(`${r.minTrades}+ trades`, `${r.days} days`);
  return out;
}

function CheckRow({ c }: { c: RuleCheck }) {
  const tone = c.ok === false ? "bg-short" : c.kind === "limit" ? (c.fill > 0.7 ? "bg-warn" : "bg-accent") : c.ok ? "bg-long" : "bg-accent";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1" data-testid={`challenge-check-${c.key}`}>
      <span className="truncate text-[0.8125rem]">{c.label}</span>
      <span className={`num text-xs ${c.ok === false ? "text-short" : c.ok ? "text-long" : "text-muted"}`}>
        {c.detail}
        {c.ok === true ? " · met" : c.ok === false ? (c.kind === "limit" ? " · broken" : " · missed") : ""}
      </span>
      <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.round(c.fill * 100)}%` }} />
      </span>
    </li>
  );
}

/**
 * Practice challenges on the Portfolio page: pick a goal with risk rules, trade, and see each rule's standing.
 * Measured from this account's trades closed after the start; kept in this browser.
 */
export function Challenges({
  address,
  trades,
  positions,
  equity,
  chainNow,
  historyFrom,
  readOnly,
  onShare,
}: {
  address: Address;
  trades: readonly ClosedTrade[];
  positions: readonly Valued[];
  /** Account value now (null while loading). */
  equity: bigint | null;
  chainNow: number;
  /** Earliest time the loaded history covers (0: not loaded yet). */
  historyFrom: number;
  readOnly: boolean;
  onShare: (r: ChallengeShare, label: string) => void;
}) {
  const { config: cfg } = useApp();
  const [attempts, setAttempts] = useLocalStore(challengeAttempts);
  const [picking, setPicking] = useState(false);
  const mine = (a: Attempt) => a.account === address.toLowerCase() && a.chainId === cfg.chainId && a.engine === cfg.perpEngine.toLowerCase();
  const active = attempts.find((a) => mine(a) && a.result === null) ?? null;
  const def = active ? challengeById(active.challenge) : undefined;
  const past = attempts.filter((a) => mine(a) && a.result !== null).slice(-5).reverse();

  const unrealised = useMemo(() => {
    if (!active) return 0n;
    return positions.reduce((sum, p) => (Number(p.view.position.openedAt) >= active.startedAt ? sum + (p.value.pnl ?? 0n) : sum), 0n);
  }, [positions, active]);
  const progress = useMemo(() => (active && def ? evaluateChallenge(def, active, trades, unrealised, chainNow) : null), [active, def, trades, unrealised, chainNow]);
  // Decide only on a history that reaches back to the start, so a trade not read yet cannot fail or pass it.
  const covered = active !== null && historyFrom > 0 && historyFrom <= active.startedAt + 60;

  useEffect(() => {
    if (!active || !progress || !covered || progress.status === "active" || readOnly) return;
    const result: Attempt["result"] = progress.status;
    setAttempts((list) =>
      list.map((a) =>
        mine(a) && a.result === null && a.startedAt === active.startedAt
          ? { ...a, result, endedAt: chainNow, reason: progress.reason, final: { net: progress.realised.toString(), trades: progress.trades } }
          : a,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.status, covered]);

  const start = (d: ChallengeDef) => {
    if (equity === null || equity <= 0n || active) return;
    setAttempts((list) => [
      ...list,
      { challenge: d.id, account: address.toLowerCase(), chainId: cfg.chainId, engine: cfg.perpEngine.toLowerCase(), stake: equity.toString(), startedAt: chainNow, endedAt: null, result: null, reason: null, final: null },
    ]);
    setPicking(false);
  };
  const abandon = () => {
    if (!active) return;
    setAttempts((list) =>
      list.map((a) =>
        mine(a) && a.result === null
          ? { ...a, result: "abandoned", endedAt: chainNow, reason: "Abandoned", final: progress ? { net: progress.realised.toString(), trades: progress.trades } : null }
          : a,
      ),
    );
  };
  const shareAttempt = (a: Attempt) => {
    const d = challengeById(a.challenge);
    if (!d) return;
    const stake = BigInt(a.stake);
    const end = a.endedAt ?? chainNow;
    const counted = trades.filter((t) => t.openTime !== null && t.openTime >= a.startedAt && t.closeTime <= end);
    const s = tradeStats(counted);
    onShare(
      { net: s.net, roi: stake > 0n ? Number((s.net * 1_000_000n) / stake) / 1e6 : null, trades: s.trades, winRate: s.winRate, volume: s.volume, liquidations: s.liquidations },
      `Challenge passed: ${d.name}`,
    );
  };

  const sym = cfg.collateralSymbol;
  return (
    <section className="panel" aria-label="Practice challenges" data-testid="challenges">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="panel-title">Challenges</h2>
        <span className="text-2xs text-faint">practice goals with risk rules, measured from your closed trades</span>
      </div>
      {active && def && progress ? (
        <div className="grid gap-3 px-3 py-3" data-testid="challenge-active">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p>
              <span className="font-semibold">{def.name}</span> <span className="text-xs text-muted">{def.blurb}</span>
            </p>
            <p className="num text-xs text-muted">
              Stake {fmtUsdc(BigInt(active.stake))} {sym} · started {fmtDateTime(active.startedAt)} · {progress.timeLeft > 0 ? `${fmtDuration(progress.timeLeft)} left` : "time is up"}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <div className="kv">
              <dt>Closed trades</dt>
              <dd className={`num ${progress.realised > 0n ? "text-long" : progress.realised < 0n ? "text-short" : ""}`}>{fmtUsdc(progress.realised, 2, { sign: true })}</dd>
            </div>
            <div className="kv">
              <dt>Open, since the start</dt>
              <dd className={`num ${progress.unrealised > 0n ? "text-long" : progress.unrealised < 0n ? "text-short" : ""}`}>{fmtUsdc(progress.unrealised, 2, { sign: true })}</dd>
            </div>
            <div className="kv">
              <dt>Trades</dt>
              <dd className="num" data-testid="challenge-trades">
                {progress.trades}
              </dd>
            </div>
          </dl>
          <ul className="grid gap-2.5">
            {progress.checks.map((c) => (
              <CheckRow key={c.key} c={c} />
            ))}
          </ul>
          {!covered ? <p className="text-xs text-faint">Reading your history back to the start before deciding.</p> : null}
          {!readOnly ? (
            <div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={abandon} data-testid="challenge-abandon">
                Abandon
              </button>
            </div>
          ) : null}
        </div>
      ) : picking || past.length === 0 ? (
        <div className="grid gap-2 px-3 py-3 sm:grid-cols-2" data-testid="challenge-list">
          {CHALLENGES.map((d) => (
            <div key={d.id} className="rounded-md border border-line bg-bg/40 p-3">
              <p className="font-semibold">{d.name}</p>
              <p className="mt-0.5 text-xs text-muted">{d.blurb}</p>
              <p className="mt-1.5 text-2xs text-faint">{rulesText(d).join(" · ")}</p>
              <button
                type="button"
                className="btn btn-sm mt-2"
                disabled={readOnly || equity === null || equity <= 0n}
                title={equity !== null && equity <= 0n ? `Add test ${sym} first: the stake is your account value` : undefined}
                onClick={() => start(d)}
                data-testid={`challenge-start-${d.id}`}
              >
                Start
              </button>
            </div>
          ))}
          <p className="text-2xs text-faint sm:col-span-2">
            The stake is your account value when you start. Only trades opened after the start count; test funds you add later do not. Kept in this browser.
          </p>
        </div>
      ) : (
        <div className="px-3 py-3">
          {!readOnly ? (
            <button type="button" className="btn btn-sm" onClick={() => setPicking(true)} data-testid="challenge-new">
              Start a challenge
            </button>
          ) : null}
        </div>
      )}
      {past.length > 0 ? (
        <ul className="divide-y divide-line border-t border-line" data-testid="challenge-history">
          {past.map((a) => {
            const d = challengeById(a.challenge);
            return (
              <li key={`${a.challenge}-${a.startedAt}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[0.8125rem]">
                <span>
                  <span className="font-semibold">{d?.name ?? a.challenge}</span>{" "}
                  <span className={a.result === "passed" ? "text-long" : a.result === "failed" ? "text-short" : "text-muted"}>
                    {a.result === "passed" ? "Passed" : a.result === "failed" ? "Failed" : "Abandoned"}
                  </span>
                  <span className="block text-xs text-faint">
                    {fmtDateTime(a.startedAt)}
                    {a.final ? ` · ${a.final.trades} trades, ${fmtUsdc(BigInt(a.final.net), 2, { sign: true })} ${sym}` : ""}
                    {a.reason && a.result === "failed" ? ` · ${a.reason}` : ""}
                  </span>
                </span>
                {a.result === "passed" ? (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => shareAttempt(a)} data-testid="challenge-share">
                    Share
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
