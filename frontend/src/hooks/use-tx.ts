"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Hex, TransactionReceipt } from "viem";
import { useAppConfig, isChainRead } from "@/components/providers";
import { humanizeError, UserFacingError } from "@/lib/errors";

export type TxState =
  | { phase: "idle" }
  | { phase: "working"; stage: "preparing" | "wallet" | "pending"; label: string; hash?: Hex }
  | { phase: "confirmed"; message: string; hash?: Hex }
  | { phase: "failed"; error: string; hash?: Hex };

export type TxApi = {
  /** Announces preparation or waiting that involves no wallet prompt. */
  preparing: (label: string) => void;
  /** Asks the wallet to send a transaction and waits until it is mined. Throws if it reverts. */
  send: (label: string, submit: () => Promise<Hex>) => Promise<TransactionReceipt>;
};

/**
 * Runs a multi-step transaction flow (for example approve, then submit) with one status the UI can render.
 * `run` resolves to true when every step confirmed.
 */
export function useTx(options: { /** Clears a success message after this long. Failures stay until dismissed. */ autoDismissMs?: number } = {}) {
  const { autoDismissMs } = options;
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
          const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId, pollingInterval: 500 });
          if (receipt.status !== "success") {
            throw new UserFacingError(`${label} was mined but reverted. Open the explorer for details.`);
          }
          void queryClient.invalidateQueries({ predicate: isChainRead });
          return receipt;
        },
      };
      try {
        const message = await job(api);
        const confirmed: TxState = { phase: "confirmed", message, hash: lastHash };
        setState(confirmed);
        if (autoDismissMs) setTimeout(() => setState((current) => (current === confirmed ? { phase: "idle" } : current)), autoDismissMs);
        return true;
      } catch (error) {
        setState({ phase: "failed", error: humanizeError(error), hash: lastHash });
        return false;
      } finally {
        running.current = false;
        void queryClient.invalidateQueries({ predicate: isChainRead });
      }
    },
    [wagmiConfig, chainId, queryClient, autoDismissMs],
  );

  const reset = useCallback(() => {
    if (!running.current) setState({ phase: "idle" });
  }, []);

  return { state, busy: state.phase === "working", run, reset };
}

export type TxHandle = ReturnType<typeof useTx>;
