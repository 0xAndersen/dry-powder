"use client";

import { useEffect, useState } from "react";
import { IS_STATIC_BUILD } from "@/lib/config";
import { staticBaseUrl } from "@/lib/nav";

/**
 * Registers the service worker (static builds only) and offers a reload when a new version has been deployed.
 * Skipped under automation so test runs never see a cached shell.
 */
export function ServiceWorkerManager() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!IS_STATIC_BUILD || typeof navigator === "undefined" || !("serviceWorker" in navigator) || navigator.webdriver) return;
    if (!window.isSecureContext) return;
    const base = staticBaseUrl(window.location);
    let cancelled = false;
    let reloading = false;

    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker
      .register(new URL("sw.js", base).toString(), { scope: base })
      .then((registration) => {
        if (cancelled) return;
        // A worker that installed while an older one controls the page waits until we tell it to take over.
        if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) setWaiting(installing);
          });
        });
        // Look for a new deployment when the app comes back to the foreground.
        const onVisible = () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
        };
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waiting) return null;
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span className="min-w-0 flex-1 text-[0.8125rem]">A new version of Dry Powder is ready.</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => waiting.postMessage("skip-waiting")}>
        Reload
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWaiting(null)} aria-label="Later">
        Later
      </button>
    </div>
  );
}
