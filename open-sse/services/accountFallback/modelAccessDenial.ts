/**
 * accountFallback/modelAccessDenial.ts — bad-request (400) model-access
 * classification for the account-fallback engine.
 *
 * Cluster C extraction from `services/accountFallback.ts` (file-size-baseline
 * gate): the structured error-code sets and text patterns that decide whether
 * a 400 is model-access-denied / malformed / parameter-validation — plus the
 * shared `getMsUntilTomorrow` daily-quota lock helper. Pure functions with no
 * import back into `accountFallback.ts` (no circular dependency — see
 * `npm run check:cycles`), following the same leaf-module pattern as
 * `exactModelLock.ts`.
 *
 * @module services/accountFallback/modelAccessDenial
 */

import {
  AUTH_CREDENTIAL_ERROR_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  MODEL_ACCESS_DENIED_PATTERNS,
} from "../errorClassifier.ts";

// Structured error codes that reliably indicate model access denied
// (more reliable than regex on human-readable messages).
// OpenAI:  { error: { code: "model_not_found", ... } }
// Anthropic: { error: { type: "not_found_error", ... } }
const MODEL_ACCESS_DENIED_CODES = new Set([
  "model_not_found", // OpenAI, OpenAI-compatible (Kiro, Together, Fireworks, etc.)
  "deployment_not_found", // Azure OpenAI
]);

const MODEL_ACCESS_DENIED_TYPES = new Set([
  "not_found_error", // Anthropic: model doesn't exist — reliably model-scoped
]);

// Anthropic's permission_error is NOT exclusively model-access related: it also
// covers API-key scope, organization restrictions and feature gating. Treating it
// as model-access-denied unconditionally would make a genuinely auth-restricted key
// silently exhaust every combo target and hide the real error from the caller.
// So it only counts when the message text confirms it refers to the model.
const MODEL_ACCESS_AMBIGUOUS_TYPES = new Set([
  "permission_error", // Anthropic: could be model access OR key/org/feature scope
]);

// Malformed request patterns — the model rejected the message format but a different
// provider/model in the combo may accept it.
const MALFORMED_REQUEST_PATTERNS = [
  /\bimproperly formed request\b/i,
  /\binvalid.*message.*format/i,
  /\bmessages must alternate\b/i,
  /\bempty (message|content)\b/i,
  // Tool call function name errors
  /\bfunction'?s? name (?:can't|can not|is|has) (?:blank|empty|missing)/i,
  /function.*name.*(?:blank|empty|missing)/i,
  /tool_call.*name.*(?:blank|empty|missing)/i,
];

// Parameter validation errors — model-specific constraints (different models = different limits)
const PARAM_VALIDATION_PATTERNS = [
  /max_tokens.*illegal/i,
  /max_tokens.*must be/i,
  /max_tokens.*range/i,
  /parameter is illegal/i,
  /is illegal.*range/i,
];

export type StructuredError = { code?: string | null; type?: string | null } | null | undefined;

/** Bad-request classification outcome for the 400 branch of checkFallbackError. */
export type BadRequestClassification =
  "model_access_denied" | "malformed" | "param_validation" | null;

/**
 * Classify a 400 error as model-access-denied / malformed / parameter-validation,
 * or null when it is none of those (a generic bad request — not fallback-worthy).
 *
 * Mirrors the inline logic previously in `checkFallbackError`:
 *  1. Structured error codes/types take priority (more reliable, no false positives).
 *  2. A clear bad-credential error must never be reclassified as model-access
 *     (which would silently exhaust every combo target) — text patterns are
 *     gated on `!looksLikeAuthCredentialError`.
 *  3. Ambiguous structured types (e.g. Anthropic permission_error) only count as
 *     model-access denial when the message text confirms it is about the model.
 *
 * Context-overflow shares the MALFORMED bucket (both are zero-cooldown
 * MODEL_CAPACITY fallbacks). NIM-degraded detection is NOT part of this
 * module — it stays inline in checkFallbackError via isNimFunctionDegraded.
 */
export function classifyBadRequest400(
  errorStr: string,
  structuredError: StructuredError
): BadRequestClassification {
  const structuredCode =
    typeof structuredError?.code === "string" ? structuredError.code.toLowerCase() : "";
  const structuredType =
    typeof structuredError?.type === "string" ? structuredError.type.toLowerCase() : "";
  // A clear bad-credential error must never be reclassified as model-access
  // (which would silently exhaust every combo target). Structured detection
  // below still catches genuine model_not_found / not_found_error codes.
  const looksLikeAuthCredentialError = AUTH_CREDENTIAL_ERROR_PATTERNS.some((p) => p.test(errorStr));
  const matchesModelAccessPattern =
    !looksLikeAuthCredentialError && MODEL_ACCESS_DENIED_PATTERNS.some((p) => p.test(errorStr));

  const isModelAccessDeniedStructured =
    !!structuredError &&
    (MODEL_ACCESS_DENIED_CODES.has(structuredCode) ||
      MODEL_ACCESS_DENIED_TYPES.has(structuredType) ||
      // Ambiguous types (e.g. Anthropic permission_error) only count as a model
      // access denial when the message text confirms it is about the model.
      (MODEL_ACCESS_AMBIGUOUS_TYPES.has(structuredType) && matchesModelAccessPattern));

  if (isModelAccessDeniedStructured || matchesModelAccessPattern) {
    return "model_access_denied";
  }
  // Context-overflow shares the MALFORMED bucket: both are zero-cooldown
  // MODEL_CAPACITY fallbacks, so collapsing them preserves checkFallbackError's
  // behavior exactly (its 400 branch only needs to know "any of these hit?").
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorStr))) {
    return "malformed";
  }
  if (MALFORMED_REQUEST_PATTERNS.some((p) => p.test(errorStr))) {
    return "malformed";
  }
  if (PARAM_VALIDATION_PATTERNS.some((p) => p.test(errorStr))) {
    return "param_validation";
  }
  return null;
}

// ─── Daily Quota Helpers ────────────────────────────────────────────────────

/**
 * Calculate milliseconds from now until tomorrow at midnight (00:00:00).
 * Used to lock a model until the next day when daily quota is exhausted.
 * @returns {number} Milliseconds until tomorrow
 */
export function getMsUntilTomorrow(): number {
  const nowMs = Date.now();
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const ms = tomorrow.getTime() - nowMs;
  // Guard against DST edge cases: if ms is negative (shouldn't happen) or
  // unreasonably large (>25h due to spring-forward), cap at 24 hours.
  return ms > 0 && ms <= 25 * 60 * 60 * 1000 ? ms : 24 * 60 * 60 * 1000;
}
