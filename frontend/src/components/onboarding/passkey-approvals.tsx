"use client";

import { useSyncExternalStore } from "react";
import { Sheet } from "@/components/ui/sheet";
import { approvalStore } from "@/lib/passkey-wallet";

const NONE: ReturnType<typeof approvalStore.get> = [];

/**
 * The passkey wallet's confirmation step. A browser wallet shows its own window for every transaction and
 * signature; the passkey wallet has none, so the app shows the request here and signs only after Approve.
 * Mounted once, inside the providers.
 */
export function PasskeyApprovals() {
  const queue = useSyncExternalStore(approvalStore.subscribe, approvalStore.get, () => NONE);
  const current = queue[0];
  if (!current) return null;
  const decide = (ok: boolean) => approvalStore.decide(current.id, ok);
  return (
    <Sheet
      title={current.title}
      description={current.kind === "transaction" ? "Your passkey wallet will sign and send this. Check it before you approve." : "Your passkey wallet will sign this. It moves nothing by itself."}
      onClose={() => decide(false)}
      testId="passkey-approval"
      footer={
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-lg" onClick={() => decide(false)} data-testid="passkey-reject">
            Reject
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => decide(true)} data-testid="passkey-approve">
            Approve
          </button>
        </div>
      }
    >
      <dl className="grid gap-1.5 text-[0.8125rem]">
        {current.lines.map((line) => (
          <div key={line.label} className="kv">
            <dt>{line.label}</dt>
            <dd className={`text-right wrap-anywhere ${/^(0x|[-+]?[0-9])/.test(line.value) ? "num" : ""}`}>{line.value}</dd>
          </div>
        ))}
      </dl>
      {queue.length > 1 ? <p className="mt-3 text-xs text-faint">{queue.length - 1} more waiting after this one.</p> : null}
    </Sheet>
  );
}
