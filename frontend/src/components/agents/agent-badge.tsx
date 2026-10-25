"use client";

import { useAgentBadges, type AgentBadgeInfo } from "@/hooks/use-agent-badges";

/**
 * Marks an address that is a listed agent (its registry name and "Agent") or an agent account (a contract a
 * wallet owns that bots and strategies trade from). Renders nothing for an ordinary wallet.
 */
export function AgentBadge({ info, showName = true }: { info: AgentBadgeInfo | undefined; showName?: boolean }) {
  if (!info) return null;
  if (info.listed) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="agent-badge" data-kind="listed">
        <span className="tag" data-tone="accent" title={`Listed in the agent registry as “${info.listed.name}” (${info.listed.kind})`}>
          Agent
        </span>
        {showName ? <span className="max-w-[16ch] truncate text-xs font-normal text-muted">{info.listed.name}</span> : null}
      </span>
    );
  }
  return (
    <span className="tag" title="An agent account: a contract a wallet owns, which agent keys and strategies trade from but cannot withdraw from" data-testid="agent-badge" data-kind="account">
      Agent account
    </span>
  );
}

/** The badge for one address, read on its own (profile pages). Lists read theirs in one batch with `useAgentBadges`. */
export function AgentBadgeFor({ address, showName = true }: { address: string; showName?: boolean }) {
  const badges = useAgentBadges([address]);
  return <AgentBadge info={badges.get(address.toLowerCase())} showName={showName} />;
}
