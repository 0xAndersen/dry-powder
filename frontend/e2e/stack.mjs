// Starts everything the UI needs, locally and offline:
//   anvil  ->  v2 contracts (PublisherOracle + TestUSDC)  ->  publisher/keeper bot  ->  mock Kraken
//   ->  the static bundle served under /arc/  ->  optional scripted traders.
//
//   node e2e/stack.mjs                      # stack only
//   TRADERS=100 RATE=4 node e2e/stack.mjs   # plus 100 scripted traders, about 4 actions per second
//
// Environment: TRADERS, RATE, EXPIRY_SECONDS (dated future, default 240), SETTLE_DELAY (default 20),
// EPOCH_SECONDS (60), LOCK_SECONDS (20), STREAM_SECONDS (60), VOLATILITY (1), ANVIL_PORT, KRAKEN_PORT, WEB_PORT,
// ANVIL (path to the anvil binary).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADDRESSES_FILE, PORTS, STATE_DIR, WEB_URL, log, publicClient, sleep } from "./lib.mjs";
import { startBot } from "./bot.mjs";
import { deploy } from "./deploy.mjs";
import { startKrakenMock } from "./kraken-mock.mjs";
import { PriceModel } from "./prices.mjs";
import { startStaticServer } from "./static-server.mjs";
import { startTraders } from "./traders.mjs";

const env = (name, fallback) => Number(process.env[name] ?? fallback);
const traderCount = env("TRADERS", 0);

function findAnvil() {
  if (process.env.ANVIL) return process.env.ANVIL;
  const local = join(homedir(), ".foundry", "bin", "anvil");
  return existsSync(local) ? local : "anvil";
}

mkdirSync(STATE_DIR, { recursive: true });
rmSync(ADDRESSES_FILE, { force: true });
// `kill $(cat e2e/.state/stack.pid)` stops everything, anvil included.
writeFileSync(join(STATE_DIR, "stack.pid"), String(process.pid));

const anvil = spawn(findAnvil(), ["--port", String(PORTS.anvil), "--chain-id", "31337", "--accounts", String(Math.max(10, traderCount + 5)), "--balance", "100000", "--silent"], {
  stdio: ["ignore", "inherit", "inherit"],
});
anvil.on("exit", (code) => {
  log("stack", `anvil exited (${code})`);
  process.exit(code ?? 1);
});

const pub = publicClient();
for (let i = 0; ; i += 1) {
  try {
    await pub.getBlockNumber();
    break;
  } catch {
    if (i > 50) throw new Error("anvil did not start");
    await sleep(200);
  }
}

const addresses = await deploy({
  lockSeconds: env("LOCK_SECONDS", 20),
  epochSeconds: env("EPOCH_SECONDS", 60),
  streamSeconds: env("STREAM_SECONDS", 60),
  expirySeconds: env("EXPIRY_SECONDS", 240),
  vaultDeposit: env("VAULT_DEPOSIT", 1_000_000),
});

const model = new PriceModel({ volatility: env("VOLATILITY", 1) });
model.start();
const kraken = startKrakenMock(model);
// EXTERNAL_KEEPER=1 leaves the publisher + keeper roles to the production keeper (keeper/src/main.mjs), which is
// how CI checks it: run it against this stack with PUBLISHER_KEY/KEEPER_KEY = the BOT account.
const external = process.env.EXTERNAL_KEEPER === "1";
const idle = { stats: { published: "external", executed: "external", liquidated: "external", settled: "external" }, stop() {} };
const bot = external ? idle : startBot({ addresses, model, settleDelaySeconds: env("SETTLE_DELAY", 20) });
const web = startStaticServer(addresses);
writeFileSync(ADDRESSES_FILE, `${JSON.stringify({ ...addresses, web: WEB_URL }, null, 2)}\n`);

let traders = null;
if (traderCount > 0) traders = await startTraders({ addresses, count: traderCount, actionsPerSecond: env("RATE", 3) });

log("stack", `ready: ${WEB_URL}/trade/`);
const report = setInterval(() => {
  log("stack", `oracle updates ${bot.stats.published}, orders executed ${bot.stats.executed}, liquidated ${bot.stats.liquidated}, settled ${bot.stats.settled}` + (traders ? `, trader actions ${traders.stats.actions} (${traders.stats.rejected} rejected)` : ""));
}, 30_000);

const shutdown = () => {
  clearInterval(report);
  traders?.stop();
  bot.stop();
  model.stop();
  kraken.close();
  web.close();
  rmSync(ADDRESSES_FILE, { force: true });
  anvil.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
