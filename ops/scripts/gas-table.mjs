// Renders the measured gas table of the last acceptance run (test/output) into README.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (n) => JSON.parse(readFileSync(join(root, "test/output", n), "utf8"));
const gas = rd("gas.json"), res = rd("result.json"), sum = rd("summary.json"), pre = rd("preflight.json");
const groups = [
  ["Deploy (7 contracts)", (k) => k.startsWith("deploy:")],
  ["Configure: 8 markets, risk params, vault seed, approvals by deployer", (k) => ["addMarket", "setRiskParams", "seed:mint", "seed:deposit"].includes(k)],
  ["Fund 102 accounts (Multicall3 batches) + top-ups", (k) => k.startsWith("fund:")],
  ["Publisher heartbeats", (k) => k === "push"],
  ["Keeper: order execution", (k) => k.startsWith("exec:")],
  ["Keeper: liquidations, settlement, epochs", (k) => ["liquidateBatch", "settleMarket", "settlePositions", "settleEpoch"].includes(k)],
  ["Agents: direct opens and closes", (k) => ["open", "open+brackets", "close"].includes(k)],
  ["Agents: orders (limit, trigger, cancel)", (k) => k.startsWith("limit:") || k.startsWith("trigger:") || k === "cancelOrder"],
  ["Agents: approvals, staking, yield, LP", (k) => ["approve", "stake", "claimYield", "lpDeposit", "lpRedeem"].includes(k)],
];
const f = (n) => n.toLocaleString("en-US");
let out = `Measured on the local chain (anvil, cancun, via-IR build of \`contracts/src\`), full acceptance run: ${res.agents} agents, ` +
  `${sum.trades.roundTrips} round trips, ${res.runMinutes} minute pace, base fee pinned at 20 gwei, tip 1 gwei.\n\n` +
  `| transaction type | count | avg gas | max gas | USDC at 20 gwei |\n| --- | ---: | ---: | ---: | ---: |\n`;
for (const [k, v] of Object.entries(gas.byType)) out += `| \`${k}\` | ${v[0]} | ${f(v[1])} | ${f(v[2])} | ${v[3].toFixed(4)} |\n`;
out += `\n| group | gas | USDC at 20 gwei |\n| --- | ---: | ---: |\n`;
let tot = 0;
for (const [name, pred] of groups) {
  const g = Object.entries(gas.byType).filter(([k]) => pred(k)).reduce((a, [, v]) => a + v[0] * v[1], 0);
  tot += g;
  out += `| ${name} | ${f(g)} | ${(g * 20e-9).toFixed(3)} |\n`;
}
out += `| **Total** | **${f(gas.totalGas)}** | **${gas.usdcAt20gwei.toFixed(3)}** |\n\n`;
out += `Arithmetic: ${f(gas.totalGas)} gas x 20 gwei = ${gas.usdcAt20gwei.toFixed(3)} USDC; with the default 1 gwei tip (21 gwei effective) ` +
  `${(gas.totalGas * 21e-9).toFixed(3)} USDC. The deployer's balance, measured, went from 40 to ${(40 - res.nativeSpent).toFixed(3)} after ` +
  `\`sweep({returnGas:true})\`: **${res.nativeSpent.toFixed(3)} USDC net** for the whole run (the extra 0.09 is the 102 return transfers at 21,000 gas each, sent after this table was read, and ` +
  `dust left in the accounts). \`preflight()\` had estimated ${f(pre.gas.total)} gas (${pre.costUsdc.total.toFixed(3)} USDC at 21 gwei) before anything was sent.\n\n` +
  `Cash flow matters more than the total: floats leave the deployer up front (100 x ${pre.floats.perAgent} + keeper ${pre.floats.keeper} + publisher ${pre.floats.publisher} = ` +
  `${pre.floats.total} USDC) and are topped up in ${"`"}topUpAmount${"`"} steps as accounts run low (${sum.gas.topUps} top-ups, ${sum.gas.topUpUsdc.toFixed(2)} USDC, in this run). ` +
  `An account must hold \`gasLimit x maxFeePerGas\` (41 gwei) for its next transaction, about 0.06 USDC for a bracketed open, so roughly that much per agent is ` +
  `still in the accounts at the end: ${res.returned.usdc.toFixed(2)} USDC came back from ${res.returned.accounts} accounts. \`preflight().required\` ` +
  `(${pre.required.toFixed(2)} USDC here) is that peak, not the spend.\n\n` +
  `Why an open costs ${f(gas.byType.open[1])} gas: the engine's OI cap reads \`vault.totalAssets()\`, which marks the whole book ` +
  `(\`unrealizedTraderPnl\` loops every market with open interest, one oracle read each). Measured mid-run with all 8 markets active that read alone is ` +
  `${f(res.probe.mid.vaultTotalAssetsGas)} gas (${f(res.probe.flat.vaultTotalAssetsGas)} with an empty book). Each bracket adds about 160k (a 10-slot order). ` +
  `For a 30 minute run on Arc add the publisher: 180 heartbeats x about 150k gas = 0.54 USDC (the 7 minute test run had ${gas.byType.push[0]} pushes because the mock moves more than 5 bp almost every second).\n`;
const p = join(root, "README.md");
const s = readFileSync(p, "utf8");
const a = s.indexOf("<!-- GAS-TABLE -->"), b = s.indexOf("<!-- /GAS-TABLE -->");
writeFileSync(p, b > 0 ? s.slice(0, a) + "<!-- GAS-TABLE -->\n" + out + s.slice(b) : s.replace("<!-- GAS-TABLE -->", "<!-- GAS-TABLE -->\n" + out + "<!-- /GAS-TABLE -->"));
console.log(out);
