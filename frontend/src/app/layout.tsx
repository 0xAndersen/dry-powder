import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import { IS_STATIC_BUILD, rawFromEnv, readRuntimeConfig, type RuntimeConfigResult } from "@/lib/config";
import { ConfigGate } from "@/components/config-gate";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "Dry Powder", template: "%s | Dry Powder" },
  description: "Risk-first perpetuals on Arc, up to 1000x. See the most you can lose before you trade. Built for people and agents.",
  // The static bundle keeps every page one directory deep, so relative URLs work under any sub-path.
  icons: {
    icon: IS_STATIC_BUILD ? "../favicon.svg" : "/favicon.svg",
    apple: IS_STATIC_BUILD ? "../apple-touch-icon.png" : "/apple-touch-icon.png",
  },
  manifest: IS_STATIC_BUILD ? "../manifest.webmanifest" : "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Dry Powder", statusBarStyle: "black-translucent" },
  openGraph: {
    title: "Dry Powder",
    description: "Up to 1000x. See the most you can lose before you trade. Open perpetuals on Arc, built for people and AI agents.",
    images: [{ url: "https://0xandersen.github.io/dry-powder/og-card.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["https://0xandersen.github.io/dry-powder/og-card.png"] },
};

export const viewport: Viewport = {
  themeColor: "#0d0f12",
  colorScheme: "dark",
  // Edge to edge on phones with a notch; the layout pads with env(safe-area-inset-*).
  viewportFit: "cover",
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
