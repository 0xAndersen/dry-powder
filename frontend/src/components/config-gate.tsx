"use client";

import { useEffect, useState, type ReactNode } from "react";
import { IS_STATIC_BUILD, rawFromJson, rawFromQuery, readRuntimeConfig, type RuntimeConfigResult } from "@/lib/config";
import { staticBaseUrl } from "@/lib/nav";
import { NotConfigured } from "@/components/not-configured";
import { Providers } from "@/components/providers";

/** Static bundle: `config.json` next to the app, then URL query overrides on top. */
async function loadStaticConfig(): Promise<RuntimeConfigResult> {
  const { raw: fromQuery, used } = rawFromQuery(new URLSearchParams(window.location.search));
  let fromFile = {};
  let fileProblem: string | null = null;
  try {
    const res = await fetch(new URL("config.json", staticBaseUrl(window.location)), { cache: "no-store" });
    if (res.ok) fromFile = rawFromJson(await res.json());
    else if (res.status !== 404) fileProblem = `config.json could not be loaded (HTTP ${res.status})`;
  } catch {
    fileProblem = "config.json is missing or is not valid JSON";
  }
  const result = readRuntimeConfig({ ...fromFile, ...fromQuery }, used);
  if (!result.ok && fileProblem) return { ok: false, problems: [fileProblem, ...result.problems] };
  return result;
}

/**
 * Resolves the deployment configuration before anything else renders. The server build receives it from the
 * layout; the static build fetches it in the browser.
 */
export function ConfigGate({ server, children }: { server: RuntimeConfigResult | null; children: ReactNode }) {
  const [result, setResult] = useState<RuntimeConfigResult | null>(server);

  useEffect(() => {
    if (server || !IS_STATIC_BUILD) return;
    let cancelled = false;
    void loadStaticConfig().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [server]);

  if (!result) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-2 text-muted" role="status">
        <span className="spinner" aria-hidden="true" /> Loading deployment configuration
      </main>
    );
  }
  if (!result.ok) return <NotConfigured problems={result.problems} />;
  return <Providers config={result.config}>{children}</Providers>;
}
