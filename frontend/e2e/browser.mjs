// Headless Chromium with an injected wallet. The wallet forwards everything to anvil, where the UI trader's
// account is unlocked, so "confirm in your wallet" resolves at once.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { RPC_URL, UI_TRADER } from "./lib.mjs";

async function loadPlaywright() {
  const candidates = ["playwright", "playwright-core", "/opt/npm-tools/node_modules/playwright/index.mjs"];
  for (const name of candidates) {
    try {
      return await import(name);
    } catch {
      // Try the next location.
    }
  }
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    throw new Error("Playwright is not installed. `npm i -D playwright` in frontend/, or set NODE_PATH to where it lives.");
  }
}

/** A Chromium installed outside Playwright's cache, for machines where Playwright's own build is missing. */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const binary = dir ? join(root, dir, "chrome-linux", "chrome") : undefined;
  return binary && existsSync(binary) ? binary : undefined;
}

export const walletScript = (address = UI_TRADER.address, rpc = RPC_URL) => `
  window.ethereum = {
    isMetaMask: true,
    _l: {},
    on(e, f) { (this._l[e] ||= []).push(f); },
    removeListener() {},
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${address}"];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "wallet_revokePermissions") return null;
      const r = await fetch("${rpc}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
      return j.result;
    },
  };`;

/**
 * Headless Chromium as the app's users run it. CHROMIUM names a binary; otherwise Playwright's own Chromium in the
 * new headless mode (`channel: "chromium"`), because the old headless shell Playwright launches by default reports
 * notifications as denied whatever the context grants, which hides the push setting's real path.
 */
export async function launch() {
  const { chromium } = await loadPlaywright();
  const args = ["--no-proxy-server"];
  if (process.env.CHROMIUM) return chromium.launch({ args, executablePath: process.env.CHROMIUM });
  try {
    return await chromium.launch({ args, channel: "chromium" });
  } catch (e) {
    const executablePath = findChromium();
    if (!executablePath) throw e;
    return chromium.launch({ args, executablePath });
  }
}

/** A page in a fresh context. `wallet: false` gives a browser with no wallet extension. */
export async function newPage(browser, { viewport = { width: 1440, height: 900 }, wallet = true, video } = {}) {
  const context = await browser.newContext({ viewport, ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
  if (wallet) await context.addInitScript(walletScript());
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  return { page, context, problems };
}
