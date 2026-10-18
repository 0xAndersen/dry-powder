"use client";

import { useState } from "react";
import { useBalance } from "wagmi";
import { InstantTradingSheet } from "@/components/instant-trading";
import { useApp } from "@/components/providers";
import type { AccountData } from "@/hooks/use-account-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { useTradeContext } from "@/hooks/use-action-context";
import { useTx } from "@/hooks/use-tx";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { TEST_MINT_AMOUNT, submitTestMint } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { fmtUsdc } from "@/lib/format";
import { createLocalStore } from "@/lib/storage";

const dismissed = createLocalStore<boolean>("dp:onboarding-dismissed:v1", false, (v) => (typeof v === "boolean" ? v : null));

type Step = { key: string; title: string; done: boolean; action?: React.ReactNode };

/**
 * First-run checklist on the trade screen: wallet, gas, test funds, instant trading, first trade. It disappears
 * once everything is done (or when dismissed) and never shows in watch mode.
 */
export function Onboarding({ account, hasTraded }: { account: AccountData | undefined; hasTraded: boolean }) {
  const { config: cfg } = useApp();
  const wallet = useWallet();
  const view = useAccountView();
  const [isDismissed, setDismissed] = useLocalStore(dismissed);
  const [instantOpen, setInstantOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const tx = useTx({ autoDismissMs: 6000 });
  const tradeContext = useTradeContext();
  const gas = useBalance({ address: wallet.address, chainId: cfg.chainId, query: { enabled: wallet.connected, refetchInterval: 10_000 } });

  if (isDismissed || view.watching) return null;

  const connected = wallet.connected || view.instant;
  const hasGas = view.instant || (gas.data?.value ?? 0n) > 0n;
  const hasFunds = (account?.balance ?? 0n) > 0n || (account?.positions.length ?? 0) > 0;
  const steps: Step[] = [
    { key: "wallet", title: "Connect a wallet on Arc Testnet", done: connected },
    {
      key: "gas",
      title: "Get gas: Arc's gas is USDC",
      done: hasGas,
      action:
        connected && !hasGas && wallet.address ? (
          <span className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(wallet.address ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? "Address copied" : "Copy my address"}
            </button>
            <a className="btn btn-sm btn-primary" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              Open the faucet
            </a>
          </span>
        ) : null,
    },
    ...(cfg.collateralIsTest
      ? [
          {
            key: "funds",
            title: `Get ${fmtUsdc(TEST_MINT_AMOUNT, 0)} test ${cfg.collateralSymbol} (paper trading, real mechanics)`,
            done: hasFunds,
            action:
              connected && hasGas && !hasFunds ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={tx.busy}
                  onClick={() =>
                    void tx.run(async (api) => {
                      const ctx = tradeContext(api);
                      if (!ctx) throw new UserFacingError("Connect your wallet first.");
                      await submitTestMint(ctx, "Get test funds");
                      return "Test funds added.";
                    })
                  }
                >
                  {tx.busy ? "Working" : "Get test funds"}
                </button>
              ) : null,
          },
        ]
      : []),
    {
      key: "instant",
      title: "Optional: instant trading, no wallet pop-up per order",
      done: view.instant,
      action:
        connected && !view.instant && cfg.agentFactory ? (
          <button type="button" className="btn btn-sm" onClick={() => setInstantOpen(true)}>
            Set up
          </button>
        ) : null,
    },
    { key: "trade", title: "Place a first trade: start small, set a stop", done: hasTraded },
  ];
  const remaining = steps.filter((s) => !s.done && s.key !== "instant");
  if (remaining.length === 0) return null;
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section className="panel px-3 py-3" aria-label="Getting started" data-testid="onboarding">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[0.8125rem] font-semibold">
          Getting started <span className="num font-normal text-faint">{doneCount}/{steps.length}</span>
        </h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(true)}>
          Hide
        </button>
      </div>
      <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-start gap-2 text-[0.8125rem]">
            <span
              className={`num mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-2xs ${s.done ? "border-long bg-long/15 text-long" : "border-line-strong text-muted"}`}
              aria-hidden="true"
            >
              {s.done ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className={s.done ? "text-muted line-through decoration-faint" : "text-text"}>{s.title}</span>
              {s.action && !s.done ? <span className="mt-1.5 block">{s.action}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {tx.state.phase === "failed" ? <p className="mt-2 text-xs text-short">{tx.state.error}</p> : null}
      {instantOpen ? <InstantTradingSheet onClose={() => setInstantOpen(false)} /> : null}
    </section>
  );
}
