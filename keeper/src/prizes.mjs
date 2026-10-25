// Season prizes (roadmap 81): a season's results from the indexer's stats.json, the Merkle tree PrizeDistributor
// verifies claims against, and the on-chain steps that fund a season and publish its results.
//
// Seasons are the leaderboard's (frontend/src/lib/aggregate.ts): weekly, Monday 00:00 UTC to the next Monday, season 1
// starting on the first Monday after the engine was deployed and season 0 (the pre-season) before it. A season is
// ranked by net PnL (realised PnL less fees) of the trades closed in it, from the per-trader daily buckets.
//
// The tree is OpenZeppelin's StandardMerkleTree for leaves (address, uint256): each leaf is
// keccak256(bytes.concat(keccak256(abi.encode(account, amount)))), leaves are sorted by hash, nodes hash sorted pairs,
// and the array layout is the same, so the root equals what @openzeppelin/merkle-tree computes and every proof is one
// MerkleProof.verify (PrizeDistributor.claim) accepts.
//
// The command line is ops/scripts/prizes.mjs; .github/workflows/prizes.yml runs it.
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, isAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentRegistryAbi, prizeDistributorAbi, testUSDCAbi } from "./abi.mjs";

export const SCHEMA = 1;
export const DAY = 86_400;
export const WEEK = 7 * DAY;
/** 1970-01-05 was a Monday: Mondays 00:00 UTC are this plus multiples of a week. */
const MONDAY_EPOCH = 4 * DAY;
const USDC = 1_000_000n;

// ─────────────────────────────── Seasons ───────────────────────────────

/** Monday 00:00 UTC on or before `time`. */
export function weekStart(time) {
  return Math.floor((time - MONDAY_EPOCH) / WEEK) * WEEK + MONDAY_EPOCH;
}

const firstSeasonStart = (launch) => weekStart(launch) + (weekStart(launch) === launch ? 0 : WEEK);

/** The season `time` falls in (frontend/src/lib/aggregate.ts seasonAt). */
export function seasonAt(time, launch) {
  const first = firstSeasonStart(launch);
  if (time < first) return { number: 0, start: launch, end: first };
  const n = Math.floor((time - first) / WEEK);
  return { number: n + 1, start: first + n * WEEK, end: first + (n + 1) * WEEK };
}

/** Season `number` (0: the pre-season, from `launch` to the first Monday). */
export function seasonByNumber(number, launch) {
  const first = firstSeasonStart(launch);
  if (number <= 0) return { number: 0, start: launch, end: first };
  return { number, start: first + (number - 1) * WEEK, end: first + number * WEEK };
}

/** The last season that has ended at `now`, or null while the pre-season runs. */
export function lastFinishedSeason(now, launch) {
  const current = seasonAt(now, launch);
  if (current.number === 0) return null;
  return seasonByNumber(current.number - 1, launch);
}

// ─────────────────────────────── Standings ───────────────────────────────

const big = (v) => (typeof v === "bigint" ? v : BigInt(v ?? 0));

/**
 * Every trader's results over `season` from stats.json's per-trader daily buckets ({ i: day, r: realised, f: fees,
 * v: volume, t: trades }), ranked by net PnL, then trades, then address (so a tie has one order everywhere).
 * Days are whole UTC days: the pre-season counts its launch day in full, as the leaderboard does.
 */
export function standings(stats, season) {
  const from = Math.floor(season.start / DAY);
  const to = Math.ceil(season.end / DAY);
  const rows = [];
  for (const [address, t] of Object.entries(stats?.traders ?? {})) {
    if (!isAddress(address)) continue;
    let realised = 0n;
    let fees = 0n;
    let volume = 0n;
    let trades = 0;
    for (const b of t.days ?? []) {
      const i = Number(b.i);
      if (i < from || i >= to) continue;
      realised += big(b.r);
      fees += big(b.f);
      volume += big(b.v);
      trades += Number(b.t) || 0;
    }
    if (trades === 0 && volume === 0n) continue;
    rows.push({ account: getAddress(address), net: realised - fees, realised, fees, volume, trades });
  }
  return rows.sort((a, b) => (a.net !== b.net ? (b.net > a.net ? 1 : -1) : b.trades !== a.trades ? b.trades - a.trades : a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));
}

