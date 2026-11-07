import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import "@fontsource/anton/400.css";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import { IS_STATIC_BUILD, rawFromEnv, readRuntimeConfig, type RuntimeConfigResult } from "@/lib/config";
import { ConfigGate } from "@/components/config-gate";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "Dry Powder", template: "%s | Dry Powder" },
  description: "Perpetuals, crosses, FX and dated futures on Arc. Trade against the house, or be the house.",
  // The static bundle keeps every page one directory deep, so a relative icon works under any sub-path.
  icons: { icon: IS_STATIC_BUILD ? "../favicon.svg" : "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#1b1a18",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server build: contract addresses come from the container environment on every request, never from the
  // build. Static build: nothing is known here; the browser loads config.json.
  let server: RuntimeConfigResult | null = null;
  if (!IS_STATIC_BUILD) {
    await connection();
    server = readRuntimeConfig(rawFromEnv(process.env));
  }

  return (
    <html lang="en">
      <body>
        <ConfigGate server={server}>
          <Suspense fallback={null}>
            <Shell>{children}</Shell>
          </Suspense>
        </ConfigGate>
      </body>
    </html>
  );
}
