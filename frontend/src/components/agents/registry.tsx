"use client";

import { useEffect, useId, useState } from "react";
import { useConfig } from "wagmi";
import type { Address, Hex } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useAgentDirectory, useListing, type AgentListing } from "@/hooks/use-strategies";
import { useTx } from "@/hooks/use-tx";
import { fmtAge, fmtDateTime, shortAddress } from "@/lib/format";
import { LISTING_KINDS, LISTING_LIMITS, byteLength, kindOf, statusOf, templateOf, validateListing, type Listing } from "@/lib/strategies";
import { registerAgent, unregisterAgent, type OwnerContext } from "@/lib/strategy-actions";

/** Only plain web links are made clickable; anything else in a listing is shown as text. */
const safeLink = (uri: string) => (/^https?:\/\/[^\s]+$/i.test(uri.trim()) ? uri.trim() : null);

const kindLabel = (kind: string) => LISTING_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** The account's own listing in the agent registry: list it, edit it, take it down. */
export function ListingCard({ account, owner, suggestedKind }: { account: Address; owner: Address | undefined; suggestedKind: string | null }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const { listing, loading, refetch, available } = useListing(account);
  const tx = useTx();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Listing>({ name: "", description: "", kind: suggestedKind ?? "", uri: "" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!listing && suggestedKind && form.kind === "") setForm((f) => ({ ...f, kind: suggestedKind }));
  }, [suggestedKind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!available) return null;
  const issues = validateListing(form);
  const bad = new Set(issues.map((i) => i.field));
  const showForm = !listing || editing;
  const ctx = (api: OwnerContext["api"]): OwnerContext => ({ wagmi: wagmiConfig, cfg, api, owner: owner! });

  const submit = () => {
    if (!owner || issues.length > 0) return;
    const update = listing !== null;
    void tx.run(async (api) => {
      await registerAgent(ctx(api), account, form, update);
      await refetch();
      setEditing(false);
      return update ? "Listing updated." : `Listed as “${form.name.trim()}”. It shows in the directory, and leaderboards mark the account as an agent.`;
    });
  };
  const remove = () => {
    if (!owner) return;
    setConfirmRemove(false);
    void tx.run(async (api) => {
      await unregisterAgent(ctx(api), account);
      await refetch();
      return "The listing is gone. The account trades exactly as before.";
    });
  };
  const edit = (l: AgentListing) => {
    setForm({ name: l.name, description: l.description, kind: l.kind, uri: l.uri });
    setEditing(true);
  };

  return (
    <section className="panel scroll-mt-16" aria-labelledby={`${id}-t`} data-testid="listing-card">
      <div className="border-b border-line px-4 py-3">
        <h2 id={`${id}-t`} className="panel-title">
          Agent listing
        </h2>
        <p className="mt-1.5 text-[0.8125rem] text-muted">
          Listing the account tells others what trades from it: a name, the kind of agent, a line about it. It is a label, not a permission, and anyone can copy a
          listed agent.
        </p>
      </div>
      {loading ? (
        <p className="px-4 py-4 text-muted">Reading the registry…</p>
      ) : listing && !editing ? (
        <div className="flex flex-col gap-2 px-4 py-3" data-testid="listing-current">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.9375rem] font-semibold">{listing.name}</span>
            <span className="tag" data-tone="accent">
              Agent
            </span>
            <span className="tag">{kindLabel(listing.kind)}</span>
          </div>
          {listing.description ? <p className="text-[0.8125rem] text-muted">{listing.description}</p> : null}
          {listing.uri ? (
            safeLink(listing.uri) ? (
              <a className="link break-all text-xs" href={safeLink(listing.uri)!} target="_blank" rel="noreferrer noopener">
                {listing.uri}
              </a>
            ) : (
              <span className="num break-all text-xs text-faint">{listing.uri}</span>
            )
          ) : null}
          <p className="text-2xs text-faint">Listed {fmtDateTime(listing.registeredAt)}{listing.updatedAt !== listing.registeredAt ? `, updated ${fmtDateTime(listing.updatedAt)}` : ""}</p>
          {owner ? (
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => edit(listing)} data-testid="listing-edit">
                Edit
              </button>
              {confirmRemove ? (
                <button type="button" className="btn btn-sm border-short text-short" disabled={tx.busy} onClick={remove} data-testid="listing-remove-confirm">
                  Remove the listing
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" disabled={tx.busy} onClick={() => setConfirmRemove(true)} data-testid="listing-remove">
                  Remove
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {showForm && !loading ? (
        <form className="flex flex-col gap-2.5 px-4 py-3" noValidate onSubmit={(e) => (e.preventDefault(), submit())}>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="field-label" htmlFor={`${id}-n`}>
                Name
              </label>
              <span className={`num text-2xs ${byteLength(form.name.trim()) > LISTING_LIMITS.name ? "text-short" : "text-faint"}`}>
                {byteLength(form.name.trim())}/{LISTING_LIMITS.name}
              </span>
            </div>
            <div className="field h-9" data-invalid={bad.has("name") && form.name !== "" ? "true" : undefined}>
              <input id={`${id}-n`} autoComplete="off" placeholder="Steady trend bot" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="listing-name" />
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor={`${id}-k`}>
              Kind
            </label>
            <div className="field h-9" data-invalid={bad.has("kind") && form.kind !== "" ? "true" : undefined}>
              <input id={`${id}-k`} list={`${id}-kinds`} autoComplete="off" placeholder="trend, copy, llm…" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} data-testid="listing-kind" />
            </div>
            <datalist id={`${id}-kinds`}>
              {LISTING_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </datalist>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="field-label" htmlFor={`${id}-d`}>
                What it does <span className="text-faint">(optional)</span>
              </label>
              <span className={`num text-2xs ${byteLength(form.description.trim()) > LISTING_LIMITS.description ? "text-short" : "text-faint"}`}>
                {byteLength(form.description.trim())}/{LISTING_LIMITS.description}
              </span>
            </div>
            <textarea
              id={`${id}-d`}
              rows={3}
              className="w-full resize-y rounded-[6px] border border-line bg-bg px-2.5 py-2 text-[0.8125rem] outline-none focus:border-accent"
              placeholder="Follows BTC trends on 15-minute readings, 3x, stop at 3%."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              data-testid="listing-description"
            />
          </div>
          <div>
            <label className="field-label" htmlFor={`${id}-u`}>
              Link <span className="text-faint">(optional: a page or an ERC-8004 agent card)</span>
            </label>
            <div className="field h-9" data-invalid={bad.has("uri") ? "true" : undefined}>
              <input id={`${id}-u`} autoComplete="off" spellCheck={false} placeholder="https://…" value={form.uri} onChange={(e) => setForm({ ...form, uri: e.target.value })} data-testid="listing-uri" />
            </div>
          </div>
          {owner ? (
            <div className="flex gap-2">
              <button type="submit" className={`btn flex-1 ${issues.length > 0 ? "" : "btn-primary"}`} disabled={issues.length > 0 || tx.busy} data-testid="listing-submit">
                {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
                {issues[0]?.message ?? (listing ? "Save the listing" : "List as an agent")}
              </button>
              {editing ? (
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted">Connect the owner&rsquo;s wallet to list the account.</p>
          )}
        </form>
      ) : null}
      {tx.state.phase !== "idle" ? (
        <div className="px-4 pb-3">
          <TxStatus state={tx.state} onDismiss={tx.reset} />
        </div>
      ) : null}
    </section>
  );
}

/** Every listed agent, what it runs now, and a way to copy it. */
export function AgentDirectory({ me, onCopy }: { me: Address | undefined; onCopy: (leader: Address, marketId: Hex | null) => void }) {
  const { byId } = useMarketData();
  const dir = useAgentDirectory();
  const now = useChainNow(30_000);
  const id = useId();
  if (!dir.available) return null;
  const symbolOf = (m: Hex) => byId.get(m)?.symbol ?? [...byId.values()].find((i) => i.id.toLowerCase() === m.toLowerCase())?.symbol ?? "…";

  return (
    <section className="panel min-w-0 scroll-mt-16" id="directory" aria-labelledby={`${id}-t`} data-testid="directory">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id={`${id}-t`} className="panel-title">
          Agent directory <span className="num ml-1 text-faint">{dir.total}</span>
        </h2>
        <p className="text-xs text-faint">Accounts their owners listed as agents. Copying one runs a copy strategy on your account.</p>
      </div>
      {dir.loading ? (
        <p className="px-4 py-8 text-center text-muted">Reading the registry…</p>
      ) : dir.entries.length === 0 ? (
        <p className="px-4 py-8 text-center text-[0.8125rem] text-muted">No agents are listed yet. List yours from the Agent listing card.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table card-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Runs now</th>
                <th>Account</th>
                <th className="r">Listed</th>
                <th className="r">
                  <span className="sr-only">Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {dir.entries.map((a) => {
                const mine = !!me && a.account.toLowerCase() === me.toLowerCase();
                const active = a.strategies.filter((s) => statusOf(s.status) === "active");
                const link = safeLink(a.uri);
                return (
                  <tr key={a.account} data-testid="directory-row" data-account={a.account.toLowerCase()}>
                    <td data-cell="market">
                      <div className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-text">{a.name}</span>
                          <span className="tag" data-tone="accent">
                            Agent
                          </span>
                          <span className="tag">{kindLabel(a.kind)}</span>
                          {mine ? <span className="tag">You</span> : null}
                        </span>
                        {a.description ? <span className="line-clamp-2 max-w-[56ch] text-xs text-muted">{a.description}</span> : null}
                        {link ? (
                          <a className="link w-fit text-2xs" href={link} target="_blank" rel="noreferrer noopener">
                            More about it
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Runs now">
                      {a.strategies.length === 0 ? (
                        <span className="text-xs text-faint">No on-chain strategy</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {a.strategies.map((s) => (
                            <span key={String(s.id)} className={`tag ${statusOf(s.status) === "paused" ? "text-faint" : ""}`} title={statusOf(s.status) === "paused" ? "Paused" : "Active"}>
                              {templateOf(kindOf(s.kind)).title} on {symbolOf(s.marketId)}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="num text-xs" data-label="Account">
                      <AppLink route="trader" params={{ address: a.account }} className="link" title={a.account}>
                        {shortAddress(a.account)}
                      </AppLink>
                    </td>
                    <td className="r num text-xs text-muted" data-label="Listed" title={fmtDateTime(a.registeredAt)}>
                      {fmtAge(Math.max(0, now - a.registeredAt))} ago
                    </td>
                    <td className="r" data-cell="actions">
                      {mine ? null : (
                        <button type="button" className="btn btn-sm" onClick={() => onCopy(a.account, (active[0] ?? a.strategies[0])?.marketId ?? null)} data-testid="directory-copy">
                          Copy this agent
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {dir.more ? (
        <button type="button" className="link mx-4 my-2 text-xs" onClick={dir.loadMore}>
          Show more agents
        </button>
      ) : null}
    </section>
  );
}
