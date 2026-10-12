"use client";

import { useMemo } from "react";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import type { AccountData } from "@/hooks/use-account-data";
import { useActionContext } from "@/hooks/use-action-context";
import { useMarketData } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import type { AccountView } from "@/hooks/use-wallet";
import { TEST_MINT_AMOUNT, submitClaim, submitTestMint } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { TOKEN_DECIMALS, fmtCompact, fmtUsdc, shortAddress } from "@/lib/format";
import { valuePosition } from "@/lib/position";

function Cell({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <dt className="truncate text-2xs text-muted">{label}</dt>
      <dd className="num mt-px truncate text-[0.8125rem]">{children}</dd>
    </div>
  );
}

/** The account at a glance: collateral, margin in use, open PnL, anything claimable, KEG. */
export function AccountBar({ view, account, loading }: { view: AccountView; account: AccountData | undefined; loading: boolean }) {
  const { config: cfg } = useApp();
  const { prices, params } = useMarketData();
  const tx = useTx({ autoDismissMs: 6000 });
  const actionContext = useActionContext();
  const sym = cfg.collateralSymbol;

  const totals = useMemo(() => {
    if (!account || !params) return null;
    let margin = 0n;
    let pnl = 0n;
    let priced = true;
    for (const p of account.positions) {
      margin += p.position.margin;
      const value = valuePosition(p, prices.get(p.position.priceId.toLowerCase())?.mark ?? null, params.maxProfitMultiple);
      if (value.pnl === null) priced = false;
      else pnl += value.pnl;
    }
    let escrow = 0n;
    for (const { order } of account.orders) {
      escrow += order.executionFee;
      if (order.orderType !== 0) continue;
      const brackets = (order.takeProfit !== 0n ? 1n : 0n) + (order.stopLoss !== 0n ? 1n : 0n);
      escrow += order.margin + order.feeBudget + brackets * order.executionFee;
    }
    return { margin, pnl, priced, escrow, equity: account.balance + margin + escrow + pnl };
  }, [account, prices, params]);

  const run = (label: string, action: "mint" | "claim") => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      if (action === "mint") {
        await submitTestMint(ctx, label);
        return `${fmtUsdc(TEST_MINT_AMOUNT, 0)} ${sym} of test funds added to your wallet.`;
      }
      await submitClaim(ctx, label);
      return `Claimed ${fmtUsdc(account?.claimable ?? 0n)} ${sym}.`;
    });
  };

  if (!view.address) {
    return (
      <section className="panel flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[0.8125rem] text-muted" aria-label="Account">
        <span>Connect a wallet to trade, or watch any account read-only from the header.</span>
        {cfg.collateralIsTest ? <span className="text-xs text-faint">This deployment uses test {sym}: free to mint once connected.</span> : null}
      </section>
    );
  }

  const dash = loading ? <span className="skeleton" /> : "—";
  return (
    <section className="panel px-3 py-2" aria-label={view.watching ? "Watched account" : "Your account"} data-testid="account-bar">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          {view.watching ? <span className="watch-badge">Watching</span> : null}
          <span className="num text-[0.8125rem] text-muted">{shortAddress(view.address)}</span>
        </div>
        <dl className="order-3 grid w-full grid-cols-3 gap-x-5 gap-y-2 sm:grid-cols-6 lg:order-none lg:w-auto lg:flex-1">
          <Cell label={`${sym} balance`}>{account ? fmtUsdc(account.balance) : dash}</Cell>
          <Cell label="Margin in use" hint="Collateral locked in open positions.">
            {totals ? fmtUsdc(totals.margin) : dash}
          </Cell>
          <Cell label="Unrealised PnL" hint="Across open positions at the current prices, after funding, before close fees.">
            {totals ? (
              <span className={totals.pnl > 0n ? "text-long" : totals.pnl < 0n ? "text-short" : ""}>
                {fmtUsdc(totals.pnl, 2, { sign: true })}
                {totals.priced ? "" : "*"}
              </span>
            ) : (
              dash
            )}
          </Cell>
          <Cell label="In open orders" hint="Margin and fees escrowed by resting orders; refunded if you cancel.">
            {totals ? fmtUsdc(totals.escrow) : dash}
          </Cell>
          <Cell label="Account value" hint="Wallet balance + margin + order escrow + unrealised PnL.">
            {totals ? fmtUsdc(totals.equity) : dash}
          </Cell>
          <Cell label="KEG" hint="Loss-rebate tokens: in the wallet, plus staked. Stake them on the House page to earn a share of house profit.">
            {account ? (
              <AppLink route="house" className="hover:text-spark">
                {fmtCompact(account.house, TOKEN_DECIMALS)}
                {account.houseStaked > 0n ? <span className="text-faint"> + {fmtCompact(account.houseStaked, TOKEN_DECIMALS)} staked</span> : null}
              </AppLink>
            ) : (
              dash
            )}
          </Cell>
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {account && account.claimable > 0n ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!view.canTrade || tx.busy}
              title="A payment to this account could not be delivered and is held by the engine."
              onClick={() => run("Claim held funds", "claim")}
            >
              Claim {fmtUsdc(account.claimable)} {sym}
            </button>
          ) : null}
          {cfg.collateralIsTest && view.canTrade ? (
            <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => run("Get test funds", "mint")} data-testid="get-test-funds">
              Get test funds
            </button>
          ) : null}
        </div>
      </div>
      {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="mt-2" /> : null}
    </section>
  );
}
