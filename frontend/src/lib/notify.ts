import { prefs } from "./prefs";
import { tradeSettings } from "./storage";
import { toast, type Toast, type ToastAction } from "./toasts";

const VIBRATION: Record<Toast["tone"], number[]> = { ok: [18], info: [12], warn: [30, 60, 30], error: [60, 40, 60] };

/**
 * One place for things the trader should know about: always an in-app toast; a system notification when the tab
 * is in the background and notifications are allowed; a short vibration on phones.
 */
export function notify(
  tone: Toast["tone"],
  title: string,
  body?: string,
  options: { system?: boolean; tag?: string; ttlMs?: number; action?: ToastAction } = {},
): void {
  toast(tone, title, body, options.ttlMs, options.action);
  const p = prefs.get();
  if (p.haptics && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(VIBRATION[tone]);
    } catch {
      // Not allowed without a user gesture on some browsers; harmless.
    }
  }
  if (options.system === false) return;
  if (!tradeSettings.get().notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  const payload = { body, tag: options.tag, icon: "../icon-192.png", badge: "../icon-192.png" };
  // Installed apps (and iOS) only show notifications through the service worker.
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    void navigator.serviceWorker.ready.then((reg) => reg.showNotification(`Dry Powder: ${title}`, payload)).catch(() => undefined);
    return;
  }
  try {
    new Notification(`Dry Powder: ${title}`, payload);
  } catch {
    // Some browsers only allow notifications from a service worker; the toast still showed.
  }
}

/** Asks for notification permission (must run from a click). Returns whether notifications can be shown. */
export async function enableSystemNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  const ok = permission === "granted";
  tradeSettings.set((s) => ({ ...s, notify: ok }));
  return ok;
}
