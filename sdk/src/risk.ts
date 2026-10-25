// Pure risk math, identical to the engine's rules. No network; safe to call in a loop.
//
// Units: sizes and margins are USDC with 6 decimals (bigint); prices have 18 decimals (bigint).

/** PerpEngine.MAX_LEVERAGE (v3.2: the Turbo markets go to 5000x). */
export const MAX_LEVERAGE = 5_000;
/** PerpEngine.DIRECT_MAX_LEVERAGE: above it a position opens and closes only through keeper-filled orders. */
export const DIRECT_MAX_LEVERAGE = 100;
/** PerpEngine.MARGIN_FEE_CAP_BPS: each side's trading fee is at most 10% of margin. */
export const MARGIN_FEE_CAP_BPS = 1_000;
/** A position is liquidated once losses plus funding reach 90% of its margin. */
export const LIQUIDATION_THRESHOLD_BPS = 9_000;
/** PerpEngine.REBATE_NOTIONAL_BPS: one close reports at most 1% of its notional to the DRY rebate. */
export const REBATE_NOTIONAL_BPS = 100;
/** v3.2 engine defaults; each is an owner parameter, so the client reads the live values. */
export const DEFAULT_PROFIT_SHARE_BPS = 2_000;
export const DEFAULT_REFERRAL_SHARE_BPS = 1_000;
export const DEFAULT_REFERRAL_DISCOUNT_BPS = 500;
/** RewardToken: DRY per whole USDC of new net loss before any loss was rebated. */
export const INITIAL_REBATE_RATE = 100n;
/** RewardToken.HALVING_LOSS: the rebated total (USDC, 6 decimals) at which the rate has halved. */
export const HALVING_LOSS = 1_000_000_000_000n;
export const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * How a market charges (`Market.feeMode`). "standard": a fee on notional at open and at close, fills on the
 * adverse side of the oracle's band. "upside" (the Turbo markets, "no fee unless you win"): nothing to open or
 * close, fills at the mid price, keeper orders only, and the house keeps `profitShareBps` of a winning close's
 * profit.
 */
export type FeeModel = "standard" | "upside";

/**
 * True when a position of this size and margin must use keeper orders to open and close: above 100x, and always
 * in an Upside market (its fills are at the mid, so only orders filled at a price published after them trade).
 */
export function needsKeeperOrders(size: bigint, margin: bigint, feeModel: FeeModel = "standard"): boolean {
  return feeModel === "upside" || size > margin * BigInt(DIRECT_MAX_LEVERAGE);
}

/** The most the engine charges per side for a position with this margin. */
export function feeCap(margin: bigint): bigint {
  return (margin * BigInt(MARGIN_FEE_CAP_BPS)) / BPS;
}

/** Margin for a size at a leverage, rounded up so the leverage is never exceeded. */
export function marginFor(size: bigint, leverage: number): bigint {
  const lev = BigInt(Math.round(leverage * 100));
  return ceilDiv(size * 100n, lev);
}

/**
 * Price at which losses plus funding reach 90% of margin. 0n means never (a long whose margin covers its size);
 * null means already liquidatable.
 */
export function liquidationPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean, fundingOwed = 0n): bigint | null {
  if (size === 0n || entry === 0n) return null;
  const room = (margin * BigInt(LIQUIDATION_THRESHOLD_BPS)) / BPS - fundingOwed;
  if (room <= 0n) return null;
  if (isLong) {
    if (room >= size) return 0n;
    return ceilDiv(entry * (size - room), size);
  }
  return (entry * (size + room)) / size;
}

/** Price at which profit reaches the cap (`multiple` x margin). Null when unreachable (a short past zero). */
export function profitCapPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean, multiple = 10n): bigint | null {
  if (size === 0n) return null;
  const cap = margin * multiple;
  if (isLong) return entry + ceilDiv(entry * cap, size);
  if (cap >= size) return null;
  return (entry * (size - cap)) / size;
}

export type RiskLevel = "low" | "moderate" | "high" | "extreme";

/** The app's risk bands, by the price move that liquidates the position. */
export function riskLevel(liquidationMove: number | null): RiskLevel {
  if (liquidationMove === null) return "low";
  if (liquidationMove >= 0.1) return "low";
  if (liquidationMove >= 0.03) return "moderate";
  if (liquidationMove >= 0.01) return "high";
  return "extreme";
}

