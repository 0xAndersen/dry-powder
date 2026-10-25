// Protocol v3.2 end to end: a Turbo market from Simple mode (no fee to open, fills at the mid, the house keeps its
// share of a win and nothing of a loss), a limit order good for one hour, taking margin out of a position, and a
// referral link from the first visit to the referrer collecting what it earned.
import { walletScript } from "../browser.mjs";
import { FEEDS, account, walletClient } from "../lib.mjs";

export const section = "v32";

const BPS = 10_000n;
const USDC = 1_000_000n;

export default async function run({ step, page, t, read, shot, num, addresses, pub, browser, ensureWallet, selectMarket, submitTicket, waitFilled, waitPosition, WEB_URL, KRAKEN_URL, UI_TRADER, artifact, sleep }) {
  if (!addresses.markets.some((m) => m.symbol === "EUR-USD-TURBO")) return; // a deployment from before v3.2

  // stack.mjs unlocks three accounts past the Simple step's: one each for the Turbo trader, the referred trader and
  // the referrer.
  const traders = Number(process.env.TRADERS ?? 12);
  const free = Math.max(10, traders + 5);
  const engineAbi = artifact("PerpEngine").abi;
  const marketId = (symbol) => addresses.markets.find((m) => m.symbol === symbol).marketId;
  const balanceOf = (who) => read(addresses.usdc, "TestUSDC", "balanceOf", [who]);
  const engine = (functionName, args = []) => read(addresses.engine, "PerpEngine", functionName, args);
  const events = (eventName, args, fromBlock) => pub.getContractEvents({ address: addresses.engine, abi: engineAbi, eventName, args, fromBlock });
  /**
   * The oracle mid a fill used: the feed's last update logged before the fill's own log (anvil keeps no history to
   * read state at a past block), scaled to 18 decimals as PythOracle does.
   */
  const midBefore = async (feed, fill) => {
    const logs = await pub.getContractEvents({
      address: addresses.publisherOracle,
      abi: artifact("PublisherOracle").abi,
      eventName: "PriceFeedUpdate",
      args: { id: feed.id },
      fromBlock: fill.blockNumber > 60n ? fill.blockNumber - 60n : 0n,
      toBlock: fill.blockNumber,
    });
    const before = logs.filter((l) => l.blockNumber < fill.blockNumber || l.logIndex < fill.logIndex);
    if (before.length === 0) throw new Error("no oracle update found before the fill");
    return BigInt(before[before.length - 1].args.price) * 10n ** BigInt(18 + feed.expo);
  };
  const waitEvent = async (eventName, args, fromBlock, timeout = 45_000) => {
    for (const started = Date.now(); Date.now() - started < timeout; await sleep(500)) {
      const [hit] = await events(eventName, args, fromBlock);
      if (hit) return hit;
    }
    throw new Error(`no ${eventName} event within ${timeout / 1000}s`);
  };
  /** The main page on the trade screen with the UI trader connected and funded (this section can run on its own). */
  const toTrade = async () => {
    if (!/\/trade\/?/.test(page.url())) {
      await page.goto(`${WEB_URL}/trade/?market=BTC-USD`);
      await page.getByTestId("market-price").waitFor({ timeout: 20_000 });
    }
    await ensureWallet();
    if ((await balanceOf(UI_TRADER.address)) < 1_000n * USDC) {
      const hash = await walletClient(UI_TRADER).writeContract({ address: addresses.usdc, abi: artifact("TestUSDC").abi, functionName: "mint", args: [UI_TRADER.address, 10_000n * USDC] });
      await pub.waitForTransactionReceipt({ hash });
    }
  };
  const qty = (p, mode, value) =>
    p
      .getByRole("group", { name: "Quantity entered as" })
      .getByRole("button", { name: mode, exact: true })
      .click()
      .then(() => p.getByTestId("ticket-qty").fill(String(value)));

  await step("turbo in simple: the Turbo group, no fee to open, a mid-price fill at 200x, cash out pays the win less the house share", async () => {
    const who = account(free).address;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(walletScript(who));
    const p = await context.newPage();
    try {
      await p.goto(`${WEB_URL}/simple/`);
      await p.getByTestId("mode-chooser").waitFor({ timeout: 20_000 });
      await p.getByTestId("choose-simple").click();
      await p.getByTestId("simple-tiles").waitFor({ timeout: 20_000 });
      await p.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
      await p.getByRole("button", { name: /0x[0-9a-fA-F]{4}…/ }).waitFor({ timeout: 10_000 });
      await p.getByRole("group", { name: "Show" }).getByRole("button", { name: "Turbo", exact: true }).click();
      await p.getByTestId("simple-turbo-note").waitFor({ timeout: 5_000 });
      const tiles = await p.locator('[data-testid^="simple-tile-"]').count();
      if (tiles !== 4) throw new Error(`${tiles} tiles in the Turbo group, expected the 4 Turbo markets`);
      await shot(p, "40-turbo-group");
      await p.getByTestId("simple-tile-EUR-USD-TURBO").click();
      await p.getByTestId("simple-trade").waitFor({ timeout: 5_000 });
      const feeLine = await p.getByTestId("simple-turbo-fee").innerText();
      if (!/Only if you win: 20(\.0+)?% of profit/.test(feeLine)) throw new Error(`fee line reads: ${feeLine}`);
      await p.getByTestId("simple-up").click();
      if ((await p.getByTestId("simple-get-practice").count()) > 0) {
        await p.getByTestId("simple-get-practice").click();
        await p.getByTestId("simple-place").waitFor({ timeout: 30_000 });
      }
      await p.getByTestId("simple-lev-200").click();
      await shot(p, "41-turbo-sheet");

      const id = marketId("EUR-USD-TURBO");
      const executionFee = await engine("executionFee");
      const before = await balanceOf(who);
      const fromBlock = await pub.getBlockNumber();
      await p.getByTestId("simple-place").click();
      const card = p.getByTestId("simple-position-EUR-USD-TURBO");
      await card.waitFor({ timeout: 45_000 });
      const pos = await engine("getPosition", [who, id]);
      if (pos.margin !== 50n * USDC || pos.size !== 10_000n * USDC) throw new Error(`position is ${pos.margin}/${pos.size}, expected 50 margin and 10,000 size`);
      const spent = before - (await balanceOf(who));
      if (spent !== pos.margin + executionFee) throw new Error(`opening cost ${spent}; the margin plus one keeper fee (${pos.margin + executionFee}) was expected, with no trading fee`);
      const opened = await waitEvent("PositionOpened", { trader: who }, fromBlock);
      if (opened.args.fee !== 0n) throw new Error(`a Turbo open charged a fee of ${opened.args.fee}`);
      const openMid = await midBefore(FEEDS.EUR, opened);
      if (opened.args.entryPrice !== openMid) throw new Error(`filled at ${opened.args.entryPrice}, not at the mid ${openMid}`);

      // Up 0.15%: about 15 of profit at 200x on 50 (the price also drifts on its own, so either outcome is checked).
      await fetch(`${KRAKEN_URL}/control/move?feed=EUR&pct=0.15`);
      await p.waitForTimeout(3_000);
      await shot(p, "42-turbo-position");
      const closeFrom = await pub.getBlockNumber();
      await card.getByTestId("simple-cash-out").click();
      await card.waitFor({ state: "detached", timeout: 45_000 });
      const closed = await waitEvent("PositionClosed", { trader: who }, closeFrom);
      const { pnl, fee, payout, exitPrice } = closed.args;
      const share = await engine("profitShareBps");
      const expected = pnl > 0n ? (pnl * share + BPS - 1n) / BPS : 0n;
      if (fee !== expected) throw new Error(`the house kept ${fee} of a result of ${pnl}; ${expected} was expected`);
      if (payout !== pos.margin + pnl - fee) throw new Error(`paid out ${payout}, expected ${pos.margin + pnl - fee}`);
      const closeMid = await midBefore(FEEDS.EUR, closed);
      if (exitPrice !== closeMid) throw new Error(`closed at ${exitPrice}, not at the mid ${closeMid}`);
      const usd = (x) => (Number(x) / 1e6).toFixed(2);
      return `account ${who}: 50 at 200x up on EUR Turbo, no open fee, mid fills; result ${usd(pnl)}, house kept ${usd(fee)}, paid ${usd(payout)}`;
    } finally {
      await context.close();
    }
  });

  await step("good until: a limit order placed for one hour carries its expiry on-chain and in the orders table, then is cancelled", async () => {
    await toTrade();
    await selectMarket("ETH-USD");
    await t("kind-limit").click();
    const mark = num(await t("market-price").innerText());
    await page.getByLabel("Limit price").fill((mark * 0.9).toFixed(2));
    await t("expiry-1h").click();
    await qty(page, "Margin", 50);
    await submitTicket();
    await t("tab-orders").click();
    const row = page.locator('tr[data-testid^="order-"]').filter({ has: page.getByTestId("order-expiry") }).first();
    await row.waitFor({ timeout: 20_000 });
    const label = await row.getByTestId("order-expiry").innerText();
    if (!/Expires in (59|60) min/.test(label)) throw new Error(`the orders table says "${label}"`);
    const orderId = BigInt((await row.getAttribute("data-testid")).slice("order-".length));
    const order = await engine("getOrder", [orderId]);
    const now = Number((await pub.getBlock()).timestamp);
    if (Math.abs(Number(order.expiresAt) - (now + 3_600)) > 120) throw new Error(`expiresAt ${order.expiresAt} is not about an hour from ${now}`);
    await shot(page, "43-good-until");
    await row.getByTestId("cancel-order").click();
    await row.waitFor({ state: "detached", timeout: 20_000 });
    await t("expiry-gtc").click();
    await t("kind-market").click();
    return `order #${orderId} good until ${order.expiresAt} (${label.toLowerCase()}), cancelled`;
  });

  await step("take margin out: 20 of 100 comes out of a 10x position, which stays open at 12.5x", async () => {
    await toTrade();
    await selectMarket("SOL-USD");
    const id = marketId("SOL-USD");
    if ((await engine("getPosition", [UI_TRADER.address, id])).size !== 0n) {
      await t("tab-positions").click();
      await t("position-SOL-USD").getByTestId("close-position").click();
      await t("close-confirm").click();
      await waitPosition("SOL-USD", false, 45_000);
    }
    await qty(page, "Margin", 100);
    await page.getByRole("button", { name: "10x", exact: true }).click();
    await submitTicket();
    await waitFilled();
    await waitPosition("SOL-USD");
    const opened = await engine("getPosition", [UI_TRADER.address, id]);
    // The removal is checked against a price published after the open (PriceNotAfterOpen): move SOL so the keeper
    // publishes one, and wait until the chain has it.
    const fromBlock = await pub.getBlockNumber();
    await fetch(`${KRAKEN_URL}/control/move?feed=SOL&pct=0.1`);
    for (let i = 0; ; i += 1) {
      const logs = await pub.getContractEvents({ address: addresses.publisherOracle, abi: artifact("PublisherOracle").abi, eventName: "PriceFeedUpdate", args: { id: FEEDS.SOL.id }, fromBlock });
      if (logs.some((l) => l.args.publishTime > opened.openedAt)) break;
      if (i === 60) throw new Error(`no SOL price newer than the open (${opened.openedAt}) within 30 s`);
      await sleep(500);
    }
    const before = await balanceOf(UI_TRADER.address);
    await t("position-SOL-USD").getByTestId("add-margin").click();
    await t("margin-mode-remove").click();
    await t("margin-max").waitFor({ timeout: 10_000 });
    await t("margin-amount").fill("20");
    await shot(page, "44-take-margin-out");
    await t("margin-confirm").click();
    for (let i = 0; ; i += 1) {
      const pos = await engine("getPosition", [UI_TRADER.address, id]);
      if (pos.margin === opened.margin - 20n * USDC) break;
      if (i === 40) throw new Error(`margin is ${pos.margin}, expected ${opened.margin - 20n * USDC}`);
      await sleep(750);
    }
    const received = (await balanceOf(UI_TRADER.address)) - before;
    if (received !== 20n * USDC) throw new Error(`the wallet received ${received}, expected 20`);
    await t("position-SOL-USD").getByTestId("close-position").click();
    await t("close-confirm").click();
    await waitPosition("SOL-USD", false, 45_000);
    return `margin ${Number(opened.margin) / 1e6} -> ${Number(opened.margin - 20n * USDC) / 1e6}, 20 back in the wallet, then closed`;
  });

  await step("referrals: a ?ref= link is linked on-chain in one transaction, the trader's fees credit the referrer, who collects them", async () => {
    const trader = account(free + 1);
    const referrer = account(free + 2);
    // Practice money for the referred trader, straight from the faucet contract.
    const faucet = walletClient(trader);
    const hash = await faucet.writeContract({ address: addresses.usdc, abi: artifact("TestUSDC").abi, functionName: "mint", args: [trader.address, 1_000n * USDC] });
    await pub.waitForTransactionReceipt({ hash });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(walletScript(trader.address));
    const p = await context.newPage();
    try {
      await p.goto(`${WEB_URL}/trade/?market=BTC-USD&ref=${referrer.address}`);
      await p.getByTestId("market-price").waitFor({ timeout: 20_000 });
      const connect = p.getByRole("button", { name: "Connect wallet", exact: true });
      if ((await connect.count()) > 0) await connect.first().click();
      await p.getByRole("button", { name: /0x[0-9a-fA-F]{4}…/ }).waitFor({ timeout: 10_000 });
      await p.getByTestId("referral-prompt").waitFor({ timeout: 20_000 });
      await shot(p, "45-referral-prompt");
      await p.getByTestId("referral-link").click();
      for (let i = 0; ; i += 1) {
        if ((await engine("referrerOf", [trader.address])).toLowerCase() === referrer.address.toLowerCase()) break;
        if (i === 40) throw new Error("the referrer was not recorded on-chain");
        await sleep(500);
      }
      await p.getByTestId("referral-link").waitFor({ state: "detached", timeout: 20_000 });

      // A trade on a Standard market: a share of its fees is credited to the referrer.
      const fromBlock = await pub.getBlockNumber();
      await qty(p, "Margin", 100);
      await p.getByTestId("ticket-submit").click();
      await p.getByTestId("confirm-yes").click();
      const paid = await waitEvent("ReferralFeePaid", { referrer: referrer.address }, fromBlock);
      if (paid.args.trader.toLowerCase() !== trader.address.toLowerCase() || paid.args.amount === 0n) throw new Error("the referral credit is for the wrong trader or zero");
      const opened = await waitEvent("PositionOpened", { trader: trader.address }, fromBlock);
      const shareBps = await engine("referralShareBps");
      if (paid.args.amount !== (opened.args.fee * shareBps) / BPS) throw new Error(`credited ${paid.args.amount} of a ${opened.args.fee} fee; ${shareBps} bps was expected`);
    } finally {
      await context.close();
    }

    // The referrer opens Portfolio, sees what it earned and collects it.
    const owed = await engine("claimable", [referrer.address]);
    const r = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await r.addInitScript(walletScript(referrer.address));
    const rp = await r.newPage();
    try {
      await rp.goto(`${WEB_URL}/portfolio/`);
      const connect = rp.getByRole("button", { name: "Connect wallet", exact: true });
      await connect.first().waitFor({ timeout: 20_000 });
      await connect.first().click();
      await rp.getByTestId("referral-card").waitFor({ timeout: 20_000 });
      const url = await rp.getByTestId("referral-url").innerText();
      if (!url.toLowerCase().includes(`ref=${referrer.address.toLowerCase()}`)) throw new Error(`the referral link is ${url}`);
      await shot(rp, "46-referral-card");
      const before = await balanceOf(referrer.address);
      await rp.getByTestId("referral-claim").click();
      for (let i = 0; ; i += 1) {
        if ((await engine("claimable", [referrer.address])) === 0n) break;
        if (i === 40) throw new Error("the referral earnings were not collected");
        await sleep(500);
      }
      const got = (await balanceOf(referrer.address)) - before;
      if (got !== owed) throw new Error(`collected ${got}, expected ${owed}`);
      return `trader ${trader.address} linked to ${referrer.address}; ${Number(owed) / 1e6} earned and collected`;
    } finally {
      await r.close();
    }
  });
}
