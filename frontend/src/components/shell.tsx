"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertWatcher } from "@/components/alert-watcher";
import { Header } from "@/components/header";
import { CommandPalette } from "@/components/command-palette";
import { MobileNav } from "@/components/mobile-nav";
import { ServiceWorkerManager } from "@/components/pwa";
import { RiskWatcher } from "@/components/risk-watcher";
import { Toasts } from "@/components/toasts";

/**
 * Everything below the providers is live chain and wallet state, none of which exists on the server. The shell
 * therefore renders after mount: the server (and the static export) ship only the frame, and there is no
 * hydration to get out of step with data that arrived in the meantime.
 */
export function Shell({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <>
        <div className="h-12 border-b border-line" />
        <main className="mx-auto flex h-64 w-full max-w-[1760px] items-center justify-center gap-2 text-muted" role="status">
          <span className="spinner" aria-hidden="true" /> Loading
        </main>
      </>
    );
  }

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Header />
      <main id="main" className="app-main mx-auto w-full max-w-[1760px] px-2 pt-2 sm:px-3">
        {children}
      </main>
      <MobileNav />
      <ServiceWorkerManager />
      <AlertWatcher />
      <RiskWatcher />
      <CommandPalette />
      <Toasts />
    </>
  );
}
