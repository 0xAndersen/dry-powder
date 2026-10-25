// Agent Studio end to end, from a fresh wallet: replays of the trend and mean-reversion templates, then a copy
// strategy that follows the deployer (a scripted leader on BTC-USD) launched in one go (account, deposit, approval,
// start); the keeper's pokes make it open with the leader and close when the leader closes; pause, resume and stop;
// then the account is listed as an agent and shows in the directory, on the leaderboard and on its profile with
// its badge.
import { walletScript } from "../browser.mjs";
import { account, walletClient } from "../lib.mjs";

export const section = "agent-studio";

const CLOSE = 3; // OrderType.Close

export default async function run({ step, browser, read, addresses, pub, WEB_URL, DEPLOYER, artifact, sleep, shot, log }) {
  if (!addresses.strategies || !addresses.agentRegistry) {
    log("e2e", "agent-studio: no Strategies or AgentRegistry in this deployment, skipped");
    return;
  }
  // The second-to-last account anvil unlocks (the simple step uses the last; scripted traders use 3..14 with 12).
  const traders = Number(process.env.TRADERS ?? 12);
  const who = account(Math.max(10, traders + 5) - 2).address;
  const btc = addresses.markets.find((m) => m.symbol === "BTC-USD").marketId;
  const deployer = walletClient(DEPLOYER);
  const write = async (address, name, functionName, args) => {
    const hash = await deployer.writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${name}.${functionName} reverted`);
  };
  const positionOf = (trader) => read(addresses.engine, "PerpEngine", "getPosition", [trader, btc]);
  const until = async (what, check, timeout = 60_000, every = 1_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(every);
    }
  };
  const ask = async () =>
    until("an on-chain BTC-USD price", async () => {
      const v = (await read(addresses.lens, "EngineLens", "getMarkets")).find((m) => m.id.toLowerCase() === btc.toLowerCase());
      return v?.hasPrice ? v.price.ask : 0n;
    });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(walletScript(who));
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  const t = (id) => p.getByTestId(id);
  let agentAccount = null;
  let strategyId = null;

  try {
    await step("agent studio: the trend and mean-reversion templates replay on recent candles", async () => {
      await p.goto(`${WEB_URL}/agents/`);
      await t("studio").waitFor({ timeout: 20_000 });
      await p.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
      await p.getByRole("button", { name: /0x[0-9a-fA-F]{4}…/ }).waitFor({ timeout: 10_000 });
      await t("studio-market").selectOption(btc);
      await t("backtest-chart").waitFor({ timeout: 20_000 });
      const explain = await t("studio-explain").innerText();
      if (!/fast one over the last 9 readings and a slow one over 21/.test(explain)) throw new Error(`unexpected trend explanation: ${explain.slice(0, 160)}`);
      const trades = await t("bt-trades").innerText();
      await shot(p, "agent-studio-trend");
      // Settings the contract refuses are flagged before anything is signed.
      await t("studio-slow").fill("5");
      await t("studio-launch").filter({ hasText: "Slow average: more readings than the fast one" }).waitFor({ timeout: 5_000 });
      await t("studio-slow").fill("21");
      await t("studio-template-meanRevert").click();
      await t("backtest-chart").waitFor({ timeout: 20_000 });
      if (!/compares the BTC-USD price with its average over the last 20 readings/.test(await t("studio-explain").innerText())) throw new Error("the mean-reversion explanation is missing");
      return `trend replay: ${trades.replace(/\s+/g, " ")}`;
    });

    await step("agent studio: launch a copy of the deployer on BTC-USD (account, deposit, approval and start in one go)", async () => {
      // The leader: the deployer goes long 1,000 at 10x through a keeper order.
      await write(addresses.usdc, "TestUSDC", "mint", [DEPLOYER.address, 2_000_000_000n]);
      await write(addresses.usdc, "TestUSDC", "approve", [addresses.engine, 2n ** 255n]);
      const before = await positionOf(DEPLOYER.address);
      if (before.size === 0n) {
        await write(addresses.engine, "PerpEngine", "createLimitOrder", [{ priceId: btc, isLong: true, margin: 100_000_000n, size: 1_000_000_000n, triggerPrice: ((await ask()) * 101n) / 100n, takeProfit: 0n, stopLoss: 0n, stopEntry: false }]);
        await until("the leader's position", async () => (await positionOf(DEPLOYER.address)).size > 0n);
      }
      // The follower's wallet gets test funds; the studio moves some into the account it creates.
      await write(addresses.usdc, "TestUSDC", "mint", [who, 2_000_000_000n]);

      await t("studio-template-copy").click();
      await t("studio-leader").fill(DEPLOYER.address);
      await t("studio-ratio").fill("50");
      await t("studio-max-size").fill("600");
      await t("studio-margin").fill("100");
      await t("studio-leverage").fill("5");
      await t("studio-deposit").fill("500");
      await t("copy-leader-position").filter({ hasText: /Long/ }).waitFor({ timeout: 15_000 });
      const steps = await t("launch-steps").locator("li").allInnerTexts();
      if (steps.length !== 4 || !/Create your agent account/.test(steps[0]) || !/Deposit 500\.00/.test(steps[1]) || !/never withdraw/.test(steps[2]) || !/Start copying 0x.+ on BTC-USD/.test(steps[3])) {
        throw new Error(`unexpected launch steps: ${steps.join(" | ").slice(0, 400)}`);
      }
      await shot(p, "agent-studio-copy");
      await t("studio-launch").click();
      await p.getByText(/is live on BTC-USD as strategy #\d+/).waitFor({ timeout: 90_000 });

      agentAccount = await read(addresses.agentFactory, "AgentAccountFactory", "accountOf", [who]);
      const ids = await read(addresses.strategies, "Strategies", "strategiesOf", [agentAccount]);
      if (ids.length !== 1) throw new Error(`expected one strategy, found ${ids.length}`);
      strategyId = ids[0];
      const [expiry, maxLeverage, maxMargin] = await read(agentAccount, "AgentAccount", "agents", [addresses.strategies]);
      const [perDay] = await read(agentAccount, "AgentAccount", "budgets", [addresses.strategies]);
      if (maxLeverage !== 5 || maxMargin !== 100_000_000n || expiry === 0n) throw new Error(`unexpected approval ${expiry}/${maxLeverage}/${maxMargin}`);
      if (perDay !== 500_000_000n) throw new Error(`unexpected daily budget ${perDay}`);
      const balance = await read(addresses.usdc, "TestUSDC", "balanceOf", [agentAccount]);
      if (balance < 400_000_000n) throw new Error(`the deposit did not arrive (${balance})`);
      return `account ${agentAccount}, strategy #${strategyId}`;
    });

    await step("agent studio: the copy is listed, and the keeper's pokes make it follow the leader in and out", async () => {
      if (!agentAccount) throw new Error("no account from the launch step");
      const row = p.locator(`[data-testid="strategy-row"][data-id="${strategyId}"]`);
      await row.waitFor({ timeout: 20_000 });
      if ((await row.getAttribute("data-status")) !== "active") throw new Error("the strategy is not active");
      // Opens half the leader's size (500) once the keeper pokes it and fills the order.
      const opened = await until("the copy's position", async () => {
        const pos = await positionOf(agentAccount);
        return pos.size > 0n ? pos : null;
      }, 90_000);
      if (!opened.isLong || opened.size !== 500_000_000n) throw new Error(`the copy holds ${opened.isLong ? "long" : "short"} ${opened.size}, expected long 500`);
      await row.getByTestId("strategy-position").filter({ hasText: "Long" }).waitFor({ timeout: 15_000 });
      await row.getByTestId("strategy-target").filter({ hasText: "Long" }).waitFor({ timeout: 15_000 });
      await p.locator('[data-testid="activity-item"][data-event="OrderSettled"]').first().waitFor({ timeout: 20_000 });
      await shot(p, "agent-studio-running");

      // The leader closes; at its next reading the copy closes too.
      await write(addresses.engine, "PerpEngine", "setTriggerOrder", [btc, CLOSE, 0n, 0n]);
      await until("the leader's close", async () => (await positionOf(DEPLOYER.address)).size === 0n);
      await until("the copy's close", async () => (await positionOf(agentAccount)).size === 0n, 150_000, 2_000);
      await row.getByTestId("strategy-target").filter({ hasText: "Flat" }).waitFor({ timeout: 15_000 });
      const events = await p.locator('[data-testid="activity-item"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-event")));
      for (const e of ["StrategyCreated", "TargetChanged", "OrderPlaced", "OrderSettled"]) if (!events.includes(e)) throw new Error(`activity lacks ${e}: ${events.join(",")}`);
      return `opened long 500 with the leader, closed with it; ${events.length} events shown`;
    });

    await step("agent studio: pause, resume and stop", async () => {
      const row = p.locator(`[data-testid="strategy-row"][data-id="${strategyId}"]`);
      const statusIs = async (code) => until(`status ${code}`, async () => Number((await read(addresses.strategies, "Strategies", "getStrategy", [strategyId])).state.status) === code, 30_000, 500);
      await row.getByTestId("strategy-pause").click();
      await p.getByText(/is paused: no readings, no orders/).waitFor({ timeout: 30_000 });
      await statusIs(2);
      await p.locator(`[data-testid="strategy-row"][data-id="${strategyId}"][data-status="paused"]`).waitFor({ timeout: 15_000 });
      await row.getByTestId("strategy-resume").click();
      await p.getByText(/is running again from the next keeper check/).waitFor({ timeout: 30_000 });
      await statusIs(1);
      await p.locator(`[data-testid="strategy-row"][data-id="${strategyId}"][data-status="active"]`).waitFor({ timeout: 15_000 });
      await row.getByTestId("strategy-stop").click();
      await row.getByTestId("strategy-stop-confirm").click();
      await p.getByText(/is stopped for good and its market is free/).waitFor({ timeout: 30_000 });
      await statusIs(3);
      await p.getByRole("button", { name: "Show 1 stopped" }).waitFor({ timeout: 15_000 });
      const live = await read(addresses.strategies, "Strategies", "strategyOf", [agentAccount, btc]);
      if (live !== 0n) throw new Error("the market was not freed");
    });

    await step("agent registry: list the account, see it in the directory, on the leaderboard and on its profile", async () => {
      await t("listing-name").fill("E2E Copybot");
      await t("listing-kind").fill("copy");
      await t("listing-description").fill("Follows the deployer on BTC-USD at half its size.");
      await t("listing-submit").click();
      await t("listing-current").waitFor({ timeout: 30_000 });
      if (!(await read(addresses.agentRegistry, "AgentRegistry", "isAgent", [agentAccount]))) throw new Error("the registry does not list the account");
      const entry = p.locator(`[data-testid="directory-row"][data-account="${agentAccount.toLowerCase()}"]`);
      await entry.filter({ hasText: "E2E Copybot" }).waitFor({ timeout: 30_000 });
      await shot(p, "agent-studio-directory");

      // Its closed copy trade puts it on the leaderboard, marked as an agent.
      await p.goto(`${WEB_URL}/leaderboard/`);
      await p.locator('[data-testid="lb-row"] [data-testid="agent-badge"][data-kind="listed"]').filter({ hasText: "E2E Copybot" }).first().waitFor({ timeout: 45_000 });
      await shot(p, "agent-studio-leaderboard");
      await p.goto(`${WEB_URL}/trader/?address=${agentAccount}`);
      await p.locator("h1 [data-testid=agent-badge]").filter({ hasText: "E2E Copybot" }).waitFor({ timeout: 20_000 });
      // A wallet is no agent account: no badge on its profile.
      await p.goto(`${WEB_URL}/trader/?address=${who}`);
      await p.locator("h1").first().waitFor({ timeout: 20_000 });
      await sleep(2_000);
      if ((await p.locator("h1 [data-testid=agent-badge]").count()) !== 0) throw new Error("a plain wallet shows an agent badge");
      if (errors.length > 0) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
      return "listed, in the directory, badged on the leaderboard and the profile";
    });

    await step("agent studio on a phone: the studio, the running list and the directory fit the width", async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await phone.addInitScript(walletScript(who));
      const q = await phone.newPage();
      try {
        await q.goto(`${WEB_URL}/agents/`);
        await q.getByTestId("studio").waitFor({ timeout: 20_000 });
        const connect = q.getByRole("button", { name: "Connect wallet", exact: true });
        if ((await connect.count()) > 0) await connect.first().click();
        await q.getByTestId("strategies").waitFor({ timeout: 20_000 });
        await q.getByTestId("backtest-chart").waitFor({ timeout: 20_000 });
        await q.waitForTimeout(800);
        await shot(q, "agent-studio-phone");
        const [scroll, inner] = await q.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        if (scroll > inner + 1) throw new Error(`horizontal overflow: ${scroll} > ${inner}`);
      } finally {
        await phone.close();
      }
    });
  } finally {
    await context.close();
  }
}