export interface RiskInput {
  entry: bigint;
  size: bigint;
  margin: bigint;
  isLong: boolean;
  /** Open fee (from `quoteOpenFee`); defaults to the cap, the most it can be. Always 0 in an Upside market. */
  openFee?: bigint;
  /** Close fee estimate; defaults to the cap. Always 0 in an Upside market. */
  closeFee?: bigint;
  /** Keeper execution fees escrowed with the order(s). */
  executionFees?: bigint;
  stopLoss?: bigint;
  maxProfitMultiple?: bigint;
  /** "upside" for the Turbo markets: no fees; the house keeps `profitShareBps` of a winning close's profit. */
  feeModel?: FeeModel;
  /** Upside markets: the engine's `profitShareBps` (default 2,000 = 20%). */
  profitShareBps?: bigint;
  /** The trader has a referrer: every fee, the profit share included, is `referralDiscountBps` lower. */
  referred?: boolean;
  referralDiscountBps?: bigint;
}

export interface Risk {
  leverage: number;
  keeperOrdersOnly: boolean;
  liquidationPrice: bigint | null;
  /** Fractional move against the position that liquidates it (0.0009 = 0.09%). */
  liquidationMove: number | null;
  level: RiskLevel;
  /** Margin plus every fee: the most this trade can cost. There is no negative balance. */
  maxLoss: bigint;
  /** Price loss if the stop fills at its trigger, before fees (negative). */
  lossAtStop: bigint | null;
  /** True when the stop sits past the liquidation price, so liquidation comes first. */
  stopPastLiquidation: boolean;
  /** The most the position can make: its capped profit, net of the house's share in an Upside market. */
  maxProfit: bigint;
  /** Fractional move in favour at which the profit cap is reached. */
  profitCapMove: number | null;
  feeModel: FeeModel;
  /** Upside markets: the share of a winning close's profit the house keeps, after any referral discount. */
  profitShareBps: number;
  /** Upside markets: what the house keeps if the position closes at its profit cap (0 otherwise). */
  shareAtCap: bigint;
}

const frac = (a: bigint, b: bigint) => Number((a * 1_000_000_000n) / b) / 1e9;

/** The worst case, the liquidation distance and the best case for a prospective position. */
export function assessRisk(r: RiskInput): Risk {
  const upside = r.feeModel === "upside";
  const cap = feeCap(r.margin);
  const openFee = upside ? 0n : (r.openFee ?? cap);
  const closeFee = upside ? 0n : (r.closeFee ?? cap);
  const liq = liquidationPrice(r.entry, r.margin, r.size, r.isLong);
  const liquidationMove = liq === null ? 0 : liq === 0n ? null : frac(r.isLong ? r.entry - liq : liq - r.entry, r.entry);
  const multiple = r.maxProfitMultiple ?? 10n;
  const capPx = profitCapPrice(r.entry, r.margin, r.size, r.isLong, multiple);
  let lossAtStop: bigint | null = null;
  let stopPastLiquidation = false;
  if (r.stopLoss) {
    const move = r.isLong ? r.stopLoss - r.entry : r.entry - r.stopLoss;
    lossAtStop = (r.size * move) / r.entry;
    if (liq !== null && liq !== 0n) stopPastLiquidation = r.isLong ? r.stopLoss <= liq : r.stopLoss >= liq;
  }
  const grossMax = r.margin * multiple;
  const share = r.profitShareBps ?? BigInt(DEFAULT_PROFIT_SHARE_BPS);
  const discount = r.referralDiscountBps ?? BigInt(DEFAULT_REFERRAL_DISCOUNT_BPS);
  const shareAtCap = upside ? settle({ pnl: grossMax, margin: r.margin, feeModel: "upside", profitShareBps: share, multiple, referred: r.referred, referralDiscountBps: discount }).fee : 0n;
  return {
    leverage: Number((r.size * 100n) / r.margin) / 100,
    keeperOrdersOnly: needsKeeperOrders(r.size, r.margin, r.feeModel),
    liquidationPrice: liq,
    liquidationMove,
    level: riskLevel(liquidationMove),
    maxLoss: r.margin + openFee + closeFee + (r.executionFees ?? 0n),
    lossAtStop,
    stopPastLiquidation,
    maxProfit: grossMax - shareAtCap,
    profitCapMove: capPx === null ? null : frac(r.isLong ? capPx - r.entry : r.entry - capPx, r.entry),
    feeModel: upside ? "upside" : "standard",
    profitShareBps: upside ? Number(r.referred ? share - (share * discount) / BPS : share) : 0,
    shareAtCap,
  };
}

// ── Settlement (v3.2): the close fee, or the Upside share of a win, and the referral split ──

/** `fee` less the referral discount (PerpEngineBase._discounted, for a trader who has a referrer). */
export function discounted(fee: bigint, referralDiscountBps: bigint = BigInt(DEFAULT_REFERRAL_DISCOUNT_BPS)): bigint {
  return fee === 0n ? 0n : fee - (fee * referralDiscountBps) / BPS;
}

