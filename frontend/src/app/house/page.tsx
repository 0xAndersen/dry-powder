import type { Metadata } from "next";
import { HouseScreen } from "@/components/house/house-screen";

export const metadata: Metadata = { title: "House" };

export default function HousePage() {
  return <HouseScreen />;
}
