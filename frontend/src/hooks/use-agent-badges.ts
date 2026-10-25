"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { useAppConfig } from "@/components/providers";
import { agentAccountAbi, agentAccountFactoryAbi, agentRegistryAbi } from "@/lib/abi";

export type AgentBadgeInfo = {
  /** The registry listing's name and kind, when the account is listed as an agent. */
  listed: { name: string; kind: string } | null;
  /** The address is an agent account the factory deployed (strategies and agent keys trade from these). */
  agentAccount: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const NONE = new Map<string, AgentBadgeInfo>();

/**
 * Which of `addresses` are listed agents (AgentRegistry) or agent accounts (AgentAccountFactory), keyed by lower-case
 * address. Reads go out in one batch: the listing and `owner()` of each address (a wallet has no code, so that call
 * fails and it is no account), then `accountOf(owner)` for the ones that answered.
 */
export function useAgentBadges(addresses: readonly string[]): Map<string, AgentBadgeInfo> {
  const cfg = useAppConfig();
  const reg = cfg.agentRegistry;
  const factory = cfg.agentFactory;
  const key = [...new Set(addresses.filter((a) => isAddress(a, { strict: false })).map((a) => a.toLowerCase()))].sort().join(",");
  const list = useMemo(() => (key ? (key.split(",").map((a) => getAddress(a)) as Address[]) : []), [key]);

  const first = useReadContracts({
    allowFailure: true,
    contracts: list.flatMap((a) => [
      ...(reg ? [{ address: reg, abi: agentRegistryAbi, functionName: "getAgent", args: [a], chainId: cfg.chainId } as const] : []),
      ...(factory ? [{ address: a, abi: agentAccountAbi, functionName: "owner", chainId: cfg.chainId } as const] : []),
    ]),
    query: { enabled: list.length > 0 && (!!reg || !!factory), staleTime: 60_000, refetchInterval: 120_000 },
  });
  const per = (reg ? 1 : 0) + (factory ? 1 : 0);
  const owners = useMemo(() => {
    const out: { account: Address; owner: Address }[] = [];
    if (!factory || !first.data) return out;
    list.forEach((a, i) => {
      const r = first.data[i * per + (reg ? 1 : 0)];
      if (r?.status === "success" && typeof r.result === "string" && r.result !== ZERO) out.push({ account: a, owner: r.result as Address });
    });
    return out;
  }, [first.data, list, per, reg, factory]);
  const second = useReadContracts({
    allowFailure: true,
    contracts: owners.map((o) => ({ address: factory ?? undefined, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [o.owner], chainId: cfg.chainId }) as const),
    query: { enabled: !!factory && owners.length > 0, staleTime: 60_000, refetchInterval: 120_000 },
  });

  return useMemo(() => {
    if (list.length === 0 || !first.data) return NONE;
    const accounts = new Set<string>();
    owners.forEach((o, i) => {
      const r = second.data?.[i];
      if (r?.status === "success" && typeof r.result === "string" && r.result.toLowerCase() === o.account.toLowerCase()) accounts.add(o.account.toLowerCase());
    });
    const out = new Map<string, AgentBadgeInfo>();
    list.forEach((a, i) => {
      const r = reg ? first.data![i * per] : undefined;
      const l = r?.status === "success" ? (r.result as { owner: Address; name: string; kind: string }) : null;
      const listed = l && l.owner !== ZERO ? { name: l.name, kind: l.kind } : null;
      const agentAccount = listed !== null || accounts.has(a.toLowerCase());
      if (listed || agentAccount) out.set(a.toLowerCase(), { listed, agentAccount });
    });
    return out;
  }, [list, first.data, second.data, owners, per, reg]);
}
