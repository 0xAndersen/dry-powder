import { ColorType, CrosshairMode, type ChartOptions, type DeepPartial } from "lightweight-charts";
import { safeLocale } from "@/lib/format";

/** The trade chart's palette (components/trade/price-chart.tsx), shared by the chart wall and the history panels. */
export const CHART_COLORS = {
  text: "#a0a9b6",
  grid: "#1a1e24",
  border: "#262b33",
  long: "#3ecf8e",
  short: "#f0646f",
  accent: "#7ea6ff",
  muted: "#6b7482",
  longFill: "rgba(62, 207, 142, 0.16)",
  shortFill: "rgba(240, 100, 111, 0.16)",
  longBar: "rgba(62, 207, 142, 0.7)",
  shortBar: "rgba(240, 100, 111, 0.7)",
  volUp: "rgba(62, 207, 142, 0.28)",
  volDown: "rgba(240, 100, 111, 0.28)",
} as const;

/** Options every chart here starts from: transparent ground, quiet grid, the app's type. Adjust with `applyOptions`. */
export function baseChartOptions(): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: CHART_COLORS.text,
      fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
      fontSize: 11,
      panes: { separatorColor: CHART_COLORS.border, separatorHoverColor: "rgba(126,166,255,0.25)", enableResize: false },
    },
    grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
    rightPriceScale: { borderColor: CHART_COLORS.border },
    timeScale: { borderColor: CHART_COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: CrosshairMode.Normal },
    localization: { locale: safeLocale() },
  };
}
