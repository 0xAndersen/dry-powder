import type { Metadata } from "next";
import { SimpleScreen } from "@/components/simple/simple-screen";

export const metadata: Metadata = { title: "Up or down" };

export default function SimplePage() {
  return <SimpleScreen />;
}
