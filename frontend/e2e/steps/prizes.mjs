// Season prizes (roadmap 81) on the Portfolio page: the card before any season is published, then a season built
// and published exactly as ops/scripts/prizes.mjs does it (keeper/src/prizes.mjs: standings from daily buckets,
// the Merkle tree, fund and publishResults), with a claim for the wallet and one for its agent account through the
// UI. Then the push opt-in in Settings (roadmap 50): hidden without a push relay, wired to one when configured.
// The results files are served from out/prizes/ (the app's fallback location) and removed afterwards.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, WEEK, parseTable, publishSeason, readResults, seasonByNumber, seasonResults, updateIndex, weekStart } from "../../../keeper/src/prizes.mjs";
import { createPushApi, createStore, generateVapidKeys, validateSubscription } from "../../../keeper/src/push.mjs";
import { FRONTEND, walletClient } from "../lib.mjs";

export const section = "prizes";

export default async function prizes({ step, page, t, read, shot, addresses, pub, ensureWallet, WEB_URL, UI_TRADER, DEPLOYER, artifact }) {
  const dir = join(FRONTEND, "out", "prizes");
  const usd = (n) => BigInt(Math.round(n * 1e6));
  if (!addresses.prizeDistributor) {
    await step("prizes: skipped (no PrizeDistributor in this deployment)", async () => "skipped");
    return;
  }

  await step("prizes: before any season is published the Portfolio explains the prizes", async () => {
    rmSync(dir, { recursive: true, force: true });
    await page.goto(`${WEB_URL}/portfolio/`);
    await ensureWallet();
    await t("prize-card").waitFor({ timeout: 20_000 });
    await t("prize-empty").waitFor({ timeout: 15_000 });
  });

  try {
    await step("prizes: a published season shows its pool and winners; the wallet and its agent account each claim", async () => {
      const deployer = walletClient(DEPLOYER);
      let agent = await read(addresses.agentFactory, "AgentAccountFactory", "accountOf", [UI_TRADER.address]);
      if (/^0x0{40}$/i.test(agent)) {
        const hash = await deployer.writeContract({ address: addresses.agentFactory, abi: artifact("AgentAccountFactory").abi, functionName: "createAccount", args: [UI_TRADER.address] });
        await pub.waitForTransactionReceipt({ hash });
        agent = await read(addresses.agentFactory, "AgentAccountFactory", "accountOf", [UI_TRADER.address]);
      }
      // Three weeks of history: season 1 is a finished week, with the indexer's daily buckets for three traders.
      const now = Number((await pub.getBlock()).timestamp);
      const launch = weekStart(now) - 2 * WEEK - DAY;
      const season = seasonByNumber(1, launch);
      const bucket = (net, trades) => ({ days: [{ i: Math.floor((season.start + DAY) / DAY), r: String(usd(net)), f: "0", v: String(usd(net * 40)), m: "0", t: trades, w: trades, l: 0, x: 0 }] });
      const stranger = "0x00000000000000000000000000000000000000a7";
      const stats = {
        chainId: 31337,
        engine: addresses.engine.toLowerCase(),
        deployTime: launch,
        cursorBlock: Number(await pub.getBlockNumber()),
        cursorTime: now,
        traders: { [UI_TRADER.address.toLowerCase()]: bucket(500, 4), [agent.toLowerCase()]: bucket(300, 9), [stranger]: bucket(100, 2) },
      };
      const results = seasonResults({ stats, season, table: parseTable("[250, 120, 50]"), deadline: now + 7 * DAY, distributor: addresses.prizeDistributor, chainId: 31337, launch });
      await publishSeason({ pub, wallet: deployer, distributor: addresses.prizeDistributor, usdc: addresses.usdc, results: readResults(results), fund: true, mint: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "season-1.json"), JSON.stringify(results, null, 2));
      writeFileSync(join(dir, "index.json"), JSON.stringify(updateIndex(null, results, "season-1.json"), null, 2));

      await page.goto(`${WEB_URL}/portfolio/`);
      await ensureWallet();
      await t("prize-pool").waitFor({ timeout: 20_000 });
      const pool = await t("prize-pool-total").innerText();
      if (!/420\.00/.test(pool)) throw new Error(`the pool shows "${pool}"`);
      const winners = await t("prize-winners").locator("li").count();
      if (winners !== 3) throw new Error(`${winners} winners listed`);
      const row = (account, status) => page.locator(`[data-testid="prize-row"][data-account="${account.toLowerCase()}"]${status ? `[data-status="${status}"]` : ""}`);
      await row(UI_TRADER.address, "claimable").waitFor({ timeout: 20_000 });
      await row(agent, "claimable").waitFor({ timeout: 20_000 });
      await shot(page, "40-prizes");

      for (const [account, amount] of [
        [UI_TRADER.address, 250],
        [agent, 120],
      ]) {
        const before = await read(addresses.usdc, "TestUSDC", "balanceOf", [account]);
        await row(account).getByTestId("prize-claim").click();
        await row(account, "claimed").waitFor({ timeout: 30_000 });
        const after = await read(addresses.usdc, "TestUSDC", "balanceOf", [account]);
        if (after - before !== usd(amount)) throw new Error(`${account} received ${after - before}, expected ${usd(amount)}`);
      }
      if (!(await read(addresses.prizeDistributor, "PrizeDistributor", "claimed", [1n, agent]))) throw new Error("the agent account's claim is not recorded");
      await row(agent, "claimed").getByText(/Agents page/).waitFor({ timeout: 5_000 });
      return `pool 420, claimed 250 to the wallet and 120 to agent account ${agent.slice(0, 10)}…`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  await step("push: Settings offer notifications while the app is closed only when a push relay is configured", async () => {
    await page.goto(`${WEB_URL}/portfolio/`);
    await ensureWallet();
    await t("settings-button").first().click();
    await t("settings-sheet").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(800);
    if ((await t("push-setting").count()) + (await t("push-unsupported").count()) > 0) throw new Error("the push setting shows without a relay");
    await page.keyboard.press("Escape");

    // A relay on a free port (the subscription API of keeper/src/push.mjs), and config.json naming it.
    const seen = [];
    const store = createStore(null);
    const api = createPushApi({ store, vapidPublicKey: generateVapidKeys().publicKey, validate: (b) => validateSubscription(b, { allowLocal: true }) });
    api.on("request", (req) => seen.push(`${req.method} ${req.url}`));
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    const relay = `http://127.0.0.1:${api.address().port}`;
    await page.route("**/config.json*", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), pushRelayUrl: relay } });
    });
    try {
      await page.context().grantPermissions(["notifications"], { origin: new URL(WEB_URL).origin });
      await page.reload();
      await ensureWallet();
      await t("settings-button").first().click();
      await page.locator('[data-testid="push-setting"], [data-testid="push-unsupported"]').first().waitFor({ timeout: 15_000 });
      if ((await t("push-unsupported").count()) > 0) return "this browser has no push support: the setting explains it";
      // A click, not check(): the box only turns on once the subscription is registered.
      await t("push-toggle").click();
      // Headless Chromium has no push service to register with: the relay is asked for its key, then the browser's
      // subscribe() fails or (with a push service) the subscription reaches the relay.
      await page.waitForFunction(() => document.querySelector('[data-testid="push-setting"] [role="alert"]') || /Watching/.test(document.querySelector('[data-testid="push-status"]')?.textContent ?? ""), null, { timeout: 20_000 });
      if (!seen.some((s) => s.startsWith("GET /vapid"))) {
        const alert = await page.locator('[data-testid="push-setting"] [role="alert"]').first().innerText().catch(() => "");
        throw new Error(`the app never asked the relay for its key (requests: ${seen.join(", ") || "none"}; the app said: ${alert || "nothing"})`);
      }
      const said = (await t("push-setting").innerText()).replace(/\s+/g, " ");
      if (store.size === 1) return `subscribed: ${said}`;
      if (await t("push-toggle").isChecked()) throw new Error("the toggle shows on although subscribing failed");
      return `relay asked for its key; the browser could not subscribe here: ${said.slice(0, 160)}`;
    } finally {
      await page.unroute("**/config.json*");
      await page.keyboard.press("Escape").catch(() => {});
      // Subscribing registered the app's service worker in this context: leave none behind for later sections.
      await page.evaluate(async () => Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => r.unregister()))).catch(() => {});
      await new Promise((r) => api.close(r));
    }
  });
}
