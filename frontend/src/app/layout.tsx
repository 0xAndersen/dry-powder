import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import { readRuntimeConfig } from "@/lib/config";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { NotConfigured } from "@/components/not-configured";

// Contract addresses come from the container environment at request time, never from the build.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Arc House", template: "%s | Arc House" },
  description: "Synthetic perpetuals on Arc Testnet. Trade against the house, or be the house.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#121a26",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const result = readRuntimeConfig(process.env);

  return (
    <html lang="en">
      <body>
        {result.ok ? (
          <Providers config={result.config}>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-raised focus:px-3 focus:py-2"
            >
              Skip to content
            </a>
            <Header />
            <main id="main" className="mx-auto w-full max-w-[1680px] px-3 pb-12 pt-3 sm:px-4">
              {children}
            </main>
          </Providers>
        ) : (
          <NotConfigured problems={result.problems} />
        )}
      </body>
    </html>
  );
}