/** Prize amounts by rank, in 6-decimal USDC, from a JSON array of whole USDC ("[500, 300, 150]", decimals allowed). */
export function parseTable(text) {
  const raw = typeof text === "string" ? JSON.parse(text) : text;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("the prize table must be a non-empty JSON array of amounts");
  return raw.map((x, i) => {
    const s = String(x).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`prize ${i + 1} is not an amount in USDC: ${JSON.stringify(x)}`);
    const [whole, frac = ""] = s.split(".");
    const amount = BigInt(whole) * USDC + BigInt(frac.padEnd(6, "0"));
    if (amount === 0n) throw new Error(`prize ${i + 1} is zero`);
    return amount;
  });
}

/**
 * Gives the table's amounts to the best-ranked traders that qualify: at least `minTrades` closed trades, a net PnL
 * of at least `minNet` (default: above zero, so a losing week wins nothing), and not in `exclude`.
 */
export function allocate(rows, table, { minNet = 1n, minTrades = 1, exclude = new Set() } = {}) {
  const skip = new Set([...exclude].map((a) => a.toLowerCase()));
  const winners = [];
  for (const r of rows) {
    if (winners.length === table.length) break;
    if (r.trades < minTrades || r.net < minNet || skip.has(r.account.toLowerCase())) continue;
    winners.push({ rank: winners.length + 1, account: r.account, amount: table[winners.length], net: r.net, trades: r.trades, volume: r.volume });
  }
  return winners;
}

// ─────────────────────────────── Merkle tree ───────────────────────────────

const LEAF_TYPES = [{ type: "address" }, { type: "uint256" }];
const bytes = (hex) => Buffer.from(hex.slice(2), "hex");
const compare = (a, b) => Buffer.compare(bytes(a), bytes(b));

/** keccak256(bytes.concat(keccak256(abi.encode(account, amount)))): the leaf PrizeDistributor.claim rebuilds. */
export function leafHash(account, amount) {
  return keccak256(keccak256(encodeAbiParameters(LEAF_TYPES, [getAddress(account), BigInt(amount)])));
}

