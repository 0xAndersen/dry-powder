// Gas sponsorship for instant trading (testnet): keeps the gas of approved session keys topped up from the
// funder, so a trader who set up instant trading never has to visit the faucet again while the key is live.
// Bounded per key and per day, and only for keys trading from accounts that hold collateral.
import { parseAbiItem } from "viem";
import { agentAccountAbi, agentAccountFactoryAbi, testUSDCAbi } from "./abi.mjs";

const ACCOUNT_CREATED = parseAbiItem("event AccountCreated(address indexed owner, address indexed account)");
const AGENT_SET = parseAbiItem("event AgentSet(address indexed agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin)");
const AGENT_REVOKED = parseAbiItem("event AgentRevoked(address indexed agent)");

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * @param o.pub public client; o.funder wallet client that pays; o.factory AgentAccountFactory; o.usdc collateral
 * @param o.opts { floor, topUp, perKeyDaily, globalDaily (all native wei), minCollateral (6-dec), lookbackBlocks, chunk }
 */
export function makeGasSponsor({ pub, funder, factory, usdc, log, opts }) {
  const { floor, topUp, perKeyDaily, globalDaily, minCollateral, lookbackBlocks, chunk } = opts;
  const accounts = new Set(); // known AgentAccounts (lower-case)
  const keys = new Map(); // agent (lower-case) -> { agent, account, expiry }
  let cursor = null; // next block to scan
  let day = utcDay();
  let spentToday = 0n;
  const spentByKey = new Map();
  const stats = { sponsored: 0, spent: "0", keys: 0, skipped: {} };
  const skip = (why) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);

  async function logs(event, address, from, to) {
    const out = [];
    for (let start = from; start <= to; start += chunk) {
      const end = start + chunk - 1n > to ? to : start + chunk - 1n;
      out.push(...(await pub.getLogs({ address, event, fromBlock: start, toBlock: end })));
    }
    return out;
  }

  async function scan() {
    const head = await pub.getBlockNumber();
    if (cursor === null) cursor = head > lookbackBlocks ? head - lookbackBlocks : 0n;
    if (cursor > head) return;
    for (const l of await logs(ACCOUNT_CREATED, factory, cursor, head)) accounts.add(l.args.account.toLowerCase());
    if (accounts.size > 0) {
      const list = [...accounts];
      for (const l of await logs(AGENT_SET, list, cursor, head)) {
        keys.set(l.args.agent.toLowerCase(), { agent: l.args.agent, account: l.address, expiry: Number(l.args.expiry) });
      }
      for (const l of await logs(AGENT_REVOKED, list, cursor, head)) keys.delete(l.args.agent.toLowerCase());
    }
    cursor = head + 1n;
    stats.keys = keys.size;
  }

  async function tick() {
    if (utcDay() !== day) {
      day = utcDay();
      spentToday = 0n;
      spentByKey.clear();
    }
    await scan();
    const now = Math.floor(Date.now() / 1000);
    for (const k of keys.values()) {
      if (k.expiry <= now) continue;
      if (spentToday + topUp > globalDaily) return skip("global-daily-cap");
      const id = k.agent.toLowerCase();
      if ((spentByKey.get(id) ?? 0n) + topUp > perKeyDaily) {
        skip("key-daily-cap");
        continue;
      }
      const gas = await pub.getBalance({ address: k.agent });
      if (gas >= floor) continue;
      // Only real accounts from this factory, with the key still approved and collateral in the account.
      const owner = await pub.readContract({ address: k.account, abi: agentAccountAbi, functionName: "owner" }).catch(() => null);
      if (!owner) continue;
      const official = await pub.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner] });
      if (official.toLowerCase() !== k.account.toLowerCase()) {
        skip("not-factory-account");
        continue;
      }
      const policy = await pub.readContract({ address: k.account, abi: agentAccountAbi, functionName: "agents", args: [k.agent] });
      if (Number(policy[0]) <= now) {
        keys.delete(id);
        continue;
      }
      const collateral = await pub.readContract({ address: usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [k.account] });
      if (collateral < minCollateral) {
        skip("no-collateral");
        continue;
      }
      const hash = await funder.sendTransaction({ to: k.agent, value: topUp });
      await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      spentToday += topUp;
      spentByKey.set(id, (spentByKey.get(id) ?? 0n) + topUp);
      stats.sponsored += 1;
      stats.spent = (BigInt(stats.spent) + topUp).toString();
      log("sponsor", `topped up session key ${k.agent} (account ${k.account}) with gas: ${hash}`);
    }
  }

  return { tick, stats };
}
