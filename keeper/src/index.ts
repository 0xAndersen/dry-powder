import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError, loadConfig } from "./config.js";
import { Keeper } from "./keeper.js";
import { describeError, log, setLogLevel } from "./logger.js";
import { PriceFeed } from "./prices.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  // On Arc, USDC is the native gas token (18 decimals natively; the ERC-20 interface uses 6).
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 5042002 ? "Arc Testnet" : `Arc (${cfg.chainId})`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  // viem retries transient RPC failures (timeouts, 429s, 5xx) with exponential backoff.
  const transport = http(cfg.rpcUrl, { retryCount: 4, retryDelay: 200, timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
  const walletClient = createWalletClient({ chain, transport, account: privateKeyToAccount(cfg.privateKey) });

  const pricesHolder: { feed?: PriceFeed } = {};
  let keeper: Keeper | undefined;
  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    keeper?.stop();
    pricesHolder.feed?.stop();
    // Let an in-flight transaction's receipt arrive before exiting.
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // The chain may not be reachable yet when the container starts; keep trying rather than crash-looping.
  for (let attempt = 1; ; attempt++) {
    try {
      const candidate = new Keeper(cfg, publicClient, walletClient);
      const ids = await candidate.init();
      const feed = new PriceFeed(cfg.hermesUrl, ids);
      pricesHolder.feed = feed;
      await feed.start();
      candidate.start(feed);
      keeper = candidate;
      return;
    } catch (err) {
      pricesHolder.feed?.stop();
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      log.error("startup failed; retrying", { attempt, retryInMs: delay, error: describeError(err) });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: describeError(reason) }));

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error(`configuration error: ${err.message}`);
    process.exit(2);
  }
  log.error("fatal", { error: describeError(err) });
  process.exit(1);
});
