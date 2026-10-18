// Read-only: every market, its price, and what 10 USDC of margin risks at each leverage. No key needed.
//   cd sdk && npm ci && npm run build && cd ../examples && npm i && node quickstart.mjs
import { DryPowder, fromPrice, fromUsd, pct, usd } from "@dry-powder/sdk";

const dp = await DryPowder.connect({ deployment: process.env.DEPLOYMENT });
const markets = await dp.markets();
console.log(`${markets.length} markets on chain ${dp.deployment.chainId}\n`);
for (const m of markets) {
  const last = m.price ?? m.lastPrice;
  const px = last ? fromPrice(last.mid).toPrecision(7) : "no price";
  console.log(`${m.symbol.padEnd(16)} ${m.kind.padEnd(13)} up to ${String(m.maxLeverage).padStart(4)}x  ${px}`);
}

console.log("\n10 USDC of margin on BTC-USD, long:");
for (const leverage of [5, 25, 100, 250, 1000]) {
  const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage });
  console.log(
    `${String(leverage).padStart(5)}x  size ${fromUsd(q.size).toFixed(0).padStart(6)}  ` +
      `liquidated after ${pct(q.risk.liquidationMove).padStart(7)}  most you can lose ${fromUsd(q.risk.maxLoss).toFixed(2)}  ` +
      `risk ${q.risk.level}${q.risk.keeperOrdersOnly ? "  (keeper orders only)" : ""}`,
  );
}
