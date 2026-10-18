"use client";

import { AppLink } from "@/components/app-link";
import { useLocalStore } from "@/hooks/use-local-store";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { shortAddress } from "@/lib/format";
import { follows, isFollowing, nicknameOf, toggleFollow } from "@/lib/social";

/** Is `address` the connected wallet or the account the screen shows as yours? */
export function useIsMe(address: string): boolean {
  const wallet = useWallet();
  const view = useAccountView();
  const a = address.toLowerCase();
  return a === wallet.address?.toLowerCase() || (!view.watching && a === view.address?.toLowerCase());
}

/** A trader's nickname (if you follow them with one) or short address, linking to their profile. */
export function TraderName({ address, link = true, className = "" }: { address: string; link?: boolean; className?: string }) {
  const [list] = useLocalStore(follows);
  const me = useIsMe(address);
  const nickname = nicknameOf(list, address);
  const body = (
    <>
      {nickname ? <span className="font-medium">{nickname}</span> : <span className="num">{shortAddress(address)}</span>}
      {me ? (
        <span className="tag ml-1.5" data-tone="accent">
          You
        </span>
      ) : null}
    </>
  );
  if (!link) return <span className={className}>{body}</span>;
  return (
    <AppLink route="trader" params={{ address }} className={`hover:text-accent hover:underline ${className}`} title={nickname ? `${nickname} (${address})` : address}>
      {body}
    </AppLink>
  );
}

/** Star to follow or unfollow a trader (kept in this browser). */
export function FollowButton({ address, label = false }: { address: string; label?: boolean }) {
  const [list] = useLocalStore(follows);
  const following = isFollowing(list, address);
  return (
    <button
      type="button"
      className={label ? `btn btn-sm ${following ? "" : "btn-primary"}` : `-m-1 p-1 text-sm leading-none ${following ? "text-warn" : "text-faint hover:text-muted"}`}
      aria-pressed={following}
      aria-label={label ? undefined : following ? `Unfollow ${address}` : `Follow ${address}`}
      onClick={(event) => {
        event.stopPropagation();
        toggleFollow(address);
      }}
      data-testid="follow-button"
    >
      {label ? (following ? "Following" : "Follow") : following ? "★" : "☆"}
    </button>
  );
}
