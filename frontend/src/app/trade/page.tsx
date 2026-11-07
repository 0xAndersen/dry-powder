import type { Metadata } from "next";
import { TradeScreen } from "@/components/trade/trade-screen";

export const metadata: Metadata = { title: "Trade" };

export default function TradePage() {
  return <TradeScreen />;
}
