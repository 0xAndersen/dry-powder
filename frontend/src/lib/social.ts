import { createLocalStore } from "./storage";

/**
 * Per-browser lists the trader curates: favourite markets and followed traders. Both live in localStorage (there is
 * no server); they never leave the device.
 */

/** Favourite markets, by symbol (ids change between deployments for dated markets; symbols are what people pick). */
export const watchlist = createLocalStore<string[]>("dp:watchlist:v1", ["BTC-USD", "ETH-USD"], (stored) => {
  if (!Array.isArray(stored)) return null;
  return [...new Set(stored.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 40))].slice(0, 64);
});

export function toggleWatch(symbol: string): void {
  watchlist.set((list) => (list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]));
}

export type Follow = {
  /** Checksummed or lower-case 0x address; compare lower-cased. */
  address: string;
  /** Optional local nickname, shown instead of the short address. */
  nickname: string;
  followedAt: number;
};

/** Traders this browser follows: their trades are highlighted in the feed and can notify. */
export const follows = createLocalStore<Follow[]>("dp:follows:v1", [], (stored) => {
  if (!Array.isArray(stored)) return null;
  const out: Follow[] = [];
  const seen = new Set<string>();
  for (const item of stored as Partial<Follow>[]) {
    if (!item || typeof item.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item.address)) continue;
    const key = item.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: item.address,
      nickname: typeof item.nickname === "string" ? item.nickname.slice(0, 32) : "",
      followedAt: Number(item.followedAt) || 0,
    });
  }
  return out.slice(0, 500);
});

export function isFollowing(list: Follow[], address: string): boolean {
  const key = address.toLowerCase();
  return list.some((f) => f.address.toLowerCase() === key);
}

export function toggleFollow(address: string): void {
  const key = address.toLowerCase();
  follows.set((list) =>
    list.some((f) => f.address.toLowerCase() === key)
      ? list.filter((f) => f.address.toLowerCase() !== key)
      : [...list, { address, nickname: "", followedAt: Date.now() }],
  );
}

export function setNickname(address: string, nickname: string): void {
  const key = address.toLowerCase();
  follows.set((list) => list.map((f) => (f.address.toLowerCase() === key ? { ...f, nickname: nickname.trim().slice(0, 32) } : f)));
}

/** The name to show for an address: its nickname if followed with one, else null. */
export function nicknameOf(list: Follow[], address: string): string | null {
  const key = address.toLowerCase();
  const f = list.find((x) => x.address.toLowerCase() === key);
  return f && f.nickname ? f.nickname : null;
}
