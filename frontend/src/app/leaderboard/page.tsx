import type { Metadata } from "next";
import { LeaderboardScreen } from "@/components/leaderboard/leaderboard-screen";

export const metadata: Metadata = { title: "Leaderboard" };

export default function LeaderboardPage() {
  return <LeaderboardScreen />;
}
