// Season prizes (roadmap 81): where a deployment's published results live, reading and checking them, and which
// prizes belong to the accounts on screen. The results come from ops/scripts/prizes.mjs (keeper/src/prizes.mjs);
// PrizeDistributor holds the pool and pays a claim that carries a proof against the season's root.
// Pure: imports only viem.
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";

export const PRIZES_SCHEMA = 1;
const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** One published season in prizes/index.json. */
export type PrizeSeasonEntry = {
  season: number;
  start: number;
  end: number;
  root: Hex;
  total: bigint;
  /** Unix seconds after which prizes can no longer be claimed. */
  deadline: number;
  winners: number;
  /** The season's results file, relative to the index. */
  file: string;
};

export type PrizesIndex = { chainId: number; distributor: Address | null; seasons: PrizeSeasonEntry[] };

export type PrizeWinner = { rank: number; account: Address; amount: bigint; net: bigint | null; trades: number | null; proof: Hex[] };

/** A season's results file: the root PrizeDistributor holds and every winner's amount and proof. */
export type PrizeSeason = {
  season: number;
  start: number;
  end: number;
  root: Hex;
  total: bigint;
  deadline: number;
  chainId: number;
  distributor: Address | null;
  winners: PrizeWinner[];
};

const GITHUB_STATUS = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/status\/status\/stats\.json(?:\?.*)?$/i;

/**
 * Where prizes/index.json is. In order: `explicit` (config.json `prizesUrl`, absolute or relative to the app); for
 * stats published on a GitHub repository's status branch, that repository's `prizes` branch (where
 * .github/workflows/prizes.yml commits); for stats published elsewhere, `prizes/index.json` beside stats.json;
 * otherwise `prizes/index.json` beside the app. `base` is the app's directory with a trailing slash.
 */
