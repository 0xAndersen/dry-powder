import { IS_STATIC_BUILD } from "@/lib/config";

/** Shown instead of the app when required settings are missing or malformed. */
export function NotConfigured({ problems }: { problems: string[] }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-16">
      <p className="wide text-lg font-semibold text-spark">Dry Powder</p>
      <h1 className="wide mt-6 text-3xl font-semibold leading-tight">This deployment is not configured yet</h1>
      <p className="mt-4 max-w-prose text-muted">
        {IS_STATIC_BUILD
          ? "This static bundle reads its contract addresses from config.json, placed next to the app, or from the page address. Fix the items below and reload; no rebuild is needed."
          : "The app reads its contract addresses from environment variables when the container starts. Fix the items below and restart the container; no rebuild is needed."}
      </p>
      <ul className="panel mt-6 divide-y divide-line">
        {problems.map((problem) => (
          <li key={problem} className="px-4 py-3 text-short">
            {problem}
          </li>
        ))}
      </ul>
      <div className="mt-6 text-muted">
        <p>{IS_STATIC_BUILD ? "Minimal config.json:" : "Required variables:"}</p>
        <pre className="panel num mt-2 overflow-x-auto px-4 py-3 text-[0.8125rem] leading-6 text-text">
          {IS_STATIC_BUILD
            ? `{
  "perpEngineAddress": "0x…",
  "engineLensAddress": "0x…",
  "houseVaultAddress": "0x…",
  "rewardTokenAddress": "0x…"
}`
            : `PERP_ENGINE_ADDRESS=0x…
ENGINE_LENS_ADDRESS=0x…
HOUSE_VAULT_ADDRESS=0x…
REWARD_TOKEN_ADDRESS=0x…`}
        </pre>
        <p className="mt-3">
          {IS_STATIC_BUILD
            ? "Or pass them in the address: ?engine=0x…&lens=0x…&vault=0x…&token=0x…. Optional keys, with Arc Testnet defaults, are listed in the README."
            : "Optional, with Arc Testnet defaults: USDC_ADDRESS, RPC_URL, CHAIN_ID, ORACLE_MODE, COLLATERAL_SYMBOL, COLLATERAL_IS_TEST, KRAKEN_URL, HERMES_URL, PYTH_API_KEY, EXPLORER_URL. See .env.example."}
        </p>
      </div>
    </main>
  );
}