/** OpenZeppelin's commutative node hash: the two children in ascending order, concatenated and hashed. */
export function hashPair(a, b) {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}`);
}

/**
 * StandardMerkleTree over `entries` ({ account, amount }): returns the root and each entry's proof, in `entries`'
 * order. One entry gives a root equal to its leaf and an empty proof.
 */
export function buildTree(entries) {
  if (entries.length === 0) throw new Error("a tree needs at least one leaf");
  const seen = new Set();
  for (const e of entries) {
    const k = getAddress(e.account);
    if (seen.has(k)) throw new Error(`${k} appears twice: one leaf per account`);
    seen.add(k);
  }
  const hashed = entries.map((e, index) => ({ index, hash: leafHash(e.account, e.amount) })).sort((a, b) => compare(a.hash, b.hash));
  const n = hashed.length;
  const tree = new Array(2 * n - 1);
  hashed.forEach((h, j) => (tree[tree.length - 1 - j] = h.hash));
  for (let i = tree.length - 1 - n; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
  const proofs = new Array(n);
  hashed.forEach((h, j) => {
    const proof = [];
    for (let i = tree.length - 1 - j; i > 0; i = Math.floor((i - 1) / 2)) proof.push(tree[i % 2 === 1 ? i + 1 : i - 1]);
    proofs[h.index] = proof;
  });
  return { root: tree[0], proofs };
}

/** MerkleProof.verify: folds the proof into the leaf with the commutative hash and compares with the root. */
export function verifyProof(proof, root, leaf) {
  let node = leaf;
  for (const sibling of proof) node = hashPair(node, sibling);
  return node.toLowerCase() === root.toLowerCase();
}

// ─────────────────────────────── Results files ───────────────────────────────

/**
 * The results file of one season: what publishResults takes (root, total, deadline) and, per winner, the amount and
 * proof the app claims with. Amounts and PnL are 6-decimal strings.
 */
export function seasonResults({ stats, season, table, deadline, distributor = null, chainId, exclude = new Set(), minNet = 1n, minTrades = 1, generatedAt = new Date().toISOString(), launch }) {
  const winners = allocate(standings(stats, season), table, { minNet, minTrades, exclude });
  if (winners.length === 0) throw new Error(`season ${season.number} has no trader who qualifies for a prize`);
  const { root, proofs } = buildTree(winners);
  const total = winners.reduce((s, w) => s + w.amount, 0n);
  return {
    schema: SCHEMA,
    chainId: Number(chainId ?? stats?.chainId ?? 0),
    engine: String(stats?.engine ?? "").toLowerCase(),
    distributor: distributor ? getAddress(distributor) : null,
    season: season.number,
    start: season.start,
    end: season.end,
    launch: Number(launch ?? stats?.deployTime ?? 0),
    metric: "net",
    rules: { minNet: String(minNet), minTrades, excluded: [...exclude].map((a) => getAddress(a)), table: table.map(String) },
    root,
    total: String(total),
    deadline,
    generatedAt,
    statsCursorBlock: Number(stats?.cursorBlock ?? 0),
    winners: winners.map((w, i) => ({ rank: w.rank, account: w.account, amount: String(w.amount), net: String(w.net), trades: w.trades, volume: String(w.volume), proof: proofs[i] })),
  };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Checks a results file and returns it with bigint amounts; throws on anything malformed or a proof that fails. */
export function readResults(json) {
  if (!json || json.schema !== SCHEMA) throw new Error("not a season results file (schema 1)");
  if (!Number.isInteger(json.season) || json.season < 0) throw new Error("bad season number");
  if (!HEX32.test(String(json.root))) throw new Error("bad root");
  if (!Number.isInteger(json.deadline) || json.deadline <= 0) throw new Error("bad deadline");
  const winners = (json.winners ?? []).map((w) => {
    if (!isAddress(w.account)) throw new Error(`bad account ${w.account}`);
    if (!Array.isArray(w.proof) || !w.proof.every((p) => HEX32.test(p))) throw new Error(`bad proof for ${w.account}`);
    const amount = BigInt(w.amount);
    if (!verifyProof(w.proof, json.root, leafHash(w.account, amount))) throw new Error(`the proof for ${w.account} does not match the root`);
    return { ...w, account: getAddress(w.account), amount };
  });
  if (winners.length === 0) throw new Error("no winners");
  const total = winners.reduce((s, w) => s + w.amount, 0n);
  if (total !== BigInt(json.total)) throw new Error(`total ${json.total} is not the sum of the prizes (${total})`);
  return { ...json, total, winners };
}

/** prizes/index.json: one entry per published season, newest first, each pointing at its results file. */
export function updateIndex(index, results, file = `season-${results.season}.json`) {
  const seasons = (index?.seasons ?? []).filter((s) => s.season !== results.season);
  seasons.push({ season: results.season, start: results.start, end: results.end, root: results.root, total: String(results.total), deadline: results.deadline, winners: results.winners.length, file });
  seasons.sort((a, b) => b.season - a.season);
  return { schema: SCHEMA, chainId: results.chainId, distributor: results.distributor, engine: results.engine, updatedAt: results.generatedAt, seasons };
}

// ─────────────────────────────── Chain ───────────────────────────────

/** A public client, and a wallet client when `key` is given. */
export function clients({ rpcUrl, chainId, key = null }) {
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl, { retryCount: 3, retryDelay: 750, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const wallet = key ? createWalletClient({ chain, transport, account: privateKeyToAccount(key) }) : null;
  return { pub, wallet };
}

/** The accounts among `accounts` that are listed in the AgentRegistry. */
export async function registeredAgents(pub, registry, accounts) {
  const out = new Set();
  for (const a of accounts) {
    const listed = await pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: "isAgent", args: [a] });
    if (listed) out.add(a.toLowerCase());
  }
  return out;
}

/** A season as PrizeDistributor holds it. */
export async function seasonOnChain(pub, distributor, season) {
  const [funded, allocated, claimed, root, claimDeadline, closed] = await pub.readContract({ address: distributor, abi: prizeDistributorAbi, functionName: "seasons", args: [BigInt(season)] });
  return { funded, allocated, claimed, root, claimDeadline: Number(claimDeadline), closed };
}

async function write(pub, wallet, request) {
  const { request: simulated } = await pub.simulateContract({ account: wallet.account, ...request });
  const hash = await wallet.writeContract(simulated);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${request.functionName} reverted: ${hash}`);
  return hash;
}

