/**
 * retryCooldown.ts — cooldown computation for the account-fallback engine.
 *
 * Cluster B extraction from `services/accountFallback.ts` (file-size-baseline
 * gate): the four nested cooldown closures inside `checkFallbackError`
 * (`parseResetFromHeaders`, `getUpstreamRetryHintMs`, `getScaledBaseCooldown`,
 * `buildRetryableFallback`) plus the shared `getScaledCooldown` helper used by
 * the model-lockout path. All are pure functions parameterized over their
 * former closure context (profile / backoff level / headers / error text /
 * rotation), with no import back into `accountFallback.ts` (no circular
 * dependency — `npm run check:cycles`).
 *
 * `checkFallbackError` keeps thin adapter closures around these so its callers
 * (`buildSubscriptionQuotaFallback`, `resolveApiKeyForbiddenFallback`) receive
 * the same zero-arg / reason-arg callback shapes as before.
 *
 * @module services/retryCooldown
 */

import { BACKOFF_CONFIG, COOLDOWN_MS, RateLimitReason } from "../config/constants.ts";
import { capScaledCooldownMs } from "./accountFallback/cooldownCap.ts";
import * as rot from "./rotationConfig.ts";

type RateLimitReasonValue = (typeof RateLimitReason)[keyof typeof RateLimitReason];

/** The subset of ProviderProfile the cooldown math actually reads. Kept as a
 *  local structural type so this module never imports accountFallback.ts. */
export type CooldownProfile = {
  baseCooldownMs?: number | null;
  maxCooldownMs?: number | null;
  maxBackoffSteps?: number;
  useUpstreamRetryHints?: boolean;
};

export type CooldownRotation = { account?: unknown } | null | undefined;

/**
 * Parse an upstream reset hint from response headers: `Retry-After` (seconds or
 * HTTP date) or `X-RateLimit-Reset` (epoch seconds or ms). Returns an absolute
 * epoch ms timestamp, or null when no usable hint is present.
 */
export function parseResetFromHeaders(
  headers: Headers | Record<string, string> | null
): number | null {
  if (!headers) return null;
  const recordHeaders = headers as Record<string, string>;

  // Retry-After header
  const retryAfter =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : recordHeaders["retry-after"] || recordHeaders["Retry-After"];

  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && String(seconds) === String(retryAfter).trim()) {
      return Date.now() + seconds * 1000;
    }
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }

  // X-RateLimit-Reset
  const rlReset =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("x-ratelimit-reset")
      : recordHeaders["x-ratelimit-reset"] || recordHeaders["X-RateLimit-Reset"];

  if (rlReset) {
    const ts = Number.parseInt(rlReset, 10);
    if (!Number.isNaN(ts)) {
      return ts > 10000000000 ? ts : ts * 1000;
    }
  }
  return null;
}

/**
 * Upstream retry hint in ms, when the profile opts in (`useUpstreamRetryHints`).
 * Prefers the header-derived reset timestamp; falls back to a parseable retry
 * delay/ISO timestamp in the error text. Returns null when no hint applies.
 *
 * `parseRetryFromErrorText` is injected by the caller (accountFallback.ts)
 * because it is a public API exported from that file — importing it back here
 * would create a circular dependency.
 */
export function getUpstreamRetryHintMs(
  profile: CooldownProfile | null | undefined,
  headers: Headers | Record<string, string> | null,
  errorStr: string,
  parseRetryFromErrorText: (text: string) => number | null
): number | null {
  if (!profile?.useUpstreamRetryHints) return null;
  const resetTime = parseResetFromHeaders(headers);
  if (resetTime) {
    const waitMs = Math.max(resetTime - Date.now(), 0);
    if (waitMs > 0) return waitMs;
  }

  const retryFromErrorText = parseRetryFromErrorText(errorStr);
  if (retryFromErrorText && retryFromErrorText > 0) {
    return retryFromErrorText;
  }

  return null;
}

/**
 * Exponential cooldown from a base, bounded by `maxBackoffLevel`.
 * Level 1 => 1× base, level 2 => 2× base, level 3 => 4× base, …
 * ReDoS-safe and finite-guarded; a non-positive base falls back to 1000 ms.
 */
