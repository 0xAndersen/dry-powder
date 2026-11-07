// Records a demo video of the UI while the scripted traders run: /trade, then /activity, then /house.
//
//   TRADERS=100 RATE=4 EXPIRY_SECONDS=3600 node e2e/stack.mjs     # in one terminal
//   node e2e/record.mjs                                            # in another -> e2e/out/demo.webm
//
// Environment: DURATION (seconds, default 60), WIDTH / HEIGHT (default 1440 x 900), OUT (file name).
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, WEB_URL, log, readAddresses, sleep } from "./lib.mjs";
import { launch, newPage } from "./browser.mjs";

const addresses = readAddresses();
const duration = Number(process.env.DURATION ?? 60) * 1000;
const viewport = { width: Number(process.env.WIDTH ?? 1440), height: Number(process.env.HEIGHT ?? 900) };
const outDir = join(HERE, "out");
const target = join(outDir, process.env.OUT ?? "demo.webm");
const scratch = join(outDir, ".video");
mkdirSync(scratch, { recursive: true });

const browser = await launch();
const { page, context } = await newPage(browser, { viewport, video: scratch });
const t = (id) => page.getByTestId(id);
const started = Date.now();
const until = async (fraction) => {
  const left = started + duration * fraction - Date.now();
  if (left > 0) await sleep(left);
};
/** Never let a hiccup in the scripted clicks cost the recording. */
const attempt = async (what, fn) => {
  try {
    await fn();
  } catch (error) {
    log("record", `skipped "${what}": ${String(error?.message ?? error).split("\n")[0]}`);
  }
};

// ── Trade: connect, fund, open a keeper-filled long with brackets, watch it fill. ──
await page.goto(`${WEB_URL}/trade/`);
await attempt("connect", async () => {
  await t("market-price").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await t("account-bar").waitFor({ timeout: 10_000 });
});
await attempt("test funds", async () => {
  await sleep(1_200);
  await t("get-test-funds").click();
  await page.getByText(/of test funds added/).waitFor({ timeout: 15_000 });
});
await attempt("market long with brackets", async () => {
  await page.getByRole("group", { name: "Quantity entered as" }).getByRole("button", { name: "Size", exact: true }).click();
  await t("ticket-qty").pressSequentially("2500", { delay: 90 });
  await page.getByRole("button", { name: "10x", exact: true }).click();
  await sleep(500);
  await t("add-brackets").click();
  await page.getByLabel("Take-profit entered as").selectOption("r");
  await page.getByLabel("Stop-loss entered as").selectOption("pct");
  await t("ticket-sl").pressSequentially("1.5", { delay: 90 });
  await t("ticket-tp").pressSequentially("2", { delay: 90 });
  await sleep(1_200);
  await t("ticket-submit").click();
  await sleep(1_400);
  await t("confirm-yes").click();
  await page.locator('[data-testid="tracked-orders"] [data-status="filled"]').first().waitFor({ timeout: 30_000 });
});
await attempt("limit price from the chart", async () => {
  await sleep(1_500);
  await page.getByRole("tab", { name: /^ETH-USD/ }).click();
  await sleep(1_000);
  await page.getByRole("group", { name: "Set a price by clicking the chart" }).getByRole("button", { name: "Limit" }).click();
  const box = await t("chart-canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.82, { steps: 20 });
  await sleep(500);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.82);
  await sleep(1_000);
  await page.getByRole("tab", { name: /^BTC-USD\b/ }).first().click();
});
await until(1 / 3);

// ── Activity: the venue-wide feed. ──
await page.goto(`${WEB_URL}/activity/`);
await attempt("activity", async () => {
  await page.locator(".feed-table tbody tr").first().waitFor({ timeout: 20_000 });
  await until(0.5);
  await page.getByRole("group", { name: "Filter by market" }).getByRole("button", { name: /^ETH-USD/ }).click();
  await sleep(3_000);
  await page.getByRole("button", { name: "All markets" }).click();
});
await until(2 / 3);

// ── House: NAV, epoch, staking. ──
await page.goto(`${WEB_URL}/house/`);
await attempt("house", async () => {
  await page.getByText("Share price").first().waitFor({ timeout: 20_000 });
  await sleep(2_000);
  await page.getByRole("button", { name: "About vault nav" }).hover();
  await sleep(5_000);
  await page.mouse.move(700, 600, { steps: 10 });
  const settle = t("settle-epoch");
  if (await settle.isEnabled()) {
    await settle.click();
    await sleep(3_000);
  }
});
await until(1);

const video = page.video();
await context.close();
const recorded = await video.path();
rmSync(target, { force: true });
renameSync(recorded, target);
rmSync(scratch, { recursive: true, force: true });
await browser.close();
log("record", `${((Date.now() - started) / 1000).toFixed(0)}s of ${viewport.width}x${viewport.height} video saved to ${target} (dated market: ${addresses.datedSymbol})`);