/**
 * Adds `amount` (6-decimal USDC) to season `season`'s pool from the wallet, approving the distributor first. With
 * `mint` it first mints the amount (test collateral only: TestUSDC mints at most 1,000,000 per call).
 */
export async function fundSeason({ pub, wallet, distributor, usdc, season, amount, mint = false, log = () => {} }) {
  const hashes = [];
  if (mint) {
    for (let left = amount; left > 0n; ) {
      const chunk = left > 1_000_000n * USDC ? 1_000_000n * USDC : left;
      hashes.push(await write(pub, wallet, { address: usdc, abi: testUSDCAbi, functionName: "mint", args: [wallet.account.address, chunk] }));
      left -= chunk;
    }
    log(`minted ${amount} to ${wallet.account.address}`);
  }
  const allowance = await pub.readContract({ address: usdc, abi: testUSDCAbi, functionName: "allowance", args: [wallet.account.address, distributor] });
  if (allowance < amount) hashes.push(await write(pub, wallet, { address: usdc, abi: testUSDCAbi, functionName: "approve", args: [distributor, amount] }));
  hashes.push(await write(pub, wallet, { address: distributor, abi: prizeDistributorAbi, functionName: "fund", args: [BigInt(season), amount] }));
  log(`funded season ${season} with ${amount}`);
  return hashes;
}

/**
 * Publishes `results` (a readResults() file) on-chain. With `fund`, first tops the season's pool up to the total
 * (minting with `mint`). Refuses when the season already has different results.
 */
export async function publishSeason({ pub, wallet, distributor, usdc, results, fund = false, mint = false, log = () => {} }) {
  const onchain = await seasonOnChain(pub, distributor, results.season);
  if (onchain.root !== `0x${"0".repeat(64)}`) {
    if (onchain.root.toLowerCase() === results.root.toLowerCase()) {
      log(`season ${results.season} is already published with this root`);
      return { already: true, hashes: [] };
    }
    throw new Error(`season ${results.season} already has other results (root ${onchain.root})`);
  }
  const hashes = [];
  if (onchain.funded < results.total) {
    if (!fund) throw new Error(`season ${results.season} holds ${onchain.funded}, less than the ${results.total} its results pay: fund it first`);
    hashes.push(...(await fundSeason({ pub, wallet, distributor, usdc, season: results.season, amount: results.total - onchain.funded, mint, log })));
  }
  hashes.push(await write(pub, wallet, { address: distributor, abi: prizeDistributorAbi, functionName: "publishResults", args: [BigInt(results.season), results.root, results.total, BigInt(results.deadline)] }));
  log(`published season ${results.season}: ${results.winners.length} winners, ${results.total} in total, claimable until ${new Date(results.deadline * 1000).toISOString()}`);
  return { already: false, hashes };
}

/**
 * After season `season`'s claim deadline, moves what is left of its pool (unclaimed prizes, any surplus) into
 * season `toSeason`, which must not have results yet. Owner only.
 */
export async function closeSeason({ pub, wallet, distributor, season, toSeason, log = () => {} }) {
  const s = await seasonOnChain(pub, distributor, season);
  if (s.closed) throw new Error(`season ${season} is already closed`);
  const hash = await write(pub, wallet, { address: distributor, abi: prizeDistributorAbi, functionName: "closeSeason", args: [BigInt(season), BigInt(toSeason)] });
  log(`closed season ${season}: ${s.funded - s.claimed} left moves to season ${toSeason}`);
  return hash;
}
