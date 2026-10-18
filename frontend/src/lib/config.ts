import { isAddress, getAddress, type Address } from "viem";

export type OracleMode = "publisher" | "pyth";

/** Deployment-specific settings. Standalone builds read them from the container environment on every
 *  request; static builds read `config.json` at runtime, with URL query overrides. */
export type RuntimeConfig = {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  perpEngine: Address;
  engineLens: Address;
  houseVault: Address;
  rewardToken: Address;
  /** AgentAccountFactory; null when this deployment has none (the Agents page then explains). */
  agentFactory: Address | null;
  usdc: Address;
  oracleMode: OracleMode;
  collateralSymbol: string;
  collateralIsTest: boolean;
  krakenUrl: string;
  hermesUrl: string;
  pythApiKey: string;
  /**
   * Where the indexer's stats.json is published (absolute, or relative to the app). Null: the app's default for the
   * chain, if any (see lib/stats-file.ts). Never taken from the page address.
   */
  statsUrl: string | null;
  /** Query parameters that replaced a configured value. Shown in the UI so a crafted link is visible. */
  overrides: string[];
};

export type RuntimeConfigResult = { ok: true; config: RuntimeConfig } | { ok: false; problems: string[] };

/** One row per setting: environment name, `config.json` key, URL query parameter. */
export const CONFIG_KEYS = [
  { env: "PERP_ENGINE_ADDRESS", json: "perpEngineAddress", query: "engine" },
  { env: "ENGINE_LENS_ADDRESS", json: "engineLensAddress", query: "lens" },
  { env: "HOUSE_VAULT_ADDRESS", json: "houseVaultAddress", query: "vault" },
  { env: "REWARD_TOKEN_ADDRESS", json: "rewardTokenAddress", query: "token" },
  { env: "USDC_ADDRESS", json: "usdcAddress", query: "collateral" },
  { env: "AGENT_FACTORY_ADDRESS", json: "agentFactoryAddress", query: "agents" },
  { env: "RPC_URL", json: "rpcUrl", query: "rpc" },
  { env: "CHAIN_ID", json: "chainId", query: "chain" },
  { env: "ORACLE_MODE", json: "oracleMode", query: "mode" },
  { env: "COLLATERAL_SYMBOL", json: "collateralSymbol", query: "symbol" },
  { env: "COLLATERAL_IS_TEST", json: "collateralIsTest", query: "test" },
  { env: "KRAKEN_URL", json: "krakenUrl", query: "kraken" },
  { env: "HERMES_URL", json: "hermesUrl", query: "hermes" },
  { env: "PYTH_API_KEY", json: "pythApiKey", query: null },
  { env: "EXPLORER_URL", json: "explorerUrl", query: "explorer" },
  { env: "STATS_URL", json: "statsUrl", query: null },
] as const;

export type ConfigEnvName = (typeof CONFIG_KEYS)[number]["env"];
export type RawConfig = Partial<Record<ConfigEnvName, string>>;

/** Query parameters that must survive navigation between pages of a static deployment. */
export const STICKY_QUERY_KEYS: readonly string[] = [
  ...CONFIG_KEYS.flatMap((k) => (k.query ? [k.query] : [])),
  "account",
];

const DEFAULTS = {
  USDC_ADDRESS: "0x3600000000000000000000000000000000000000",
  RPC_URL: "https://rpc.testnet.arc.io",
  HERMES_URL: "https://hermes.pyth.network",
  KRAKEN_URL: "https://api.kraken.com",
  CHAIN_ID: "5042002",
  EXPLORER_URL: "https://explorer.testnet.arc.io",
  ORACLE_MODE: "publisher",
  COLLATERAL_SYMBOL: "USDC",
} as const;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Picks the known settings out of `process.env`. */
export function rawFromEnv(env: Record<string, string | undefined>): RawConfig {
  const out: RawConfig = {};
  for (const key of CONFIG_KEYS) {
    const value = env[key.env];
    if (typeof value === "string" && value.trim() !== "") out[key.env] = value.trim();
  }
  return out;
}

/** Reads a parsed `config.json`. Accepts the camelCase keys and, for convenience, the env names. */
export function rawFromJson(json: unknown): RawConfig {
  const out: RawConfig = {};
  if (!json || typeof json !== "object") return out;
  const record = json as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = record[key.json] ?? record[key.env];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).trim();
      if (text !== "") out[key.env] = text;
    }
  }
  return out;
}

