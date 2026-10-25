import { getAddress, isAddress, type Address } from "viem";
import { hrefFor, stickyQuery } from "./nav";
import { createLocalStore } from "./storage";

/**
 * Referrals (v3.2, roadmap 25 and 79). A link carrying `?ref=0x…` remembers who sent the visitor; once they trade,
 * the app offers to record that referrer on the engine (one transaction, once per trading account). From then on
 * the trader pays `referralDiscountBps` less on every fee and the referrer collects `referralShareBps` of it.
 * Front-ends, wallets and agent builders earn the same way: builder codes are referral links.
 */
export type StoredReferral = { referrer: Address; at: number; dismissed?: boolean };

export const referralStore = createLocalStore<StoredReferral | null>("dp:referrer:v1", null, (stored) => {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<StoredReferral>;
  if (typeof s.referrer !== "string" || !isAddress(s.referrer, { strict: false })) return null;
  return { referrer: getAddress(s.referrer), at: typeof s.at === "number" ? s.at : 0, dismissed: s.dismissed === true };
});

/** Reads `?ref=` from `search` and remembers it, unless a referral is already remembered (first touch wins). */
export function captureReferral(search: string): void {
  const raw = new URLSearchParams(search).get("ref");
  if (!raw || !isAddress(raw, { strict: false })) return;
  if (referralStore.get()) return;
  referralStore.set({ referrer: getAddress(raw), at: Math.floor(Date.now() / 1000) });
}

/** The link that refers others to the app as `address`: the app's home page with `?ref=`. */
export function referralLink(address: Address): string {
  if (typeof window === "undefined") return "";
  const query = stickyQuery(new URLSearchParams(window.location.search), { ref: address, account: null, address: null });
  try {
    return new URL(hrefFor("simple", query), window.location.href).toString();
  } catch {
    return window.location.href;
  }
}
