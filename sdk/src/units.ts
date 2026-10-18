// Conversions between human numbers and the engine's fixed-point units.

const E9 = 10n ** 9n;

/** 12.5 -> 12_500_000n (USDC, 6 decimals). */
export const usd = (x: number | string): bigint => BigInt(Math.round(Number(x) * 1e6));
/** 12_500_000n -> 12.5 */
export const fromUsd = (x: bigint): number => Number(x) / 1e6;
/** 100000.5 -> 100000.5e18 (prices, 18 decimals; 9 significant decimals kept). */
export const price = (x: number | string): bigint => BigInt(Math.round(Number(x) * 1e9)) * E9;
/** 18-decimal price -> number */
export const fromPrice = (x: bigint): number => Number(x / E9) / 1e9;
/** 0.0009 -> "0.09%" */
export const pct = (x: number | null, dp = 2): string => (x === null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
