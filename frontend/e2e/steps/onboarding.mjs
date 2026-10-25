// Onboarding with no extension: a passkey account (Chrome's virtual authenticator with the PRF extension stands in
// for Face ID or Touch ID), gas detected as it arrives, instant trading with test funds after one in-app approval,
// signing back in after a reload, the funds sheet (CCTP screen, withdraw, a rejected approval) and signing out.
// Passkeys need a named host, so this page runs on localhost rather than 127.0.0.1.
import { fileURLToPath } from "node:url";
import { parseEther, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_PATH, PORTS, walletClient } from "../lib.mjs";

export const section = "onboarding";

const SHOTS = fileURLToPath(new URL("../out/shots/", import.meta.url));
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const units = (value) => (Number(value) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

export default async function onboarding({ step, read, addresses, browser, newPage, DEPLOYER, pub, sleep, log }) {
  const base = `http://localhost:${PORTS.web}${BASE_PATH}`;
  const { page, context, problems } = await newPage(browser, { wallet: false });
  const t = (id) => page.getByTestId(id);
  const state = { address: null, account: null };
  // Viewport shots after the sheets' 140 ms fade (full-page captures render fixed layers see-through).
  const snap = async (name) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}${name}.png` });
  };

  // The shared step helper reports the main page's alerts; these steps report this page's.
  const check = (name, fn) =>
    step(name, async () => {
      try {
        return await fn();
      } catch (error) {
        const said = await page
          .locator('[role="alert"]')
          .allInnerTexts()
          .then((texts) => texts.map((x) => x.trim()).filter(Boolean).join(" / "))
          .catch(() => "");
        await snap(`onboarding-fail-${name.slice(0, 32).replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
        throw new Error(`${String(error?.message ?? error).split("\n")[0]}${said ? ` | onboarding page: ${said.slice(0, 300)}` : ""}`);
      }
    });
  const need = (what) => {
    if (!state[what]) throw new Error(`skipped: an earlier onboarding step failed (no ${what})`);
    return state[what];
  };
  const usdc = (who) => read(addresses.usdc, "TestUSDC", "balanceOf", [who]);
  const until = async (what, fn, timeout = 20_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(400);
    }
  };
  /** 32-byte hex values in this page's storage that are the private key of `address` (there must be none). */
  const storedKeysFor = async (address) => {
    const values = await page.evaluate(() => [...Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ""), ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? "")]);
    return values
      .flatMap((v) => v.match(/0x[0-9a-fA-F]{64}/g) ?? [])
      .filter((hex) => {
        try {
          return privateKeyToAccount(hex).address === address;
        } catch {
          return false;
        }
      });
  };

  await check("passkey: a new trader signs up with no extension and no seed phrase (virtual authenticator with PRF)", async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`${base}/trade/`);
    await t("market-price").waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    const sheet = t("sign-in-sheet");
    await sheet.waitFor({ timeout: 5_000 });
    await sheet.getByRole("alert").getByText(/No browser wallet found/).waitFor({ timeout: 5_000 });
    await snap("onboarding-01-sign-in");
    await t("passkey-create").click();
    await t("signin-address").waitFor({ timeout: 15_000 });

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("dp:passkeys:v1") ?? "[]"));
    if (stored.length !== 1) throw new Error(`expected one remembered passkey, found ${stored.length}`);
    const [record] = stored;
    if (record.rpId !== "localhost") throw new Error(`the passkey is recorded for ${record.rpId}, not localhost`);
    if (Object.keys(record).some((k) => !["credentialId", "address", "rpId", "createdAt", "lastUsedAt"].includes(k))) {
      throw new Error(`more than the credential id and address is remembered: ${Object.keys(record).join(", ")}`);
    }
    const shown = (await t("signin-address").innerText()).trim();
    if (shown !== short(record.address)) throw new Error(`the sheet shows ${shown}; the passkey's address is ${record.address}`);
    if ((await storedKeysFor(record.address)).length > 0) throw new Error("the wallet key was written to the browser's storage");
    state.address = record.address;
    return `${short(record.address)}, only the credential id and address stored`;
  });

  await check("passkey: gas guidance with the Circle faucet, then gas is detected as it arrives", async () => {
    const address = need("address");
    await t("gas-waiting").waitFor({ timeout: 10_000 });
    const faucet = t("sign-in-sheet").getByRole("link", { name: /faucet/i }).first();
    if (!/faucet\.circle\.com/.test((await faucet.getAttribute("href")) ?? "")) throw new Error("no link to faucet.circle.com");
    if (!(await t("signin-instant").isDisabled())) throw new Error("instant trading should wait for gas");
    const hash = await walletClient(DEPLOYER).sendTransaction({ to: address, value: parseEther("5") });
    await pub.waitForTransactionReceipt({ hash });
    await t("gas-ready").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="signin-instant"]')?.disabled === false, null, { timeout: 10_000 });
    return "5 USDC of gas seen without a reload";
  });

  await check("passkey: instant trading and test funds after one in-app approval", async () => {
    const address = need("address");
    await t("signin-instant").click();
    const approval = t("passkey-approval");
    await approval.waitFor({ timeout: 15_000 });
    const text = await approval.innerText();
    if (!/Create your trading account/.test(text)) throw new Error(`the approval does not say what it does: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    if (!/Network fee, at most/.test(text)) throw new Error("the approval does not show the most it can cost");
    await snap("onboarding-02-approval");
    await t("passkey-approve").click();
    await t("signin-done").waitFor({ timeout: 30_000 });
    const account = await read(addresses.agentFactory, "AgentAccountFactory", "accountOf", [address]);
    if (account === zeroAddress) throw new Error("no trading account on chain for the passkey address");
    state.account = account;
    const funded = await until("test funds in the trading account", async () => {
      const balance = await usdc(account);
      return balance > 0n ? balance : null;
    });
    await sleep(800);
    if ((await approval.count()) > 0) throw new Error("a second approval was asked for");
    if ((await storedKeysFor(address)).length > 0) throw new Error("the wallet key was written to the browser's storage");
    await snap("onboarding-03-instant-on");
    return `trading account ${short(account)} with ${units(funded)} tUSDC`;
  });

  await check("passkey: after a reload the same passkey signs back in to the same account", async () => {
    const address = need("address");
    await page.reload();
    await t("market-price").waitFor({ timeout: 20_000 });
    // The key lived in memory only: the reload signed the wallet out.
    await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor({ timeout: 10_000 });
    await t("open-sign-in").click();
    const resume = t("passkey-continue");
    await resume.waitFor({ timeout: 5_000 });
    if (!(await resume.innerText()).includes(short(address))) throw new Error("the remembered passkey is not offered");
    await resume.click();
    await t("signin-address").waitFor({ timeout: 15_000 });
    const shown = (await t("signin-address").innerText()).trim();
    if (shown !== short(address)) throw new Error(`signed back in as ${shown}, expected ${short(address)}`);
    await t("signin-done").waitFor({ timeout: 10_000 });
    return "same address; instant trading still on";
  });

  await check("funds: the CCTP screen sends to the passkey address; withdraw everything after one approval", async () => {
    const address = need("address");
    const account = need("account");
    await t("signin-funds").click();
    await t("funds-sheet").waitFor({ timeout: 5_000 });
    await t("funds-tab-bridge").click();
    const quote = t("bridge-quote");
    await quote.waitFor({ timeout: 5_000 });
    await quote.getByText(`${short(address)} on Arc`).waitFor({ timeout: 5_000 });
    const sources = await t("bridge-source").locator("option").count();
    if (sources < 8) throw new Error(`only ${sources} source chains offered`);
    await snap("onboarding-04-bridge");

    await t("funds-tab-withdraw").click();
    const inAccount = await usdc(account);
    const before = await usdc(address);
    await page.waitForFunction(() => /[1-9]/.test(document.querySelector('[data-testid="withdraw-available"]')?.textContent ?? ""), null, { timeout: 15_000 });
    await t("withdraw-all").click();
    const approval = t("passkey-approval");
    await approval.waitFor({ timeout: 15_000 });
    if (!/Withdraw from your trading account/.test(await approval.innerText())) throw new Error("the approval does not say it is a withdrawal");
    await t("passkey-approve").click();
    await until("the withdrawal to reach the passkey wallet", async () => (await usdc(address)) === before + inAccount);
    if ((await usdc(account)) !== 0n) throw new Error("the trading account is not empty after Withdraw everything");
    await snap("onboarding-05-withdrawn");
    return `${units(inAccount)} tUSDC back in the passkey wallet`;
  });

  await check("passkey: Reject in the approval step sends nothing; Approve then goes through", async () => {
    const address = need("address");
    const account = need("account");
    await t("funds-tab-add").click();
    const moveIn = t("funds-move-in");
    await moveIn.waitFor({ timeout: 10_000 });
    const before = await usdc(address);
    const nonce = await pub.getTransactionCount({ address });
    await moveIn.click();
    await t("passkey-approval").waitFor({ timeout: 15_000 });
    await t("passkey-reject").click();
    await t("passkey-approval").waitFor({ state: "detached", timeout: 5_000 });
    await sleep(1_500);
    if ((await pub.getTransactionCount({ address })) !== nonce) throw new Error("a transaction went out after Reject");
    if ((await usdc(address)) !== before) throw new Error("funds moved after Reject");
    await page.waitForFunction(() => document.querySelector('[data-testid="funds-move-in"]')?.disabled === false, null, { timeout: 10_000 });
    await moveIn.click();
    await t("passkey-approval").waitFor({ timeout: 15_000 });
    await t("passkey-approve").click();
    await until("the deposit into the trading account", async () => (await usdc(account)) === before);
    return `rejected, then ${units(before)} tUSDC moved in`;
  });

  await check("passkey: Sign out forgets the key", async () => {
    const address = need("address");
    await page.keyboard.press("Escape");
    await t("funds-sheet").waitFor({ state: "detached", timeout: 5_000 });
    await page.getByRole("button", { name: short(address) }).first().click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Connect wallet", exact: true }).waitFor({ timeout: 10_000 });
  });

  await check("onboarding page raised no uncaught errors", async () => {
    const errors = [...new Set(problems.filter((p) => p.startsWith("pageerror")))];
    if (errors.length > 0) throw new Error(errors.slice(0, 3).join(" / "));
  });
  const consoleErrors = [...new Set(problems.filter((p) => !p.startsWith("pageerror")))];
  if (consoleErrors.length > 0) log("e2e", `onboarding console errors (not failures):\n  ${consoleErrors.slice(0, 8).join("\n  ")}`);
  await context.close();
}