export function getScaledCooldown(
  baseCooldownMs: number,
  failureCount: number,
  maxBackoffLevel = BACKOFF_CONFIG.maxLevel
): number {
  const safeBase = Number.isFinite(baseCooldownMs) && baseCooldownMs > 0 ? baseCooldownMs : 1000;
  const exponent = Math.min(Math.max(0, failureCount - 1), Math.max(0, maxBackoffLevel));
  return safeBase * Math.pow(2, exponent);
}

/**
 * Scaled base cooldown for the connection-level retryable path: base from the
 * profile (or transientInitial default), exponentially scaled, then capped
 * against the profile's `maxCooldownMs` falling back to `BACKOFF_CONFIG.max`
 * (mirrors the model-lockout cap — #8396).
 */
export function getScaledBaseCooldown(
  profile: CooldownProfile | null | undefined,
  reason: RateLimitReasonValue,
  level: number,
  maxBackoffSteps: number
): { baseCooldownMs: number; cooldownMs: number; newBackoffLevel: number } {
  void reason;
  const baseCooldownMs =
    typeof profile?.baseCooldownMs === "number" && profile.baseCooldownMs >= 0
      ? profile.baseCooldownMs
      : COOLDOWN_MS.transientInitial;
  return {
    baseCooldownMs,
    cooldownMs: capScaledCooldownMs(
      getScaledCooldown(baseCooldownMs, level + 1, maxBackoffSteps),
      profile?.maxCooldownMs,
      BACKOFF_CONFIG.max
    ),
    newBackoffLevel: Math.min(level + 1, maxBackoffSteps),
  };
}

export type RetryableFallback = {
  shouldFallback: true;
  cooldownMs: number;
  baseCooldownMs: number;
  newBackoffLevel: number;
  usedUpstreamRetryHint: boolean;
  reason: string;
};

/** Execution context shared by the retryable-fallback builders. */
export type RetryCooldownContext = {
  profile: CooldownProfile | null | undefined;
  backoffLevel: number;
  maxBackoffSteps: number;
  headers: Headers | Record<string, string> | null;
  errorStr: string;
  rotation: CooldownRotation;
  /** Injected by the caller: accountFallback.ts's public `parseRetryFromErrorText`. */
  parseRetryFromErrorText: (text: string) => number | null;
};

/**
 * Build a retryable fallback result: an upstream retry hint wins outright
 * (newBackoffLevel resets to 0); otherwise a rotation override applies if one
 * is configured, else the scaled base cooldown advances the backoff level.
 */
export function buildRetryableFallback(
  ctx: RetryCooldownContext,
  reason: RateLimitReasonValue
): RetryableFallback {
  const upstreamRetryHintMs = getUpstreamRetryHintMs(
    ctx.profile,
    ctx.headers,
    ctx.errorStr,
    ctx.parseRetryFromErrorText
  );
  if (typeof upstreamRetryHintMs === "number" && upstreamRetryHintMs > 0) {
    return {
      shouldFallback: true,
      cooldownMs: upstreamRetryHintMs,
      baseCooldownMs: upstreamRetryHintMs,
      newBackoffLevel: 0,
      usedUpstreamRetryHint: true,
      reason,
    };
  }

  const ro = rot.overrideFor(reason, ctx.rotation?.account);
  if (ro) {
    return {
      shouldFallback: true,
      cooldownMs: ro.cooldownMs,
      baseCooldownMs: ro.baseCooldownMs,
      newBackoffLevel: ro.newBackoffLevel,
      usedUpstreamRetryHint: ro.usedUpstreamRetryHint,
      reason: ro.reason,
    };
  }
  const scaled = getScaledBaseCooldown(ctx.profile, reason, ctx.backoffLevel, ctx.maxBackoffSteps);
  return {
    shouldFallback: true,
    cooldownMs: scaled.cooldownMs,
    baseCooldownMs: scaled.baseCooldownMs,
    newBackoffLevel: scaled.newBackoffLevel,
    usedUpstreamRetryHint: false,
    reason,
  };
}
