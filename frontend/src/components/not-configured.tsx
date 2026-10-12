/** Shown instead of the app when required environment variables are missing or malformed. */
export function NotConfigured({ problems }: { problems: string[] }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-16">
      <p className="wide text-lg font-semibold text-brass">Arc House</p>
      <h1 className="wide mt-6 text-3xl font-semibold leading-tight">This deployment is not configured yet</h1>
      <p className="mt-4 max-w-prose text-muted">
        The app reads its contract addresses from environment variables when the container starts. Fix the
        items below and restart the container; no rebuild is needed.
      </p>
      <ul className="panel mt-6 divide-y divide-line">
        {problems.map((problem) => (
          <li key={problem} className="px-4 py-3 text-short">
            {problem}
          </li>
        ))}
      </ul>
      <div className="mt-6 text-muted">
        <p>Required variables:</p>
        <pre className="panel num mt-2 overflow-x-auto px-4 py-3 text-[0.8125rem] leading-6 text-text">
          {`PERP_ENGINE_ADDRESS=0x…
HOUSE_VAULT_ADDRESS=0x…
REWARD_TOKEN_ADDRESS=0x…`}
        </pre>
        <p className="mt-3">
          Optional, with Arc Testnet defaults: USDC_ADDRESS, PYTH_ADDRESS, RPC_URL, HERMES_URL, CHAIN_ID,
          EXPLORER_URL. See <span className="text-text">.env.example</span>.
        </p>
      </div>
    </main>
  );
}
