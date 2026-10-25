import type { Metadata } from "next";
import { ChartWall } from "@/components/charts/chart-wall";

export const metadata: Metadata = { title: "Charts" };

export default function ChartsPage() {
  return <ChartWall />;
}
