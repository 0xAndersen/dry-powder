// End-to-end click-through of the v2 frontend against the local stack (start it first: `node e2e/stack.mjs`
// with TRADERS >= 5 so the activity feed and the house have something to show).
//
//   node e2e/run.mjs                 # everything
//   node e2e/run.mjs trade,house     # only some sections: trade, instruments, watch, activity, settle, house, extras, agents, responsive
//
// Exits non-zero if any step fails. Screenshots land in e2e/out/shots/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIRST_SCRIPTED_TRADER, HERE, KRAKEN_URL, RPC_URL, UI_TRADER, WEB_URL, account, artifact, log, publicClient, readAddresses, sleep } from "./lib.mjs";
import { launch, newPage } from "./browser.mjs";

const addresses = readAddresses();
const pub = publicClient();
const SHOTS = join(HERE, "out", "shots");
mkdirSync(SHOTS, { recursive: true });

const only = process.argv[2]?.split(",");
const want = (section) => !only || only.includes(section);
const results = [];
const failedRequests = new Map();

async function step(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    log("e2e", `ok    ${name}${note ? `  (${note})` : ""}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error).split("\n").slice(0, 3).join(" | ") });
    log("e2e", `FAIL  ${name} :: ${results[results.length - 1].error}`);
    await page.screenshot({ path: join(SHOTS, `fail-${results.length}.png`) }).catch(() => {});
    return false;
  }
}

const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const num = (text) => Number(String(text).replace(/[^0-9.+-]/g, ""));
const read = (address, name, functionName, args = []) => pub.readContract({ address, abi: artifact(name).abi, functionName, args });

const browser = await launch();
const { page, problems } = await newPage(browser);
page.on("requestfailed", (r) => {
  const key = `${r.url().slice(0, 100)} ${r.failure()?.errorText ?? ""}`;
  if (!/ERR_ABORTED/.test(key)) failedRequests.set(key, (failedRequests.get(key) ?? 0) + 1);
});
page.on("response", (r) => {
  if (r.status() >= 400) failedRequests.set(`${r.status()} ${r.url().slice(0, 100)}`, 1);
});

const t = (id) => page.getByTestId(id);
const price = async () => num(await t("market-price").innerText());

/** Lets a section run on its own: connects the injected wallet if this browser context has not yet. */
async function ensureWallet() {
  await page.waitForTimeout(1_200);
  const connect = page.getByRole("button", { name: "Connect wallet", exact: true });
  if ((await connect.count()) > 0) {
    await connect.first().click();
    await page.getByRole("button", { name: /0x[0-9a-fA-F]{4}…/ }).waitFor({ timeout: 10_000 });
  }
}

async function selectMarket(symbol, viaSearch) {
  await t("market-picker").click();
  if (viaSearch) await page.getByLabel("Search markets").fill(viaSearch);
  await t(`market-option-${symbol}`).click();
  await page.getByRole("heading", { name: `Trade ${symbol}` }).waitFor({ state: "attached", timeout: 5_000 });
  await page.waitForTimeout(600);
}

async function setQty(mode, value) {
  await page.getByRole("group", { name: "Quantity entered as" }).getByRole("button", { name: mode, exact: true }).click();
  await t("ticket-qty").fill(String(value));
}

async function submitTicket() {
  await t("ticket-submit").click();
  await t("confirm-yes").click();
}

async function waitFilled(timeout = 30_000) {
  await page.locator('[data-testid="tracked-orders"] [data-status="filled"]').first().waitFor({ timeout });
}

async function waitPosition(symbol, present = true, timeout = 30_000) {
  await t("tab-positions").click();
  await t(`position-${symbol}`).waitFor({ state: present ? "visible" : "detached", timeout });
}

// ─────────────────────────────── trade ───────────────────────────────
if (want("trade")) {
  await step(`app loads from ${WEB_URL} and lists markets from the chain`, async () => {
    await page.goto(`${WEB_URL}/`);
    await page.waitForURL(/\/trade\/?(\?|$)/, { timeout: 10_000 });
    await t("market-price").waitFor({ timeout: 20_000 });
    const tabs = await page.getByRole("tablist", { name: "Markets" }).getByRole("tab").count();
    if (tabs !== addresses.markets.length) throw new Error(`expected ${addresses.markets.length} markets, saw ${tabs}`);
    await page.waitForFunction(() => /Bid .* Ask/.test(document.querySelector('[data-testid="market-quote"]')?.textContent ?? ""), null, { timeout: 15_000 });
    await shot(page, "01-trade-disconnected");
    return `${tabs} markets`;
  });

  await step("connect the injected wallet", async () => {
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await t("account-bar").waitFor({ timeout: 10_000 });
  });

  await step("get test funds (TestUSDC.mint 10,000)", async () => {
    const before = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    await t("get-test-funds").click();
    await page.getByText(/of test funds added/).waitFor({ timeout: 20_000 });
    const after = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    if (after - before !== 10_000_000_000n) throw new Error(`balance moved by ${after - before}`);
    await t("account-bar").getByText("10,000.00").first().waitFor({ timeout: 10_000 });
  });

  await step("approve + keeper-filled market long on BTC-USD with TP (%) and SL (%)", async () => {
    await selectMarket("BTC-USD");
    await setQty("Size", 2000);
    await page.getByRole("button", { name: "10x", exact: true }).click();
    await t("add-brackets").click();
    await page.getByLabel("Take-profit entered as").selectOption("pct");
    await t("ticket-tp").fill("3");
    await page.getByLabel("Stop-loss entered as").selectOption("pct");
    await t("ticket-sl").fill("2.5");
    await page.waitForTimeout(800);
    const equivalents = await t("ticket-equivalents").innerText();
    if (!/Margin 200\.00/.test(equivalents) || !/BTC/.test(equivalents)) throw new Error(`quantity modes out of sync: ${equivalents}`);
    await shot(page, "02-ticket-filled-in");
    await t("ticket-submit").click();
    await t("confirm-dialog").waitFor();
    await shot(page, "03-confirm");
    await t("confirm-yes").click();
    await page.getByText(/Approve tUSDC/).first().waitFor({ timeout: 15_000 });
    await page.getByText(/Market long sent as order #\d+/).waitFor({ timeout: 30_000 });
    await waitFilled();
    await waitPosition("BTC-USD");
    const allowance = await read(addresses.usdc, "TestUSDC", "allowance", [UI_TRADER.address, addresses.engine]);
    if (allowance === 0n) throw new Error("no allowance was granted");
    const pos = await read(addresses.engine, "PerpEngine", "getPosition", [UI_TRADER.address, addresses.markets[0].marketId]);
    if (pos.size !== 2_000_000_000n || pos.margin !== 200_000_000n || pos.tpOrderId === 0n || pos.slOrderId === 0n) throw new Error("position on-chain differs from the ticket");
    await page.waitForTimeout(1500);
    await shot(page, "04-position-open");
    return (await page.locator('[data-testid="tracked-orders"] [data-status="filled"]').first().innerText()).replace(/\s+/g, " ");
  });

  await step("edit the take-profit inline", async () => {
    const mark = await price();
    await t("position-BTC-USD").getByTestId("edit-tp").click();
    await t("input-tp").fill((mark * 1.04).toFixed(2));
    await t("save-tp").click();
    await page.getByText(/Take-profit moved to/).waitFor({ timeout: 20_000 });
    const pos = await read(addresses.engine, "PerpEngine", "getPosition", [UI_TRADER.address, addresses.markets[0].marketId]);
    const order = await read(addresses.engine, "PerpEngine", "getOrder", [pos.tpOrderId]);
    const onchain = Number(order.triggerPrice) / 1e18;
    if (Math.abs(onchain / (mark * 1.04) - 1) > 0.0001) throw new Error(`trigger on-chain is ${onchain}`);
    // A trigger on the wrong side would fire at once; the UI must refuse it.
    await t("position-BTC-USD").getByTestId("edit-tp").click();
    await t("input-tp").fill((mark * 0.9).toFixed(2));
    if (!(await t("save-tp").isDisabled())) throw new Error("a take-profit below the price was not blocked");
    await page.keyboard.press("Escape");
  });

  await step("limit order by clicking the chart, then cancel it", async () => {
    await selectMarket("ETH-USD", "eth-usd");
    await page.getByRole("group", { name: "Set a price by clicking the chart" }).getByRole("button", { name: "Limit" }).click();
    await page.getByText(/Click the chart to set the limit price/).waitFor();
    const box = await t("chart-canvas").boundingBox();
    const mark = await price();
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.9);
    const limit = Number(await page.getByLabel("Limit price").inputValue());
    if (!(limit > 0) || limit >= mark) throw new Error(`chart click gave ${limit}, market is ${mark}`);
    await setQty("Size", 500);
    await page.waitForTimeout(500);
    await shot(page, "05-limit-from-chart");
    await submitTicket();
    await page.getByText(/Limit long #\d+ is resting/).waitFor({ timeout: 30_000 });
    await t("tab-orders").click();
    const row = page.locator('[data-testid^="order-"]').filter({ hasText: "ETH-USD" }).first();
    await row.getByText(/Resting/).waitFor({ timeout: 10_000 });
    await shot(page, "06-limit-resting");
    const before = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    await row.getByTestId("cancel-order").click();
    await page.getByText(/Order #\d+ cancelled/).waitFor({ timeout: 20_000 });
    const after = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    if (after <= before) throw new Error("the escrow was not refunded");
    return `limit ${limit} vs market ${mark}, refunded ${Number(after - before) / 1e6}`;
  });

  await step("keyboard-accessible alternative to the chart click (type a stop-loss price)", async () => {
    await page.getByRole("group", { name: "Set a price by clicking the chart" }).getByRole("button", { name: "SL" }).click();
    const input = page.getByLabel(/Click the chart to set the stop-loss/);
    const mark = await price();
    await input.fill((mark * 0.97).toFixed(2));
    await input.press("Enter");
    const value = Number(await t("ticket-sl").inputValue());
    if (Math.abs(value / (mark * 0.97) - 1) > 0.0001) throw new Error(`stop-loss field holds ${value}`);
    await t("ticket-sl").fill("");
  });

  await step("one-click Close places a keeper Close order; history shows the round trip", async () => {
    await selectMarket("BTC-USD");
    await t("tab-positions").click();
    await t("position-BTC-USD").getByTestId("close-position").click();
    await page.getByText(/Close order #\d+ sent/).waitFor({ timeout: 20_000 });
    await waitPosition("BTC-USD", false);
    await t("tab-history").click();
    await t("history-close").first().waitFor({ timeout: 15_000 });
    await t("history-open").first().waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
    await shot(page, "07-history");
    return `realised ${await t("history-realised").innerText()}`;
  });

  await step("risk-based sizing + stop-loss fill mints KEG", async () => {
    await selectMarket("SOL-USD");
    await page.getByRole("group", { name: "Quantity entered as" }).getByRole("button", { name: "Risk", exact: true }).click();
    await page.getByLabel("Amount to risk at the stop-loss").fill("10");
    await page.getByLabel("Stop-loss entered as").selectOption("pct");
    await t("ticket-sl").fill("0.12");
    await page.getByText(/Risking 10\.00 tUSDC to your stop gives/).waitFor({ timeout: 5_000 });
    const summary = await page.getByText(/Risking 10\.00 tUSDC to your stop gives/).innerText();
    await shot(page, "08-risk-sizing");
    const fromBlock = await pub.getBlockNumber();
    await submitTicket();
    await waitFilled();
    // The stop is tight on purpose, so the position can be gone again within a second: read the fill from the logs.
    const engineAbi = artifact("PerpEngine").abi;
    const opened = await pub.getContractEvents({ address: addresses.engine, abi: engineAbi, eventName: "PositionOpened", args: { trader: UI_TRADER.address }, fromBlock });
    const size = Number(opened[opened.length - 1]?.args.size ?? 0n) / 1e6;
    // 10 USDC at a 0.12% stop with 0.05% x 2 fees: about 4,545 of size.
    if (size < 4_300 || size > 4_800) throw new Error(`risk sizing produced ${size}`);
    // Push the price through the stop rather than wait for the random walk to get there.
    await fetch(`${KRAKEN_URL}/control/move?feed=SOL&pct=-1.5`);
    for (let i = 0; i < 60; i += 1) {
      const pos = await read(addresses.engine, "PerpEngine", "getPosition", [UI_TRADER.address, addresses.markets[2].marketId]);
      if (pos.size === 0n) break;
      if (i === 59) throw new Error("the stop-loss never triggered");
      await sleep(500);
    }
    await waitPosition("SOL-USD", false, 10_000);
    const house = await read(addresses.token, "RewardToken", "balanceOf", [UI_TRADER.address]);
    if (house === 0n) throw new Error("the stop-loss fill minted no KEG (did the position close at a profit?)");
    return `${summary.replace(/\s+/g, " ")} | KEG ${Number(house / 10n ** 16n) / 100}`;
  });
}

// ─────────────────────────────── instruments ───────────────────────────────
if (want("instruments")) {
  await step("dated future: countdown, settlement copy, open in contracts", async () => {
    if (!/\/trade\/?(\?|$)/.test(page.url())) await page.goto(`${WEB_URL}/trade/`);
    await t("market-price").waitFor({ timeout: 20_000 });
    await ensureWallet();
    await t("market-picker").click();
    await page.getByRole("region", { name: "Dated futures" }).waitFor();
    for (const group of ["Perpetuals", "Crosses", "FX & Metals", "Dated futures"]) {
      if ((await page.getByRole("region", { name: group }).count()) === 0) throw new Error(`group ${group} missing from the selector`);
    }
    await t(`market-option-${addresses.datedSymbol}`).click();
    await t("expiry-countdown").waitFor({ timeout: 5_000 });
    await t("dated-banner").getByText(/Settles at the oracle price at expiry/).waitFor();
    await setQty("Contracts", "0.02");
    await page.getByRole("button", { name: "5x", exact: true }).click();
    await page.waitForTimeout(600);
    const eq = await t("ticket-equivalents").innerText();
    await shot(page, "09-dated-future");
    await submitTicket();
    await waitFilled();
    await waitPosition(addresses.datedSymbol);
    const pos = await read(addresses.engine, "PerpEngine", "getPosition", [UI_TRADER.address, addresses.markets[7].marketId]);
    const units = Number(pos.size) / 1e6 / (Number(pos.entryPrice) / 1e18);
    if (Math.abs(units - 0.02) > 0.0002) throw new Error(`0.02 contracts became ${units}`);
    return `${eq.replace(/\s+/g, " ")} | expires in ${await t("expiry-countdown").innerText()}`;
  });

  await step("cross market ETH-BTC: sensible decimals, open short by margin", async () => {
    await selectMarket("ETH-BTC", "cross");
    const text = await t("market-price").innerText();
    if (!/^0\.0\d{5,7}$/.test(text.trim())) throw new Error(`ETH-BTC price shown as "${text}"`);
    await page.getByRole("group", { name: "Direction" }).getByRole("button", { name: "Short" }).click();
    await setQty("Margin", 100);
    await page.getByRole("button", { name: "5x", exact: true }).click();
    await page.waitForTimeout(500);
    await submitTicket();
    await waitFilled();
    await waitPosition("ETH-BTC");
    await shot(page, "10-cross-market");
    return `price ${text}`;
  });

  await step("inverted FX (JPY-USD) and gold show sensible decimals", async () => {
    await selectMarket("JPY-USD");
    const jpy = (await t("market-price").innerText()).trim();
    if (!/^0\.00\d{6}$/.test(jpy)) throw new Error(`JPY-USD price shown as "${jpy}"`);
    await selectMarket("XAU-USD");
    const xau = (await t("market-price").innerText()).trim();
    if (!/^\d,\d{3}\.\d{2}$/.test(xau)) throw new Error(`XAU-USD price shown as "${xau}"`);
    return `JPY-USD ${jpy}, XAU-USD ${xau}`;
  });

  await step("reverse: close order, wait for the keeper, open the other side", async () => {
    await selectMarket("ETH-BTC");
    await page.getByRole("button", { name: "Reverse", exact: true }).click();
    await page.getByText(/Reversing is two keeper orders/).waitFor();
    await shot(page, "11-reverse-confirm");
    await t("confirm-yes").click();
    await page.getByText(/Market long sent as order #\d+/).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => /Long/.test(document.querySelector('[data-testid="ticket-position"]')?.textContent ?? ""), null, { timeout: 30_000 });
    const pos = await read(addresses.engine, "PerpEngine", "getPosition", [UI_TRADER.address, addresses.markets[6].marketId]);
    if (!pos.isLong) throw new Error("the position did not flip");
  });

  await step("awaiting price: a market with a stale on-chain price still takes a keeper order", async () => {
    await fetch(`${KRAKEN_URL}/control/freeze?feed=EUR&on=1`);
    try {
      // A closed market is recognised by its ticker not changing; give the publisher time to notice.
      await sleep(Number(process.env.FREEZE_SETTLE_MS ?? 8_000));
      await selectMarket("EUR-USD");
      await t("market-quote").getByText(/Awaiting on-chain price/).waitFor({ timeout: 20_000 });
      await setQty("Size", 300);
      await page.getByText(/Awaiting an on-chain price/).waitFor({ timeout: 5_000 });
      await shot(page, "12-awaiting-price");
      await submitTicket();
      await page.locator('[data-testid="tracked-orders"] [data-status="resting"]').waitFor({ timeout: 30_000 });
      await sleep(3_000);
      if ((await page.locator('[data-testid="tracked-orders"] [data-status="filled"]').count()) > 0) throw new Error("filled without a price");
    } finally {
      await fetch(`${KRAKEN_URL}/control/freeze?feed=EUR&on=0`);
    }
    await waitFilled();
    await waitPosition("EUR-USD");
    await t("position-EUR-USD").getByTestId("close-position").click();
    await waitPosition("EUR-USD", false);
  });
}

// ─────────────────────────────── extras ───────────────────────────────
if (want("extras")) {
  await step("keyboard shortcuts and the ? overlay", async () => {
    if (!/\/trade\/?(\?|$)/.test(page.url())) await page.goto(`${WEB_URL}/trade/`);
    await t("market-price").waitFor({ timeout: 20_000 });
    await ensureWallet();
    await page.locator("h1").focus().catch(() => {});
    await page.mouse.click(5, 300);
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    await shot(page, "13-shortcuts");
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    if ((await page.getByRole("group", { name: "Direction" }).getByRole("button", { name: "Short" }).getAttribute("aria-pressed")) !== "true") throw new Error("S did not select short");
    await page.keyboard.press("b");
    await page.keyboard.press("l");
    if ((await page.getByRole("tab", { name: "Limit" }).getAttribute("aria-selected")) !== "true") throw new Error("L did not select limit");
    await page.keyboard.press("m");
    const before = await page.locator("h1").innerText();
    await page.keyboard.press("]");
    await page.waitForTimeout(400);
    const after = await page.locator("h1").innerText();
    if (before === after) throw new Error("] did not change market");
    await page.keyboard.press("[");
    await page.keyboard.press("q");
    if (!(await t("ticket-qty").evaluate((el) => el === document.activeElement))) throw new Error("Q did not focus the size field");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 300);
    await page.keyboard.press("i");
    await page.getByRole("button", { name: /Indicators.*hidden/ }).waitFor({ timeout: 3_000 });
    await page.keyboard.press("i");
  });

  await step("indicators: toggle and parameterise (EMA x2, SMA, Bollinger, VWAP, RSI, MACD)", async () => {
    await page.getByRole("button", { name: /^Indicators/ }).click();
    const menu = page.getByRole("dialog", { name: "Indicators" });
    for (const name of ["EMA (slow)", "SMA", "Bollinger Bands", "VWAP (daily, UTC)", "RSI (own pane)", "MACD (own pane)"]) await menu.getByLabel(name).check();
    await menu.locator("li").filter({ hasText: "RSI" }).getByRole("spinbutton").fill("9");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    await shot(page, "14-indicators");
    const panes = await page.evaluate(() => document.querySelectorAll('[data-testid="chart-canvas"] table tr').length);
    if (panes < 5) throw new Error(`expected extra panes for RSI and MACD, table rows: ${panes}`);
    await page.getByRole("button", { name: /^Indicators/ }).click();
    for (const name of ["SMA", "Bollinger Bands", "VWAP (daily, UTC)", "RSI (own pane)", "MACD (own pane)"]) await menu.getByLabel(name).uncheck();
    await page.keyboard.press("Escape");
  });

  await step("price alert fires a toast", async () => {
    await selectMarket("BTC-USD");
    await t("tab-alerts").click();
    const now = await price();
    await t("alert-price").fill((now * 1.003).toFixed(2));
    await page.getByRole("button", { name: "Add alert above" }).click();
    await t("alert-row").first().getByText("Waiting").waitFor();
    // Push the price through the level rather than wait for the random walk.
    await fetch(`${KRAKEN_URL}/control/move?feed=BTC&pct=0.8`);
    await page.getByRole("region", { name: "Notifications" }).getByText(/BTC-USD rose to/).waitFor({ timeout: 20_000 });
    await t("alert-row").first().getByText(/^Fired/).waitFor({ timeout: 5_000 });
    await shot(page, "15-alert-fired");
  });

  await step("history exports to CSV", async () => {
    await t("tab-history").click();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), t("export-csv").click()]);
    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    if (lines.length < 3 || !lines[0].startsWith("time_utc,market,action")) throw new Error(`unexpected CSV: ${lines[0]}`);
    return `${lines.length - 1} rows`;
  });
}

// ─────────────────────────────── watch + activity ───────────────────────────────
if (want("watch")) {
  await step("watch mode: paste an address with no wallet, read-only", async () => {
    const { page: guest, context } = await newPage(browser, { wallet: false });
    await guest.goto(`${WEB_URL}/trade/`);
    await guest.getByTestId("market-price").waitFor({ timeout: 20_000 });
    await guest.getByRole("button", { name: /Watch/ }).click();
    await guest.getByLabel("Account address").fill(UI_TRADER.address);
    await guest.getByRole("button", { name: "Watch account" }).click();
    await guest.getByTestId("account-bar").getByText("Watching").waitFor({ timeout: 10_000 });
    if (!guest.url().includes(`account=${UI_TRADER.address}`)) throw new Error("the address did not go into the URL");
    await guest.getByTestId("tab-positions").click();
    await guest.locator('[data-testid^="position-"]').first().waitFor({ timeout: 15_000 });
    const closeButtons = await guest.getByTestId("close-position").count();
    const submit = await guest.getByRole("button", { name: "Watching: trading is off" }).isDisabled();
    if (closeButtons !== 0 || !submit) throw new Error("trading controls are available in watch mode");
    await guest.getByTestId("tab-history").click();
    await guest.getByTestId("history-open").first().waitFor({ timeout: 20_000 });
    await guest.screenshot({ path: join(SHOTS, "16-watch-mode.png"), fullPage: true });
    await context.close();
  });
}

if (want("activity")) {
  await step("activity: live feed, totals, OI bars, leaderboard, filter", async () => {
    await page.goto(`${WEB_URL}/activity/`);
    await page.locator(".feed-table tbody tr").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="stat-trades"]')?.textContent?.replace(/,/g, "")) > 3, null, { timeout: 30_000 });
    const first = num(await t("stat-trades").innerText());
    await page.waitForFunction((n) => Number(document.querySelector('[data-testid="stat-trades"]')?.textContent?.replace(/,/g, "")) > n, first, { timeout: 30_000 });
    const traders = num(await t("stat-traders").innerText());
    const bars = await page.locator('[data-testid^="oi-"]').count();
    const leaders = await t("leader-row").count();
    if (traders < 2 || bars !== addresses.markets.length || leaders < 2) throw new Error(`traders ${traders}, OI rows ${bars}, leaderboard ${leaders}`);
    await shot(page, "17-activity");
    await page.getByRole("group", { name: "Filter by market" }).getByRole("button", { name: /^BTC-USD\b/ }).first().click();
    await page.waitForTimeout(800);
    const other = await page.locator(".feed-table tbody tr").filter({ hasText: /ETH-USD|SOL-USD/ }).count();
    if (other > 0) throw new Error("the market filter let other markets through");
    await page.getByRole("button", { name: "All markets" }).click();
    return `trades ${first}+, traders ${traders}`;
  });

  await step("activity stays responsive while events stream (frame pacing)", async () => {
    const stats = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const gaps = [];
          let last = performance.now();
          const end = last + 6_000;
          const tick = (now) => {
            gaps.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(tick);
            else {
              gaps.sort((a, b) => a - b);
              resolve({ frames: gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1] });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    if (stats.max > 400) throw new Error(`a frame took ${stats.max.toFixed(0)} ms`);
    return `${stats.frames} frames in 6 s, p95 ${stats.p95.toFixed(1)} ms, worst ${stats.max.toFixed(0)} ms`;
  });

  await step("clicking a trader in the feed opens watch mode", async () => {
    const link = page.locator(".feed-table tbody tr a").first();
    const title = await link.getAttribute("title");
    await link.click();
    await page.waitForURL(/\/trade\/?\?.*account=0x/, { timeout: 10_000 });
    await t("account-bar").getByText("Watching").waitFor({ timeout: 15_000 });
    await shot(page, "18-watch-from-activity");
    await page.getByRole("button", { name: "Stop watching this account" }).click();
    await page.waitForFunction(() => !location.search.includes("account="), null, { timeout: 5_000 });
    return title ?? "";
  });
}

// ─────────────────────────────── dated settlement ───────────────────────────────
if (want("settle")) {
  await step("dated future: expiry, settlement, Settle & close", async () => {
    await page.goto(`${WEB_URL}/trade/?market=${addresses.datedSymbol}`);
    await t("market-price").waitFor({ timeout: 20_000 });
    await ensureWallet();
    const remaining = addresses.expiry - Number((await pub.getBlock()).timestamp);
    if (remaining > 0) {
      log("e2e", `      waiting ${remaining}s for ${addresses.datedSymbol} to expire`);
      await t("dated-banner").getByText(/^Expired\./).waitFor({ timeout: (remaining + 20) * 1000 });
    }
    await shot(page, "19-dated-expired");
    // Anyone can settle from the UI once a post-expiry price is on-chain; the keeper also does it after a delay.
    let settledBy = "keeper";
    const button = t("settle-market");
    try {
      await page.waitForFunction(() => document.querySelector('[data-testid="settle-market"]')?.disabled === false, null, { timeout: 8_000 });
      await button.click();
      await page.getByText(/settled\. Positions can now be closed/).waitFor({ timeout: 20_000 });
      settledBy = "UI";
    } catch {
      // Fall through: the keeper settles shortly.
    }
    await t("settlement-price").waitFor({ timeout: 60_000 });
    const market = await read(addresses.engine, "PerpEngine", "getMarket", [addresses.markets[7].marketId]);
    if (market.settlementPrice === 0n) throw new Error("the market is not settled on-chain");
    await t("tab-positions").click();
    await shot(page, "20-dated-settled");
    await t(`position-${addresses.datedSymbol}`).getByTestId("settle-close").click();
    await page.getByText(/closed at the settlement price/).waitFor({ timeout: 20_000 });
    await waitPosition(addresses.datedSymbol, false);
    if (!(await t("ticket-submit").isDisabled())) throw new Error("a settled market still accepts orders");
    return `settled by ${settledBy} at ${await t("settlement-price").innerText()}`;
  });
}

// ─────────────────────────────── house ───────────────────────────────
if (want("house")) {
  await step("house: NAV, share price, epoch timer, v2 copy", async () => {
    await page.goto(`${WEB_URL}/house/`);
    await page.getByText("Share price").first().waitFor({ timeout: 20_000 });
    await ensureWallet();
    await page.getByText(/15% of that gain is set aside/).waitFor();
    await page.getByText(/15% of house profit above the vault/).waitFor();
    if ((await page.getByText(/15% of everything that flows/).count()) > 0) throw new Error("the v1 staking copy is still there");
    await page.getByRole("button", { name: "About vault nav" }).hover();
    await page.getByText(/Exit value:/).waitFor({ timeout: 3_000 });
    await shot(page, "21-house");
    await page.mouse.move(5, 5);
  });

  await step("house: deposit, lock, withdraw", async () => {
    await t("vault-amount").fill("500");
    await page.waitForTimeout(800);
    await t("vault-submit").click();
    await page.getByText(/Deposited 500\.00 tUSDC/).waitFor({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Withdraw" }).click();
    await page.getByRole("button", { name: /Locked for/ }).waitFor({ timeout: 10_000 });
    await shot(page, "22-house-locked");
    await page.getByText("Unlocked").waitFor({ timeout: 40_000 });
    await t("vault-max").click();
    await page.waitForTimeout(1500);
    await t("vault-submit").click();
    await page.getByText(/Withdrew the maximum/).waitFor({ timeout: 30_000 });
    const shares = await read(addresses.vault, "HouseVault", "balanceOf", [UI_TRADER.address]);
    if (shares !== 0n) throw new Error(`shares left after max withdrawal: ${shares}`);
  });

  await step("house: stake KEG", async () => {
    const house = await read(addresses.token, "RewardToken", "balanceOf", [UI_TRADER.address]);
    if (house === 0n) throw new Error("the trader has no KEG (run the trade section first)");
    await t("stake-max").click();
    await t("stake-submit").click();
    await page.getByText(/^Staked /).waitFor({ timeout: 30_000 });
    const staked = await read(addresses.token, "RewardToken", "stakedBalance", [UI_TRADER.address]);
    if (staked !== house) throw new Error("staked amount differs");
  });

  let streamed = false;
  await step("house: settle epoch when due", async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="settle-epoch"]')?.disabled === false, null, { timeout: 90_000 });
    await t("epoch-due").waitFor();
    await shot(page, "23-epoch-due");
    await t("settle-epoch").click();
    const status = page.getByText(/^Epoch settled/);
    await status.waitFor({ timeout: 30_000 });
    const text = await status.innerText();
    streamed = /streams to KEG stakers/.test(text);
    await t("epoch-countdown").waitFor({ timeout: 10_000 });
    return text;
  });

  await step("house: claim streamed yield", async () => {
    if (!streamed) {
      const rate = await read(addresses.token, "RewardToken", "yieldRate");
      if (rate === 0n) return "SKIPPED: the house was not above its high-water mark this epoch, so nothing streamed";
    }
    await t("yield-stream").getByText(/\/ day to all stakers/).waitFor({ timeout: 10_000 });
    await sleep(6_000);
    await page.waitForFunction(() => document.querySelector('[data-testid="claim-yield"]')?.disabled === false, null, { timeout: 20_000 });
    await shot(page, "24-yield-streaming");
    const before = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    await t("claim-yield").click();
    await page.getByText(/^Claimed .* of staking yield/).waitFor({ timeout: 30_000 });
    const after = await read(addresses.usdc, "TestUSDC", "balanceOf", [UI_TRADER.address]);
    if (after <= before) throw new Error("claim paid nothing");
    return `claimed ${Number(after - before) / 1e6} tUSDC`;
  });
}

// ─────────────────────────────── responsive / no wallet ───────────────────────────────
if (want("agents")) {
  await step("agents: create account, deposit, approve an agent, agent trades, revoke", async () => {
    await page.goto(`${WEB_URL}/agents/`);
    await ensureWallet();
    await t("agents-create-button").click();
    await t("agents-funds").waitFor({ timeout: 30_000 });
    const agentAccount = await read(addresses.agentFactory, "AgentAccountFactory", "accountOf", [UI_TRADER.address]);
    await t("agents-amount").fill("1500");
    await t("agents-funds-submit").click();
    await page.getByText(/Moved 1,500\.00 .* into the agent account/).waitFor({ timeout: 30_000 });
    await t("agent-generate").click();
    const shown = await page.locator(".notice .num.break-all").innerText();
    await t("agent-approve").click();
    await page.getByText(/approved until/).waitFor({ timeout: 30_000 });
    await t("agents-list").getByText("active").waitFor({ timeout: 10_000 });
    await shot(page, "25-agents");

    // The generated key trades from the account within its policy, through the engine, never for itself.
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createWalletClient, http } = await import("viem");
    const { foundry } = await import("viem/chains");
    const agentAcct = privateKeyToAccount(shown.trim());
    const fund = createWalletClient({ chain: foundry, transport: http(RPC_URL), account: account(5) });
    await pub.waitForTransactionReceipt({ hash: await fund.sendTransaction({ to: agentAcct.address, value: 10n ** 18n }) });
    const agentWallet = createWalletClient({ chain: foundry, transport: http(RPC_URL), account: agentAcct });
    const eth = addresses.markets.find((m) => m.symbol === "ETH-USD").marketId;
    const markets = await read(addresses.lens, "EngineLens", "getMarkets");
    const ask = markets.find((m) => m.id.toLowerCase() === eth.toLowerCase()).price.ask;
    const abi = artifact("AgentAccount").abi;
    await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract({ address: agentAccount, abi, functionName: "createLimitOrder", args: [{ priceId: eth, isLong: true, margin: 100_000_000n, size: 500_000_000n, triggerPrice: (ask * 101n) / 100n, takeProfit: 0n, stopLoss: 0n }] }) });
    for (let i = 0; i < 40; i++) {
      const p = await read(addresses.engine, "PerpEngine", "getPosition", [agentAccount, eth]);
      if (p.trader.toLowerCase() === agentAccount.toLowerCase()) break;
      if (i === 39) throw new Error("the agent's order was not filled");
      await sleep(1000);
    }
    await page.goto(`${WEB_URL}/trade/?account=${agentAccount}`);
    await t("position-ETH-USD").waitFor({ timeout: 20_000 });
    await page.goto(`${WEB_URL}/agents/`);
    await t("agents-list").getByRole("button", { name: "Revoke" }).click();
    await page.getByText(/revoked\. Its open positions stay/).waitFor({ timeout: 30_000 });
    return `account ${agentAccount}, agent ${agentAcct.address} traded ETH-USD and was revoked`;
  });
}

if (want("responsive")) {
  for (const width of [360, 768]) {
    await step(`no horizontal overflow at ${width}px on /trade, /activity, /house`, async () => {
      const { page: small, context } = await newPage(browser, { viewport: { width, height: 800 } });
      const notes = [];
      for (const path of ["/trade/?market=JPY-USD", "/activity/", "/house/"]) {
        await small.goto(`${WEB_URL}${path}`);
        await small.waitForTimeout(3_500);
        if (path.startsWith("/trade")) await small.getByRole("button", { name: "Connect wallet", exact: true }).click().catch(() => {});
        await small.waitForTimeout(1_500);
        const [scroll, inner] = await small.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        await small.screenshot({ path: join(SHOTS, `m-${width}${path.replace(/\W+/g, "_")}.png`), fullPage: true });
        if (scroll > inner + 1) notes.push(`${path}: ${scroll} > ${inner}`);
      }
      await context.close();
      if (notes.length > 0) throw new Error(notes.join("; "));
    });
  }

  await step("no wallet installed: a clear message", async () => {
    const { page: bare, context } = await newPage(browser, { wallet: false });
    await bare.goto(`${WEB_URL}/trade/`);
    await bare.getByTestId("market-price").waitFor({ timeout: 20_000 });
    await bare.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await bare.getByRole("alert").getByText(/No browser wallet found/).waitFor({ timeout: 5_000 });
    await context.close();
  });

  await step("configuration by URL only (no config.json values needed) shows the custom-deployment badge", async () => {
    const { page: other, context } = await newPage(browser, { wallet: false });
    const query = new URLSearchParams({ engine: addresses.engine, lens: addresses.lens, vault: addresses.vault, token: addresses.token, collateral: addresses.usdc, symbol: "xUSD" });
    await other.goto(`${WEB_URL}/trade/?${query}`);
    await other.getByTestId("market-price").waitFor({ timeout: 20_000 });
    await other.getByText("Custom deployment").waitFor({ timeout: 5_000 });
    await other.getByRole("link", { name: "House", exact: true }).click();
    await other.waitForURL(/\/house\/?\?.*engine=0x/, { timeout: 10_000 });
    await other.getByText(/xUSD/).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
    await context.close();
  });

  await step("bad configuration is explained, not a blank page", async () => {
    const { page: bad, context } = await newPage(browser, { wallet: false });
    await bad.goto(`${WEB_URL}/trade/?engine=0x1234`);
    await bad.getByText("This deployment is not configured yet").waitFor({ timeout: 15_000 });
    await bad.getByText(/PERP_ENGINE_ADDRESS is not a valid address/).waitFor();
    await context.close();
  });
}

await browser.close();

const failed = results.filter((r) => !r.ok);
log("e2e", `${results.length - failed.length}/${results.length} steps passed`);
const pageProblems = [...new Set(problems)];
if (pageProblems.length > 0) log("e2e", `page problems:\n  ${pageProblems.slice(0, 12).join("\n  ")}`);
if (failedRequests.size > 0) log("e2e", `failed requests:\n  ${[...failedRequests.keys()].slice(0, 12).join("\n  ")}`);
void FIRST_SCRIPTED_TRADER;
void account;
process.exit(failed.length > 0 ? 1 : 0);
