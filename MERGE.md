# Merging Project Nexus into Dry Powder

Decision record, 2026-10-12. Input: the Nexus repository bundle (main plus five unfinished `feat/*` branches), its
Arc Testnet state (v1 to v3 deployments, escape proofs) and the Migration & Merge Pack.

## The question

What gives retail traders and AI agents the best trading experience on Arc **today**, and which Nexus pieces
help with that?

## The answer in one paragraph

Dry Powder stays the venue. Its model (an on-chain engine, a USDC vault that takes the other side of every trade
at the oracle price, keeper-filled orders) works with one contract set and one keeper, needs no market makers,
and fills any size up to the open-interest cap from the first minute. Nexus is a stronger long-term settlement
design (an off-chain matching engine verified on Arc by attestors and later zk proofs, with a provable escape
hatch), but it needs a sequencer, three attestors, a relayer and a market maker running, an order book that is
empty without them, and its own pack lists RPC access, a live price source and proving compute as open
blockers. So Dry Powder takes Nexus's best **product** ideas, the ones aimed at agents and at safety, and leaves
the settlement stack for later.

## Taken

| From Nexus | In Dry Powder | Why it matters |
| --- | --- | --- |
| Agent keys that can trade but never withdraw (SPEC §2, at most 32 agents per account) | `AgentAccount` + `AgentAccountFactory` (`contracts/src/AgentAccount.sol`): an account owned by a wallet; agents get an on-chain policy (expiry, max leverage, max margin per order, optional market list); the engine pays only the account; only the owner can move tokens out. 15 tests, incl. fuzzed "agent cannot withdraw" | The core requirement for letting an agent swarm trade real balances. Nexus enforced it in the off-chain engine; here the contract enforces it |
| MCP server with guardrails (`mcp/`: notional cap, allowed markets, slippage cap and price band, two-step confirmation, refusal of the owner key) | `mcp/`: `dp_markets`, `dp_account`, `dp_quote`, `dp_open`, `dp_limit`, `dp_close`, `dp_set_tpsl`, `dp_cancel`, `dp_faucet`; trades from an agent account | Any MCP client (Claude and others) can trade the venue with limits set by a human |
| "Exits never pause" principle | Already true in the engine (close, cancel, claim, liquidation and settlement are not pausable); the keeper now gives traders 10 minutes to close a settled dated position themselves before sweeping | Confirms the existing design against Nexus's rule |
| Arc operating knowledge (20 gwei floor, 10,000-block `eth_getLogs` cap, USDC's two decimal faces, Multicall3, Safe v1.4.1 addresses, Chainlink feed addresses on Arc mainnet) | Already honoured (the app reads logs in 2,000-block spans; contracts use the 6-decimal interface); mainnet Chainlink feeds recorded in `docs/ARC_NOTES.md` for the mainnet oracle path | Avoids re-learning what Nexus learned on chain |
| Test-harness lesson: a closed market is a ticker that stops changing | The keeper never publishes a feed whose Kraken ticker has been frozen for 60 s; the local Kraken mock now freezes the ticker the same way | No fills against weekend FX prices |

## Left out, and why

| Nexus piece | Why not now |
| --- | --- |
| Off-chain sequencer, CLOB and STF (`engine/`, Rust) | A second settlement model. Retail and agents need guaranteed fills now; an empty order book does not give them that. Worth revisiting as a second venue once there is volume |
| Attestors, relayer, `NexusPortal`, escape hatch, SP1 guest | Only meaningful with the off-chain engine. Dry Powder's state is on-chain already, so users exit with Arc alone |
| `nexus-mm` market-making bot | The vault is the counterparty; nothing to quote |
| `feat/pools` (AMM-style curves) | The vault already is the pool; a curve would replace oracle pricing, which is what makes fills predictable |
| `feat/baskets` (multi-leg orders) | Useful later as a router over single-market positions; unfinished in Nexus (envelope-size problem) |
| `feat/oracle` (Chainlink `pokeOracle`) | Chainlink Data Feeds exist only on Arc mainnet and update every few minutes, too slow for leverage. Noted for mainnet |
| `feat/ops` (rate limits, metrics) | For the sequencer's HTTP API, which Dry Powder does not have. The keeper exposes `/health` |
| Nexus UI | Dry Powder's trading terminal is further along (keeper-filled orders, TP/SL on chart, risk sizing, activity feed, watch mode) |
| Nexus testnet deployments and Safe keys | Not reused: Dry Powder deploys fresh with its own keys. The escape proofs stay a Nexus record |

## Still open after the merge

- Oracle: the testnet runs on `PublisherOracle` (whoever holds the publisher key sets prices). Mainnet needs a
  real source: Pyth (paid Hermes key), Chainlink Data Streams, or Stork. Same blocker as Nexus.
- Governance: Dry Powder's owner acts immediately. Before mainnet, put ownership behind a Safe and a timelock
  as Nexus did.
- Stale-oracle exit: if the publisher stops, positions cannot be closed at a price until it returns. A
  margin-back exit after a long oracle outage would close that gap (needs ~1 KB of the engine's 1,347-byte
  headroom).
