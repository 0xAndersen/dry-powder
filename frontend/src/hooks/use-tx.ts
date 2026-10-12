"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Hex } from "viem";
import { useAppConfig, isChainRead } from "@/components/providers";
import { humanizeError, UserFacingError } from "@/lib/errors";

export type TxState =
  | { phase: "idle" }
  | { phase: "working"; stage: "preparing" | "wallet" | "pending"; label: string; hash?: Hex }
  | { phase: "confirmed"; message: string; hash?: Hex }
  | { phase: "failed"; error: string; hash?: Hex };

export type TxApi = {
  /** Announces off-chain preparation (fetching a price update, checking allowance…). */
  preparing: (label: string) => void;
  /** Asks the wallet to send a transaction and waits until it is mined. Throws if it reverts. */
  send: (label: string, submit: () => Promise<Hex>) => Promise<Hex>;
};

/**
 * Runs a multi-step transaction flow (for example approve → submit) with one status the UI can render.
 * `run` resolves to true when every step confirmed.
 */
export function useTx() {
  const wagmiConfig = useConfig();
  const { chainId } = useAppConfig();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const running = useRef(false);

  const run = useCallback(
    async (job: (api: TxApi) => Promise<string>): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      let lastHash: Hex | undefined;
      const api: TxApi = {
        preparing: (label) => setState({ phase: "working", stage: "preparing", label }),
        send: async (label, submit) => {
          setState({ phase: "working", stage: "wallet", label });
          const hash = await submit();
          lastHash = hash;
          setState({ phase: "working", stage: "pending", label, hash });
          const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId, pollingInterval: 1_000 });
          if (receipt.status !== "success") {
            throw new UserFacingError(`${label} was mined but reverted. Open the explorer for details.`);
          }
          void queryClient.invalidateQueries({ predicate: isChainRead });
          return hash;
        },
      };
      try {
        const message = await job(api);
        setState({ phase: "confirmed", message, hash: lastHash });
        return true;
      } catch (error) {
        setState({ phase: "failed", error: humanizeError(error), hash: lastHash });
        return false;
      } finally {
        running.current = false;
        void queryClient.invalidateQueries({ predicate: isChainRead });
      }
    },
    [wagmiConfig, chainId, queryClient],
  );

  const reset = useCallback(() => {
    if (!running.current) setState({ phase: "idle" });
  }, []);

  return { state, busy: state.phase === "working", run, reset };
}
