# Contributing

Dry Powder is open infrastructure for people and agents trading on Arc. Contributions are welcome: contracts,
the app, the keeper, the MCP server, the SDK, examples and docs.

## Layout

| Path | Stack | Check |
| --- | --- | --- |
| `contracts/` | Foundry, Solidity 0.8.28 | `forge test` |
| `frontend/` | Next.js, wagmi, viem | `npx tsc --noEmit`; `e2e/with-keeper.sh` end to end |
| `keeper/` | Node 22, viem | runs inside `frontend/e2e/with-keeper.sh` |
| `mcp/` | Node 22, MCP SDK | `npm test`; smoke test in `with-keeper.sh` |
| `sdk/` | TypeScript, viem | `npm test`; smoke test in `with-keeper.sh` |
| `examples/` | Node, the SDK | `node quickstart.mjs` against testnet |
| `ops/` | Node, Playwright | `npm test` (the 100-agent run) |

After changing a contract's interface, run `node scripts/export-abis.mjs` (after `forge build`): it regenerates
the ABI modules for the app, the keeper, the MCP server and the SDK.

## Rules of the road

- **Risk changes need tests.** Anything that can change what a trader can lose, what the vault owes, or who can
  move funds comes with a test that would fail without it. `contracts/test/HighLeverage.t.sol` is a good model.
- **Say the number.** UI and docs copy follows `BRAND.md`: plain, short, worst case first. Never hype leverage.
- **Keys.** Testnet keys only, never in commits, issues or logs. Workflows derive role keys from `DEPLOYER_KEY`.
- **Security issues** go to a private advisory (Security tab), not an issue. `SECURITY.md` lists what is known.

## Pull requests

Small and focused is best. Explain the why, and fill in the risk section of the template. CI runs the contract
tests, the app typecheck and build, and the whole-system run.
