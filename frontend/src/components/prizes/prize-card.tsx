"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useConfig, useReadContracts } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { Tip } from "@/components/tip";
import { TxStatus } from "@/components/tx-status";
import { useChainNow } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import { useStatsFile } from "@/hooks/use-venue-stats";
import { useWallet } from "@/hooks/use-wallet";
import { agentAccountFactoryAbi, prizeDistributorAbi } from "@/lib/abi";
import { seasonAt } from "@/lib/aggregate";
import { IS_STATIC_BUILD } from "@/lib/config";
import { fmtDuration, fmtUsdc, fmtUtc, shortAddress } from "@/lib/format";
import { staticBaseUrl } from "@/lib/nav";
import {
  claimStatus,
  parsePrizeSeason,
  parsePrizesIndex,
  prizesFor,
  prizesIndexUrl,
  readOnChainSeason,
  seasonsToLoad,
  type ClaimStatus,
  type PrizeAccount,
  type PrizeRow,
  type PrizeSeason,
  type PrizesIndex,
} from "@/lib/prizes";
import { optionalSettingsQuery } from "@/lib/push";
import { statsUrlFor } from "@/lib/stats-file";
import { walletWrite } from "@/lib/wallet-write";

const appBase = () => (typeof window === "undefined" ? "" : IS_STATIC_BUILD ? staticBaseUrl(window.location) : `${window.location.origin}/`);

