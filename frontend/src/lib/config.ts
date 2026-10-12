import { isAddress, getAddress, type Address } from "viem";

/** Deployment-specific settings, read from the container environment on every request. */
export type RuntimeConfig = {
  chainId: number;
  rpcUrl: string;
  hermesUrl: string;
  explorerUrl: string;
  perpEngine: Address;
  houseVault: Address;
  rewardToken: Address;
  usdc: Address;
  pyth: Address;
};

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; problems: string[] };

const DEFAULTS = {
  USDC_ADDRESS: "0x3600000000000000000000000000000000000000",
  PYTH_ADDRESS: "0x2880aB155794e7179c9eE2e38200202908C17B43",
  RPC_URL: "https://rpc.testnet.arc.network",
  HERMES_URL: "https://hermes.pyth.network",
  CHAIN_ID: "5042002",
  EXPLORER_URL: "https://testnet.arcscan.app",
} as const;

type Env = Record<string, string | undefined>;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Validates the environment. Never throws: problems are reported so the UI can explain them. */
export function readRuntimeConfig(env: Env): RuntimeConfigResult {
  const problems: string[] = [];

  const value = (name: string): string => (env[name] ?? "").trim();

  const address = (name: string, fallback?: string): Address => {
    const raw = value(name) || fallback || "";
    if (!raw) {
      problems.push(`${name} is not set`);
      return "0x0000000000000000000000000000000000000000";
    }
    if (!isAddress(raw, { strict: false })) {
      problems.push(`${name} is not a valid address (got "${raw}")`);
      return "0x0000000000000000000000000000000000000000";
    }
    return getAddress(raw);
  };

  const url = (name: keyof typeof DEFAULTS): string => {
    const raw = value(name) || DEFAULTS[name];
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      problems.push(`${name} is not a valid http(s) URL (got "${raw}")`);
    }
    return trimSlash(raw);
  };

  const perpEngine = address("PERP_ENGINE_ADDRESS");
  const houseVault = address("HOUSE_VAULT_ADDRESS");
  const rewardToken = address("REWARD_TOKEN_ADDRESS");
  const usdc = address("USDC_ADDRESS", DEFAULTS.USDC_ADDRESS);
  const pyth = address("PYTH_ADDRESS", DEFAULTS.PYTH_ADDRESS);
  const rpcUrl = url("RPC_URL");
  const hermesUrl = url("HERMES_URL");
  const explorerUrl = url("EXPLORER_URL");

  const rawChainId = value("CHAIN_ID") || DEFAULTS.CHAIN_ID;
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    problems.push(`CHAIN_ID is not a positive integer (got "${rawChainId}")`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: { chainId, rpcUrl, hermesUrl, explorerUrl, perpEngine, houseVault, rewardToken, usdc, pyth },
  };
}
