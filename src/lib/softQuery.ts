import { useMemo } from "react";
import { useQueries } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";

export type PublicQuery = FunctionReference<"query", "public", any, any>;

/**
 * A `useQuery` variant that never throws.
 *
 * `useQuery` re-throws a query error during render, so a single query that the
 * backend can't answer (a deployment still missing that function, a temporary
 * server error, a stale schema during a rolling deploy) unmounts the whole
 * React tree onto the crash panel — the phone reads it as a frozen app.
 *
 * This hook returns the same data (or `undefined` while pending) plus an
 * `unavailable` flag instead of throwing. Screens treat `unavailable` exactly
 * like "no data yet": they render their loading/empty state and spring to
 * life automatically the moment the same query starts answering — no reload
 * needed. It is built on `useQueries`, whose API returns query errors as
 * values rather than throwing them.
 */
export function useSoftQuery(
  query: PublicQuery,
  args: Record<string, unknown> | "skip",
): { data: unknown; unavailable: boolean } {
  // `api.users.me` and friends (the generated `api` object, backed by
  // `anyApi`) are PROXIES that materialize a brand-new reference on every
  // property access — the `query` argument therefore has a different object
  // identity on every render. Memoizing on that raw object would rebuild
  // `queries` every render, which re-creates the convex subscription every
  // render, which makes convex/react's useSubscription call setState during
  // render on every render — React's nested-update guard then throws "Too
  // many re-renders" the first time any screen re-renders after mount
  // (i.e. as soon as a query answers). Key the memo on the resolved function
  // NAME instead (stable across renders, identical semantics to how
  // convex/react's own useQuery dedupes); args are compared structurally
  // (JSON), never by reference.
  const queryName = getFunctionName(query);
  const queries = useMemo(
    () => (args === "skip" ? {} : { q: { query, args } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryName, args === "skip" ? "skip" : JSON.stringify(args)],
  );
  const results = useQueries(queries as never) as Record<string, unknown>;
  const value = results.q;
  const errored = value instanceof Error;
  return {
    data: errored ? undefined : value,
    unavailable: errored,
  };
}
