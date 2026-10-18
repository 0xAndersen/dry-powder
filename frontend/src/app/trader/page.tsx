import type { Metadata } from "next";
import { TraderScreen } from "@/components/trader/trader-screen";

export const metadata: Metadata = { title: "Trader" };

export default function TraderPage() {
  return <TraderScreen />;
}
