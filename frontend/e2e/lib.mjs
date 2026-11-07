// Shared pieces of the local end-to-end harness.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FRONTEND = join(HERE, "..");
export const CONTRACTS_OUT = join(FRONTEND, "..", "contracts", "out");
export const STATE_DIR = join(HERE, ".state");
export const ADDRESSES_FILE = join(STATE_DIR, "addresses.json");

export const PORTS = {
  anvil: Number(process.env.ANVIL_PORT ?? 8645),
  kraken: Number(process.env.KRAKEN_PORT ?? 8647),
  web: Number(process.env.WEB_PORT ?? 8648),
};
export const RPC_URL = `http://127.0.0.1:${PORTS.anvil}`;
export const KRAKEN_URL = `http://127.0.0.1:${PORTS.kraken}`;
/** The static bundle is served under a sub-path on purpose, to prove it does not depend on the site root. */
export const BASE_PATH = "/arc";
export const WEB_URL = process.env.BASE ?? `http://127.0.0.1:${PORTS.web}${BASE_PATH}`;

/** Anvil's well-known development mnemonic. Never use it anywhere else. */
export const MNEMONIC = "test test test test test test test test test test test junk";
export const account = (index) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
export const DEPLOYER = account(0);
/** The account the browser's fake wallet controls. */
export const UI_TRADER = account(1);
/** Signs oracle updates and executes orders, liquidations and settlements. */
export const BOT = account(2);
export const FIRST_SCRIPTED_TRADER = 3;

export const FEEDS = {
  BTC: { id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8, kraken: "XBTUSD", krakenKey: "XXBTZUSD", price: 104_250, vol: 1 },
  ETH: { id: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", expo: -8, kraken: "ETHUSD", krakenKey: "XETHZUSD", price: 3_890, vol: 1.2 },
  SOL: { id: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8, kraken: "SOLUSD", krakenKey: "SOLUSD", price: 182.4, vol: 1.6 },
  EUR: { id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b", expo: -5, kraken: "EURUSD", krakenKey: "ZEURZUSD", price: 1.0842, vol: 0.15 },
  JPY: { id: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52", expo: -3, kraken: "USDJPY", krakenKey: "ZUSDZJPY", price: 151.23, vol: 0.15 },
  XAU: { id: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", expo: -3, kraken: "PAXGUSD", krakenKey: "PAXGUSD", price: 2_655.4, vol: 0.4 },
};

export function artifact(name) {
  // Contracts that share a source file with another one.
  const source = { AgentAccountFactory: "AgentAccount" }[name] ?? name;
  const file = join(CONTRACTS_OUT, `${source}.sol`, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Build the contracts first: cd contracts && forge build --offline --skip test --skip script`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export const transport = () => http(RPC_URL, { batch: false, retryCount: 0 });
export const publicClient = () => createPublicClient({ chain: foundry, transport: transport(), pollingInterval: 100 });
/** A wallet client that signs locally (mnemonic account) or asks anvil to (unlocked address string). */
export const walletClient = (acct) => createWalletClient({ chain: foundry, transport: transport(), account: acct });

export function readAddresses() {
  if (!existsSync(ADDRESSES_FILE)) throw new Error("The stack is not running: start it with `node e2e/stack.mjs`.");
  return JSON.parse(readFileSync(ADDRESSES_FILE, "utf8"));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (scope, ...args) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${scope}]`, ...args);