export interface SettleInput {
  /** Price PnL after funding (negative: a loss), before the profit cap. */
  pnl: bigint;
  margin: bigint;
  feeModel?: FeeModel;
  /** Standard markets: the close fee before any discount; defaults to the cap. */
  closeFee?: bigint;
  /** Upside markets: the engine's `profitShareBps`. */
  profitShareBps?: bigint;
  multiple?: bigint;
  referred?: boolean;
  referralDiscountBps?: bigint;
  referralShareBps?: bigint;
}

export interface Settlement {
  /** PnL after the profit cap: a loss is at most the margin. */
  pnl: bigint;
  /** The close fee, or in an Upside market the share of the profit the house kept (0 on a loss). */
  fee: bigint;
  /** What the trader gets back: margin plus profit less the fee, or what is left of the margin less the fee. */
  payout: bigint;
  /** The referrer's part of the fee (credited to their claimable balance on the engine). */
  toReferrer: bigint;
}

/**
 * How the engine settles a close (PerpEngineBase._settle): profit capped at `multiple` x margin; a Standard market
 * takes its close fee out of what is left of the margin; an Upside market charges nothing on a loss and keeps
 * `profitShareBps` of a profit (rounded up). With a referrer the fee is `referralDiscountBps` lower and
 * `referralShareBps` of it goes to the referrer.
 */
export function settle(s: SettleInput): Settlement {
  const multiple = s.multiple ?? 10n;
  const cap = s.margin * multiple;
  const pnl = s.pnl > cap ? cap : s.pnl;
  const disc = (fee: bigint) => (s.referred ? discounted(fee, s.referralDiscountBps) : fee);
  const toReferrer = (fee: bigint) => (s.referred && fee !== 0n ? (fee * (s.referralShareBps ?? BigInt(DEFAULT_REFERRAL_SHARE_BPS))) / BPS : 0n);
  if (s.feeModel === "upside") {
    if (pnl < 0n) return { pnl, fee: 0n, payout: s.margin - min(-pnl, s.margin), toReferrer: 0n };
    const fee = disc(ceilDiv(pnl * (s.profitShareBps ?? BigInt(DEFAULT_PROFIT_SHARE_BPS)), BPS));
    return { pnl, fee, payout: s.margin + pnl - fee, toReferrer: toReferrer(fee) };
  }
  const base = disc(s.closeFee ?? feeCap(s.margin));
  if (pnl >= 0n) {
    const fee = min(base, s.margin);
    return { pnl, fee, payout: s.margin - fee + pnl, toReferrer: toReferrer(fee) };
  }
  const remaining = s.margin - min(-pnl, s.margin);
  const fee = min(base, remaining);
  return { pnl, fee, payout: remaining - fee, toReferrer: toReferrer(fee) };
}

/** PnL from the price move alone, rounded against the trader like PositionMath.pricePnl. */
export function pricePnl(size: bigint, entry: bigint, price: bigint, isLong: boolean): bigint {
  const gain = isLong ? price >= entry : price <= entry;
  const diff = price > entry ? price - entry : entry - price;
  return gain ? (size * diff) / entry : -ceilDiv(size * diff, entry);
}

// ── DRY rebates on net results (v3.2) ──

/** What one close of a position of `size` reports to the DRY rebate for a win or a loss of `amount`. */
export function rebateBase(size: bigint, amount: bigint): bigint {
  return min(amount, (size * BigInt(REBATE_NOTIONAL_BPS)) / BPS);
}

/**
 * DRY (18 decimals) that `loss` (USDC, 6 decimals) of new net loss mints once `totalRebatedLoss` has been rebated:
 * RewardToken.rebateFor, the rate at the loss's midpoint on the curve 100 x H / (H + x) DRY per USDC.
 */
export function rebateFor(loss: bigint, totalRebatedLoss = 0n): bigint {
  return (loss * INITIAL_REBATE_RATE * 10n ** 12n * HALVING_LOSS) / (HALVING_LOSS + totalRebatedLoss + loss / 2n);
}

/** DRY (18 decimals) per whole USDC of new net loss right now (RewardToken.rebateRate). */
export function rebateRate(totalRebatedLoss = 0n): bigint {
  return (INITIAL_REBATE_RATE * 10n ** 18n * HALVING_LOSS) / (HALVING_LOSS + totalRebatedLoss);
}

/**
 * One close's effect on a trader's rebate ledger (RewardToken.recordResult): the running result moves by `result`
 * (USDC, negative for a loss, already capped with `rebateBase`), and DRY is minted only for how far it falls
 * below its previous low, so a win must be lost back before losses earn rebates again.
 */
