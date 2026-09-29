/**
 * providerBreaker.ts — provider-level circuit-breaker compatibility layer.
 *
 * Cluster D extraction from `services/accountFallback.ts` (file-size-baseline
 * gate): the legacy provider-breaker helpers that delegate to the shared
 * `src/shared/utils/circuitBreaker` utility. Pure of module state w.r.t.
 * accountFallback.ts — profile resolution is injected via a DI factory
 * (`createProviderBreakerLayer`), so this module never imports
 * accountFallback.ts (no circular dependency — `npm run check:cycles`).
 * Follows the same leaf-module pattern as `accountFallback/exactModelLock.ts`.
 *
 * @module services/providerBreaker
 */

import {
  getAllCircuitBreakerStatuses,
  getCircuitBreaker,
} from "../../src/shared/utils/circuitBreaker";
import { classify429FromError, type FailureKind } from "../../src/shared/utils/classify429";
import { resolveUseUpstream429BreakerHints } from "../../src/shared/utils/providerHints";
import { recordProviderSuccess as resetCooldownFailureCount } from "./providerCooldownTracker.ts";

/** Provider-level failure tracking for circuit breaker behavior
 *  Error codes that count toward provider-level failure threshold.
 *  429 is included: per-error-type cooldowns (rate_limit: 60s, quota_exhausted: 1h)
 *  prevent cascading provider trips at scale (Issue #1846 concern addressed),
 *  while still allowing the circuit breaker to open on sustained 429s and
 *  prevent infinite combo retries (Issue #3200). */
const PROVIDER_FAILURE_ERROR_CODES = new Set([408, 429, 500, 502, 503, 504]);

// Per-connection failure deduplication: prevents rapid-fire failures from the
// same connection from counting multiple times toward the provider breaker.
const CONNECTION_FAILURE_DEDUP_MS = 5000;
const MAX_CONNECTION_FAILURE_DEDUP_ENTRIES = 10_000;
const lastConnectionFailure = new Map<string, number>();

// Per-provider network-error dedup: several combo targets on the SAME provider can
// fail the same single network event (a VPN blip) in the same request. Without this,
// each target counts once and one transient blip opens the whole-provider breaker
// while the provider is healthy. A genuinely dead proxy persists ACROSS requests
// (past the window) and still accumulates to its threshold.
const NETWORK_ERROR_DEDUP_MS = 10_000;
const MAX_NETWORK_ERROR_DEDUP_ENTRIES = 1000;
const lastNetworkErrorByProvider = new Map<string, number>();

function pruneConnectionFailureDedupeEntries(): void {
  while (lastConnectionFailure.size > MAX_CONNECTION_FAILURE_DEDUP_ENTRIES) {
    const oldestKey = lastConnectionFailure.keys().next().value;
    if (typeof oldestKey !== "string") return;
    lastConnectionFailure.delete(oldestKey);
  }
}

const _connectionFailureSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastConnectionFailure) {
    if (now - ts > CONNECTION_FAILURE_DEDUP_MS) lastConnectionFailure.delete(key);
  }
}, 60_000);
if (typeof _connectionFailureSweep === "object" && "unref" in _connectionFailureSweep) {
  (_connectionFailureSweep as { unref?: () => void }).unref?.();
}

export type ProviderBreakerProfile = {
  failureThreshold?: number;
  degradationThreshold?: number;
  resetTimeoutMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerReset?: number;
};

/** Structural subset of ProviderProfile that the breaker layer reads. */
export type ProviderProfileLike = {
  failureThreshold: number;
  resetTimeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerReset: number;
  useUpstream429BreakerHints?: boolean;
  degradationThreshold?: number;
  maxBackoffMultiplier?: number;
  backoffEscalationCount?: number;
};

export interface ProviderBreakerDeps {
  getProviderProfile(provider: string): ProviderProfileLike;
}

/**
 * DI factory: builds the provider-breaker compatibility layer with the
 * caller's profile resolver (accountFallback.ts's `getProviderProfile`),
 * keeping this module free of any import back into accountFallback.ts.
 */
