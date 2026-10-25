"use client";

import { useState } from "react";
import { useConfig } from "wagmi";
import type { Address } from "viem";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { useTx } from "@/hooks/use-tx";
import { USDC_DECIMALS, fmtUsdc, parseAmount, shortAddress, toInputString } from "@/lib/format";
import { setDailyBudget } from "@/lib/strategy-actions";

/**
 * One agent key's daily margin budget (`budgets(agent)`): what it may put up per UTC day and what it used today,
 * with an inline editor (`setAgentBudget`). Margin coming back from closes does not refill it.
 */
export function KeyBudget({ account, owner, agent, budget, onDone }: { account: Address; owner: Address; agent: Address; budget: readonly [bigint, number, bigint] | undefined; onDone: () => void }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const tx = useTx({ autoDismissMs: 8_000 });
  const sym = cfg.collateralSymbol;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const amount = text.trim() === "" ? 0n : parseAmount(text, USDC_DECIMALS);
  const perDay = budget?.[0] ?? 0n;
  const today = Math.floor(Date.now() / 86_400_000);
  const spent = budget && budget[1] === today ? budget[2] : 0n;

  const save = () => {
    if (amount === null) return;
    void tx.run(async (api) => {
      await setDailyBudget(
        { wagmi: wagmiConfig, cfg, api, owner },
        account,
        agent,
        amount,
        amount === 0n ? `Remove the daily budget of ${shortAddress(agent)}` : `Cap ${shortAddress(agent)} at ${fmtUsdc(amount)} ${sym} a day`,
      );
      setEditing(false);
      onDone();
      return amount === 0n ? `${shortAddress(agent)} has no daily budget now: only its per-trade limits hold it.` : `${shortAddress(agent)} may put up at most ${fmtUsdc(amount)} ${sym} of new margin per UTC day.`;
    });
  };

  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="key-budget">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>
          Daily budget:{" "}
          {budget === undefined ? (
            "…"
          ) : perDay > 0n ? (
            <>
              <span className="num text-text">{fmtUsdc(perDay)}</span> {sym}, <span className="num">{fmtUsdc(spent)}</span> used today (UTC)
            </>
          ) : (
            "no daily limit"
          )}
        </span>
        {editing ? (
          <form className="inline-flex items-center gap-1.5" onSubmit={(e) => (e.preventDefault(), save())}>
            <input
              className="mini-input num w-24"
              inputMode="decimal"
              placeholder="no limit"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={`Daily budget of ${shortAddress(agent)} in ${sym}`}
              aria-invalid={amount === null || undefined}
              autoFocus
              data-testid="key-budget-input"
            />
            <button type="submit" className="btn btn-sm" disabled={tx.busy || amount === null} data-testid="key-budget-save">
              Save
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="link" onClick={() => (setText(perDay > 0n ? toInputString(perDay, USDC_DECIMALS, 2) : ""), setEditing(true))} data-testid="key-budget-edit">
            {perDay > 0n ? "Change" : "Set one"}
          </button>
        )}
      </div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </div>
  );
}
