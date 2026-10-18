import type { Metadata } from "next";
import { MarketsScreen } from "@/components/markets/markets-screen";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return <MarketsScreen />;
}
