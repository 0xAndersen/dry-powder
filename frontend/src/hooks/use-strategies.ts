"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { encodeEventTopics, numberToHex, pad, parseEventLogs, toHex, type Address, type Hex, type Log } from "viem";
import { useAppConfig } from "@/components/providers";
import { agentAccountAbi, agentRegistryAbi, strategiesAbi } from "@/lib/abi";
import { pickResolution } from "@/lib/backtest";
import { krakenSource, type Instrument } from "@/lib/instruments";
import { RESOLUTIONS, fetchInstrumentCandles } from "@/lib/kraken";
import { statusOf, type AgentPolicy, type StrategyConfig, type StrategyState } from "@/lib/strategies";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

export type StrategyRow = { id: bigint; account: Address; marketId: Hex; config: StrategyConfig; state: StrategyState };

export type AccountStrategies = {
  /** Every strategy the account ran: live ones first (newest first), then stopped ones. */
  rows: StrategyRow[];
  live: StrategyRow[];
  /** The account's approval of the Strategies contract (expiry 0: none). */
  policy: AgentPolicy | null;
  /** The Strategies contract's daily margin budget on the account. */
  budget: { perDay: bigint; day: number; spent: bigint } | null;
  /** The account limits its agents to the markets it lists. */
  restrictMarkets: boolean;
  loading: boolean;
  refetch: () => void;
};

