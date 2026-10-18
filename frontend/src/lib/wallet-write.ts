import { getPublicClient, simulateContract, writeContract } from "wagmi/actions";
import type { Config } from "wagmi";
import type { Abi, Address, Hex } from "viem";
import { withGasHeadroom } from "./session";

export type WalletCall = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  account: Address;
  chainId: number;
};

/**
 * Simulates a call from the connected wallet (a revert surfaces with its reason before anything is signed), then
 * sends it with a gas limit that carries headroom. The transaction runs on a later state than the estimate: an
 * epoch that streams yield once the house is above its mark, a deposit after a trade moved the marked value, a
 * claim after the stream advanced. A tight limit runs out there. Wallets that re-estimate may still override it.
 */
export async function walletWrite(wagmi: Config, call: WalletCall): Promise<Hex> {
  const { request } = await simulateContract(wagmi, call as never);
  let gas: bigint | undefined;
  try {
    const client = getPublicClient(wagmi, { chainId: call.chainId });
    // By address: estimating with the request's account object can cap a second estimate at the first.
    if (client) gas = withGasHeadroom(await client.estimateContractGas(call as never));
  } catch {
    gas = undefined;
  }
  return writeContract(wagmi, { ...(request as object), ...(gas !== undefined ? { gas } : {}) } as never);
}
