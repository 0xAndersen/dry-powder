"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { IS_STATIC_BUILD } from "@/lib/config";
import { hrefFor, stickyQuery, type Route } from "@/lib/nav";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  route: Route;
  /** Query parameters to add (or remove with null) on top of the ones that always carry over. */
  params?: Record<string, string | null>;
  children: ReactNode;
};

/** In-app navigation that keeps deployment overrides and the watched account, and works under any sub-path. */
export function AppLink({ route, params, children, ...rest }: Props) {
  const searchParams = useSearchParams();
  const href = hrefFor(route, stickyQuery(new URLSearchParams(searchParams.toString()), params));
  if (IS_STATIC_BUILD) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
