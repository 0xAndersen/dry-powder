import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import {
  DAY,
  WEEK,
  allocate,
  buildTree,
  fundSeason,
  hashPair,
  lastFinishedSeason,
  leafHash,
  parseTable,
  publishSeason,
  readResults,
  seasonAt,
  seasonByNumber,
  seasonResults,
  standings,
  updateIndex,
  verifyProof,
  weekStart,
} from "../src/prizes.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const usd = (n) => BigInt(Math.round(n * 1e6));
const MONDAY = Date.UTC(2026, 9, 5) / 1000; // Monday 5 October 2026, 00:00 UTC
const ZERO = `0x${"0".repeat(64)}`;

test("seasons match the leaderboard's: weekly from the first Monday after launch, a pre-season before it", () => {
  assert.equal(weekStart(MONDAY), MONDAY);
  assert.equal(weekStart(MONDAY + 3 * DAY + 5), MONDAY);
  assert.equal(weekStart(MONDAY - 1), MONDAY - WEEK);
  const launch = MONDAY - 2 * DAY + 3600; // a Saturday
  assert.deepEqual(seasonAt(launch + 10, launch), { number: 0, start: launch, end: MONDAY });
  assert.deepEqual(seasonAt(MONDAY, launch), { number: 1, start: MONDAY, end: MONDAY + WEEK });
  assert.deepEqual(seasonAt(MONDAY + WEEK + 1, launch), { number: 2, start: MONDAY + WEEK, end: MONDAY + 2 * WEEK });
  for (const n of [0, 1, 2, 9]) assert.deepEqual(seasonByNumber(n, launch), seasonAt(seasonByNumber(n, launch).start, launch));
  // Launched on a Monday at midnight: season 1 starts at launch.
  assert.equal(seasonAt(MONDAY, MONDAY).number, 1);
  assert.equal(lastFinishedSeason(launch + DAY, launch), null);
  assert.equal(lastFinishedSeason(MONDAY + 2 * DAY, launch).number, 0);
  assert.deepEqual(lastFinishedSeason(MONDAY + WEEK + 2 * DAY, launch), seasonByNumber(1, launch));
});

const day = (time) => Math.floor(time / DAY);
const bucket = (time, { r = 0, f = 0, v = 0, t = 1 } = {}) => ({ i: day(time), r: String(usd(r)), f: String(usd(f)), v: String(usd(v)), m: "0", t, w: 0, l: 0, x: 0 });

function statsFixture() {
  return {
    chainId: 31337,
    engine: "0x00000000000000000000000000000000000000e1",
    deployTime: MONDAY - 3 * DAY,
    cursorBlock: 1234,
    cursorTime: MONDAY + WEEK + 600,
    traders: {
      [A.toLowerCase()]: { days: [bucket(MONDAY + DAY, { r: 900, f: 10, v: 50_000, t: 3 }), bucket(MONDAY + WEEK + DAY, { r: 5_000, f: 0, v: 1, t: 1 })] },
      [B]: { days: [bucket(MONDAY + 2 * DAY, { r: 400, f: 10, v: 10_000, t: 2 }), bucket(MONDAY - DAY, { r: 10_000, t: 9 })] },
      [C]: { days: [bucket(MONDAY + 6 * DAY, { r: 390, f: 0, v: 2_000, t: 4 })] },
      [D]: { days: [bucket(MONDAY + 3 * DAY, { r: -50, f: 5, v: 7_000, t: 2 })] },
      "not-an-address": { days: [bucket(MONDAY + DAY, { r: 1e9 })] },
    },
  };
}

test("standings rank a season's daily buckets by net PnL, then trades, then address", () => {
  const stats = statsFixture();
  const s1 = seasonByNumber(1, stats.deployTime);
  const rows = standings(stats, s1);
  // B's pre-season day and A's season-2 day stay out of season 1; B and C tie on net and C has more trades.
  assert.deepEqual(rows.map((r) => r.account), [getAddress(A), getAddress(C), getAddress(B), getAddress(D)]);
  assert.equal(rows[0].net, usd(890));
  assert.equal(rows[0].trades, 3);
  assert.equal(rows[0].volume, usd(50_000));
  assert.equal(rows[1].net, usd(390));
  assert.equal(rows[2].net, usd(390));
  assert.equal(rows[3].net, usd(-55));
  stats.traders[C].days[0].t = 1;
  const tie = standings(stats, s1);
  assert.deepEqual(tie.slice(1, 3).map((r) => r.account), [getAddress(B), getAddress(C)]);
  stats.traders[C].days[0].t = 2;
  assert.deepEqual(standings(stats, s1).slice(1, 3).map((r) => r.account), [getAddress(B), getAddress(C)], "equal trades: lower address first");
  // The pre-season counts its launch day whole.
  const s0 = seasonByNumber(0, stats.deployTime);
  assert.deepEqual(standings(stats, s0).map((r) => r.account), [getAddress(B)]);
  assert.deepEqual(standings({}, s1), []);
});

