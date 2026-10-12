"use client";

import { useAppConfig } from "@/components/providers";
import type { TxState } from "@/hooks/use-tx";

function ExplorerLink({ hash }: { hash: string }) {
  const { explorerUrl } = useAppConfig();
  return (
    <a className="link whitespace-nowrap" href={`${explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
      View on explorer
    </a>
  );
}

/** One line describing where a transaction flow stands, with an explorer link once there is a hash. */
export function TxStatus({ state, onDismiss, className = "" }: { state: TxState; onDismiss?: () => void; className?: string }) {
  if (state.phase === "idle") return null;

  if (state.phase === "working") {
    const text =
      state.stage === "preparing"
        ? `${state.label}…`
        : state.stage === "wallet"
          ? `${state.label}: confirm in your wallet`
          : `${state.label}: waiting for confirmation`;
    return (
      <div className={`notice flex items-center gap-2 ${className}`} role="status" aria-live="polite">
        <span className="spinner text-brass" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-text">{text}</span>
        {state.hash ? <ExplorerLink hash={state.hash} /> : null}
      </div>
    );
  }

  const failed = state.phase === "failed";
  return (
    <div
      className={`notice flex items-start gap-2 ${className}`}
      data-tone={failed ? "error" : "ok"}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="min-w-0 flex-1">{failed ? state.error : state.message}</span>
      {state.hash ? <ExplorerLink hash={state.hash} /> : null}
      {onDismiss ? (
        <button type="button" className="text-muted hover:text-text" onClick={onDismiss} aria-label="Dismiss message">
          {"✕"}
        </button>
      ) : null}
    </div>
  );
}
