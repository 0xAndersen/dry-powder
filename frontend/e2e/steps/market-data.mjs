// Market data: funding and open-interest history on the Markets page, and the chart wall (/charts/).
// The local stack publishes no stats.json, so the history runs on live samples only; that path is what is checked.
export const section = "market-data";

export default async function marketData({ step, page, t, shot, newPage, browser, WEB_URL }) {
  await step("markets: a market's funding and open-interest history unfolds, live samples without an indexer", async () => {
    await page.goto(`${WEB_URL}/markets/`);
    await t("market-row-BTC-USD").waitFor({ timeout: 20_000 });
    // The table's toggle (the phone card's twin is hidden at this width).
    await t("history-toggle-BTC-USD").first().click();
    const panel = t("market-history-BTC-USD").first();
    await panel.waitFor({ timeout: 5_000 });
    await panel.getByTestId("history-source").getByText(/Live samples since this page opened/).waitFor({ timeout: 10_000 });
    // The first live sample fills the legend: funding a year and long / short open interest.
    await panel.getByTestId("history-funding").filter({ hasText: /%/ }).waitFor({ timeout: 20_000 });
    const funding = (await panel.getByTestId("history-funding").innerText()).replace(/\s+/g, " ");
    const oi = (await panel.getByTestId("history-oi").innerText()).replace(/\s+/g, " ");
    if (!/\d/.test(oi)) throw new Error(`no open interest shown: ${oi}`);
    await panel.locator("canvas").first().waitFor({ timeout: 5_000 });
    for (const r of ["7d", "30d", "24h"]) {
      await panel.getByTestId(`history-range-${r}`).click();
      if ((await panel.getByTestId(`history-range-${r}`).getAttribute("aria-pressed")) !== "true") throw new Error(`range ${r} did not apply`);
    }
    await shot(page, "30-market-history");
    await t("history-toggle-BTC-USD").first().click();
    await t("market-history-BTC-USD").first().waitFor({ state: "detached", timeout: 5_000 });
    return `BTC-USD funding ${funding}, open interest ${oi}`;
  });

  await step("markets on a phone: the history opens inside the card without horizontal overflow", async () => {
    const { page: phone, context } = await newPage(browser, { viewport: { width: 390, height: 844 } });
    try {
      await phone.goto(`${WEB_URL}/markets/`);
      const card = phone.getByTestId("market-card-ETH-USD");
      await card.waitFor({ timeout: 20_000 });
      await card.getByTestId("history-toggle-ETH-USD").click();
      const panel = card.getByTestId("funding-oi-panel");
      await panel.waitFor({ timeout: 5_000 });
      await panel.getByTestId("history-funding").filter({ hasText: /%/ }).waitFor({ timeout: 20_000 });
      await panel.locator("canvas").first().waitFor({ timeout: 5_000 });
      const [scroll, inner] = await phone.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (scroll > inner + 1) throw new Error(`horizontal overflow: ${scroll} > ${inner}`);
      await phone.screenshot({ path: shotPath("m-market-history") });
      // The card's link still opens the market; the toggle did not navigate.
      if (!/\/markets\/?$/.test(new URL(phone.url()).pathname)) throw new Error(`the toggle navigated to ${phone.url()}`);
    } finally {
      await context.close();
    }
  });

  await step("chart wall: four charts with their own market and interval, remembered after a reload", async () => {
    await page.goto(`${WEB_URL}/markets/`);
    await t("open-chart-wall").click();
    await t("chart-wall").waitFor({ timeout: 20_000 });
    await t("wall-layout-4").click();
    const cells = page.locator('[data-testid^="wall-cell-"]');
    await t("wall-cell-3").waitFor({ timeout: 10_000 });
    if ((await cells.count()) !== 4) throw new Error(`${await cells.count()} charts for layout 4`);
    const second = t("wall-cell-1");
    await second.getByTestId("wall-market").selectOption({ label: "ETH-USD" });
    await second.getByTestId("wall-interval-60").click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="wall-cell-1"]');
      return el?.getAttribute("data-market") === "ETH-USD" && el?.getAttribute("data-resolution") === "60";
    }, null, { timeout: 5_000 });
    for (let k = 0; k < 4; k += 1) await t(`wall-cell-${k}`).locator("canvas").first().waitFor({ timeout: 10_000 });
    // Every chart gets a real drawing area, not just its header.
    const heights = await cells.evaluateAll((els) => els.map((e) => Math.max(0, ...[...e.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect().height))));
    if (heights.some((h) => h < 150)) throw new Error(`chart areas too small: ${heights.map(Math.round).join(", ")} px`);
    const markets = await cells.evaluateAll((els) => els.map((e) => e.getAttribute("data-market")));
    await shot(page, "31-chart-wall");

    await page.reload();
    await t("wall-cell-3").waitFor({ timeout: 20_000 });
    if ((await cells.count()) !== 4) throw new Error("the layout was not remembered");
    const market = await t("wall-cell-1").getAttribute("data-market");
    const res = await t("wall-cell-1").getAttribute("data-resolution");
    if (market !== "ETH-USD" || res !== "60") throw new Error(`after a reload chart 2 shows ${market} at ${res}`);
    const href = (await t("wall-cell-1").getByTestId("wall-trade").getAttribute("href")) ?? "";
    if (!/trade\/?\?(.*&)?market=ETH-USD/.test(href)) throw new Error(`chart 2 trades through ${href}`);

    await t("wall-layout-6").click();
    await t("wall-cell-5").waitFor({ timeout: 10_000 });
    if ((await cells.count()) !== 6) throw new Error(`${await cells.count()} charts for layout 6`);
    await t("wall-layout-1").click();
    await t("wall-cell-1").waitFor({ state: "detached", timeout: 5_000 });
    return `${markets.join(", ")}; chart 2 kept ETH-USD at 1h after a reload`;
  });

  await step("chart wall on a phone: charts stack one under another", async () => {
    const { page: phone, context } = await newPage(browser, { viewport: { width: 390, height: 844 } });
    try {
      await phone.goto(`${WEB_URL}/charts/`);
      await phone.getByTestId("wall-layout-4").click();
      await phone.getByTestId("wall-cell-3").waitFor({ timeout: 20_000 });
      const boxes = await phone.locator('[data-testid^="wall-cell-"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.width)]));
      if (new Set(boxes.map((b) => b[0])).size !== 1) throw new Error(`charts are not stacked: ${JSON.stringify(boxes)}`);
      const [scroll, inner] = await phone.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (scroll > inner + 1) throw new Error(`horizontal overflow: ${scroll} > ${inner}`);
      await phone.screenshot({ path: shotPath("m-chart-wall"), fullPage: true });
    } finally {
      await context.close();
    }
  });
}

// Screenshots land next to the run's others (e2e/out/shots).
function shotPath(name) {
  return new URL(`../out/shots/${name}.png`, import.meta.url).pathname;
}