/** JSON from the results host, or null for a 404 (nothing published yet). Raw hosts cache: a per-minute query string. */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}t=${Math.floor(Date.now() / 60_000)}`, { cache: "no-store", signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (unix: number) => DAY_FORMAT.format(new Date(unix * 1000));

/** Results for another chain or another distributor are not this deployment's. */
function forThisDeployment(x: { chainId: number; distributor: Address | null }, chainId: number, distributor: Address): boolean {
  return (x.chainId === 0 || x.chainId === chainId) && (x.distributor === null || sameAddress(x.distributor, distributor));
}

const STATUS_TEXT: Record<ClaimStatus, string> = {
  claimable: "Claim",
  claimed: "Claimed",
  expired: "Claim window closed",
  closed: "Season closed",
  pending: "Not published on-chain yet",
};

/**
 * Season prizes on the Portfolio page (roadmap 81): the latest season's pool and winners, the prizes the accounts on
 * screen won (the wallet and its agent account), and a claim for each. Results come from ops/scripts/prizes.mjs via
 * prizes/index.json; PrizeDistributor checks every claim against the season's root. Hidden on deployments without a
 * PrizeDistributor.
 */
export function PrizeCard({ address, watching }: { address: Address; watching: boolean }) {
  const { config: cfg } = useApp();
  const distributor = cfg.prizeDistributor;
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const tx = useTx();
  const now = useChainNow(15_000);
  const stats = useStatsFile();
  const sym = cfg.collateralSymbol;

  const settings = useQuery({ ...optionalSettingsQuery(appBase(), IS_STATIC_BUILD), enabled: distributor !== null });
  const indexUrl = settings.isFetched ? prizesIndexUrl({ explicit: settings.data?.prizesUrl ?? null, statsUrl: statsUrlFor(cfg), base: appBase() }) : null;
  const index = useQuery<PrizesIndex | null>({
    queryKey: ["prizes-index", indexUrl],
    enabled: distributor !== null && indexUrl !== null,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const parsed = parsePrizesIndex(await fetchJson(indexUrl!, signal));
      return parsed && distributor && forThisDeployment(parsed, cfg.chainId, distributor) ? parsed : null;
    },
  });
  const entries = useMemo(() => (index.data ? seasonsToLoad(index.data, now) : []), [index.data, now]);
  const files = useQueries({
    queries: entries.map((e) => {
      const url = new URL(e.file, indexUrl!).toString();
      return {
        queryKey: ["prize-season", url, e.root],
        staleTime: 10 * 60_000,
        retry: 1,
        queryFn: async ({ signal }: { signal?: AbortSignal }) => {
          const s = parsePrizeSeason(await fetchJson(url, signal));
          // The file must be the one the index announced, for this deployment.
          return s && s.root === e.root && s.season === e.season && distributor && forThisDeployment(s, cfg.chainId, distributor) ? s : null;
        },
      };
    }),
  });
  const seasons = files.map((f) => f.data).filter((s): s is PrizeSeason => Boolean(s));
  const latest = seasons.find((s) => s.season === entries[0]?.season) ?? null;

  // The wallet's agent account wins prizes of its own: show and claim them here too.
  const factory = cfg.agentFactory;
  const owner = watching ? undefined : wallet.address;
  const base = useReadContracts({
    allowFailure: true,
    contracts: [
      ...(factory && owner ? [{ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner], chainId: cfg.chainId } as const] : []),
      ...seasons.map((s) => ({ address: distributor!, abi: prizeDistributorAbi, functionName: "seasons", args: [BigInt(s.season)], chainId: cfg.chainId }) as const),
    ],
    query: { enabled: distributor !== null, refetchInterval: 30_000 },
  });
  const offset = factory && owner ? 1 : 0;
  const agentRaw = offset ? (base.data?.[0]?.result as Address | undefined) : undefined;
  const agentAccount = agentRaw && agentRaw !== zeroAddress ? agentRaw : null;
  const chainSeasons = new Map(seasons.map((s, i) => [s.season, readOnChainSeason(base.data?.[offset + i]?.result)]));

  const accounts = useMemo<PrizeAccount[]>(() => {
    if (watching) return [{ address, label: "This account" }];
    const list: PrizeAccount[] = [];
    if (wallet.address) list.push({ address: wallet.address, label: "Your wallet" });
    if (agentAccount) list.push({ address: agentAccount, label: "Your agent account" });
    if (!list.some((a) => sameAddress(a.address, address))) list.push({ address, label: "This account" });
    return list;
  }, [watching, address, wallet.address, agentAccount]);
  const rows = prizesFor(seasons, accounts);
  const claimed = useReadContracts({
    allowFailure: true,
    contracts: rows.map((r) => ({ address: distributor!, abi: prizeDistributorAbi, functionName: "claimed", args: [BigInt(r.season), r.account], chainId: cfg.chainId }) as const),
    query: { enabled: distributor !== null && rows.length > 0, refetchInterval: 30_000 },
  });

  // The running season, when the launch time is known: when it ends and what its pool holds so far.
  const launch = stats.data?.status === "ready" && stats.data.state.deployTime > 0 ? stats.data.state.deployTime : cfg.deployedAt;
  const current = launch ? seasonAt(now, launch) : null;
  const currentPool = useReadContracts({
    allowFailure: true,
    contracts: current && distributor ? [{ address: distributor, abi: prizeDistributorAbi, functionName: "seasons", args: [BigInt(current.number)], chainId: cfg.chainId } as const] : [],
    query: { enabled: current !== null && distributor !== null, refetchInterval: 60_000 },
  });
  const funded = readOnChainSeason(currentPool.data?.[0]?.result)?.funded ?? 0n;

  if (!distributor) return null;

  const claim = (row: PrizeRow) => {
    const who = wallet.address;
    if (!who || !wallet.ready) return;
    void tx.run(async (api) => {
      await api.send(`Claim ${fmtUsdc(row.amount)} ${sym}`, () =>
        walletWrite(wagmiConfig, {
          address: distributor,
          abi: prizeDistributorAbi,
          functionName: "claim",
          args: [BigInt(row.season), row.account, row.amount, row.proof],
          account: who,
          chainId: cfg.chainId,
        }),
      );
      return sameAddress(row.account, who)
        ? `Season ${row.season} prize claimed: ${fmtUsdc(row.amount)} ${sym} is in your wallet.`
        : `Season ${row.season} prize claimed: ${fmtUsdc(row.amount)} ${sym} went to ${row.label.replace(/^Your /, "your ")}.`;
    });
  };

  const loading = settings.isLoading || index.isLoading || files.some((f) => f.isLoading);
  const failed = index.isError;
  const chain = latest ? chainSeasons.get(latest.season) : null;

  return (
    <section className="panel" aria-label="Season prizes" data-testid="prize-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="panel-title flex items-center gap-1">
          Season prizes
          <Tip label="About season prizes">
            Each weekly season (Monday to Monday, UTC) the top traders by net PnL share a prize pool. After the season the results are published
            on-chain; each winner claims with a proof, before the deadline. Anyone can submit a claim, and the prize always goes to the winning account.
          </Tip>
        </h2>
        {current ? (
          <span className="num text-2xs text-faint" data-testid="prize-current">
            Season {current.number} ends in {fmtDuration(current.end - now)}
            {funded > 0n ? ` · pool so far ${fmtUsdc(funded, 0)} ${sym}` : ""}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="px-3 py-3">
          <span className="skeleton h-10 w-full" />
        </div>
      ) : !latest ? (
        <p className="px-4 py-6 text-center text-[0.8125rem] text-muted" data-testid="prize-empty">
          {failed ? "Season results could not be loaded right now." : "No season has been paid out yet."} The top traders of each week by net PnL share
          its prize pool; results show here once a season is published.{" "}
          <AppLink route="leaderboard" className="link">
            See the standings
          </AppLink>
        </p>
      ) : (
        <div className="grid gap-3 px-3 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4" data-testid="prize-pool">
            <div className="kv">
              <dt>Season</dt>
              <dd className="num">
                {latest.season} <span className="text-faint">· {day(latest.start)} to {day(latest.end)}</span>
              </dd>
            </div>
            <div className="kv">
              <dt>Prize pool</dt>
              <dd className="num" data-testid="prize-pool-total">
                {fmtUsdc(latest.total)} {sym}
              </dd>
            </div>
            <div className="kv">
              <dt>Winners</dt>
              <dd className="num">
                {latest.winners.length}
                {chain ? <span className="text-faint"> · {fmtUsdc(chain.claimed)} claimed</span> : null}
              </dd>
            </div>
            <div className="kv">
              <dt>Claim by</dt>
              <dd className="num">{fmtUtc(chain?.claimDeadline || latest.deadline)}</dd>
            </div>
          </dl>

          {rows.length > 0 ? (
            <ul className="grid gap-1.5" aria-label="Your prizes">
              {rows.map((r, i) => {
                const status = claimStatus(r, chainSeasons.get(r.season) ?? null, claimed.data?.[i]?.result as boolean | undefined, Math.floor(now));
                return (
                  <li key={`${r.season}-${r.account}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2" data-testid="prize-row" data-account={r.account.toLowerCase()} data-status={status}>
                    <span className="min-w-0 text-[0.8125rem]">
                      <span className="font-semibold">{r.label}</span> <span className="text-muted">won #{r.rank} in season {r.season}</span>
                      <span className="num ml-2 text-long">
                        {fmtUsdc(r.amount)} {sym}
                      </span>
                      {status === "claimed" && !sameAddress(r.account, wallet.address) && !watching ? (
                        <span className="block text-2xs text-faint">
                          Paid to the account. <AppLink route="agents" className="link">Withdraw it on the Agents page</AppLink>
                        </span>
                      ) : null}
                    </span>
                    {status === "claimable" && !watching ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!wallet.ready || tx.busy}
                        title={wallet.ready ? undefined : wallet.connected ? "Switch to the app's network" : "Connect a wallet to claim"}
                        onClick={() => claim(r)}
                        data-testid="prize-claim"
                      >
                        Claim {fmtUsdc(r.amount)} {sym}
                      </button>
                    ) : (
                      <span className={`text-xs ${status === "claimed" ? "text-long" : "text-faint"}`} data-testid={status === "claimed" ? "prize-claimed" : "prize-status"}>
                        {status === "claimable" ? "Unclaimed" : STATUS_TEXT[status]}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[0.8125rem] text-muted" data-testid="prize-none">
              {watching ? "This account" : "You"} did not place in season {latest.season}. Next season: trade, keep the net PnL positive, and climb the leaderboard.
            </p>
          )}

          <ol className="grid gap-0.5 text-xs" aria-label={`Season ${latest.season} winners`} data-testid="prize-winners">
            {latest.winners.slice(0, 5).map((w) => {
              const mine = accounts.some((a) => sameAddress(a.address, w.account));
              return (
                <li key={w.account} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="num text-faint">#{w.rank}</span>{" "}
                    <AppLink route="trader" params={{ address: w.account }} className="num hover:text-accent">
                      {shortAddress(w.account)}
                    </AppLink>
                    {mine ? <span className="ml-1 text-accent">you</span> : null}
                  </span>
                  <span className="num">
                    {fmtUsdc(w.amount)} {sym}
                    {w.net !== null ? <span className="ml-2 text-faint">net {fmtUsdc(w.net, 2, { sign: true })}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <TxStatus state={tx.state} onDismiss={tx.reset} className="mx-3 mb-3" />
    </section>
  );
}
