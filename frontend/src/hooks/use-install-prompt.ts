"use client";

import { useSyncExternalStore } from "react";

/** The browser's deferred install prompt (Chromium on Android and desktop). */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

type InstallState = { deferred: InstallEvent | null; installed: boolean; standalone: boolean; ios: boolean };

let state: InstallState = { deferred: null, installed: false, standalone: false, ios: false };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  state = { ...state, standalone, ios };
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    set({ deferred: event as InstallEvent });
  });
  window.addEventListener("appinstalled", () => set({ deferred: null, installed: true }));
}

// Registered as soon as the module loads: the event fires once, early, and is lost if nobody listens.
start();

const subscribe = (l: () => void) => {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => state;
const serverSnapshot: InstallState = { deferred: null, installed: false, standalone: false, ios: false };

/** Whether the app can be installed here, and a function that asks the browser to install it. */
export function useInstallPrompt() {
  const s = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
  return {
    canInstall: s.deferred !== null && !s.standalone,
    /** iOS Safari never fires the event: the user adds the page from the Share menu. */
    iosHint: s.ios && !s.standalone && !s.installed,
    standalone: s.standalone,
    prompt: async () => {
      if (!s.deferred) return false;
      await s.deferred.prompt();
      const choice = await s.deferred.userChoice;
      set({ deferred: null });
      return choice.outcome === "accepted";
    },
  };
}