/** The strategies of an agent account, its approval of the Strategies contract and that contract's budget. */
export function useAccountStrategies(account: Address | undefined): AccountStrategies {
  const cfg = useAppConfig();
  const sx = cfg.strategies;
  const enabled = !!sx && !!account;
  const head = useReadContracts({
    allowFailure: false,
    contracts:
      enabled && sx && account
        ? ([
            { address: sx, abi: strategiesAbi, functionName: "strategiesOf", args: [account], chainId: cfg.chainId },
            { address: account, abi: agentAccountAbi, functionName: "agents", args: [sx], chainId: cfg.chainId },
            { address: account, abi: agentAccountAbi, functionName: "budgets", args: [sx], chainId: cfg.chainId },
            { address: account, abi: agentAccountAbi, functionName: "restrictMarkets", chainId: cfg.chainId },
          ] as const)
        : [],
    query: { enabled, refetchInterval: 4_000 },
  });
  const ids = useMemo(() => ((head.data?.[0] as readonly bigint[] | undefined) ?? []).slice(), [head.data]);
  const list = useReadContracts({
    allowFailure: false,
    contracts: ids.map((id) => ({ address: sx ?? undefined, abi: strategiesAbi, functionName: "getStrategy", args: [id], chainId: cfg.chainId }) as const),
    query: { enabled: enabled && ids.length > 0, refetchInterval: 3_000 },
  });

  return useMemo<AccountStrategies>(() => {
    const raw = (list.data ?? []) as unknown as { account: Address; marketId: Hex; config: StrategyConfig; state: StrategyState }[];
    const rows: StrategyRow[] = raw.map((s, i) => ({ id: ids[i]!, account: s.account, marketId: s.marketId, config: s.config, state: s.state }));
    const live = rows.filter((r) => statusOf(r.state.status) === "active" || statusOf(r.state.status) === "paused");
    const done = rows.filter((r) => !live.includes(r));
    const byNewest = (a: StrategyRow, b: StrategyRow) => (a.id > b.id ? -1 : 1);
    const d = head.data;
    const p = d?.[1] as readonly [bigint, number, bigint] | undefined;
    const b = d?.[2] as readonly [bigint, number, bigint] | undefined;
    return {
      rows: [...live.sort(byNewest), ...done.sort(byNewest)],
      live,
      policy: p ? { expiry: p[0], maxLeverage: Number(p[1]), maxMargin: p[2] } : null,
      budget: b ? { perDay: b[0], day: Number(b[1]), spent: b[2] } : null,
      restrictMarkets: (d?.[3] as boolean | undefined) ?? false,
      loading: enabled && (head.isLoading || (ids.length > 0 && list.isLoading)),
      refetch: () => {
        void head.refetch();
        void list.refetch();
      },
    };
  }, [list.data, head.data, ids, enabled, head.isLoading, list.isLoading]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Whether `account` lets its agents trade `marketId` (only asked when it restricts markets). */
export function useMarketAllowed(account: Address | undefined, marketId: Hex | undefined, restricted: boolean): boolean | undefined {
  const cfg = useAppConfig();
  const q = useReadContract({
    address: account,
    abi: agentAccountAbi,
    functionName: "marketAllowed",
    args: [marketId ?? "0x0000000000000000000000000000000000000000000000000000000000000000"],
    chainId: cfg.chainId,
    query: { enabled: !!account && !!marketId && restricted, refetchInterval: 10_000 },
  });
  if (!restricted) return true;
  return q.data as boolean | undefined;
}

// ─────────────────────────────── Activity ───────────────────────────────

const ACTIVITY = ["StrategyCreated", "TargetChanged", "OrderPlaced", "OrderSettled", "OrderDropped", "ActionRefused", "ExitedElsewhere", "StrategyPaused", "StrategyResumed", "StrategyStopped"] as const;
export type ActivityName = (typeof ACTIVITY)[number];

export type StrategyEvent = {
  key: string;
  id: bigint;
  name: ActivityName;
  args: Record<string, unknown>;
  block: bigint;
  logIndex: number;
  tx: Hex;
  /** Unix seconds, once known. */
  time: number | null;
};

const SPAN = 5_000n;
const SMALL_SPAN = 2_000n;
/** Back-fill stops after this many spans even if a strategy's creation was not found (very old strategies). */
const MAX_SPANS = 80;

/**
 * What the given strategies did, newest first, from the Strategies contract's events: read back until each one's
 * creation, then followed every few seconds. Samples are left out (one per interval; the row shows the latest).
 */
export function useStrategyActivity(ids: readonly bigint[], max = 80): { events: StrategyEvent[]; status: "idle" | "loading" | "live" | "error" } {
  const cfg = useAppConfig();
  const client = usePublicClient({ chainId: cfg.chainId });
  const key = ids.map(String).sort().join(",");
  const [events, setEvents] = useState<StrategyEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "error">("idle");

  useEffect(() => {
    const address = cfg.strategies;
    const wanted = key ? key.split(",").map((x) => BigInt(x)) : [];
    if (!client || !address || wanted.length === 0) {
      setEvents([]);
      setStatus("idle");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const topic0 = ACTIVITY.map((name) => encodeEventTopics({ abi: strategiesAbi, eventName: name })[0]!);
    const topic1 = wanted.map((id) => pad(toHex(id), { size: 32 }));
    const seen = new Map<string, StrategyEvent>();
    const times = new Map<bigint, number>();

    const fetchLogs = async (from: bigint, to: bigint): Promise<Log[]> => {
      const get = (a: bigint, b: bigint) =>
        client.request({ method: "eth_getLogs", params: [{ address, fromBlock: numberToHex(a), toBlock: numberToHex(b), topics: [topic0, topic1] }] }) as Promise<Log[]>;
      try {
        return await get(from, to);
      } catch (error) {
        if (to - from + 1n <= SMALL_SPAN) throw error;
        // The RPC refused the span: read it in smaller pieces.
        const out: Log[] = [];
        for (let a = from; a <= to; a += SMALL_SPAN) out.push(...(await get(a, a + SMALL_SPAN - 1n > to ? to : a + SMALL_SPAN - 1n)));
        return out;
      }
    };

    const add = async (logs: Log[]) => {
      const parsed = parseEventLogs({ abi: strategiesAbi, logs, eventName: [...ACTIVITY] });
      for (const l of parsed) {
        const k = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(k)) continue;
        const stamp = (l as { blockTimestamp?: Hex | bigint | null }).blockTimestamp;
        if (stamp !== undefined && stamp !== null) times.set(l.blockNumber, Number(BigInt(stamp)));
        seen.set(k, {
          key: k,
          id: (l.args as { id: bigint }).id,
          name: l.eventName as ActivityName,
          args: l.args as Record<string, unknown>,
          block: l.blockNumber,
          logIndex: l.logIndex,
          tx: l.transactionHash,
          time: null,
        });
      }
      const list = [...seen.values()].sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1)).slice(0, max);
      // Timestamps of the blocks shown that the logs did not carry.
      const missing = [...new Set(list.filter((e) => !times.has(e.block)).map((e) => e.block))].slice(0, 40);
      await Promise.all(
        missing.map(async (b) => {
          try {
            const block = await client.getBlock({ blockNumber: b });
            times.set(b, Number(block.timestamp));
          } catch {
            // Shown without a time.
          }
        }),
      );
      if (!stopped) setEvents(list.map((e) => ({ ...e, time: times.get(e.block) ?? null })));
    };

    const run = async () => {
      setStatus("loading");
      try {
        const head = await client.getBlockNumber();
        const created = new Set<string>();
        let end = head;
        for (let n = 0; n < MAX_SPANS && !stopped; n += 1) {
          const start = end + 1n > SPAN ? end - SPAN + 1n : 0n;
          const logs = await fetchLogs(start, end);
          for (const l of parseEventLogs({ abi: strategiesAbi, logs, eventName: "StrategyCreated" })) created.add(String(l.args.id));
          await add(logs);
          if (start === 0n || wanted.every((id) => created.has(String(id)))) break;
          end = start - 1n;
        }
        if (stopped) return;
        setStatus("live");
        let last = head;
        const tail = async () => {
          if (stopped) return;
          try {
            const now = await client.getBlockNumber();
            if (now > last) {
              await add(await fetchLogs(last + 1n, now));
              last = now;
            }
            if (!stopped) setStatus("live");
          } catch {
            if (!stopped) setStatus("error");
          }
          if (!stopped) timer = setTimeout(tail, 3_000);
        };
        timer = setTimeout(tail, 3_000);
      } catch {
        if (!stopped) setStatus("error");
      }
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, cfg.strategies, key, max]);

  return { events, status };
}

// ─────────────────────────────── Registry ───────────────────────────────

export type AgentListing = {
  account: Address;
  owner: Address;
  registeredAt: number;
  updatedAt: number;
  name: string;
  description: string;
  kind: string;
  uri: string;
};

type RawListing = { owner: Address; registeredAt: bigint; updatedAt: bigint; name: string; description: string; kind: string; uri: string };
const toListing = (account: Address, a: RawListing): AgentListing => ({
  account,
  owner: a.owner,
  registeredAt: Number(a.registeredAt),
  updatedAt: Number(a.updatedAt),
  name: a.name,
  description: a.description,
  kind: a.kind,
  uri: a.uri,
});

/** The registry listing of `account`, or null when it has none. */
export function useListing(account: Address | undefined) {
  const cfg = useAppConfig();
  const reg = cfg.agentRegistry;
  const q = useReadContract({
    address: reg ?? undefined,
    abi: agentRegistryAbi,
    functionName: "getAgent",
    args: [account ?? ZERO],
    chainId: cfg.chainId,
    query: { enabled: !!reg && !!account, refetchInterval: 8_000 },
  });
  const listing = q.data && account && (q.data as RawListing).owner !== ZERO ? toListing(account, q.data as RawListing) : null;
  return { listing, loading: q.isLoading, refetch: q.refetch, available: !!reg };
}

const PAGE = 100;

export type DirectoryEntry = AgentListing & { strategies: { id: bigint; kind: number; marketId: Hex; status: number }[] };

/** Every listed agent (in pages of 100) with the strategies each one runs now. */
export function useAgentDirectory() {
  const cfg = useAppConfig();
  const reg = cfg.agentRegistry;
  const sx = cfg.strategies;
  const [pages, setPages] = useState(1);
  const count = useReadContract({ address: reg ?? undefined, abi: agentRegistryAbi, functionName: "agentCount", chainId: cfg.chainId, query: { enabled: !!reg, refetchInterval: 15_000 } });
  const total = Number((count.data as bigint | undefined) ?? 0n);
  const shown = Math.min(pages, Math.ceil(total / PAGE));
  const lists = useReadContracts({
    allowFailure: false,
    contracts: Array.from({ length: shown }, (_, i) => ({ address: reg ?? undefined, abi: agentRegistryAbi, functionName: "getAgents", args: [BigInt(i * PAGE), BigInt(PAGE)], chainId: cfg.chainId }) as const),
    query: { enabled: !!reg && shown > 0, refetchInterval: 15_000 },
  });
  const live = useReadContract({ address: sx ?? undefined, abi: strategiesAbi, functionName: "getStrategies", args: [0n, 500n], chainId: cfg.chainId, query: { enabled: !!sx, refetchInterval: 15_000 } });

  const entries = useMemo<DirectoryEntry[]>(() => {
    const running = new Map<string, DirectoryEntry["strategies"]>();
    const l = live.data as readonly [readonly bigint[], readonly { account: Address; marketId: Hex; config: { kind: number }; state: { status: number } }[]] | undefined;
    if (l) {
      l[1].forEach((s, i) => {
        const k = s.account.toLowerCase();
        running.set(k, [...(running.get(k) ?? []), { id: l[0][i]!, kind: Number(s.config.kind), marketId: s.marketId, status: Number(s.state.status) }]);
      });
    }
    const out: DirectoryEntry[] = [];
    for (const page of (lists.data ?? []) as unknown as (readonly [readonly Address[], readonly RawListing[]])[]) {
      page[0].forEach((account, i) => out.push({ ...toListing(account, page[1][i]!), strategies: running.get(account.toLowerCase()) ?? [] }));
    }
    return out.sort((a, b) => b.registeredAt - a.registeredAt);
  }, [lists.data, live.data]);

  return {
    entries,
    total,
    more: shown * PAGE < total,
    loadMore: () => setPages((n) => n + 1),
    loading: count.isLoading || (shown > 0 && lists.isLoading),
    available: !!reg,
  };
}

// ─────────────────────────────── Candles ───────────────────────────────

/**
 * Recent candles of `instrument` at the largest resolution that fits `interval`, from the same source and cache as
 * the price chart.
 */
export function useStrategyCandles(instrument: Instrument | undefined, interval: number) {
  const cfg = useAppConfig();
  const seconds = pickResolution(interval, RESOLUTIONS.map((r) => r.minutes));
  const res = RESOLUTIONS.find((r) => r.minutes * 60 === seconds) ?? RESOLUTIONS[0];
  const source = useMemo(() => (instrument ? krakenSource(instrument) : null), [instrument?.feedId, instrument?.quoteFeedId, instrument?.invert]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({
    queryKey: ["candles", cfg.krakenUrl, instrument?.id, res.key],
    queryFn: ({ signal }) => fetchInstrumentCandles(cfg.krakenUrl, source!, res.minutes, signal),
    enabled: source !== null,
    staleTime: 20_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return { candles: q.data, seconds: res.minutes * 60, label: res.label, loading: q.isLoading, error: q.isError, available: source !== null };
}
