"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { useLocalStore } from "@/hooks/use-local-store";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useWallet } from "@/hooks/use-wallet";
import { IS_STATIC_BUILD } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { staticBaseUrl } from "@/lib/nav";
import { enableSystemNotifications } from "@/lib/notify";
import { prefs, type Prefs } from "@/lib/prefs";
import {
  currentSubscription,
  optionalSettingsQuery,
  pushAccounts,
  pushSupported,
  readPushRecord,
  subscribePush,
  unsubscribePush,
  writePushRecord,
  type PushRecord,
  type PushTopic,
} from "@/lib/push";
import { MAX_SLIPPAGE_BPS, tradeSettings } from "@/lib/storage";

const SLIPPAGE = [10, 30, 50, 100] as const;
const LEVERAGE_CAPS = [null, 10, 25, 50, 100, 250] as const;

function Toggle({ label, hint, checked, onChange, testId }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex items-start gap-3 py-1.5">
      <input type="checkbox" className="check mt-0.5" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={testId} />
      <span className="min-w-0">
        <span className="block text-[0.8125rem] text-text">{label}</span>
        {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h3 className="mb-1.5 text-xs font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** App-wide settings: trading defaults, notifications, self-imposed risk limits, install. */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { config: cfg } = useApp();
  const [settings, setSettings] = useLocalStore(tradeSettings);
  const [p, setPrefs] = useLocalStore(prefs);
  const install = useInstallPrompt();
  const [lossText, setLossText] = useState(p.dailyLossLimit === null ? "" : String(p.dailyLossLimit));
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const set = (patch: Partial<Prefs>) => setPrefs((prev) => ({ ...prev, ...patch }));

  return (
    <Sheet title="Settings" onClose={onClose} testId="settings-sheet">
      <div className="grid gap-4">
        <Section title="Trading">
          <span className="field-label">Slippage tolerance for market orders</span>
          <div className="segmented" role="group" aria-label="Slippage tolerance">
            {SLIPPAGE.map((bps) => (
              <button key={bps} type="button" aria-pressed={settings.slippageBps === bps} onClick={() => setSettings((s) => ({ ...s, slippageBps: Math.min(bps, MAX_SLIPPAGE_BPS) }))}>
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </div>
          <Toggle label="Skip the confirmation step" hint="Orders above 100x always ask first." checked={settings.oneClick} onChange={(v) => setSettings((s) => ({ ...s, oneClick: v }))} />
          <Toggle
            label={`Approve ${cfg.collateralSymbol} once`}
            hint="A standing allowance for the engine, so later wallet orders need one signature."
            checked={settings.approveUnlimited}
            onChange={(v) => setSettings((s) => ({ ...s, approveUnlimited: v }))}
          />
        </Section>

        <Section title="Risk limits (your own rules, enforced by this app)">
          <label className="block">
            <span className="field-label">Daily loss limit: stop opening new positions after losing</span>
            <span className="field">
              <input
                inputMode="decimal"
                placeholder="No limit"
                value={lossText}
                onChange={(event) => setLossText(event.target.value)}
                onBlur={() => {
                  const n = Number(lossText.replace(/,/g, ""));
                  set({ dailyLossLimit: lossText.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null });
                }}
                aria-label="Daily loss limit"
                data-testid="daily-loss-limit"
              />
              <span className="field-unit">{cfg.collateralSymbol} / day (UTC)</span>
            </span>
          </label>
          <span className="field-label mt-3">Highest leverage I allow myself</span>
          <div className="segmented" role="group" aria-label="Personal leverage cap">
            {LEVERAGE_CAPS.map((cap) => (
              <button key={cap ?? "off"} type="button" aria-pressed={p.maxLeverage === cap} onClick={() => set({ maxLeverage: cap })}>
                {cap === null ? "Market max" : `${cap}x`}
              </button>
            ))}
          </div>
          <span className="field-label mt-3">After a liquidation, pause new positions for</span>
          <div className="segmented" role="group" aria-label="Cool-off after a liquidation">
            {([null, 15, 60, 240] as const).map((m) => (
              <button key={m ?? "off"} type="button" aria-pressed={p.coolOffMinutes === m} onClick={() => set({ coolOffMinutes: m })}>
                {m === null ? "No pause" : m < 60 ? `${m} min` : `${m / 60} h`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-faint">Closing and managing positions always works; only new ones wait.</p>
        </Section>

        <Section title="Alerts and notifications">
          <span className="field-label">Warn me before liquidation</span>
          <div className="segmented" role="group" aria-label="Liquidation warning">
            {(
              [
                ["off", "Off"],
                ["half", "Half the buffer gone"],
                ["quarter", "Three quarters gone"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={p.liqWarn === value} onClick={() => set({ liqWarn: value })}>
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-faint">The buffer is the distance to liquidation a position starts with, so this works the same at 2x and 1000x.</p>
          <div className="mt-2">
            {permission === "granted" && settings.notify ? (
              <Toggle label="System notifications" hint="When the app is in the background." checked onChange={(v) => setSettings((s) => ({ ...s, notify: v }))} />
            ) : permission === "unsupported" ? (
              <p className="text-xs text-faint">This browser cannot show notifications. Install the app to get them on a phone.</p>
            ) : permission === "denied" ? (
              <p className="text-xs text-warn">Notifications are blocked for this site in the browser settings.</p>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void enableSystemNotifications()} data-testid="enable-notifications">
                Turn on system notifications
              </button>
            )}
          </div>
          <PushSetting liqWarn={p.liqWarn} fills={p.fillNotifications} />
          <Toggle label="Notify on fills, take-profits and stop-losses" checked={p.fillNotifications} onChange={(v) => set({ fillNotifications: v })} />
          <Toggle label="Vibrate on fills and warnings" hint="Phones only." checked={p.haptics} onChange={(v) => set({ haptics: v })} />
          <Toggle label="Price and PnL in the tab title" checked={p.titleTicker} onChange={(v) => set({ titleTicker: v })} />
          <Toggle
            label="Alert me when traders I follow trade"
            hint="Opens, additions, closes and liquidations, while the app is open."
            checked={p.followAlerts}
            onChange={(v) => set({ followAlerts: v })}
            testId="follow-alerts"
          />
        </Section>

        {install.canInstall || install.iosHint ? (
          <Section title="App">
            {install.canInstall ? (
              <button type="button" className="btn btn-sm" onClick={() => void install.prompt()}>
                Install Dry Powder
              </button>
            ) : (
              <p className="text-xs text-muted">To install on iPhone or iPad: tap Share in Safari, then Add to Home Screen.</p>
            )}
          </Section>
        ) : null}
      </div>
    </Sheet>
  );
}

const appBase = () => (IS_STATIC_BUILD ? staticBaseUrl(window.location) : `${window.location.origin}/`);

/**
 * Notifications while the app is closed (roadmap 50), through the push relay (keeper/src/push.mjs). Shown only when
 * the deployment names one (`pushRelayUrl` in config.json). Watches the wallet and its trading account; follows the
 * liquidation warning and fill choices above.
 */
function PushSetting({ liqWarn, fills }: { liqWarn: Prefs["liqWarn"]; fills: boolean }) {
  const wallet = useWallet();
  const trading = useTradingAccount();
  const settings = useQuery(optionalSettingsQuery(typeof window === "undefined" ? "" : appBase(), IS_STATIC_BUILD));
  const relay = settings.data?.pushRelayUrl ?? null;
  const [record, setRecord] = useState<PushRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribed: this browser has a subscription and it was registered with this relay.
  useEffect(() => {
    if (!relay) return;
    let live = true;
    void currentSubscription(appBase())
      .then((sub) => {
        const saved = readPushRecord();
        if (live) setRecord(sub && saved && saved.relay === relay && saved.endpoint === sub.endpoint ? saved : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [relay]);

  const accounts = pushAccounts([wallet.address, trading.account]);
  const topics: PushTopic[] = fills ? ["liquidation", "fill", "close"] : ["liquidation"];
  const changed = record !== null && (record.accounts.length !== accounts.length || record.accounts.some((a) => !accounts.includes(a)));

  const run = async (job: () => Promise<PushRecord | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await job();
      writePushRecord(next);
      setRecord(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const subscribe = (watch: string[]) =>
    run(async () => {
      const sub = await subscribePush({ relay: relay!, base: appBase(), accounts: watch, topics, liqWarn });
      return { relay: relay!, endpoint: sub.endpoint, accounts: watch, topics, liqWarn };
    });
  const unsubscribe = () =>
    run(async () => {
      await unsubscribePush({ relay: relay!, base: appBase() });
      return null;
    });

  // The warning level and the fill choice above apply to pushes too: re-register when they change.
  const stale = record !== null && (record.liqWarn !== liqWarn || (record.topics ?? []).join() !== topics.join());
  useEffect(() => {
    if (stale && !busy && record && relay) void subscribe(record.accounts);
  }, [stale]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!relay) return null;
  if (!pushSupported()) {
    return (
      <p className="mt-2 text-xs text-faint" data-testid="push-unsupported">
        Notifications while the app is closed need a browser with push support. On iPhone and iPad, install the app first.
      </p>
    );
  }
  return (
    <div className="mt-2" data-testid="push-setting">
      <Toggle
        label="Notify me while the app is closed"
        hint={
          accounts.length === 0
            ? "Connect a wallet first: the relay watches your wallet and its trading account."
            : "Liquidation warnings, and fills and closes when they are on below, through this deployment's push relay."
        }
        checked={record !== null}
        onChange={(v) => {
          if (busy || accounts.length === 0) return;
          void (v ? subscribe(accounts) : unsubscribe());
        }}
        testId="push-toggle"
      />
      <p className="text-xs text-faint" role="status" aria-live="polite" data-testid="push-status">
        {busy
          ? "Working…"
          : record
            ? `Watching ${record.accounts.map(shortAddress).join(" and ")}.`
            : ""}
        {record && changed && !busy ? (
          <>
            {" "}
            <button type="button" className="link" onClick={() => void subscribe(accounts)}>
              Watch {accounts.map(shortAddress).join(" and ")} instead
            </button>
          </>
        ) : null}
      </p>
      {error ? (
        <p className="text-xs text-warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-ghost h-8 px-2 ${className}`} aria-label="Settings" title="Settings" onClick={() => setOpen(true)} data-testid="settings-button">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      </button>
      {open ? <SettingsSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
