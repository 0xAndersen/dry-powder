import { defineChain, type Chain } from "viem";
import type { RuntimeConfig } from "./config";

/**
 * Arc Testnet. The gas token is USDC with 18 decimals; the same balance is exposed through a
 * 6-decimal ERC-20 interface, which is what every protocol amount uses.
 */
export function buildChain(config: RuntimeConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: config.chainId === 5042002 ? "Arc Testnet" : `Arc (${config.chainId})`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: "Arcscan", url: config.explorerUrl } },
    testnet: true,
  });
}