/** Reads overrides from a URL query string. Returns the settings and the parameter names that were used. */
export function rawFromQuery(params: URLSearchParams): { raw: RawConfig; used: string[] } {
  const raw: RawConfig = {};
  const used: string[] = [];
  for (const key of CONFIG_KEYS) {
    if (!key.query) continue;
    const value = params.get(key.query);
    if (value !== null && value.trim() !== "") {
      raw[key.env] = value.trim();
      used.push(key.query);
    }
  }
  return { raw, used };
}

/** Validates settings. Never throws: problems are reported so the UI can explain them. */
export function readRuntimeConfig(raw: RawConfig, overrides: string[] = []): RuntimeConfigResult {
  const problems: string[] = [];
  const value = (name: ConfigEnvName): string => (raw[name] ?? "").trim();

  const address = (name: ConfigEnvName, fallback?: string): Address => {
    const text = value(name) || fallback || "";
    if (!text) {
      problems.push(`${name} is not set`);
      return "0x0000000000000000000000000000000000000000";
    }
    if (!isAddress(text, { strict: false })) {
      problems.push(`${name} is not a valid address (got "${text}")`);
      return "0x0000000000000000000000000000000000000000";
    }
    return getAddress(text);
  };

  const url = (name: "RPC_URL" | "HERMES_URL" | "KRAKEN_URL" | "EXPLORER_URL"): string => {
    const text = value(name) || DEFAULTS[name];
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      problems.push(`${name} is not a valid http(s) URL (got "${text}")`);
    }
    return trimSlash(text);
  };

  const perpEngine = address("PERP_ENGINE_ADDRESS");
  const engineLens = address("ENGINE_LENS_ADDRESS");
  const houseVault = address("HOUSE_VAULT_ADDRESS");
  const rewardToken = address("REWARD_TOKEN_ADDRESS");
  const agentFactory = value("AGENT_FACTORY_ADDRESS") ? address("AGENT_FACTORY_ADDRESS") : null;
  const usdc = address("USDC_ADDRESS", DEFAULTS.USDC_ADDRESS);
  const rpcUrl = url("RPC_URL");
  const hermesUrl = url("HERMES_URL");
  const krakenUrl = url("KRAKEN_URL");
  const explorerUrl = url("EXPLORER_URL");

  const rawChainId = value("CHAIN_ID") || DEFAULTS.CHAIN_ID;
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    problems.push(`CHAIN_ID is not a positive integer (got "${rawChainId}")`);
  }

  const rawMode = (value("ORACLE_MODE") || DEFAULTS.ORACLE_MODE).toLowerCase();
  if (rawMode !== "publisher" && rawMode !== "pyth") {
    problems.push(`ORACLE_MODE must be "publisher" or "pyth" (got "${rawMode}")`);
  }

  const collateralSymbol = (value("COLLATERAL_SYMBOL") || DEFAULTS.COLLATERAL_SYMBOL).slice(0, 12);
  const collateralIsTest = /^(1|true|yes|on)$/i.test(value("COLLATERAL_IS_TEST"));

  // Absolute http(s), or a path relative to the app (a static host serving stats.json next to it).
  const rawStats = value("STATS_URL");
  let statsUrl: string | null = null;
  if (rawStats) {
    if (/^https?:\/\//i.test(rawStats) || /^(\.{1,2}\/|\/)[^\s]*$/.test(rawStats)) statsUrl = rawStats;
    else problems.push(`STATS_URL must be an http(s) URL or a relative path (got "${rawStats}")`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      chainId,
      rpcUrl,
      explorerUrl,
      perpEngine,
      engineLens,
      houseVault,
      rewardToken,
      agentFactory,
      usdc,
      oracleMode: rawMode as OracleMode,
      collateralSymbol,
      collateralIsTest,
      krakenUrl,
      hermesUrl,
      pythApiKey: value("PYTH_API_KEY"),
      statsUrl,
      overrides,
    },
  };
}

/** True in the bundle produced by `npm run build:static`. */
export const IS_STATIC_BUILD = process.env.NEXT_PUBLIC_BUILD_TARGET === "static";
