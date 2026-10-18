import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGasSponsor } from "../src/sponsor.mjs";

const FACTORY = "0x00000000000000000000000000000000000000fa";
const USDC = "0x00000000000000000000000000000000000000c0";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OWNER = "0x00000000000000000000000000000000000000b1";
const AGENT = "0x00000000000000000000000000000000000000d1";
const E18 = 10n ** 18n;

function world({ gas = 0n, collateral = 100_000_000n, expiry = Math.floor(Date.now() / 1000) + 3600, official = ACCOUNT } = {}) {
  const sent = [];
  const pub = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ event }) => {
      if (event.name === "AccountCreated") return [{ args: { owner: OWNER, account: ACCOUNT }, address: FACTORY }];
      if (event.name === "AgentSet") return [{ args: { agent: AGENT, expiry: BigInt(expiry) }, address: ACCOUNT }];
      return [];
    },
    getBalance: async () => gas,
    readContract: async ({ functionName }) => {
      if (functionName === "owner") return OWNER;
      if (functionName === "accountOf") return official;
      if (functionName === "agents") return [BigInt(expiry), 1000, 1n];
      if (functionName === "balanceOf") return collateral;
      throw new Error(functionName);
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  };
  const funder = { sendTransaction: async (tx) => (sent.push(tx), "0xhash") };
  const opts = { floor: E18 / 20n, topUp: E18 / 4n, perKeyDaily: E18 / 2n, globalDaily: 25n * E18, minCollateral: 10_000_000n, lookbackBlocks: 50n, chunk: 2000n };
  return { sponsor: makeGasSponsor({ pub, funder, factory: FACTORY, usdc: USDC, log: () => {}, opts }), sent };
}

test("tops up an approved key that ran low, within the per-key daily cap", async () => {
  const { sponsor, sent } = world();
  await sponsor.tick();
  await sponsor.tick();
  await sponsor.tick();
  assert.equal(sent.length, 2); // 0.25 + 0.25 = the 0.5 daily cap
  assert.equal(sent[0].to, AGENT);
});

test("leaves keys with gas, expired keys, empty accounts and foreign accounts alone", async () => {
  for (const w of [world({ gas: E18 }), world({ expiry: 1 }), world({ collateral: 0n }), world({ official: OWNER })]) {
    await w.sponsor.tick();
    assert.equal(w.sent.length, 0);
  }
});
