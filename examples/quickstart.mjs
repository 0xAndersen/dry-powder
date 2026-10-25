// Read-only: every market, its price, and what 10 USDC of margin risks at each leverage. No key needed.
//   cd sdk && npm ci && npm run build && cd ../examples && npm i && node quickstart.mjs
import { DryPowder, fromPrice, fromUsd, pct, usd } from "@dry-powder/sdk";

const dp = await DryPowder.connect({ deployment: process.env.DEPLOYMENT });
const markets = await dp.markets();
console.log(`${markets.length} markets on chain ${dp.deployment.chainId}\n`);
for (const m of markets) {
  const last = m.price ?? m.lastPrice;
  const px = last ? fromPrice(last.mid).toPrecision(7) : "no price";
  const fees = m.feeModel === "upside" ? "no fee unless you win" : "fees on notional";
  console.log(`${m.symbol.padEnd(16)} ${m.kind.padEnd(13)} up to ${String(m.maxLeverage).padStart(4)}x  ${px.padEnd(12)} ${fees}`);
}

const show = async (market, leverages) => {
  console.log(`\n10 USDC of margin on ${market}, long:`);
  for (const leverage of leverages) {
    const q = await dp.quote({ market, side: "long", margin: usd(10), leverage });
    console.log(
      `${String(leverage).padStart(5)}x  size ${fromUsd(q.size).toFixed(0).padStart(6)}  ` +
        `liquidated after ${pct(q.risk.liquidationMove, 3).padStart(7)}  most you can lose ${fromUsd(q.risk.maxLoss).toFixed(2)}  ` +
        `most you can make ${fromUsd(q.risk.maxProfit).toFixed(2)}  risk ${q.risk.level}${q.risk.keeperOrdersOnly ? "  (keeper orders only)" : ""}`,
    );
  }
};
await show("BTC-USD", [5, 25, 100, 250, 1000]);
// Turbo: no fee to open or close, mid-price fills; a winning close pays the house a share of its profit.
if (markets.some((m) => m.symbol === "BTC-USD-TURBO")) {
  await show("BTC-USD-TURBO", [100, 1000, 2500, 5000]);
  console.log(`\n${(await dp.quote({ market: "BTC-USD-TURBO", side: "long", margin: usd(10), leverage: 1000 })).feeNote}`);
}
