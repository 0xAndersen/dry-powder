"use client";

import { useReadContracts } from "wagmi";
import { keepPreviousData } from "@tanstack/react-query";
import { useAppConfig } from "@/components/providers";
import { perpEngineAbi } from "@/lib/abi";
import { fmtCompact, USDC_DECIMALS } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";

const SIZES = [1_000n, 10_000n, 100_000n, 1_000_000n].map((n) => n * 1_000_000n);

/**
 * The vault's "depth": there is no order book, so what changes with size is the open fee, which rises when a trade
 * makes the market more one-sided (the skew surcharge). Fees in basis points of size, for each side, from the
 * engine's own quote at the current skew (margin taken equal to size, so the per-trade fee cap does not hide it).
 */
export function CostBySize({ instrument, enabled }: { instrument: Instrument; enabled: boolean }) {
  const cfg = useAppConfig();
  const room = (isLong: boolean) => {
    const used = isLong ? instrument.longOi : instrument.shortOi;
    return instrument.maxOiPerSide > used ? instrument.maxOiPerSide - used : 0n;
  };
  const rows = SIZES.filter((s) => s <= instrument.maxOiPerSide);
  const reads = useReadContracts({
    allowFailure: true,
    contracts: rows.flatMap((size) =>
      [true, false].map((isLong) => ({ abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId, functionName: "quoteOpenFee", args: [instrument.id, size, isLong, size] }) as const),
    ),
    query: { enabled: enabled && rows.length > 0, refetchInterval: 10_000, placeholderData: keepPreviousData },
  });
  if (!enabled || rows.length === 0) return null;
  const bps = (i: number, size: bigint) => {
    const r = reads.data?.[i];
    if (r?.status !== "success") return "—";
    return `${(Number((r.result as bigint) * 1_000_000n / size) / 100).toFixed(2)} bp`;
  };
  return (
    <div className="mt-3" data-testid="cost-by-size">
      <p className="flex items-baseline justify-between text-xs text-muted">
        <span>Open fee by size</span>
        <span className="text-2xs text-faint">bp of size, now</span>
      </p>
      <table className="num mt-1 w-full text-xs">
        <thead>
          <tr className="text-2xs text-faint">
            <th className="py-0.5 text-left font-normal">Size</th>
            <th className="py-0.5 text-right font-normal">Long</th>
            <th className="py-0.5 text-right font-normal">Short</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((size, i) => (
            <tr key={String(size)}>
              <td className="py-0.5">{fmtCompact(size, USDC_DECIMALS)}</td>
              <td className={`py-0.5 text-right ${size > room(true) ? "text-faint line-through" : ""}`} title={size > room(true) ? "More than the long open interest left" : undefined}>
                {bps(i * 2, size)}
              </td>
              <td className={`py-0.5 text-right ${size > room(false) ? "text-faint line-through" : ""}`} title={size > room(false) ? "More than the short open interest left" : undefined}>
                {bps(i * 2 + 1, size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-2xs text-faint">No order book: every size fills at the oracle price. The fee rises with size only on the side that makes the market more one-sided.</p>
    </div>
  );
}
