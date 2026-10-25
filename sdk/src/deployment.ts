import type { Address, Hex } from "viem";

/** The shape of deployments/arc-testnet.json, written by the deploy workflows. */
export interface Deployment {
  network?: string;
  /** "v3.2" for the deployment this SDK version targets. */
  version?: string;
  chainId: number;
  rpcUrl?: string;
  explorerUrl?: string;
  appUrl?: string;
  collateral?: "test" | "usdc";
  /** The one engine address (v3.2: PerpEngine, which runs PerpEngineExt for everything off the trading path). */
  engine: Address;
  /** PerpEngineExt (v3.2), for reference only: every call goes to `engine`. */
  engineExt?: Address;
  lens: Address;
  vault: Address;
  token: Address;
  usdc: Address;
  pub?: Address;
  oracle?: Address;
  agentFactory?: Address;
  /** TrailingStops add-on (v3.1 deployments). */
  trailingStops?: Address;
  /** TwapOrders add-on (v3.1 deployments). */
  twapOrders?: Address;
  /** Strategies add-on (v3.2): on-chain trend, mean-reversion and copy agents for agent accounts. */
  strategies?: Address;
  /** AgentRegistry (v3.2): agent accounts listed with a name, kind and description. */
  agentRegistry?: Address;
  /** PrizeDistributor (v3.2): season prizes, claimed with a Merkle proof. */
  prizeDistributor?: Address;
  markets?: { symbol: string; id: Hex }[];
}

/** The live Arc Testnet deployment, always current with the repository's main branch. */
export const ARC_TESTNET_DEPLOYMENT_URL = "https://raw.githubusercontent.com/0xAndersen/dry-powder/main/deployments/arc-testnet.json";

/** Arc Testnet public RPCs (docs.arc.io), tried in order. */
export const ARC_TESTNET_RPCS = [
  "https://rpc.testnet.arc.io",
  "https://rpc.quicknode.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://5042002.rpc.thirdweb.com",
];

/** Loads a deployment from a URL or a local JSON file (Node). Defaults to the live Arc Testnet deployment. */
export async function loadDeployment(src: string = ARC_TESTNET_DEPLOYMENT_URL): Promise<Deployment> {
  let d: Deployment;
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`deployment ${src}: http ${r.status}`);
    d = (await r.json()) as Deployment;
  } else {
    const { readFile } = await import("node:fs/promises");
    d = JSON.parse(await readFile(src, "utf8")) as Deployment;
  }
  for (const k of ["engine", "lens", "usdc"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(d[k] ?? "")) throw new Error(`deployment is missing ${k}`);
  }
  return { ...d, chainId: Number(d.chainId ?? 5042002) };
}
