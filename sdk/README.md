# @dry-powder/sdk

TypeScript SDK for [Dry Powder](https://0xandersen.github.io/dry-powder/trade/), the open, risk-first perps venue
on Arc (USDC gas). Markets, worst-case quotes, keeper-filled orders up to 1000x, stops, and agent accounts that
let a bot trade but never withdraw. Built on [viem](https://viem.sh).

```bash
npm install @dry-powder/sdk viem      # or, from this repo: cd sdk && npm ci && npm run build
```

## Worst case first

```ts
import { DryPowder, usd, price, pct, fromUsd } from "@dry-powder/sdk";
import { privateKeyToAccount } from "viem/accounts";

const dp = await DryPowder.connect({ account: privateKeyToAccount(process.env.KEY as `0x${string}`) });

const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
console.log(`most you can lose ${fromUsd(q.risk.maxLoss)} USDC`);        // margin + fees, never more
console.log(`liquidated after a ${pct(q.risk.liquidationMove)} move`);  // 0.09% at 1000x
console.log(q.risk.level, q.risk.keeperOrdersOnly);                     // "extreme", true

const { orderId } = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: price(99_960) });
await dp.waitForFill(orderId);
await dp.close("BTC"); // above 100x this is a keeper Close order
```

`market.price` is the oracle price when it is fresh enough to trade on directly; `market.lastPrice` is the last
price on-chain even when older. Quotes and keeper orders use the fresh one if there is one, else the last one
(the keeper always fills at a newer price), or `referencePrice` if you pass your own.

`connect()` with no `deployment` loads the live Arc Testnet deployment from this repository and fails over across
Arc's public RPCs. Pass `deployment` (an object, a path or a URL) for any other one.

## The rules the SDK follows (and the engine enforces)

| Rule | Value |
| --- | --- |
| Leverage | 1x to the market's maximum: BTC, ETH 1000x; SOL 500x; EUR, gold, BTC future 250x; JPY, ETH-BTC 100x |
| Above 100x | Opens and closes only through keeper-filled orders, which always fill at a price published after the order |
| Liquidation | When losses plus funding reach 90% of margin. You can never lose more than margin plus fees |
| Fees | 5 bp of size plus a skew surcharge, capped at 10% of margin per side |
| Profit cap | 10x margin per position |

`assessRisk`, `liquidationPrice`, `profitCapPrice`, `needsKeeperOrders`, `feeCap` and `riskLevel` are pure
functions with the same maths, for use in loops and backtests without a network.

## Agent accounts

An owner creates an account, funds it and approves an agent key with an on-chain policy (expiry, max leverage,
max margin per order). The agent can trade from it; only the owner can withdraw.

```ts
const owner = await DryPowder.connect({ account: ownerKey });
const account = await owner.createAgentAccount();
await owner.approveAgent(account, agentKey.address, { expiresInSeconds: 86_400, maxLeverage: 50, maxMarginPerOrder: usd(100) });

const agent = await DryPowder.connect({ account: agentKey, agentAccount: account });
await agent.open({ market: "ETH", side: "short", margin: usd(20), leverage: 25, stopLoss: price(3_900) });
```

## Units

Sizes and margins are USDC with 6 decimals (`usd(12.5)`); prices have 18 decimals (`price(100_000)`).
`fromUsd`, `fromPrice` and `pct` convert back for display.

## Also here

- `examples/` in the repository root: a risk-capped trend agent and a swarm runner.
- The generated contract ABIs are exported (`perpEngineAbi`, `engineLensAbi`, `agentAccountAbi`, ...).
- `test/risk.test.mjs` (unit) and `test/smoke.mjs` (against the local stack in `frontend/e2e/with-keeper.sh`).