export function prizesIndexUrl({ explicit, statsUrl, base }: { explicit: string | null; statsUrl: string | null; base: string }): string | null {
  try {
    if (explicit) return new URL(explicit.replace(/^\.\//, ""), base).toString();
    if (statsUrl) {
      const gh = GITHUB_STATUS.exec(statsUrl);
      if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/prizes/prizes/index.json`;
      const stats = new URL(statsUrl, base);
      return new URL("prizes/index.json", new URL(".", stats)).toString();
    }
    return new URL("prizes/index.json", base).toString();
  } catch {
    return null;
  }
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const big = (v: unknown): bigint | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    const b = BigInt(v);
    return b >= 0n ? b : null;
  } catch {
    return null;
  }
};
const signed = (v: unknown): bigint | null => {
  if (typeof v !== "string") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
};
const addr = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);
const root = (v: unknown): Hex | null => (typeof v === "string" && HEX32.test(v) ? (v.toLowerCase() as Hex) : null);

/** Reads prizes/index.json; null when it is not one. Entries that do not parse are skipped. */
export function parsePrizesIndex(json: unknown): PrizesIndex | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (j.schema !== PRIZES_SCHEMA || !Array.isArray(j.seasons)) return null;
  const seasons: PrizeSeasonEntry[] = [];
  for (const s of j.seasons as Record<string, unknown>[]) {
    if (!s || typeof s !== "object") continue;
    const season = int(s.season);
    const start = int(s.start);
    const end = int(s.end);
    const deadline = int(s.deadline);
    const winners = int(s.winners);
    const r = root(s.root);
    const total = big(s.total);
    const file = typeof s.file === "string" && /^[\w.-]+(\/[\w.-]+)*\.json$/.test(s.file) && !s.file.includes("..") ? s.file : null;
    if (season === null || start === null || end === null || deadline === null || winners === null || r === null || total === null || file === null) continue;
    seasons.push({ season, start, end, root: r, total, deadline, winners, file });
  }
  seasons.sort((a, b) => b.season - a.season);
  return { chainId: int(j.chainId) ?? 0, distributor: addr(j.distributor), seasons };
}

/** keccak256(bytes.concat(keccak256(abi.encode(account, amount)))): the leaf PrizeDistributor.claim checks. */
export function leafHash(account: Address, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, amount])));
}

/** OpenZeppelin's MerkleProof: fold the siblings in with the sorted-pair hash and compare with the root. */
export function verifyProof(proof: readonly Hex[], expectedRoot: Hex, leaf: Hex): boolean {
  let node = leaf.toLowerCase();
  for (const sibling of proof) {
    const s = sibling.toLowerCase();
    node = keccak256((node < s ? `${node}${s.slice(2)}` : `${s}${node.slice(2)}`) as Hex);
  }
  return node === expectedRoot.toLowerCase();
}

/**
 * Reads a season's results file. Null when it is not one, or when any proof fails against its root or the amounts
 * do not add up to the total: such a file is never offered for claiming.
 */
export function parsePrizeSeason(json: unknown): PrizeSeason | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (j.schema !== PRIZES_SCHEMA || !Array.isArray(j.winners)) return null;
  const season = int(j.season);
  const start = int(j.start);
  const end = int(j.end);
  const deadline = int(j.deadline);
  const r = root(j.root);
  const total = big(j.total);
  if (season === null || start === null || end === null || deadline === null || r === null || total === null) return null;
  const winners: PrizeWinner[] = [];
  let sum = 0n;
  for (const w of j.winners as Record<string, unknown>[]) {
    const account = addr(w?.account);
    const amount = big(w?.amount);
    const rank = int(w?.rank);
    const proof = Array.isArray(w?.proof) && (w.proof as unknown[]).every((p) => root(p) !== null) ? (w.proof as string[]).map((p) => p.toLowerCase() as Hex) : null;
    if (!account || amount === null || amount === 0n || rank === null || proof === null) return null;
    if (!verifyProof(proof, r, leafHash(account, amount))) return null;
    sum += amount;
    winners.push({ rank, account, amount, net: signed(w.net), trades: int(w.trades), proof });
  }
  if (winners.length === 0 || sum !== total) return null;
  winners.sort((a, b) => a.rank - b.rank);
  return { season, start, end, root: r, total, deadline, chainId: int(j.chainId) ?? 0, distributor: addr(j.distributor), winners };
}

export type PrizeAccount = { address: Address; label: string };

/** A prize one of `accounts` won. */
export type PrizeRow = { season: number; rank: number; account: Address; label: string; amount: bigint; proof: Hex[]; deadline: number; root: Hex };

/** The prizes `accounts` won across `seasons`, newest season first. */
export function prizesFor(seasons: readonly PrizeSeason[], accounts: readonly PrizeAccount[]): PrizeRow[] {
  const labels = new Map<string, PrizeAccount>();
  for (const a of accounts) if (!labels.has(a.address.toLowerCase())) labels.set(a.address.toLowerCase(), a);
  const rows: PrizeRow[] = [];
  for (const s of [...seasons].sort((a, b) => b.season - a.season)) {
    for (const w of s.winners) {
      const who = labels.get(w.account.toLowerCase());
      if (who) rows.push({ season: s.season, rank: w.rank, account: w.account, label: who.label, amount: w.amount, proof: w.proof, deadline: s.deadline, root: s.root });
    }
  }
  return rows;
}

/** A season as PrizeDistributor.seasons(id) returns it. */
export type OnChainSeason = { funded: bigint; allocated: bigint; claimed: bigint; root: Hex; claimDeadline: number; closed: boolean };

export function readOnChainSeason(raw: unknown): OnChainSeason | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const [funded, allocated, claimed, r, deadline, closed] = raw as [bigint, bigint, bigint, Hex, bigint | number, boolean];
  return { funded, allocated, claimed, root: r, claimDeadline: Number(deadline), closed };
}

export type ClaimStatus = "claimable" | "claimed" | "expired" | "closed" | "pending";

/**
 * Where a prize stands: "pending" until the chain holds this file's root (results not published yet, or published
 * differently), then claimable until the on-chain deadline.
 */
export function claimStatus(row: Pick<PrizeRow, "root">, chain: OnChainSeason | null, claimed: boolean | undefined, now: number): ClaimStatus {
  if (claimed) return "claimed";
  if (!chain || chain.root === ZERO_ROOT || chain.root.toLowerCase() !== row.root.toLowerCase()) return "pending";
  if (chain.closed) return "closed";
  if (now > chain.claimDeadline) return "expired";
  return "claimable";
}

/** Results files worth fetching: the newest season, and any other still inside its claim window. At most `limit`. */
export function seasonsToLoad(index: PrizesIndex, now: number, limit = 6): PrizeSeasonEntry[] {
  return index.seasons.filter((s, i) => i === 0 || s.deadline >= now).slice(0, limit);
}