export function createProviderBreakerLayer(deps: ProviderBreakerDeps) {
  function getProviderBreaker(provider: string | null | undefined) {
    return provider ? getCircuitBreaker(provider) : null;
  }

  function configureProviderBreaker(
    provider: string | null | undefined,
    profile?: ProviderBreakerProfile | null
  ) {
    if (!provider) return null;

    const resolvedProfile = { ...deps.getProviderProfile(provider), ...profile };
    // Issue #2100 follow-up: resolve useUpstream429BreakerHints from the
    // provider profile (stored override) or fall back to per-provider default.
    // Stored value type is `boolean | undefined` — never `null` after PATCH.
    const userValue = resolvedProfile.useUpstream429BreakerHints;
    const useHints = resolveUseUpstream429BreakerHints(provider, userValue);
    return getCircuitBreaker(provider, {
      failureThreshold: resolvedProfile.failureThreshold ?? resolvedProfile.circuitBreakerThreshold,
      resetTimeout: resolvedProfile.resetTimeoutMs ?? resolvedProfile.circuitBreakerReset,
      ...(useHints
        ? {
            cooldownByKind: {
              rate_limit: 60_000,
              quota_exhausted: 3_600_000,
            } satisfies Partial<Record<FailureKind, number>>,
            classifyError: classify429FromError,
          }
        : {}),
      degradationThreshold: resolvedProfile.degradationThreshold,
      maxBackoffMultiplier: resolvedProfile.maxBackoffMultiplier,
      backoffEscalationCount: resolvedProfile.backoffEscalationCount,
    });
  }

  /**
   * Check if a provider is currently blocked by the shared circuit breaker.
   */
  function isProviderInCooldown(provider: string | null | undefined): boolean {
    const breaker = getProviderBreaker(provider);
    return breaker ? !breaker.canExecute() : false;
  }

  /**
   * Get remaining retry-after time for a provider breaker.
   */
  function getProviderCooldownRemainingMs(provider: string | null | undefined): number | null {
    const breaker = getProviderBreaker(provider);
    if (!breaker || breaker.canExecute()) return null;
    const remaining = breaker.getRetryAfterMs();
    return remaining > 0 ? remaining : null;
  }

  function getProviderBreakerState(provider: string | null | undefined) {
    const breaker = getProviderBreaker(provider);
    return breaker?.getStatus?.() ?? null;
  }

  /**
   * Record a provider failure against the shared circuit breaker.
   * Delegates to the existing CircuitBreaker utility which handles
   * failure counting, threshold detection, and state transitions.
   *
   * IMPORTANT: If the breaker is already OPEN (in cooldown), we skip
   * recording the failure to prevent resetting the cooldown timer.
   * This matches the original behavior where failures during cooldown
   * were ignored to avoid indefinite lockout.
   */
  function recordProviderFailure(
    provider: string | null | undefined,
    log?: { warn?: (...args: unknown[]) => void },
    connectionId?: string | null,
    profile?: ProviderBreakerProfile | null,
    opts?: { isQueueTimeout?: boolean; isNetworkError?: boolean }
  ): void {
    if (!provider) return;
    // OmniRoute's own rate-limit queue timeout is backpressure we applied, not a
    // provider failure — the provider never saw the request, so it must not count
    // toward the provider breaker.
    if (opts?.isQueueTimeout) return;

    // Network-layer errors (proxy_unreachable) get a separate SAME-PROVIDER dedup, so a
    // single transient network event is not counted once per combo target (see the
    // declaration). A dead proxy persists across requests and still accumulates.
    if (opts?.isNetworkError) {
      const now = Date.now();
      const last = lastNetworkErrorByProvider.get(provider);
      if (last && now - last < NETWORK_ERROR_DEDUP_MS) return;
      lastNetworkErrorByProvider.delete(provider);
      lastNetworkErrorByProvider.set(provider, now);
      while (lastNetworkErrorByProvider.size > MAX_NETWORK_ERROR_DEDUP_ENTRIES) {
        const oldestKey = lastNetworkErrorByProvider.keys().next().value;
        if (typeof oldestKey !== "string") break;
        lastNetworkErrorByProvider.delete(oldestKey);
      }
    }

    // Deduplicate rapid-fire failures from the same connection
    if (connectionId) {
      const dedupKey = `${provider}:${connectionId}`;
      const now = Date.now();
      const lastFailure = lastConnectionFailure.get(dedupKey);
      if (lastFailure && now - lastFailure < CONNECTION_FAILURE_DEDUP_MS) {
        return;
      }
      lastConnectionFailure.delete(dedupKey);
      lastConnectionFailure.set(dedupKey, now);
      pruneConnectionFailureDedupeEntries();
    }

    const breaker = configureProviderBreaker(provider, profile);
    if (!breaker) return;

    if (!breaker.canExecute()) return;

    breaker._onFailure();

    if (!breaker.canExecute()) {
      log?.warn?.(`[ProviderFailure] ${provider}: circuit breaker opened after repeated failures`);
    }
  }

  /**
   * Record a successful request for a provider.
   * Symmetric counterpart of recordProviderFailure:
   * - Resets cooldown failureCount (exponential backoff) for all non-OPEN states.
   * - HALF_OPEN -> CLOSED (probe success), CLOSED/DEGRADED -> decay failureCount.
   *
   * When the breaker is OPEN (provider is failing), this is a no-op -- the
   * cooldown stays intact and the breaker keeps its cooldown period.
   *
   * Matches execute()'s behavior: _onSuccess() is called for all non-OPEN states.
   */
  function recordProviderSuccess(
    provider: string | null | undefined,
    connectionId?: string | null
  ): void {
    if (!provider || provider === "unknown") return;

    const breaker = getProviderBreaker(provider);
    if (!breaker) return;
    const breakerState = breaker.getStatus().state;

    // When breaker is OPEN, the provider is failing -- do not reset cooldown
    // even if one request slipped through (dispatched before the open).
    // The cooldown resets when the breaker reaches HALF_OPEN and the probe
    // succeeds below.
    if (breakerState === "OPEN") return;

    // Reset cooldown failureCount (exponential backoff) -- symmetric with
    // recordProviderCooldown which increments it on each failure.
    resetCooldownFailureCount(provider, connectionId ?? undefined);

    // Clear failure-dedup window so the next genuine failure is not suppressed.
    if (connectionId) {
      lastConnectionFailure.delete(`${provider}:${connectionId}`);
    }

    // Transition breaker on success, matching execute()'s behavior:
    // HALF_OPEN -> CLOSED (probe success), CLOSED/DEGRADED -> decay failureCount.
    breaker._onSuccess();
  }

  /**
   * Reset the shared provider breaker.
   */
  function clearProviderFailure(provider: string | null | undefined): void {
    const breaker = getProviderBreaker(provider);
    breaker?.reset();
  }

  /**
   * Get all providers currently blocked by the shared breaker.
   */
  function getProvidersInCooldown(): Array<{
    provider: string;
    failureCount: number;
    cooldownRemainingMs: number | null;
    lastFailureAt: number | null;
  }> {
    return getAllCircuitBreakerStatuses()
      .filter((status) => {
        const breaker = getProviderBreaker(status.name);
        return Boolean(breaker && !breaker.canExecute());
      })
      .map((status) => ({
        provider: status.name,
        failureCount: status.failureCount,
        cooldownRemainingMs: status.retryAfterMs || null,
        lastFailureAt: status.lastFailureTime,
      }));
  }

  /**
   * Check if a status code should be counted toward provider failure threshold
   */
  function isProviderFailureCode(status: number): boolean {
    return PROVIDER_FAILURE_ERROR_CODES.has(status);
  }

  return {
    getProviderBreaker,
    configureProviderBreaker,
    isProviderInCooldown,
    getProviderCooldownRemainingMs,
    getProviderBreakerState,
    recordProviderFailure,
    recordProviderSuccess,
    clearProviderFailure,
    getProvidersInCooldown,
    isProviderFailureCode,
  };
}
