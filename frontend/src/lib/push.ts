// Web Push from the app (roadmap 50): subscribes this browser with the push relay (keeper/src/push.mjs) so that
// liquidation warnings, fills and closes arrive while the app is closed; public/sw.js shows them. Also reads the
// optional settings lib/config.ts does not carry: the push relay's URL and where season prizes are published.
// No app imports: callers pass the app's base URL.

export type OptionalSettings = {
  /** The push relay's base URL (https, or http on localhost); null hides the setting. */
  pushRelayUrl: string | null;
  /** prizes/index.json, absolute or relative to the app; null: derived from the stats URL (lib/prizes.ts). */
  prizesUrl: string | null;
};

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

/** An https URL (or http on localhost) without a trailing slash, or null. */
export function relayUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const text = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(text);
    if (u.protocol === "https:" || LOCAL.test(text)) return text;
  } catch {
    // Not a URL.
  }
  return null;
}

/** Absolute http(s), or a path relative to the app: the same rule as the stats URL. */
export function dataUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return /^https?:\/\//i.test(text) || /^(\.{1,2}\/|\/)[^\s]*$/.test(text) ? text : null;
}

function readSettings(json: Record<string, unknown>): OptionalSettings {
  return {
    pushRelayUrl: relayUrl(json.pushRelayUrl ?? json.PUSH_RELAY_URL ?? process.env.NEXT_PUBLIC_PUSH_RELAY_URL),
    prizesUrl: dataUrl(json.prizesUrl ?? json.PRIZES_URL ?? process.env.NEXT_PUBLIC_PRIZES_URL),
  };
}

/**
 * The optional settings: `pushRelayUrl` and `prizesUrl` in the static bundle's config.json (next to the app at
 * `base`); in the server build, NEXT_PUBLIC_PUSH_RELAY_URL and NEXT_PUBLIC_PRIZES_URL at build time. Never taken
 * from the page's query string.
 */
export async function loadOptionalSettings(base: string, staticBuild: boolean): Promise<OptionalSettings> {
  if (!staticBuild) return readSettings({});
  try {
    const res = await fetch(new URL("config.json", base), { cache: "no-store" });
    if (!res.ok) return readSettings({});
    const json: unknown = await res.json();
    return readSettings(json && typeof json === "object" ? (json as Record<string, unknown>) : {});
  } catch {
    return readSettings({});
  }
}

/** For react-query: one read per page load, shared by every component that needs it. */
export const optionalSettingsQuery = (base: string, staticBuild: boolean) => ({
  queryKey: ["optional-settings", base, staticBuild] as const,
  queryFn: () => loadOptionalSettings(base, staticBuild),
  staleTime: Infinity,
  retry: false,
});

// ─────────────────────────────── Subscribing ───────────────────────────────

export type PushTopic = "liquidation" | "fill" | "close";
export type LiqWarn = "half" | "quarter" | "off";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined" && window.isSecureContext;
}

/** The VAPID key the relay signs with, as subscribe() wants it. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The app's service worker (registering it when the page has not), within a few seconds. */
async function registration(base: string): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(base);
  const reg = existing ?? (await navigator.serviceWorker.register(new URL("sw.js", base).toString(), { scope: base }));
  if (reg.active) return reg;
  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The app's service worker did not start. Reload the page and try again.")), 10_000)),
  ]);
}

/** fetch, with a failure that says what could not be reached. */
async function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("The push relay could not be reached. Try again later.");
  }
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return `HTTP ${res.status}`;
}

/** This browser's subscription, if it has one. */
export async function currentSubscription(base: string): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(base);
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Asks for permission (call it from a click), subscribes with the browser's push service under the relay's key, and
 * registers the subscription with the relay for `accounts`. Calling it again updates the accounts and topics.
 */
export async function subscribePush({ relay, base, accounts, topics, liqWarn }: { relay: string; base: string; accounts: string[]; topics: PushTopic[]; liqWarn: LiqWarn }): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error("This browser cannot receive push notifications. On iPhone and iPad, install the app first.");
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this site in the browser settings." : "Notifications were not allowed.");
  const keyRes = await relayFetch(`${relay}/vapid`, { cache: "no-store" });
  if (!keyRes.ok) throw new Error(`The push relay did not answer (${await errorOf(keyRes)}).`);
  const { publicKey } = (await keyRes.json()) as { publicKey?: unknown };
  if (typeof publicKey !== "string") throw new Error("The push relay sent no key.");
  const key = base64UrlToBytes(publicKey);
  const reg = await registration(base);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made under another key (the relay rotated it) cannot receive this relay's pushes.
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const res = await relayFetch(`${relay}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), accounts, topics, liqWarn }),
  });
  if (!res.ok) throw new Error(`The push relay refused the subscription: ${await errorOf(res)}.`);
  return sub;
}

/** Stops pushes to this browser: tells the relay, then drops the subscription. */
export async function unsubscribePush({ relay, base }: { relay: string; base: string }): Promise<void> {
  const sub = await currentSubscription(base);
  if (!sub) return;
  await fetch(`${relay}/subscriptions`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
  await sub.unsubscribe();
}

// ─────────────────────────────── What this browser asked for ───────────────────────────────

/** Remembered per browser, to show which accounts are watched and notice when they or the choices change. */
export type PushRecord = { relay: string; endpoint: string; accounts: string[]; topics?: PushTopic[]; liqWarn?: LiqWarn };
const KEY = "dp-push-v1";

export function readPushRecord(): PushRecord | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const r = raw ? (JSON.parse(raw) as PushRecord) : null;
    return r && typeof r.relay === "string" && typeof r.endpoint === "string" && Array.isArray(r.accounts) ? r : null;
  } catch {
    return null;
  }
}

export function writePushRecord(record: PushRecord | null): void {
  try {
    if (record) window.localStorage.setItem(KEY, JSON.stringify(record));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the subscription still works; only the summary is lost.
  }
}

/** Accounts as the relay stores them: lower case, without repeats. */
export function pushAccounts(list: readonly (string | null | undefined)[]): string[] {
  return [...new Set(list.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()))];
}
