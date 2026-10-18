"use client";

import { useState, type ReactNode } from "react";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";

const REPO = "https://github.com/0xAndersen/dry-powder";

type Faq = { q: string; a: ReactNode };

function faqs(sym: string, test: boolean): Faq[] {
  return [
    {
      q: "What is Dry Powder?",
      a: (
        <>
          An open perpetual-futures venue on Arc. A USDC vault (the House) takes the other side of every trade at the oracle price, so any
          size up to a market&rsquo;s cap fills at once. You post margin, choose leverage up to the market&rsquo;s maximum (1000x on BTC and ETH),
          and always see the most you can lose before you trade.
        </>
      ),
    },
    {
      q: test ? "How do I start? (it is free on testnet)" : "How do I start?",
      a: (
        <>
          Connect a wallet on Arc Testnet. Gas is native USDC from <a className="link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>.
          {test ? ` Then press Get test funds for 10,000 test ${sym}: it is paper trading with real mechanics.` : ""} Turn on Instant trading to stop
          confirming every order in your wallet.
        </>
      ),
    },
    {
      q: "What is the most I can lose?",
      a: (
        <>
          The margin of the position plus its fees. A position is liquidated once its loss (price move plus funding) reaches 90% of its margin, and
          losses stop at the margin: there are no negative balances and no losses passed to other traders. The ticket&rsquo;s risk card shows the
          exact figures before you trade.
        </>
      ),
    },
    {
      q: "Why do orders above 100x go through a keeper?",
      a: (
        <>
          At 1000x a 0.1% price move is the whole margin. A keeper fills your order at a price published after you placed it, so nobody can trade
          against a price they already know is stale. Below 100x you can also open and close directly.
        </>
      ),
    },
    {
      q: "What are the fees?",
      a: (
        <>
          5 bp of the position size to open and to close, plus a small surcharge when your trade makes a market more one-sided. Each side is capped
          at 10% of the position&rsquo;s margin. Keeper orders also escrow a 0.10 {sym} execution fee, paid to whoever fills them.
        </>
      ),
    },
    {
      q: "Is profit capped?",
      a: <>Yes: a position can make at most 10x its margin. It bounds what one position can take from the House.</>,
    },
    {
      q: "How does funding work?",
      a: <>The heavier side pays the lighter side, continuously, in proportion to how one-sided the market is. The rate is shown per hour in the market header.</>,
    },
    {
      q: "Is Instant trading safe?",
      a: (
        <>
          It adds a key, kept in this browser, to your own trading account with limits you choose (expiry, leverage, margin per order). It can
          place and close orders; it can never withdraw. Only your wallet can move funds out, and you can revoke the key at any time. Anyone with
          access to this browser profile could trade within those limits, so revoke it on shared devices.
        </>
      ),
    },
    {
      q: "What is the House, and DRY?",
      a: (
        <>
          The House is the USDC vault every trade is against: deposit to earn the venue&rsquo;s edge (and take the risk that traders win). Every 1{" "}
          {sym} a trader loses mints 100 DRY as a rebate; staked DRY earns 15% of House profit above its high-water mark.
        </>
      ),
    },
    {
      q: "Can bots and AI agents trade?",
      a: (
        <>
          Yes, with the same rules: the TypeScript SDK, an MCP server for AI agents, and agent accounts that let a bot trade but never withdraw. See{" "}
          <a className="link" href={`${REPO}/blob/main/AGENTS.md`} target="_blank" rel="noreferrer">AGENTS.md</a>.
        </>
      ),
    },
  ];
}

/** In-app help: plain answers, how to stay safe, where to get support. */
export function HelpSheet({ onClose }: { onClose: () => void }) {
  const { config: cfg } = useApp();
  const [open, setOpen] = useState<number | null>(0);
  const list = faqs(cfg.collateralSymbol, cfg.collateralIsTest);
  return (
    <Sheet title="Help" description="Straight answers. Nothing here is financial advice." onClose={onClose} wide testId="help-sheet">
      <div className="grid gap-4">
        <ul className="divide-y divide-line rounded-[var(--radius-ui)] border border-line">
          {list.map((item, i) => (
            <li key={item.q}>
              <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-[0.875rem] text-text" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {item.q}
                <span aria-hidden="true" className="text-faint">
                  {open === i ? "−" : "+"}
                </span>
              </button>
              {open === i ? <p className="px-3 pb-3 text-[0.8125rem] leading-relaxed text-muted">{item.a}</p> : null}
            </li>
          ))}
        </ul>
        <section className="notice" data-tone="warn">
          <p className="font-semibold">Stay safe</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.8125rem]">
            <li>Nobody from Dry Powder will ever message you first, ask for your seed phrase, or ask you to sign something to &ldquo;fix&rdquo; an account.</li>
            <li>The official app is served from the project&rsquo;s GitHub Pages; the code is open at the repository below.</li>
            <li>A custom-deployment badge in the header means the page address changed the contract addresses. Only trade if you trust the link.</li>
          </ul>
        </section>
        <section className="text-[0.8125rem] text-muted">
          <p className="font-semibold text-text">Support</p>
          <p className="mt-1">
            Questions and bugs: open an issue on{" "}
            <a className="link" href={`${REPO}/issues/new/choose`} target="_blank" rel="noreferrer">
              GitHub
            </a>
            . Security reports go privately to the{" "}
            <a className="link" href={`${REPO}/security/advisories/new`} target="_blank" rel="noreferrer">
              security advisories
            </a>
            . Venue status (keeper, oracle) is in the header.
          </p>
        </section>
      </div>
    </Sheet>
  );
}

export function HelpButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-ghost h-8 px-2 ${className}`} aria-label="Help" title="Help" onClick={() => setOpen(true)} data-testid="help-button">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01" />
        </svg>
      </button>
      {open ? <HelpSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
