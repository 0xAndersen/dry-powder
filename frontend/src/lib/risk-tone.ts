/** The app's risk bands, by the price move that liquidates a position (also in BRAND.md and the SDK). */
export type RiskTone = "calm" | "moderate" | "high" | "extreme";

export function riskTone(liquidationDistance: number | null): RiskTone | null {
  if (liquidationDistance === null) return null;
  if (liquidationDistance >= 0.1) return "calm";
  if (liquidationDistance >= 0.03) return "moderate";
  if (liquidationDistance >= 0.01) return "high";
  return "extreme";
}

/** Text colour for a liquidation figure: neutral while far, then warn, hot and short as it gets close. */
export const RISK_TEXT: Record<RiskTone, string> = { calm: "text-text", moderate: "text-warn", high: "text-hot", extreme: "text-short" };
export const RISK_COLOR: Record<RiskTone, string> = { calm: "var(--color-long)", moderate: "var(--color-warn)", high: "var(--color-hot)", extreme: "var(--color-short)" };
