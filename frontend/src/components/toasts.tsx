"use client";

import { useSyncExternalStore } from "react";
import { emptyToasts, toastStore } from "@/lib/toasts";

export function Toasts() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get, emptyToasts);
  return (
    <div className="pointer-events-none fixed bottom-3 left-3 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className="toast pointer-events-auto"
          data-tone={t.tone}
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-text">{t.title}</p>
            {t.body ? <p className="num mt-0.5 text-[0.8125rem] text-muted">{t.body}</p> : null}
          </div>
          <button type="button" className="text-muted hover:text-text" aria-label="Dismiss notification" onClick={() => toastStore.dismiss(t.id)}>
            {"✕"}
          </button>
        </div>
      ))}
    </div>
  );
}