test("prize tables are whole USDC with up to six decimals", () => {
  assert.deepEqual(parseTable("[500, 300, 150.5, 0.000001]"), [usd(500), usd(300), usd(150.5), 1n]);
  assert.deepEqual(parseTable(["25"]), [usd(25)]);
  assert.throws(() => parseTable("[]"), /non-empty/);
  assert.throws(() => parseTable("[1, -2]"), /prize 2/);
  assert.throws(() => parseTable("[0]"), /zero/);
  assert.throws(() => parseTable("[1.0000001]"), /prize 1/);
  assert.throws(() => parseTable("{}"), /non-empty/);
});

test("allocation skips the excluded, losing weeks and traders under the minimum", () => {
  const stats = statsFixture();
  const rows = standings(stats, seasonByNumber(1, stats.deployTime));
  const table = [usd(500), usd(300), usd(150)];
  assert.deepEqual(allocate(rows, table).map((w) => [w.rank, w.account, w.amount]), [
    [1, getAddress(A), usd(500)],
    [2, getAddress(C), usd(300)],
    [3, getAddress(B), usd(150)],
  ]);
  const skipA = allocate(rows, table, { exclude: new Set([A.toUpperCase().replace("0X", "0x")]) });
  assert.deepEqual(skipA.map((w) => w.account), [getAddress(C), getAddress(B)], "D lost money: no third prize");
  assert.deepEqual(allocate(rows, table, { minTrades: 3 }).map((w) => w.account), [getAddress(A), getAddress(C)]);
  assert.deepEqual(allocate(rows, [usd(1)]).map((w) => w.account), [getAddress(A)]);
  assert.equal(allocate(rows, table, { minNet: usd(10_000) }).length, 0);
});

test("the tree is OpenZeppelin's StandardMerkleTree: same root and proofs as @openzeppelin/merkle-tree", () => {
  // Root and proofs computed with @openzeppelin/merkle-tree 1.0.7 (StandardMerkleTree.of(values, ["address", "uint256"])).
  const entries = [
    { account: A, amount: usd(500) },
    { account: B, amount: usd(300) },
    { account: C, amount: usd(150) },
  ];
  const { root, proofs } = buildTree(entries);
  assert.equal(root, "0xb1568b1176dc6bd8e4c86713a4e2241153a03e6d43a92e39841c594fb11a8667");
  assert.deepEqual(proofs, [
    ["0x123a89fd10c44e9bdc6167875f0b5dbcc43484cddd7111d7d92a7dc8e7251e65"],
    ["0x0c5ac5fd68bcdc3114ac03cf672ef0296503b3af97ee8d2de1f73fbece5f8716", "0x7c6bcaa388efff2969e00030993171e7aaba435da8c59fe3888376c6b40515aa"],
    ["0x1e3b24b0c847437ca94b3e9576e272506736ba1f50636955d52e0a7f1f03dd67", "0x7c6bcaa388efff2969e00030993171e7aaba435da8c59fe3888376c6b40515aa"],
  ]);
  entries.forEach((e, i) => assert.ok(verifyProof(proofs[i], root, leafHash(e.account, e.amount))));
  assert.ok(!verifyProof(proofs[0], root, leafHash(A, usd(501))), "a different amount fails");
  assert.ok(!verifyProof(proofs[1], root, leafHash(A, usd(500))), "someone else's proof fails");
});

test("every proof verifies for odd and even counts; one leaf is its own root; an account appears once", () => {
  const one = buildTree([{ account: A, amount: 7n }]);
  assert.equal(one.root, leafHash(A, 7n));
  assert.deepEqual(one.proofs, [[]]);
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 17]) {
    const entries = Array.from({ length: n }, (_, i) => ({ account: `0x${(i + 1).toString(16).padStart(40, "0")}`, amount: BigInt(1000 + i) }));
    const { root, proofs } = buildTree(entries);
    entries.forEach((e, i) => assert.ok(verifyProof(proofs[i], root, leafHash(e.account, e.amount)), `n=${n} i=${i}`));
    assert.ok(proofs.every((p) => p.length <= Math.ceil(Math.log2(n))));
  }
  assert.throws(() => buildTree([{ account: A, amount: 1n }, { account: A.toUpperCase().replace("0X", "0x"), amount: 2n }]), /twice/);
  assert.throws(() => buildTree([]), /at least one/);
  assert.equal(hashPair(leafHash(A, 1n), leafHash(B, 2n)), hashPair(leafHash(B, 2n), leafHash(A, 1n)));
});

