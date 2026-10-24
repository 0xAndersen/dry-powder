import { defineChain, type Chain } from "viem";
import type { RuntimeConfig } from "./config";

/**
 * Arc Testnet. The gas token is USDC with 18 decimals; the same balance is exposed through a
 * 6-decimal ERC-20 interface, which is what every protocol amount uses.
 */
export function buildChain(config: RuntimeConfig): Chain {
  const isArc = config.chainId === 5042002;
  return defineChain({
    id: config.chainId,
    name: isArc ? "Arc Testnet" : config.chainId === 31337 ? "Local devnet" : `Chain ${config.chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: "Arcscan", url: config.explorerUrl } },
    testnet: true,
  });
}
