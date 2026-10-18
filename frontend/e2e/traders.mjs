// Scripted traders: unlocked anvil accounts that mint test collateral and then open, bracket and close
// positions at random across all live markets, some with enough leverage to get liquidated. They use both
// execution paths the engine offers: keeper-filled orders and direct transactions against the fresh price.
import { maxUint256, parseUnits } from "viem";
import { FIRST_SCRIPTED_TRADER, account, artifact, log, publicClient, sleep, walletClient } from "./lib.mjs";

const usd = (n) => parseUnits(n.toFixed(2), 6);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export async function startTraders({ addresses, count, actionsPerSecond = 3, quiet = false }) {
  const pub = publicClient();
  const engineAbi = artifact("PerpEngine").abi;
  const lensAbi = artifact("EngineLens").abi;
  const usdcAbi = artifact("TestUSDC").abi;
  const traders = Array.from({ length: count }, (_, i) => account(FIRST_SCRIPTED_TRADER + i).address);
  const wallets = new Map(traders.map((address) => [address, walletClient(address)]));
  const stats = { actions: 0, rejected: 0 };
  let stopped = false;

  const send = async (from, address, abi, functionName, args) => {
    try {
      const hash = await wallets.get(from).writeContract({ address, abi, functionName, args, gas: 1_500_000n });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") stats.actions += 1;
      else stats.rejected += 1;
      return receipt.status === "success";
    } catch {
      stats.rejected += 1;
      return false;
    }
  };

  // Funding in small parallel batches keeps start-up short with a hundred accounts.
  for (let i = 0; i < traders.length; i += 10) {
    await Promise.all(
      traders.slice(i, i + 10).map(async (trader) => {
        await send(trader, addresses.usdc, usdcAbi, "mint", [trader, usd(20_000)]);
        await send(trader, addresses.usdc, usdcAbi, "approve", [addresses.engine, maxUint256]);
      }),
    );
  }
  if (!quiet) log("traders", `${count} scripted traders funded`);

  const act = async () => {
    const trader = pick(traders);
    const markets = await pub.readContract({ address: addresses.lens, abi: lensAbi, functionName: "getMarkets" });
    const now = Math.floor(Date.now() / 1000);
    const live = markets.filter((m) => m.hasPrice && m.market.enabled && (m.market.expiry === 0n || Number(m.market.expiry) > now + 5));
    if (live.length === 0) return;
    const positions = await pub.readContract({ address: addresses.lens, abi: lensAbi, functionName: "getTraderPositions", args: [trader] });
    const roll = Math.random();

    if (positions.length > 0 && (roll < 0.42 || positions.length >= 3)) {
      const view = pick(positions);
      // Half close through the keeper, half directly against the price already on-chain.
      if (Math.random() < 0.5) await send(trader, addresses.engine, engineAbi, "setTriggerOrder", [view.position.priceId, 3, 0n]);
      else await send(trader, addresses.engine, engineAbi, "closePosition", [view.position.priceId, 0n, []]);
      return;
    }
    if (positions.length > 0 && roll < 0.55) {
      const view = pick(positions);
      const pos = view.position;
      const up = (pos.entryPrice * 1012n) / 1000n;
      const down = (pos.entryPrice * 990n) / 1000n;
      await send(trader, addresses.engine, engineAbi, "setTriggerOrder", [pos.priceId, 1, pos.isLong ? up : down]);
      return;
    }

    const held = new Set(positions.map((v) => v.position.priceId.toLowerCase()));
    const candidates = live.filter((m) => !held.has(m.id.toLowerCase()));
    if (candidates.length === 0) return;
    const m = pick(candidates);
    const isLong = Math.random() < 0.52;
    // Direct opens stop at 100x; 1000x is exercised by the SDK smoke test and contracts/test/HighLeverage.t.sol.
    const maxLev = Math.min(100, Number(m.market.maxLeverage));
    // Mostly sensible leverage, with a tail of gamblers who feed the liquidation feed.
    const leverage = Math.random() < 0.25 ? maxLev : Math.max(2, Math.round(Math.random() * Math.min(25, maxLev)));
    const margin = usd(20 + Math.random() * 380);
    const size = margin * BigInt(leverage);
    if (Math.random() < 0.6) {
      const trigger = isLong ? (m.price.ask * 1005n) / 1000n : (m.price.bid * 995n) / 1000n;
      await send(trader, addresses.engine, engineAbi, "createLimitOrder", [{ priceId: m.id, isLong, margin, size, triggerPrice: trigger, takeProfit: 0n, stopLoss: 0n }]);
    } else {
      await send(trader, addresses.engine, engineAbi, "openPosition", [{ priceId: m.id, isLong, margin, size, acceptablePrice: 0n, takeProfit: 0n, stopLoss: 0n }, []]);
    }
  };

  // A few independent loops so actions interleave rather than queue behind one another.
  const lanes = Math.max(1, Math.min(4, Math.ceil(actionsPerSecond)));
  const loop = async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        await act();
      } catch {
        stats.rejected += 1;
      }
      await sleep(Math.max(0, (lanes * 1000) / actionsPerSecond - (Date.now() - started)));
    }
  };
  for (let i = 0; i < lanes; i += 1) void loop();

  return {
    stats,
    traders,
    stop() {
      stopped = true;
    },
  };
}