export function recordResult(ledger: { net: bigint; low: bigint }, result: bigint, totalRebatedLoss = 0n): { net: bigint; low: bigint; newLoss: bigint; minted: bigint } {
  const net = ledger.net + result;
  if (net >= ledger.low) return { net, low: ledger.low, newLoss: 0n, minted: 0n };
  const newLoss = ledger.low - net;
  return { net, low: net, newLoss, minted: rebateFor(newLoss, totalRebatedLoss) };
}

// ── Taking margin out (v3.2) ──

export interface RemovableInput {
  size: bigint;
  margin: bigint;
  entry: bigint;
  isLong: boolean;
  /** The bid for a long, the ask for a short (the price a close would get). */
  exitPrice: bigint;
  /** Funding the position owes (positive) or is owed (negative). */
  fundingOwed?: bigint;
  /** The market's max leverage; above 100x only keeper orders, so margin removal stops at 100x. */
  marketMaxLeverage: number;
  minMargin?: bigint;
  /** Through an agent account, as an agent: its policy's leverage cap also applies. */
  agentMaxLeverage?: number;
}

/**
 * The most margin `removeMargin` takes out of a position now (PerpEngineExt.removeMargin): what stays holds the
 * minimum margin, keeps leverage within the market's limit and 100x, and covers any loss at the exit price plus
 * the initial margin at that leverage. Unrealised profit never counts. 0n when nothing can come out.
 */
export function removableMargin(p: RemovableInput): bigint {
  const lev = BigInt(Math.min(p.marketMaxLeverage, DIRECT_MAX_LEVERAGE));
  if (lev <= 0n || p.agentMaxLeverage === 0) return 0n;
  const pnl = pricePnl(p.size, p.entry, p.exitPrice, p.isLong) - (p.fundingOwed ?? 0n);
  const loss = pnl < 0n ? -pnl : 0n;
  const floors = [p.minMargin ?? 5_000_000n, loss + ceilDiv(p.size, lev)];
  // AgentAccount.removeMargin: what stays must keep the position within the agent's own leverage cap.
  if (p.agentMaxLeverage !== undefined) floors.push(ceilDiv(p.size, BigInt(p.agentMaxLeverage)));
  const keep = floors.reduce((a, b) => (a > b ? a : b));
  return keep >= p.margin ? 0n : p.margin - keep;
}

/** PerpEngine's unit scale (`size * 1e36 / entry`): the merged entry price is computed from it. */
const UNIT_PRECISION = 10n ** 36n;

export interface MergeInput {
  /** The open position. */
  position: { size: bigint; margin: bigint; entry: bigint; isLong: boolean };
  /** What the order adds, filled at `price`. */
  add: { size: bigint; margin: bigint; price: bigint };
}

/**
 * The position after an addition, as the engine computes it (v3.1): size and margin add up; the entry is
 * size over units, rounded against the trader (up for a long, down for a short), so the position's PnL at any
 * price is what the two parts would have made separately (less rounding).
 */
export function mergedPosition(m: MergeInput): { size: bigint; margin: bigint; entry: bigint; leverage: number; liquidationPrice: bigint | null } {
  const { position: p, add } = m;
  const units = (p.size * UNIT_PRECISION) / p.entry + (add.size * UNIT_PRECISION) / add.price;
  const size = p.size + add.size;
  const margin = p.margin + add.margin;
  const entry = p.isLong ? ceilDiv(size * UNIT_PRECISION, units) : (size * UNIT_PRECISION) / units;
  return { size, margin, entry, leverage: Number((size * 100n) / margin) / 100, liquidationPrice: liquidationPrice(entry, margin, size, p.isLong) };
}

/**
 * A partial close as the engine settles it (v3.1): margin released in proportion (rounded down) and the part's
 * own profit cap; when what would remain is under `minMargin`, the whole position closes instead.
 */
export function partialClose(position: { size: bigint; margin: bigint }, closeSize: bigint, minMargin = 5_000_000n): { whole: boolean; releasedMargin: bigint; remaining: { size: bigint; margin: bigint } } {
  if (closeSize === 0n || closeSize >= position.size) return { whole: true, releasedMargin: position.margin, remaining: { size: 0n, margin: 0n } };
  const releasedMargin = (position.margin * closeSize) / position.size;
  if (position.margin - releasedMargin < minMargin) return { whole: true, releasedMargin: position.margin, remaining: { size: 0n, margin: 0n } };
  return { whole: false, releasedMargin, remaining: { size: position.size - closeSize, margin: position.margin - releasedMargin } };
}

/** Prices for a ladder of `count` orders evenly spaced from `from` to `to` (both included). */
export function ladderPrices(from: bigint, to: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  if (count === 1) return [from];
  const step = (to - from) / BigInt(count - 1);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? to : from + step * BigInt(i)));
}
