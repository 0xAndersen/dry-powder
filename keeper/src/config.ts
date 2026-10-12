import { type Address, type Hex, isAddress, isHex, parseGwei } from "viem";
import type { LogLevel } from "./logger.js";

export interface Config {
  rpcUrl: string;
  chainId: number;
  engine: Address;
  pyth: Address;
  hermesUrl: string;
  privateKey: Hex;
  refreshIntervalMs: number;
  tickIntervalMs: number;
  batchSize: number;
  executeOrders: boolean;
  priorityFee: bigint;
  maxFee: bigint;
  dryRun: boolean;
  logLevel: LogLevel;
}

class ConfigError extends Error {}

function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${name} is required`);
}

function address(name: string, fallback?: string): Address {
  const value = str(name, fallback);
  if (!isAddress(value)) throw new ConfigError(`${name} is not a valid address: ${value}`);
  return value;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = str(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name, String(fallback)).toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be true or false, got ${raw}`);
}

function gwei(name: string, fallback: string): bigint {
  const raw = str(name, fallback);
  try {
    return parseGwei(raw);
  } catch {
    throw new ConfigError(`${name} must be a gwei amount, got ${raw}`);
  }
}

export function loadConfig(): Config {
  const privateKey = str("KEEPER_PRIVATE_KEY");
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new ConfigError("KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }
  const logLevel = str("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error, got ${logLevel}`);
  }
  return {
    rpcUrl: str("RPC_URL", "https://rpc.testnet.arc.network"),
    chainId: int("CHAIN_ID", 5042002, 1, Number.MAX_SAFE_INTEGER),
    engine: address("PERP_ENGINE_ADDRESS"),
    pyth: address("PYTH_ADDRESS", "0x2880aB155794e7179c9eE2e38200202908C17B43"),
    hermesUrl: str("HERMES_URL", "https://hermes.pyth.network").replace(/\/+$/, ""),
    privateKey,
    refreshIntervalMs: int("REFRESH_INTERVAL_MS", 2000, 250, 600_000),
    tickIntervalMs: int("TICK_INTERVAL_MS", 250, 50, 60_000),
    batchSize: int("LIQUIDATION_BATCH_SIZE", 20, 1, 100),
    executeOrders: bool("EXECUTE_ORDERS", true),
    priorityFee: gwei("PRIORITY_FEE_GWEI", "1"),
    maxFee: gwei("MAX_FEE_GWEI", "500"),
    dryRun: bool("DRY_RUN", false),
    logLevel: logLevel as LogLevel,
  };
}

export { ConfigError };
