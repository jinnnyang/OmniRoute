/**
 * Shared "is this provider durably down" predicate.
 *
 * Extracted from open-sse/services/combo/dispatchPrelude.ts (the context-cache
 * pin drop decision, Fix #679) so the Vision Bridge router can apply the same
 * health gate to its own candidate selection without importing the combo
 * dispatch module — that import would create a cycle:
 *   visionBridgeRouter -> dispatchPrelude -> visionBridgeHelpers -> visionBridgeRouter
 *
 * A provider is DURABLY down when:
 *   - its circuit breaker is OPEN, or
 *   - it has no active connections, or
 *   - EVERY active connection is either in a terminal status
 *     (credits_exhausted / banned / expired), has accumulated
 *     `backoffLevel >= K` consecutive failures, or is rate-limited beyond
 *     a short grace window (a brief transient cooldown is tolerated so an
 *     unstable provider does not churn candidates/pins every turn).
 *
 * Pure + unit-testable; no DB or breaker imports.
 */

/** Connection-level statuses from which a connection does not recover on its own. */
export const TERMINAL_UNHEALTHY_STATUSES: ReadonlySet<string> = new Set([
  "credits_exhausted",
  "banned",
  "expired",
]);

/** Minimal row shape needed for the health verdict (tests inject pure data). */
export interface ConnectionHealthRowLike {
  testStatus?: string | null;
  backoffLevel?: number | null;
  rateLimitedUntil?: string | null;
}

export interface DurablyUnhealthyOptions {
  /** Backoff level at which a connection is considered durably failing. Default: env `PIN_DROP_BACKOFF_LEVEL` or 2. */
  backoffLevel?: number;
  /** Grace window (ms) for a transient rate-limit. Default: env `PIN_DROP_GRACE_MS` or 20000. */
  graceMs?: number;
}

/**
 * Decide whether a provider (given its circuit state and active connections)
 * is durably down. `true` ⇒ callers must drop/skip the provider and fail over.
 */
export function providerConnectionsDurablyUnhealthy(
  circuitState: string | undefined,
  connections: ReadonlyArray<ConnectionHealthRowLike>,
  now: number,
  opts: DurablyUnhealthyOptions = {}
): boolean {
  if (circuitState === "OPEN") return true;
  if (!Array.isArray(connections) || connections.length === 0) return true;
  const backoffThreshold = opts.backoffLevel ?? Number(process.env.PIN_DROP_BACKOFF_LEVEL || "2");
  const graceMs = opts.graceMs ?? Number(process.env.PIN_DROP_GRACE_MS || "20000");
  // The provider survives as long as AT LEAST ONE connection is healthy or only
  // briefly cooling down — failover only when every connection is durably down.
  const anyUsable = connections.some((c) => {
    const status = typeof c.testStatus === "string" ? c.testStatus : "";
    if (TERMINAL_UNHEALTHY_STATUSES.has(status)) return false;
    if (Number(c.backoffLevel ?? 0) >= backoffThreshold) return false;
    const rl = c.rateLimitedUntil ? new Date(String(c.rateLimitedUntil)).getTime() : 0;
    if (Number.isFinite(rl) && rl - now > graceMs) return false;
    return true;
  });
  return !anyUsable;
}
