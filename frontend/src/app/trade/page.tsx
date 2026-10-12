import type { Metadata } from "next";
import { Suspense } from "react";
import { TradeScreen } from "@/components/trade/trade-screen";

export const metadata: Metadata = { title: "Trade" };

export default function TradePage() {
  return (
    <Suspense fallback={null}>
      <TradeScreen />
    </Suspense>
  );
}
