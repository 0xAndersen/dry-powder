// Simple mode end to end, from a clean wallet: choose Simple on the first visit, sign in, get practice money,
// go up on Bitcoin with 50 at 10x, see the trade with its fuse, cash out, then switch to Advanced.
import { walletScript } from "../browser.mjs";
import { account } from "../lib.mjs";

export const section = "simple";

export default async function run({ step, browser, read, addresses, WEB_URL, sleep }) {
  // The last account anvil unlocks: no history, no positions (scripted traders use 3..14 with 12 traders).
  const traders = Number(process.env.TRADERS ?? 12);
  const who = account(Math.max(10, traders + 5) - 1).address;

  await step("simple mode: first-visit choice, practice money, up on Bitcoin, the fuse, cash out, switch to Advanced", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await context.addInitScript(walletScript(who));
    const p = await context.newPage();
    try {
      await p.goto(`${WEB_URL}/simple/`);
      await p.getByTestId("mode-chooser").waitFor({ timeout: 20_000 });
      await p.getByTestId("choose-simple").click();
      await p.getByTestId("simple-tiles").waitFor({ timeout: 20_000 });
      const theme = await p.evaluate(() => document.documentElement.dataset.ui);
      if (theme !== "simple") throw new Error(`the simple palette is not applied (data-ui=${theme})`);
      await p.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
      await p.getByRole("button", { name: /0x[0-9a-fA-F]{4}…/ }).waitFor({ timeout: 10_000 });
      await p.getByTestId("simple-tile-BTC-USD").click();
      await p.getByTestId("simple-trade").waitFor({ timeout: 5_000 });
      await p.getByTestId("simple-up").click();
      if ((await p.getByTestId("simple-get-practice").count()) > 0) {
        await p.getByTestId("simple-get-practice").click();
        await p.getByTestId("simple-place").waitFor({ timeout: 30_000 });
      }
      const fuse = await p.getByTestId("simple-fuse-text").innerText();
      if (!/falls 9\.\d%/.test(fuse)) throw new Error(`unexpected fuse text at 10x: ${fuse}`);
      await p.getByTestId("simple-place").click();
      const card = p.getByTestId("simple-position-BTC-USD");
      await card.waitFor({ timeout: 45_000 });
      const btc = addresses.markets.find((m) => m.symbol === "BTC-USD").marketId;
      const pos = await read(addresses.engine, "PerpEngine", "getPosition", [who, btc]);
      if (pos.margin !== 50_000_000n || pos.size !== 500_000_000n) throw new Error(`position is ${pos.margin}/${pos.size}, expected 50 margin and 500 size`);
      if (pos.slOrderId === 0n) throw new Error("the stop at half was not attached");
      await card.getByTestId("fuse").waitFor({ timeout: 5_000 });
      await card.getByTestId("simple-cash-out").click();
      await card.waitFor({ state: "detached", timeout: 45_000 });
      for (let i = 0; i < 20; i++) {
        const after = await read(addresses.engine, "PerpEngine", "getPosition", [who, btc]);
        if (after.size === 0n) break;
        if (i === 19) throw new Error("the cash out did not close the position");
        await sleep(500);
      }
      await p.getByTestId("mode-advanced").click();
      await p.waitForURL(/\/trade\/?/, { timeout: 15_000 });
      const mode = await p.evaluate(() => localStorage.getItem("dp:ui-mode:v1"));
      if (mode !== '"advanced"') throw new Error(`mode not remembered: ${mode}`);
      return `account ${who}: 50 at 10x up on BTC with a stop at half, cashed out; Advanced remembered`;
    } finally {
      await context.close();
    }
  });
}
