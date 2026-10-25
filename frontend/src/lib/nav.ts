import { IS_STATIC_BUILD, STICKY_QUERY_KEYS } from "./config";

export const ROUTES = ["trade", "markets", "portfolio", "activity", "leaderboard", "trader", "house", "agents", "simple", "charts"] as const;
export type Route = (typeof ROUTES)[number];

/** The route the browser is on, whatever sub-path the app is served from. */
export function currentRoute(pathname: string): Route | null {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.replace(/\.html$/, "");
  return (ROUTES as readonly string[]).includes(last ?? "") ? (last as Route) : null;
}

/** Keeps deployment overrides and the watched account when moving between pages. */
export function stickyQuery(current: URLSearchParams, extra: Record<string, string | null> = {}): string {
  const out = new URLSearchParams();
  for (const key of STICKY_QUERY_KEYS) {
    const value = current.get(key);
    if (value) out.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) out.delete(key);
    else out.set(key, value);
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}

/**
 * Link target for `route`. The static bundle uses relative links (every page lives one directory deep,
 * so `../house/` works under any sub-path); the server build uses absolute paths.
 */
export function hrefFor(route: Route, query: string): string {
  return IS_STATIC_BUILD ? `../${route}/${query}` : `/${route}${query}`;
}

/** Directory the static bundle is served from, with a trailing slash. */
export function staticBaseUrl(location: Location): string {
  const segments = location.pathname.split("/");
  // Drop everything from the last known route segment on: "/sub/trade/" -> "/sub/".
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const name = segments[i]!.replace(/\.html$/, "");
    if ((ROUTES as readonly string[]).includes(name)) {
      return `${location.origin}${segments.slice(0, i).join("/")}/`;
    }
  }
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`;
}
