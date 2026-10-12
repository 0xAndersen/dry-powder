"use client";

import { useId, useMemo, useState } from "react";
import { useConfig, useConnect, useReadContract, useSwitchChain } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import {
  useUsdcAllowance,
  useUsdcBalance,
  type EngineParams,
  type MarketState,
  type PositionView,
} from "@/hooks/use-engine";
import { usePriceState } from "@/hooks/use-prices";
import { MAX_SLIPPAGE_BPS, useSlippage } from "@/hooks/use-slippage";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { perpEngineAbi } from "@/lib/abi";
import { ensureAllowance, freshOracleUpdate } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { PRICE_DECIMALS, USDC_DECIMALS, fmtAge, fmtPrice, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import type { MarketInfo } from "@/lib/markets";
import { BPS, estimateLiquidationPrice, maxOpenFee, withSlippageDown, withSlippageUp } from "@/lib/math";

type OrderKind = "market" | "limit";

/** Kept back when "Max" is used, so gas and the oracle fee (both paid in USDC on Arc) stay covered. */
const GAS_RESERVE = 100_000n;
const SLIPPAGE_PRESETS = [10, 30, 100] as const;

function SummaryRow({ label, value, hint, strong }: { label: string; value: React.ReactNode; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className={strong ? "text-text" : "text-muted"}>{label}</dt>
      <dd className={`num text-right ${strong ? "font-semibold text-text" : "text-text"}`}>{value}</dd>
    </div>
  );
}

export function OrderPanel({
  market,
  marketState,
  params,
  paramsError,
  positions,
}: {
  market: MarketInfo;
  marketState: MarketState | undefined;
  params: EngineParams | undefined;
  paramsError: boolean;
  positions: readonly PositionView[] | undefined;
}) {
  const { config: cfg, chain, prices } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const tx = useTx();
  const ids = useId();

  const [kind, setKind] = useState<OrderKind>("market");
  const [isLong, setIsLong] = useState(true);
  const [marginText, setMarginText] = useState("");
  const [leverageText, setLeverageText] = useState("5");
  const [limitText, setLimitText] = useState("");
  const [tpText, setTpText] = useState("");
  const [slText, setSlText] = useState("");
  const [slippageBps, setSlippageBps] = useSlippage();
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [slippageText, setSlippageText] = useState<string | null>(null);

  const { tick, age, stale } = usePriceState(market.id);
  const balance = useUsdcBalance(wallet.ready ? wallet.address : undefined);
  const allowance = useUsdcAllowance(wallet.ready ? wallet.address : undefined, cfg.perpEngine);

  const maxLeverage = marketState?.listed ? marketState.maxLeverage : undefined;
  const sideWord = isLong ? "long" : "short";

  // ── Parsed inputs ──
  const margin = parseAmount(marginText, USDC_DECIMALS);
  const leverageTenths = (() => {
    const parsed = parseAmount(leverageText, 1);
    return parsed === null ? null : Number(parsed);
  })();
  const size = margin !== null && leverageTenths !== null ? (margin * BigInt(leverageTenths)) / 10n : null;
  const limitPrice = parseAmount(limitText, PRICE_DECIMALS);
  const takeProfit = tpText.trim() === "" ? 0n : parseAmount(tpText, PRICE_DECIMALS);
  const stopLoss = slText.trim() === "" ? 0n : parseAmount(slText, PRICE_DECIMALS);
  const brackets = (takeProfit ? 1 : 0) + (stopLoss ? 1 : 0);

  // ── Quotes ──
  const feeQuote = useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "quoteOpenFee",
    args: [market.id, size ?? 0n, isLong],
    query: { enabled: kind === "market" && size !== null && size > 0n && marketState?.listed === true },
  });

  const referencePrice = kind === "market" ? (tick ? (isLong ? tick.ask : tick.bid) : null) : limitPrice;
  const feeCeiling = params && size !== null ? maxOpenFee(size, params.baseFeeBps, params.maxSkewFeeBps) : null;
  const openFee = kind === "market" ? (size !== null && size > 0n ? (feeQuote.data ?? null) : null) : feeCeiling;
  const executionCount = brackets + (kind === "limit" ? 1 : 0);
  const executionFees = params ? params.executionFee * BigInt(executionCount) : null;
  const total = margin !== null && openFee !== null && executionFees !== null ? margin + openFee + executionFees : null;
  // The live fee can rise with skew between quote and execution, so the approval covers the ceiling.
  const approvalAmount =
    margin !== null && feeCeiling !== null && executionFees !== null ? margin + feeCeiling + executionFees : null;
  const liquidationEstimate =
    referencePrice && margin !== null && size !== null && size > 0n
      ? estimateLiquidationPrice(referencePrice, margin, size, isLong)
      : null;
  const needsApproval = approvalAmount !== null && allowance.data !== undefined && allowance.data < approvalAmount;

  const existingPosition = useMemo(
    () => positions?.find((p) => p.position.priceId.toLowerCase() === market.id),
    [positions, market.id],
  );

  // ── Validation: field-level messages plus the first blocking problem for the button ──
  const marginError =
    marginText.trim() === ""
      ? null
      : margin === null
        ? "Enter a number, for example 25.50"
        : params && margin < params.minMargin
          ? `Minimum margin is ${fmtUsdc(params.minMargin)} USDC`
          : null;

  const leverageError =
    leverageTenths === null
      ? "Enter leverage as a number"
      : leverageTenths < 10
        ? "Leverage starts at 1×"
        : maxLeverage !== undefined && leverageTenths > maxLeverage * 10
          ? `${market.symbol} allows up to ${maxLeverage}×`
          : null;

  const limitError =
    kind !== "limit" || limitText.trim() === ""
      ? null
      : limitPrice === null || limitPrice === 0n
        ? "Enter a price greater than zero"
        : null;

  const refLabel = kind === "market" ? `the current ${isLong ? "ask" : "bid"}` : "your limit price";
  const tpError =
    tpText.trim() === ""
      ? null
      : takeProfit === null || takeProfit === 0n
        ? "Enter a price greater than zero"
        : referencePrice && (isLong ? takeProfit <= referencePrice : takeProfit >= referencePrice)
          ? `Take-profit for a ${sideWord} must be ${isLong ? "above" : "below"} ${refLabel}`
          : null;
  const slError =
    slText.trim() === ""
      ? null
      : stopLoss === null || stopLoss === 0n
        ? "Enter a price greater than zero"
        : referencePrice && (isLong ? stopLoss >= referencePrice : stopLoss <= referencePrice)
          ? `Stop-loss for a ${sideWord} must be ${isLong ? "below" : "above"} ${refLabel}`
          : null;
  const slBeyondLiquidation =
    !slError && stopLoss && liquidationEstimate !== null && liquidationEstimate > 0n
      ? isLong
        ? stopLoss <= liquidationEstimate
        : stopLoss >= liquidationEstimate
      : false;

  const capProblem = (() => {
    if (!marketState || !params || size === null) return null;
    const sideOi = isLong ? marketState.longOi : marketState.shortOi;
    if (sideOi + size > marketState.maxOiPerSide) {
      const room = marketState.maxOiPerSide > sideOi ? marketState.maxOiPerSide - sideOi : 0n;
      return `Only ${fmtUsdc(room)} USDC of ${sideWord} open interest is left in this market`;
    }
    if ((params.totalOpenInterest + size) * BPS > params.vaultNav * params.maxOiToNavBps) {
      const cap = (params.vaultNav * params.maxOiToNavBps) / BPS;
      const room = cap > params.totalOpenInterest ? cap - params.totalOpenInterest : 0n;
      return `The house vault can back only ${fmtUsdc(room)} USDC more open interest`;
    }
    return null;
  })();

  const blocking: string | null = (() => {
    if (paramsError) return "Could not read the engine. Check the RPC";
    if (!params || !marketState) return "Loading market";
    if (!marketState.listed) return `${market.symbol} is not listed on this deployment`;
    if (params.paused) return "Trading is paused";
    if (!marketState.enabled) return `${market.symbol} is closed to new positions`;
    if (kind === "market" && !tick) return "Waiting for a price";
    if (kind === "market" && stale) return "Market closed: price is stale";
    if (marginText.trim() === "") return "Enter margin";
    if (marginError) return marginError;
    if (leverageError) return leverageError;
    if (kind === "limit" && limitText.trim() === "") return "Enter a limit price";
    if (limitError) return limitError;
    if (tpError) return tpError;
    if (slError) return slError;
    if (kind === "market" && existingPosition) return `You already have a ${market.symbol} position`;
    if (capProblem) return capProblem;
    if (kind === "market" && openFee === null) return feeQuote.isError ? "Could not quote the open fee" : "Calculating fee";
    if (total !== null && balance.data !== undefined && total > balance.data) {
      return `Not enough USDC: ${fmtUsdc(total)} needed`;
    }
    if (balance.data === undefined) return "Loading balance";
    return null;
  })();

  const limitFillsNow =
    kind === "limit" && tick && !stale && limitPrice ? (isLong ? tick.ask <= limitPrice : tick.bid >= limitPrice) : false;

  // ── Actions ──
  const setMax = () => {
    if (balance.data === undefined || !params || leverageTenths === null) return;
    const spendable = balance.data > GAS_RESERVE + (executionFees ?? 0n) ? balance.data - GAS_RESERVE - (executionFees ?? 0n) : 0n;
    // margin + margin × leverage × feeBps / 1e4 ≤ spendable
    const feeBps = params.baseFeeBps + params.maxSkewFeeBps;
    const denominator = 10n * BPS + BigInt(leverageTenths) * feeBps;
    const maxMargin = (spendable * 10n * BPS) / denominator;
    setMarginText(toInputString(maxMargin > 2n ? maxMargin - 2n : 0n, USDC_DECIMALS, 2));
  };

  const submit = async () => {
    const account = wallet.address;
    if (blocking || !account || !params || margin === null || size === null || approvalAmount === null) return;
    if (takeProfit === null || stopLoss === null) return;
    const seen = tick;
    const title = `${kind === "market" ? "Open" : "Place limit"} ${sideWord} ${market.symbol}`;

    const ok = await tx.run(async (api) => {
      await ensureAllowance(wagmiConfig, cfg, api, {
        token: cfg.usdc,
        owner: account,
        spender: cfg.perpEngine,
        amount: approvalAmount,
        symbol: "USDC",
      });

      if (kind === "limit") {
        if (!limitPrice) throw new UserFacingError("Enter a limit price.");
        await api.send(title, async () => {
          const { request } = await simulateContract(wagmiConfig, {
            abi: perpEngineAbi,
            address: cfg.perpEngine,
            functionName: "createLimitOrder",
            args: [{ priceId: market.id, isLong, margin, size, triggerPrice: limitPrice, takeProfit, stopLoss }],
            account,
            chainId: cfg.chainId,
          });
          return writeContract(wagmiConfig, request);
        });
        return `Limit ${sideWord} placed. A keeper fills it when the price is reached.`;
      }

      if (!seen) throw new UserFacingError("No price available yet.");
      // Slippage is measured from the price shown when the button was pressed.
      const acceptablePrice = isLong
        ? withSlippageUp(seen.ask, BigInt(slippageBps))
        : withSlippageDown(seen.bid, BigInt(slippageBps));

      // The engine accepts prices at most `maxPriceAge` seconds old, so the update is fetched last.
      api.preparing(`Fetching the latest ${market.symbol} price`);
      const oracle = await freshOracleUpdate(wagmiConfig, cfg, prices, market, Number(params.maxPriceAge));
      await api.send(title, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          abi: perpEngineAbi,
          address: cfg.perpEngine,
          functionName: "openPosition",
          args: [{ priceId: market.id, isLong, margin, size, acceptablePrice, takeProfit, stopLoss }, oracle.updateData],
          value: oracle.fee,
          account,
          chainId: cfg.chainId,
        });
        return writeContract(wagmiConfig, request);
      });
      return `${isLong ? "Long" : "Short"} ${market.symbol} opened.`;
    });
    if (ok) {
      setTpText("");
      setSlText("");
      if (kind === "limit") setLimitText("");
    }
  };

  // ── Primary button ──
  let button: React.ReactNode;
  if (!wallet.connected) {
    const connector = connectors[0];
    button = (
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={connecting || !connector}
        onClick={() => connector && connect({ connector, chainId: chain.id })}
      >
        {connecting ? "Connecting" : "Connect wallet to trade"}
      </button>
    );
  } else if (wallet.wrongNetwork) {
    button = (
      <button type="button" className="btn btn-lg border-warn text-warn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  } else {
    const action = kind === "market" ? `Open ${sideWord}` : `Place limit ${sideWord}`;
    const label = tx.busy ? "Working" : (blocking ?? (needsApproval ? `Approve USDC and ${action.toLowerCase()}` : action));
    button = (
      <button
        type="button"
        className={`btn btn-lg ${blocking ? "" : isLong ? "btn-long" : "btn-short"}`}
        disabled={blocking !== null || tx.busy}
        onClick={() => void submit()}
      >
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        <span className="truncate">{label}</span>
      </button>
    );
  }

  const sliderMax = maxLeverage ?? 1;
  const sliderValue = Math.min(sliderMax, Math.max(1, leverageTenths === null ? 1 : leverageTenths / 10));
  const sliderFill = sliderMax > 1 ? ((sliderValue - 1) / (sliderMax - 1)) * 100 : 0;
  const pd = market.priceDecimals;
  const pricePlaceholder = tick ? toInputString(tick.mid, PRICE_DECIMALS, pd) : "0";

  return (
    <section className="panel" aria-label="Place order">
      <div role="tablist" aria-label="Order type" className="tabs">
        {(["market", "limit"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className="tab" onClick={() => setKind(k)}>
            {k === "market" ? "Market" : "Limit"}
          </button>
        ))}
        <div className="ml-auto flex items-center pr-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={slippageOpen}
            aria-controls={`${ids}-slippage`}
            onClick={() => setSlippageOpen((v) => !v)}
          >
            Slippage <span className="num text-text">{(slippageBps / 100).toFixed(2)}%</span>
          </button>
        </div>
      </div>

      <form
        className="flex flex-col gap-4 p-3 sm:p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        {slippageOpen ? (
          <div id={`${ids}-slippage`} className="notice">
            <p className="text-text">Slippage limit for market orders and closes</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  className="chip"
                  aria-pressed={slippageBps === bps && slippageText === null}
                  onClick={() => {
                    setSlippageBps(bps);
                    setSlippageText(null);
                  }}
                >
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
              <label className="field ml-auto h-8 w-24">
                <span className="sr-only">Custom slippage in percent</span>
                <input
                  inputMode="decimal"
                  value={slippageText ?? (slippageBps / 100).toString()}
                  onChange={(event) => {
                    const text = event.target.value;
                    setSlippageText(text);
                    const parsed = parseAmount(text, 2);
                    if (parsed !== null && parsed <= BigInt(MAX_SLIPPAGE_BPS)) setSlippageBps(Number(parsed));
                  }}
                />
                <span className="field-unit">%</span>
              </label>
            </div>
            {slippageText !== null &&
            (parseAmount(slippageText, 2) === null || parseAmount(slippageText, 2)! > BigInt(MAX_SLIPPAGE_BPS)) ? (
              <p className="mt-1.5 text-xs text-short">Enter a percentage between 0 and {MAX_SLIPPAGE_BPS / 100}.</p>
            ) : (
              <p className="mt-1.5 text-xs">
                The order reverts if the fill is worse than the price you saw by more than this. Limit orders fill at
                your price or better.
              </p>
            )}
          </div>
        ) : null}

        <div role="group" aria-label="Direction" className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={isLong}
            onClick={() => setIsLong(true)}
            className={`btn h-10 ${isLong ? "border-long bg-long/15 text-long" : "text-muted"}`}
          >
            Long
          </button>
          <button
            type="button"
            aria-pressed={!isLong}
            onClick={() => setIsLong(false)}
            className={`btn h-10 ${!isLong ? "border-short bg-short/15 text-short" : "text-muted"}`}
          >
            Short
          </button>
        </div>

        {kind === "limit" ? (
          <div>
            <label className="field-label" htmlFor={`${ids}-limit`}>
              Limit price
            </label>
            <div className="field" data-invalid={limitError !== null}>
              <input
                id={`${ids}-limit`}
                inputMode="decimal"
                autoComplete="off"
                placeholder={pricePlaceholder}
                value={limitText}
                onChange={(event) => setLimitText(event.target.value)}
                aria-invalid={limitError !== null}
                aria-describedby={`${ids}-limit-help`}
              />
              <button
                type="button"
                className="chip"
                disabled={!tick}
                onClick={() => tick && setLimitText(toInputString(tick.mid, PRICE_DECIMALS, pd))}
              >
                Mark
              </button>
            </div>
            <p id={`${ids}-limit-help`} className={`mt-1 text-xs ${limitError ? "text-short" : limitFillsNow ? "text-warn" : "text-faint"}`}>
              {limitError ??
                (limitFillsNow
                  ? "The market is already at this price: the order fills as soon as a keeper sees it."
                  : isLong
                    ? "Fills when the ask falls to this price or lower."
                    : "Fills when the bid rises to this price or higher.")}
            </p>
          </div>
        ) : null}

        <div>
          <div className="flex items-baseline justify-between">
            <label className="field-label" htmlFor={`${ids}-margin`}>
              Margin
            </label>
            <span className="num text-xs text-muted">
              {wallet.ready ? (balance.data !== undefined ? `Balance ${fmtUsdc(balance.data)} USDC` : "Balance …") : ""}
            </span>
          </div>
          <div className="field" data-invalid={marginError !== null}>
            <input
              id={`${ids}-margin`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={marginText}
              onChange={(event) => setMarginText(event.target.value)}
              aria-invalid={marginError !== null}
              aria-describedby={marginError ? `${ids}-margin-error` : undefined}
            />
            <span className="field-unit">USDC</span>
            <button type="button" className="chip" disabled={!wallet.ready || balance.data === undefined || !params} onClick={setMax}>
              Max
            </button>
          </div>
          {marginError ? (
            <p id={`${ids}-margin-error`} className="mt-1 text-xs text-short">
              {marginError}
            </p>
          ) : null}
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <label className="field-label mb-0" htmlFor={`${ids}-leverage`}>
              Leverage
            </label>
            <div className="field h-8 w-24" data-invalid={leverageError !== null}>
              <input
                id={`${ids}-leverage`}
                inputMode="decimal"
                autoComplete="off"
                value={leverageText}
                onChange={(event) => setLeverageText(event.target.value)}
                aria-invalid={leverageError !== null}
                aria-describedby={leverageError ? `${ids}-leverage-error` : undefined}
              />
              <span className="field-unit">{"×"}</span>
            </div>
          </div>
          <input
            type="range"
            className="slider mt-1.5"
            min={1}
            max={sliderMax}
            step={1}
            value={Math.round(sliderValue)}
            disabled={maxLeverage === undefined}
            onChange={(event) => setLeverageText(event.target.value)}
            aria-label="Leverage slider"
            aria-valuetext={`${sliderValue} times`}
            style={{ ["--fill" as string]: `${sliderFill}%` }}
          />
          <div className="num flex justify-between text-2xs text-faint">
            <span>1{"×"}</span>
            <span>{maxLeverage !== undefined ? `${maxLeverage}× max` : ""}</span>
          </div>
          {leverageError ? (
            <p id={`${ids}-leverage-error`} className="mt-1 text-xs text-short">
              {leverageError}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="field-label" htmlFor={`${ids}-tp`}>
              Take-profit <span className="text-faint">(optional)</span>
            </label>
            <div className="field" data-invalid={tpError !== null}>
              <input
                id={`${ids}-tp`}
                inputMode="decimal"
                autoComplete="off"
                placeholder="Price"
                value={tpText}
                onChange={(event) => setTpText(event.target.value)}
                aria-invalid={tpError !== null}
                aria-describedby={tpError ? `${ids}-bracket-error` : undefined}
              />
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor={`${ids}-sl`}>
              Stop-loss <span className="text-faint">(optional)</span>
            </label>
            <div className="field" data-invalid={slError !== null}>
              <input
                id={`${ids}-sl`}
                inputMode="decimal"
                autoComplete="off"
                placeholder="Price"
                value={slText}
                onChange={(event) => setSlText(event.target.value)}
                aria-invalid={slError !== null}
                aria-describedby={slError ? `${ids}-bracket-error` : undefined}
              />
            </div>
          </div>
          {tpError || slError ? (
            <p id={`${ids}-bracket-error`} className="col-span-2 text-xs text-short">
              {tpError ?? slError}
            </p>
          ) : slBeyondLiquidation ? (
            <p className="col-span-2 text-xs text-warn">
              This stop-loss sits beyond the estimated liquidation price, so liquidation would come first.
            </p>
          ) : null}
        </div>

        <dl className="grid gap-1.5 border-t border-line pt-3 text-[0.8125rem]">
          <SummaryRow label="Position size" value={size !== null && size > 0n ? `${fmtUsdc(size)} USDC` : "—"} />
          <SummaryRow
            label={kind === "market" ? `Est. entry (${isLong ? "ask" : "bid"})` : "Entry (limit price or better)"}
            hint="Buys fill at the top of Pyth's confidence band, sells at the bottom."
            value={referencePrice ? fmtPrice(referencePrice, pd) : "—"}
          />
          <SummaryRow
            label="Est. liquidation price"
            hint="Where the loss reaches 90% of margin, before funding."
            value={
              liquidationEstimate === null ? "—" : liquidationEstimate === 0n ? "None" : fmtPrice(liquidationEstimate, pd)
            }
          />
          <SummaryRow
            label={kind === "market" ? "Open fee" : "Open fee (maximum, rest refunded)"}
            hint="Base fee plus a surcharge when the trade adds to the market's skew."
            value={openFee !== null ? `${fmtUsdc(openFee, 4)} USDC` : size !== null && size > 0n && kind === "market" && !feeQuote.isError ? "…" : "—"}
          />
          <SummaryRow
            label={`Keeper fees (${executionCount})`}
            hint="One flat fee per order a keeper executes for you: the limit order itself and each take-profit or stop-loss."
            value={executionFees !== null ? `${fmtUsdc(executionFees)} USDC` : "—"}
          />
          <SummaryRow label="Total required" strong value={total !== null ? `${fmtUsdc(total, 4)} USDC` : "—"} />
        </dl>

        {kind === "market" && stale && age !== undefined ? (
          <p className="notice" data-tone="warn">
            {market.symbol} is closed: the last Pyth price is {fmtAge(age)} old and the engine rejects prices older than{" "}
            {params ? Number(params.maxPriceAge) : 3} seconds. You can still place a limit order.
          </p>
        ) : null}
        {kind === "limit" && existingPosition ? (
          <p className="notice" data-tone="warn">
            You already hold a {market.symbol} position. This order can only fill after that position is closed.
          </p>
        ) : null}

        {button}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>
    </section>
  );
}
