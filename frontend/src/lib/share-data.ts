import type { PositionView } from "@/hooks/use-account-data";
import type { ClosedTrade } from "./aggregate";
import { fmtCompact, fmtDuration, fmtPercent, fmtPrice, fmtUsdc, fmtUtc, USDC_DECIMALS } from "./format";
import { hrefFor, stickyQuery } from "./nav";
import type { PositionValue } from "./position";
import { cardPercent, displayUrl, type CardFigure, type ProfileCard, type TradeCard } from "./share-card";

/** What a card needs from the app around it. */
export type CardContext = {
  /** Market symbol and price decimals by market id (any case). */
  market: (marketId: string) => { symbol: string; priceDecimals: number } | undefined;
  unit: string;
  chainId: number;
  /** The trader as shown: nickname, or the short address. */
  trader: string;
  /** Page address; the card shows the site part of it. */
  href: string;
};

export function networkName(chainId: number): string {
  return chainId === 5042002 ? "Arc Testnet" : chainId === 31337 ? "Local devnet" : `Chain ${chainId}`;
}

const money = (v: bigint, unit: string, sign = true) => `${fmtUsdc(v, 2, { sign })} ${unit}`;

/** "3h 12m", "2d 4h", "45s": short enough for a card column. */
function held(seconds: number): string {
  const text = fmtDuration(seconds);
  return text.split(" ").slice(0, 2).join(" ");
}

/** A closed (or liquidated) round trip. */
export function closedTradeCard(t: ClosedTrade, ctx: CardContext): TradeCard {
  const m = ctx.market(t.marketId);
  const dp = m?.priceDecimals ?? 2;
  const figures: CardFigure[] = [];
  if (t.entry !== null) figures.push({ label: "Entry", value: fmtPrice(t.entry, dp) });
  figures.push({ label: t.liquidated ? "Liquidated at" : "Exit", value: fmtPrice(t.exit, dp) });
  if (t.size !== null) figures.push({ label: "Size", value: `${fmtCompact(t.size, USDC_DECIMALS)} ${ctx.unit}` });
  if (t.openTime !== null) figures.push({ label: "Held", value: held(Math.max(0, t.closeTime - t.openTime)) });
  return {
    kind: "trade",
    symbol: m?.symbol ?? "Trade",
    side: t.isLong === null ? null : t.isLong ? "Long" : "Short",
    leverage: t.leverage,
    headline: t.roe !== null ? cardPercent(t.roe) : null,
    pnl: money(t.net, ctx.unit),
    positive: t.net > 0n,
    status: t.liquidated ? "Liquidated" : t.partials > 0 ? "Closed in parts" : "Closed",
    figures,
    trader: ctx.trader,
    when: fmtUtc(t.closeTime),
    url: displayUrl(ctx.href),
    network: networkName(ctx.chainId),
  };
}

/** An open position at the current mark: unrealised, before the close fee. */
export function openPositionCard(view: PositionView, value: PositionValue, mark: bigint | null, nowSeconds: number, ctx: CardContext): TradeCard {
  const pos = view.position;
  const m = ctx.market(pos.priceId);
  const dp = m?.priceDecimals ?? 2;
  const pnl = value.pnl ?? 0n;
  const figures: CardFigure[] = [{ label: "Entry", value: fmtPrice(pos.entryPrice, dp) }];
  if (mark !== null) figures.push({ label: "Mark", value: fmtPrice(mark, dp) });
  figures.push({ label: "Size", value: `${fmtCompact(pos.size, USDC_DECIMALS)} ${ctx.unit}` });
  if (value.liquidationDistance !== null) figures.push({ label: "To liquidation", value: fmtPercent(value.liquidationDistance, 2) });
  return {
    kind: "trade",
    symbol: m?.symbol ?? "Position",
    side: pos.isLong ? "Long" : "Short",
    leverage: value.leverage,
    headline: value.roe !== null ? cardPercent(value.roe) : null,
    pnl: money(pnl, ctx.unit),
    positive: pnl > 0n,
    status: "Open",
    figures,
    trader: ctx.trader,
    when: fmtUtc(nowSeconds),
    url: displayUrl(ctx.href),
    network: networkName(ctx.chainId),
  };
}

/** A trader's record over a period. */
export function profileCard(
  r: { net: bigint; roi: number | null; trades: number; winRate: number | null; volume: bigint; liquidations: number },
  period: string,
  ctx: CardContext,
): ProfileCard {
  return {
    kind: "profile",
    trader: ctx.trader,
    period,
    headline: r.roi !== null ? cardPercent(r.roi) : money(r.net, ctx.unit),
    pnl: money(r.net, ctx.unit),
    positive: r.net > 0n,
    figures: [
      { label: "Trades", value: String(r.trades) },
      { label: "Win rate", value: r.winRate === null ? "—" : fmtPercent(r.winRate, 0) },
      { label: "Volume", value: `${fmtCompact(r.volume, USDC_DECIMALS)} ${ctx.unit}` },
      { label: "Liquidations", value: String(r.liquidations) },
    ],
    url: displayUrl(ctx.href),
    network: networkName(ctx.chainId),
  };
}

/** The words that go with a shared card. */
export function shareText(card: TradeCard | ProfileCard): string {
  if (card.kind === "profile") return `${card.trader} on Dry Powder, ${card.period.toLowerCase()}: ${card.headline} (${card.pnl}), ${card.network}.`;
  const lev = card.leverage !== null ? ` ${card.leverage >= 10 ? Math.round(card.leverage) : Math.round(card.leverage * 10) / 10}x` : "";
  const what = `${card.symbol}${card.side ? ` ${card.side.toLowerCase()}${lev}` : ""}`;
  const result = card.headline ? `${card.headline} on margin (${card.pnl})` : card.pnl;
  return `${what}: ${result}${card.status === "Open" ? ", still open" : card.status === "Liquidated" ? ", liquidated" : ""}. On Dry Powder, ${card.network}.`;
}

/** Absolute link to a trader's public profile, from any page of the app (keeps deployment overrides). */
export function profileLink(address: string): string {
  if (typeof window === "undefined") return "";
  const query = stickyQuery(new URLSearchParams(window.location.search), { address, account: null });
  try {
    return new URL(hrefFor("trader", query), window.location.href).toString();
  } catch {
    return window.location.href;
  }
}
