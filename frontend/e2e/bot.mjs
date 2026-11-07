// Plays the two off-chain roles the testnet deployment has: the price publisher and the keeper.
//
// Every tick it signs one update per feed (the format in V2_SPEC.md) and posts them to the PublisherOracle,
// then executes every order whose condition holds, liquidates what is past the threshold and settles
// expired dated markets.
import { encodeAbiParameters, keccak256 } from "viem";
import { BOT, FEEDS, artifact, log, publicClient, walletClient } from "./lib.mjs";

const UPDATE_TYPES = [{ type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint64" }, { type: "bytes" }];
const DIGEST_TYPES = [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint64" }];

export async function signUpdate(chainId, oracle, { id, price, conf, expo }, publishTime) {
  const digest = keccak256(encodeAbiParameters(DIGEST_TYPES, [BigInt(chainId), oracle, id, price, conf, expo, BigInt(publishTime)]));
  const sig = await BOT.signMessage({ message: { raw: digest } });
  return encodeAbiParameters(UPDATE_TYPES, [id, price, conf, expo, BigInt(publishTime), sig]);
}

export function startBot({ addresses, model, intervalMs = 1_000, settleDelaySeconds = 20, quiet = false }) {
  const pub = publicClient();
  const wallet = walletClient(BOT);
  const engineAbi = artifact("PerpEngine").abi;
  const lensAbi = artifact("EngineLens").abi;
  const oracleAbi = artifact("PublisherOracle").abi;
  const stats = { published: 0, executed: 0, liquidated: 0, settled: 0, errors: 0 };
  let busy = false;
  let lastPublish = 0;
  let stopped = false;
  let chainId;

  const write = async (address, abi, functionName, args) => {
    // Simulating first is what a real keeper does: a call that would revert costs nothing.
    await pub.simulateContract({ address, abi, functionName, args, account: BOT.address });
    const hash = await wallet.writeContract({ address, abi, functionName, args, gas: 3_000_000n });
    return pub.waitForTransactionReceipt({ hash });
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      chainId ??= await pub.getChainId();
      const block = await pub.getBlock();
      const chainNow = Number(block.timestamp);
      // Strictly newer than the last update, never more than the oracle's two-second future allowance.
      const publishTime = Math.max(lastPublish + 1, Math.min(Math.floor(Date.now() / 1000), chainNow + 1));
      const updates = [];
      for (const key of Object.keys(FEEDS)) {
        if (model.frozen.has(key)) continue;
        updates.push(await signUpdate(chainId, addresses.publisherOracle, model.oracle(key), publishTime));
      }
      if (updates.length > 0) {
        await write(addresses.publisherOracle, oracleAbi, "updatePriceFeeds", [updates]);
        lastPublish = publishTime;
        stats.published += 1;
      }

      const markets = await pub.readContract({ address: addresses.lens, abi: lensAbi, functionName: "getMarkets" });
      const price = new Map(markets.filter((m) => m.hasPrice).map((m) => [m.id.toLowerCase(), m.price]));

      // Dated markets: fix the settlement price a little after expiry (the delay lets the UI show the gap).
      for (const m of markets) {
        const expiry = Number(m.market.expiry);
        if (expiry === 0 || m.market.settlementPrice !== 0n || chainNow < expiry + settleDelaySeconds) continue;
        try {
          await write(addresses.engine, engineAbi, "settleMarket", [m.id, []]);
          stats.settled += 1;
          if (!quiet) log("keeper", `settled ${m.market.symbol}`);
        } catch {
          // Needs a price published after expiry; the next tick has one.
        }
      }

      // Orders: execute everything whose condition holds at the prices just published.
      const [ids, orders] = await pub.readContract({ address: addresses.lens, abi: lensAbi, functionName: "getOrders", args: [0n, 400n] });
      for (let i = 0; i < ids.length; i += 1) {
        const o = orders[i];
        const px = price.get(o.priceId.toLowerCase());
        if (!px || px.publishTime < o.createdAt) continue;
        let met;
        if (o.orderType === 0) met = o.isLong ? px.ask <= o.triggerPrice : px.bid >= o.triggerPrice;
        else if (o.orderType === 3) met = o.triggerPrice === 0n || (o.isLong ? px.bid >= o.triggerPrice : px.ask <= o.triggerPrice);
        else met = (o.isLong === (o.orderType === 1)) ? px.mid >= o.triggerPrice : px.mid <= o.triggerPrice;
        if (!met) continue;
        try {
          await write(addresses.engine, engineAbi, "executeOrder", [ids[i], []]);
          stats.executed += 1;
        } catch {
          // Typical reasons: a position already exists in that market, or the position was opened this second.
        }
      }

      // Liquidations.
      const positions = await pub.readContract({ address: addresses.lens, abi: lensAbi, functionName: "getPositions", args: [0n, 600n] });
      const keys = [];
      for (const v of positions) {
        const px = price.get(v.position.priceId.toLowerCase());
        if (!px) continue;
        const liq = v.liquidationPrice;
        if (v.position.isLong ? px.mid <= liq : px.mid >= liq) keys.push(v.key);
      }
      for (let i = 0; i < keys.length; i += 25) {
        try {
          await write(addresses.engine, engineAbi, "liquidateBatch", [keys.slice(i, i + 25), []]);
          stats.liquidated += Math.min(25, keys.length - i);
        } catch {
          // Someone closed in between.
        }
      }
    } catch (error) {
      stats.errors += 1;
      if (!quiet && stats.errors < 5) log("keeper", "tick failed:", String(error?.shortMessage ?? error?.message ?? error).split("\n")[0]);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  void tick();
  return {
    stats,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
