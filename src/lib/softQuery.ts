import { useMemo } from "react";
import { useQueries } from "convex/react";
import type { FunctionReference } from "convex/server";

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
  const queries = useMemo(
    () => (args === "skip" ? {} : { q: { query, args } }),
    // Same identity semantics as convex/react's own useQuery: args are
    // compared structurally (JSON), never by reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, args === "skip" ? "skip" : JSON.stringify(args)],
  );
  const results = useQueries(queries as never) as Record<string, unknown>;
  const value = results.q;
  const errored = value instanceof Error;
  return {
    data: errored ? undefined : value,
    unavailable: errored,
  };
}