test("a season's results file carries the root, total, deadline and a working proof per winner", () => {
  const stats = statsFixture();
  const season = seasonByNumber(1, stats.deployTime);
  const table = parseTable("[500, 300, 150, 100]");
  const deadline = season.end + 14 * DAY;
  const results = seasonResults({ stats, season, table, deadline, distributor: "0x00000000000000000000000000000000000000d1", chainId: 31337, exclude: new Set([C]), generatedAt: "2026-10-12T00:10:00.000Z" });
  assert.equal(results.season, 1);
  assert.equal(results.start, MONDAY);
  assert.equal(results.end, MONDAY + WEEK);
  assert.equal(results.total, String(usd(800)), "C is excluded and D lost: two prizes");
  assert.deepEqual(results.winners.map((w) => [w.rank, w.account, w.amount, w.net]), [
    [1, getAddress(A), String(usd(500)), String(usd(890))],
    [2, getAddress(B), String(usd(300)), String(usd(390))],
  ]);
  assert.deepEqual(results.rules.excluded, [getAddress(C)]);
  assert.equal(results.statsCursorBlock, 1234);
  assert.equal(results.distributor, "0x00000000000000000000000000000000000000D1");
  // Round-trips through JSON and validates.
  const read = readResults(JSON.parse(JSON.stringify(results)));
  assert.equal(read.total, usd(800));
  assert.equal(read.winners[0].amount, usd(500));
  const tampered = JSON.parse(JSON.stringify(results));
  tampered.winners[1].amount = String(usd(301));
  tampered.total = String(usd(801));
  assert.throws(() => readResults(tampered), /does not match the root/);
  const badTotal = JSON.parse(JSON.stringify(results));
  badTotal.total = "1";
  assert.throws(() => readResults(badTotal), /not the sum/);
  assert.throws(() => readResults({ schema: 9 }), /schema 1/);
  assert.throws(() => seasonResults({ stats, season, table, deadline, minNet: usd(1e6) }), /no trader who qualifies/);
});

test("the index lists one entry per season, newest first", () => {
  const stats = statsFixture();
  const make = (n, generatedAt) =>
    seasonResults({ stats: { ...stats, traders: { [A]: { days: [bucket(seasonByNumber(n, stats.deployTime).start + DAY, { r: 10 })] } } }, season: seasonByNumber(n, stats.deployTime), table: [usd(5)], deadline: 2e9, chainId: 31337, generatedAt });
  let index = updateIndex(null, make(1, "t1"));
  index = updateIndex(index, make(3, "t3"));
  index = updateIndex(index, make(2, "t2"));
  index = updateIndex(index, { ...make(3, "t4"), total: "99" });
  assert.deepEqual(index.seasons.map((s) => [s.season, s.file]), [[3, "season-3.json"], [2, "season-2.json"], [1, "season-1.json"]]);
  assert.equal(index.seasons[0].total, "99");
  assert.equal(index.updatedAt, "t4");
  assert.equal(index.chainId, 31337);
});

// A fake chain: the distributor's seasons, the token's allowance, and a record of every transaction sent.
function fakeChain({ root = ZERO, funded = 0n, allowance = 0n } = {}) {
  const sent = [];
  const pub = {
    async readContract({ functionName }) {
      if (functionName === "seasons") return [funded, 0n, 0n, root, 0n, false];
      if (functionName === "allowance") return allowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract(request) {
      return { request };
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: "success", transactionHash: hash };
    },
  };
  const wallet = {
    account: { address: D },
    async writeContract(request) {
      sent.push([request.functionName, ...request.args.map(String)]);
      return `0x${String(sent.length).padStart(64, "0")}`;
    },
  };
  return { pub, wallet, sent };
}

const results = () =>
  readResults(JSON.parse(JSON.stringify(seasonResults({ stats: statsFixture(), season: seasonByNumber(1, MONDAY - 3 * DAY), table: [usd(500), usd(300)], deadline: 2e9, chainId: 31337 }))));

test("publishing tops up the pool when asked, then publishes once", async () => {
  const r = results();
  const distributor = "0x00000000000000000000000000000000000000d1";
  const usdc = "0x00000000000000000000000000000000000000c1";
  const chain = fakeChain({ funded: usd(100) });
  await assert.rejects(publishSeason({ ...chain, distributor, usdc, results: r }), /fund it first/);
  const out = await publishSeason({ ...chain, distributor, usdc, results: r, fund: true, mint: true });
  assert.equal(out.already, false);
  assert.deepEqual(chain.sent, [
    ["mint", D, String(usd(700))],
    ["approve", distributor, String(usd(700))],
    ["fund", "1", String(usd(700))],
    ["publishResults", "1", r.root, String(usd(800)), "2000000000"],
  ]);
  const again = fakeChain({ root: r.root, funded: usd(800) });
  assert.deepEqual(await publishSeason({ ...again, distributor, usdc, results: r }), { already: true, hashes: [] });
  assert.deepEqual(again.sent, []);
  const other = fakeChain({ root: `0x${"ab".repeat(32)}`, funded: usd(800) });
  await assert.rejects(publishSeason({ ...other, distributor, usdc, results: r }), /already has other results/);
});

test("funding mints in chunks of at most 1,000,000 and skips the approval when it is already there", async () => {
  const chain = fakeChain({ allowance: usd(3_000_000) });
  await fundSeason({ ...chain, distributor: B, usdc: C, season: 4, amount: usd(2_500_000), mint: true });
  assert.deepEqual(chain.sent, [
    ["mint", D, String(usd(1_000_000))],
    ["mint", D, String(usd(1_000_000))],
    ["mint", D, String(usd(500_000))],
    ["fund", "4", String(usd(2_500_000))],
  ]);
});
