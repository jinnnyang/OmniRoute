import { HTTP_STATUS, RateLimitReason } from "../config/constants.ts";
import { matchErrorRuleByText } from "../config/errorConfig.ts";
import { getProviderErrorRuleMatch } from "../config/providerErrorRules.ts";
import { getProviderCategory, getRegistryEntry } from "../config/providerRegistry.ts";
import { looksLikeQuotaExhausted } from "../../src/shared/utils/classify429";
import { isSubscriptionQuotaText } from "./quotaTextCooldowns.ts";

// ─── Error Classification (migrated from accountFallback.ts, cluster A) ─────

type RateLimitReasonValue = (typeof RateLimitReason)[keyof typeof RateLimitReason];

// T06 (sub2api PR #1037): Signals that indicate permanent account deactivation.
// When a 401 body contains these strings, the account is permanently dead
// and should NOT be retried after token refresh.
export const ACCOUNT_DEACTIVATED_SIGNALS = [
  "account_deactivated",
  "account has been deactivated",
  "account has been disabled",
  "your account has been suspended",
  "this account is deactivated",
  // AG (Antigravity/Google Cloud Code) permanent ban signals
  "verify your account to continue",
  "this service has been disabled in this account for violation",
  "this service has been disabled in this account",
];

// Custom banned signals — loaded from DB settings at runtime.
// Combined with ACCOUNT_DEACTIVATED_SIGNALS in isAccountDeactivated().
let _customBannedSignals: string[] = [];

export function setCustomBannedSignals(signals: string[]): void {
  _customBannedSignals = signals;
}

export function getMergedBannedSignals(): string[] {
  if (_customBannedSignals.length === 0) return ACCOUNT_DEACTIVATED_SIGNALS;
  return [...ACCOUNT_DEACTIVATED_SIGNALS, ..._customBannedSignals];
}

// T10 (sub2api PR #1169): Signals that indicate billing credits are exhausted.
// Distinct from rate-limit 429 — the account won't recover until credits are added.
export const CREDITS_EXHAUSTED_SIGNALS = [
  "insufficient_quota",
  "billing_hard_limit_reached",
  "exceeded your current quota",
  "exceeded your current usage quota",
  "credit_balance_too_low",
  "your credit balance is too low",
  "credits exhausted",
  "out of credits",
  "payment required",
  "free tier of the model has been exhausted",
  // #8631: narrower than a bare "has been exhausted" — that generic phrase also
  // appears in Gemini's transient RPM/TPM 429 body ("Resource has been exhausted
  // (e.g. check quota)."), which must stay RATE_LIMIT_EXCEEDED, not terminal.
  // Anchoring on "tier" keeps free-tier depletion wording matched while excluding
  // Gemini's "resource has been exhausted" rate-limit phrasing.
  "tier has been exhausted",
  // #5239: providers (e.g. DeepSeek/GLM-style) return "Insufficient account balance"
  // on a depleted key. 402 is already terminalized by status, but catch non-402
  // out-of-credit bodies here too.
  "insufficient balance",
  "insufficient_balance",
  "insufficient account balance",
  "insufficient credit balance",
  // Command Code returns 400 "You have insufficient credits to make this
  // request. Please purchase more credits to continue using the service."
  // when the account's billing credits run out. Without this signal the
  // error stays unclassified (errorType=null), so the connection is never
  // marked credits_exhausted and keeps being re-selected on every request.
  "insufficient credits",
  "insufficient credit",
];

// T11: Signals that indicate OAuth token is invalid/expired (not permanent deactivation)
export const OAUTH_INVALID_TOKEN_SIGNALS = [
  "invalid authentication credentials",
  "oauth 2",
  "login cookie",
  "valid authentication credential",
  "invalid credentials",
];

// Context overflow patterns — the prompt exceeds the model's maximum context length.
// Different providers phrase this differently. Used to decide whether a 400 error
// should trigger combo fallback (a different model may have a larger context window).
// Exported so combo.ts's isContextOverflow400() guard (open-sse/services/combo.ts)
// can reuse this single source of truth instead of maintaining its own,
// independently-drifting pattern list (see issue #6637).
export const CONTEXT_OVERFLOW_PATTERNS = [
  /\binput is too long\b/i,
  /\binput too long\b/i,
  /\bcontext.*(too long|exceeded|overflow|limit)/i,
  /\btoo many tokens\b/i,
  /\bprompt is too long\b/i,
  /\bcontext window/i,
  /\bmaximum context/i,
  /\bmax.*token/i,
  /\btoken limit/i,
  /\brequest too large\b/i,
];

// Model access patterns — the account does not have access to the requested model
// but a different account (e.g. PRO vs free tier) may support it.
// Exported so combo.ts #2101 can exempt model-scoped 400s from the body-specific
// stop guard (#5249): "model not supported" must advance to the next combo target
// even when the message also contains wrapper words like "invalid" / "bad request".
export const MODEL_ACCESS_DENIED_PATTERNS = [
  /\binvalid model\b/i,
  /\bmodel.*not.*(?:available|found|supported|accessible)\b/i,
  /\bmodel.*(?:does not exist|doesn't exist)\b/i,
  // "does not support" / "unsupported model" — GitHub Copilot / OpenAI-compatible
  // often phrase model rejection this way without the "is not supported" word order.
  /\bmodel\b[\s\S]{0,80}?\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b/i,
  /\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b[\s\S]{0,80}?\bmodel\b/i,
  /\bunsupported\s+model\b/i,
  /\baccess.*denied.*model\b/i,
  /\bmodel.*access.*denied\b/i,
  /\bplease select a different model\b/i,
  // "...access to the requested model" / "model ... access" — bounded lookahead
  // (no nested quantifiers) so it stays ReDoS-safe while requiring BOTH an
  // access/permission word and "model" so a pure auth error never matches.
  /\b(?:access|permission)[\s\S]{0,60}?\bmodel\b/i,
  /\bmodel[\s\S]{0,60}?\b(?:access|permission)\b/i,
];

// Pure credential/authentication failures — the key or token itself is bad, which
// is NOT a model-availability problem. Some providers phrase these as a 400 that
// also mentions the model (e.g. "invalid api key for model X"), which would
// otherwise trip MODEL_ACCESS_DENIED_PATTERNS above and trigger combo fallback
// across every target, masking the real "fix your credential" error. When the
// text clearly indicates a bad credential, the regex-based model-access detection
// is suppressed (structured codes/types like model_not_found are unaffected).
export const AUTH_CREDENTIAL_ERROR_PATTERNS = [
  /\b(?:invalid|incorrect|expired|missing|revoked)\s+api[\s_-]?key\b/i,
  /\bapi[\s_-]?key\s+(?:is\s+)?(?:invalid|incorrect|expired|missing|revoked|not\s+valid)\b/i,
  /\bauthentication\s+(?:failed|error|required)\b/i,
  /\b(?:invalid|expired|missing|revoked)\s+(?:token|credentials?|bearer)\b/i,
  /\bunauthorized\b/i,
  /\bnot\s+authenticated\b/i,
];

// #10460: strict subset of MODEL_ACCESS_DENIED_PATTERNS that is unambiguously
// PROVIDER-wide — the model does not exist / is not served by this provider at all, so
// no account of that provider could serve it (e.g. "The requested model is not
// supported", "model not found"). Deliberately EXCLUDES the "access"/"permission"
// patterns from MODEL_ACCESS_DENIED_PATTERNS (e.g. "does not have permission to access
// this model", "access denied ... model"): those commonly indicate an ACCOUNT-scoped
// entitlement gap (e.g. PRO vs free tier) where a *different* account of the same
// provider may still have access, so they must keep rotating through the normal
// account-cooldown path — not be treated as provider-wide unsupported.
const PROVIDER_MODEL_UNSUPPORTED_PATTERNS = [
  /\binvalid model\b/i,
  /\bmodel.*not.*(?:available|found|supported|accessible)\b/i,
  /\bmodel.*(?:does not exist|doesn't exist)\b/i,
  /\bmodel\b[\s\S]{0,80}?\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b/i,
  /\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b[\s\S]{0,80}?\bmodel\b/i,
  /\bunsupported\s+model\b/i,
  /\bplease select a different model\b/i,
];

/**
 * #10460: is this 400 an unambiguous, PROVIDER-wide "model not supported" response —
 * i.e. would retrying a *different account* of the same provider also fail for the
 * same reason? Reuses AUTH_CREDENTIAL_ERROR_PATTERNS (the same bad-credential
 * exclusion `checkFallbackError`'s 400 branch applies) so a message like "invalid api
 * key for model X" is never misclassified as model-wide. Also excludes the broader,
 * ambiguous MODEL_ACCESS_DENIED_PATTERNS access/permission phrasing — those can be
 * account-scoped entitlement gaps, not a provider-wide unsupported model — so account
 * rotation for those keeps working normally via the regular cooldown path.
 *
 * Callers that want "should combo keep trying other targets" (not "should this
 * specific account keep rotating") should use MODEL_ACCESS_DENIED_PATTERNS /
 * isModelScoped400() instead — this helper is deliberately narrower.
 */
export function isProviderModelUnsupported400(status: number, errorText: string): boolean {
  if (status !== HTTP_STATUS.BAD_REQUEST) return false;
  if (AUTH_CREDENTIAL_ERROR_PATTERNS.some((p) => p.test(errorText))) return false;
  return PROVIDER_MODEL_UNSUPPORTED_PATTERNS.some((p) => p.test(errorText));
}

// Rate-limit text on a 400 — some providers (e.g. MiMoCode) signal throttling with a
// non-standard 400 status whose body carries rate-limit semantics instead of a 429
// (#4976). When detected, the request is fallback-worthy at connection-cooldown scope
// (NOT a whole-provider breaker) so combo routing can fail over to another free target.
// Exported: mimocode.ts's executor reuses this list directly (single source of truth).
export const RATE_LIMIT_TEXT_PATTERNS = [
  /high.?frequency/i,
  /non-compliant/i,
  /too many requests/i,
  /rate.?limit/i,
  /频繁/, // "frequent" (zh) — high-frequency request throttling
  /频率/, // "frequency" (zh) — request-frequency throttling
];

// #4 (bad taste scan): the three signal-classifiers below were byte-for-byte
// isomorphic (lowercase + .some(include)) — deduped through matchesAnySignal.
function matchesAnySignal(lower: string, signals: readonly string[]): boolean {
  return signals.some((sig) => lower.includes(sig));
}

/**
 * T06: Returns true if response body indicates the account is permanently deactivated.
 */
export function isAccountDeactivated(errorText: string): boolean {
  const lower = String(errorText || "").toLowerCase();
  return matchesAnySignal(lower, getMergedBannedSignals());
}

/**
 * T10: Returns true if response body indicates credits/quota are permanently exhausted.
 */
export function isCreditsExhausted(errorText: string): boolean {
  const lower = String(errorText || "").toLowerCase();
  return matchesAnySignal(lower, CREDITS_EXHAUSTED_SIGNALS);
}

/**
 * T11: Returns true if response body indicates OAuth token is invalid/expired.
 * This is different from permanent account deactivation - token refresh can recover.
 */
export function isOAuthInvalidToken(errorText: string): boolean {
  const lower = String(errorText || "").toLowerCase();
  return matchesAnySignal(lower, OAUTH_INVALID_TOKEN_SIGNALS);
}

/**
 * Classify error text into RateLimitReason
 */
export function classifyErrorText(errorText: unknown): RateLimitReasonValue {
  if (!errorText) return RateLimitReason.UNKNOWN;
  const lower = String(errorText).toLowerCase();

  if (
    lower.includes("quota exceeded") ||
    lower.includes("quota depleted") ||
    lower.includes("quota will reset") ||
    lower.includes("your quota will reset") ||
    lower.includes("quota has been exceeded") ||
    lower.includes("hour quota") ||
    lower.includes("billing") ||
    looksLikeQuotaExhausted(lower) ||
    // Issue #2321: Anthropic OAuth (Claude Code Pro/Team) 429 bodies surface
    // the subscription quota with phrases that contain neither "quota" nor
    // "billing". Without these patterns the error was classified as a
    // transient RATE_LIMIT_EXCEEDED (~5s base cooldown), which cascades all
    // Pro accounts into a tight retry loop until the 5h window resets.
    isSubscriptionQuotaText(lower)
  ) {
    return RateLimitReason.QUOTA_EXHAUSTED;
  }
  // T10: credits_exhausted signals
  if (isCreditsExhausted(lower)) {
    return RateLimitReason.QUOTA_EXHAUSTED;
  }
  // T06: account_deactivated signals
  if (isAccountDeactivated(lower)) {
    return RateLimitReason.AUTH_ERROR;
  }
  const configuredRule = matchErrorRuleByText(errorText);
  if (configuredRule?.reason) return configuredRule.reason;
  if (lower.includes("rate_limit")) return RateLimitReason.RATE_LIMIT_EXCEEDED;
  if (lower.includes("resource exhausted") || lower.includes("high demand"))
    return RateLimitReason.MODEL_CAPACITY;
  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return RateLimitReason.AUTH_ERROR;
  }
  if (lower.includes("server error") || lower.includes("internal error")) {
    return RateLimitReason.SERVER_ERROR;
  }
  return RateLimitReason.UNKNOWN;
}

/**
 * Classify HTTP status + error text into RateLimitReason
 *
 * If context (provider, headers, body) is supplied, provider-specific rules
 * are evaluated FIRST. A provider like Opencode can signal account-wide quota
 * exhaustion via `x-ratelimit-remaining-requests: 0` even when the body says
 * "rate limit" — without context, classifyError falls through to the global
 * text rules and misclassifies as RATE_LIMIT_EXCEEDED. With context, the
 * provider rule takes precedence.
 */
export function classifyError(
  status: number,
  errorText: unknown,
  context?: { provider?: string | null; headers?: Record<string, string> | null; body?: unknown }
): RateLimitReasonValue {
  // Provider-specific rules take priority — they have the most accurate signal
  // (e.g. `x-ratelimit-remaining-requests: 0` is irrefutable account exhaustion).
  if (context?.provider) {
    const match = getProviderErrorRuleMatch(
      context.provider,
      status,
      context.headers ?? null,
      context.body
    );
    if (match) return match.reason;
  }

  // Text classification takes priority (more specific)
  const textReason = classifyErrorText(errorText);
  if (textReason !== RateLimitReason.UNKNOWN) return textReason;

  // Fall back to status code
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
    return RateLimitReason.AUTH_ERROR;
  }
  if (status === HTTP_STATUS.PAYMENT_REQUIRED) {
    return RateLimitReason.QUOTA_EXHAUSTED;
  }
  if (status === HTTP_STATUS.RATE_LIMITED) {
    return RateLimitReason.RATE_LIMIT_EXCEEDED;
  }
  if (status === HTTP_STATUS.SERVICE_UNAVAILABLE || status === 529) {
    return RateLimitReason.MODEL_CAPACITY;
  }
  if (status >= 500) {
    return RateLimitReason.SERVER_ERROR;
  }
  return RateLimitReason.UNKNOWN;
}

/**
 * Check if error text indicates daily quota exhaustion (as opposed to rate limiting).
 * Daily quota errors typically mention "today's quota" or "try again tomorrow".
 * @param {string} errorText - Error message text
 * @returns {boolean} True if daily quota is exhausted
 */
export function isDailyQuotaExhausted(errorText: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return (
    lower.includes("today's quota") ||
    lower.includes("daily quota") ||
    lower.includes("try again tomorrow")
  );
}

// Terminal stop signals where an empty content payload is still a legitimate,
// successful completion (truncated at the token limit, or a tool-call turn) —
// NOT a silent "fake success" failure. Used to avoid rewriting a valid HTTP 200
// (e.g. a Claude Code `max_tokens: 1` connectivity ping) into a synthetic 502.
const LEGIT_EMPTY_CLAUDE_STOP = new Set(["max_tokens", "tool_use"]);
const LEGIT_EMPTY_OPENAI_FINISH = new Set(["length", "tool_calls", "content_filter"]);

export function isEmptyContentResponse(responseBody: unknown): boolean {
  if (!responseBody || typeof responseBody !== "object") return false;

  const body = responseBody as Record<string, unknown>;

  if (Array.isArray(body.choices)) {
    const firstChoice = body.choices[0] as Record<string, unknown> | undefined;
    if (!firstChoice) return true;

    const message = firstChoice.message as Record<string, unknown> | undefined;
    const delta = firstChoice.delta as Record<string, unknown> | undefined;

    const content = message?.content ?? delta?.content;
    const reasoningContent = message?.reasoning_content ?? delta?.reasoning_content;
    // opencode-routed gateways (e.g. opencode/mimo-v2.5-free) name the reasoning
    // field `reasoning` instead of `reasoning_content` (#6623).
    const reasoningAlt = message?.reasoning ?? delta?.reasoning;
    const hasToolCalls =
      (Array.isArray(message?.tool_calls) && (message.tool_calls as unknown[]).length > 0) ||
      (Array.isArray(delta?.tool_calls) && (delta.tool_calls as unknown[]).length > 0);

    const hasContent = content !== null && content !== undefined && content !== "";
    const hasReasoning =
      (reasoningContent !== null && reasoningContent !== undefined && reasoningContent !== "") ||
      (reasoningAlt !== null && reasoningAlt !== undefined && reasoningAlt !== "");

    // A response truncated at the token limit (finish_reason "length") is a valid,
    // successful completion even with empty text — do not flag it as a fake success.
    const finishReason =
      typeof firstChoice.finish_reason === "string" ? firstChoice.finish_reason : "";
    if (LEGIT_EMPTY_OPENAI_FINISH.has(finishReason)) return false;

    return !hasContent && !hasReasoning && !hasToolCalls;
  }

  if (Array.isArray(body.content)) {
    if (body.content.length > 0) return false;
    // Empty content array: a response truncated at max_tokens (or one that stopped
    // to emit a tool_use block) is a legitimate terminal state, not a silent
    // failure. Only flag empty content when no such terminal stop_reason is present.
    const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : "";
    return !LEGIT_EMPTY_CLAUDE_STOP.has(stopReason);
  }

  if (typeof body.text === "string") {
    return body.text.trim() === "";
  }

  if ("content" in body) {
    const content = body.content;
    return content === null || content === undefined || content === "";
  }

  return false;
}

export const PROVIDER_ERROR_TYPES = {
  RATE_LIMITED: "rate_limited",
  UNAUTHORIZED: "unauthorized",
  ACCOUNT_DEACTIVATED: "account_deactivated",
  FORBIDDEN: "forbidden",
  SERVER_ERROR: "server_error",
  QUOTA_EXHAUSTED: "quota_exhausted",
  PROJECT_ROUTE_ERROR: "project_route_error",
  CONTEXT_OVERFLOW: "context_overflow",
  OAUTH_INVALID_TOKEN: "oauth_invalid_token",
  EMPTY_CONTENT: "empty_content",
  MODEL_NOT_FOUND: "model_not_found",
  FINGERPRINT_REJECTION: "fingerprint_rejection",
  GEO_BLOCKED: "geo_blocked",
  // Antigravity BYOP fast-fail (executor 422, code gcp_project_required): the
  // Google account must Bring Its Own GCP Project. Account-specific and
  // fixable by entering a Project ID — never a model lockout and never a ban.
  GCP_PROJECT_REQUIRED: "gcp_project_required",
};

export const CONTEXT_OVERFLOW_SIGNALS = [
  "context overflow",
  "prompt too large",
  "context window",
  "maximum context",
  "exceeds context",
  "input too long",
  "token limit",
  "too many tokens",
  "context length",
  "exceed.*context",
  "messages exceed",
];

export const CONTEXT_OVERFLOW_REGEX = new RegExp(CONTEXT_OVERFLOW_SIGNALS.join("|"), "i");

export function isContextOverflow(errorText: string): boolean {
  return CONTEXT_OVERFLOW_REGEX.test(String(errorText || ""));
}

// Matches phrasing like `Model minimax-m3-free is not supported` or
// `model "gpt-9" is not supported` — free-tier/aggregator providers name the
// specific model in the sentence instead of using a fixed fragment like
// "model not supported". Shared by modelFamilyFallback.ts's
// isModelUnavailableError() (400/403/404) and this module's 401 branch below,
// so the same phrasing locks the model out on either status. Bounded
// quantifier ({0,80}) keeps it ReDoS-safe. (#7268)
const MODEL_NAMED_UNSUPPORTED_REGEX = /\bmodel\b[^\n]{0,80}\bis not supported\b/i;

export function containsModelUnavailableMessage(errorMessage: string): boolean {
  return MODEL_NAMED_UNSUPPORTED_REGEX.test(String(errorMessage || "").toLowerCase());
}

// Google regional-availability rejection: the Cloud Code / Gemini Code Assist
// API is not offered from every country, and the upstream answers with a 400
// FAILED_PRECONDITION like "User location is not supported for the API use."
// This is an ACCOUNT-INDEPENDENT, location-scoped refusal: every account on
// this server egresses from the same region, so retrying another credential
// cannot help — but routing egress through a proxy in a supported region can.
// Detected here so routing treats it as a non-terminal, cached-per-connection
// exclusion instead of a generic 400 (which would keep re-selecting the same
// account and surface a cryptic "upstream error (400)").
const GEO_BLOCK_SIGNALS = [
  "user location is not supported",
  "location is not supported",
  "not supported for the api use",
  "region is not supported",
  "unsupported location",
  "not available in your location",
  "not available in your region",
];

export function isGeoBlockedError(errorMessage: string): boolean {
  const lower = String(errorMessage || "").toLowerCase();
  return GEO_BLOCK_SIGNALS.some((signal) => lower.includes(signal));
}

// Providers whose upstream surface emits Google's regional-availability
// refusal (GEO_BLOCK_SIGNALS above): Cloud Code / Gemini Code Assist — the
// antigravity executor (antigravity, agy) — and the Gemini Developer API
// (generativelanguage.googleapis.com; gemini, vertex). The gate matters
// because classifyProviderError is shared across every provider: an unrelated
// upstream returning a lookalike "not available in your region" must NOT be
// classified as an egress-fixable geo block, or it would get the non-terminal
// 24h exclusion treatment instead of that provider's own (possibly terminal)
// path.
function isGeoBlockEligibleProvider(provider?: string | null): boolean {
  const p = (provider || "").toLowerCase();
  if (
    p === "antigravity" ||
    p === "agy" ||
    p === "gemini" ||
    p === "gemini-cli" ||
    p === "vertex"
  ) {
    return true;
  }
  if (p.includes("cloudcode") || p.includes("cloud-code")) return true;
  // Registry-driven fallback: any provider whose upstream surface is the Cloud
  // Code API (executor/format "antigravity") or the Gemini API (format
  // "gemini") stays eligible even when a new provider id is added later.
  if (!provider) return false;
  const entry = getRegistryEntry(provider);
  if (!entry) return false;
  const surface = `${entry.executor || ""} ${entry.format || ""}`.toLowerCase();
  return surface.includes("antigravity") || surface.includes("gemini");
}

// Cloudflare 1010 "Access denied ... blocked based on your browser's signature" —
// a fingerprint/browser-like rejection issued by the CDN in front of an upstream
// (e.g. opencode.ai/zen/v1), carrying error_code 1010 or error_name
// "browser_signature_banned". Distinct from an auth 403: the account is healthy,
// the CLIENT's TLS/UA signature was refused.
//
// IMPORTANT: the bare number 1010 is NOT matched on its own — a 403 body can
// legitimately contain "1010" as a port, count, request id, or model token
// ("model foo-1010 is not supported", "retry after 1010 seconds"). 1010 is only
// treated as a fingerprint rejection when it appears with an explicit Cloudflare
// key (`error_code` / `error-code`) or the unique `browser_signature_banned` /
// `fingerprint_rejection` tokens. `\\?` tolerates the escaped-quote form that
// appears when the upstream body is nested inside the gateway's error.message JSON.
const CLOUDFLARE_1010_REGEX =
  /(?<![A-Za-z0-9_-])error[\s_-]?code[\\"':=\s]{0,12}1010(?!\w)|(?<![A-Za-z0-9_-])error[-_]\s?1010(?!\w)\/?/i;

export function isCloudflareFingerprintRejection(errorText: string): boolean {
  const text = String(errorText || "").toLowerCase();
  return (
    CLOUDFLARE_1010_REGEX.test(text) ||
    text.includes("browser_signature_banned") ||
    text.includes("fingerprint_rejection")
  );
}

function responseBodyToString(responseBody: unknown): string {
  if (typeof responseBody === "string") return responseBody;
  if (responseBody !== null && typeof responseBody === "object") {
    try {
      return JSON.stringify(responseBody);
    } catch {
      return "";
    }
  }
  return "";
}

// A provider can return 404 for request-scoped resources (Files API ids,
// response items, uploads, etc.). These failures describe the request payload,
// not provider/model health. Keep every expression bounded to avoid ReDoS on
// upstream-controlled error bodies.
const RESOURCE_NOT_FOUND_PATTERNS = [
  /\bfiles?\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
  /\b(?:not found|does not exist)\b[^\n]{0,160}\bfiles?\b/i,
  /\b(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
  /\b(?:not found|does not exist)\b[^\n]{0,160}\b(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)\b/i,
  /\bfile-[a-z0-9_-]+\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
];

/**
 * Whether an upstream error identifies a missing request-scoped resource.
 *
 * Resource signals intentionally take precedence over an outer
 * `code: "model_not_found"` because compatibility layers may synthesize that
 * code from the HTTP status before preserving the upstream file error.
 */
export function isResourceNotFoundResponse(responseBody: unknown): boolean {
  const body = responseBodyToString(responseBody);
  return RESOURCE_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(body));
}

function shouldPreserveQuotaSignalsFor429(provider?: string | null): boolean {
  if (!provider) return true;
  return getProviderCategory(provider) === "oauth";
}

export function classifyProviderError(
  statusCode: number,
  responseBody: unknown,
  provider?: string | null
): string | null {
  const bodyStr = responseBodyToString(responseBody);
  const creditsExhausted = isCreditsExhausted(bodyStr);
  const subscriptionQuotaExhausted = isSubscriptionQuotaText(bodyStr.toLowerCase());
  const accountDeactivated = isAccountDeactivated(bodyStr);
  const oauthInvalid = isOAuthInvalidToken(bodyStr);
  const preserveQuota429 = shouldPreserveQuotaSignalsFor429(provider);

  if ((creditsExhausted || subscriptionQuotaExhausted) && [400, 402, 403].includes(statusCode)) {
    return PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED;
  }

  if ((creditsExhausted || subscriptionQuotaExhausted) && statusCode === 429 && preserveQuota429) {
    return PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED;
  }

  // API-key providers route 429 cooldowns through the resilience-aware fallback layer.
  // OAuth providers keep their existing quota semantics because some of them encode
  // longer quota windows as 429 responses.
  if (statusCode === 429) {
    if (preserveQuota429 && isDailyQuotaExhausted(bodyStr)) {
      return PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED;
    }
    return PROVIDER_ERROR_TYPES.RATE_LIMITED;
  }

  // 404 — model or endpoint not found. Without classification the error
  // falls through to `return null`, so no cooldown/lockout is applied and the
  // retry/backoff loop keeps hammering the dead endpoint until the upstream
  // rate-limits it (404 + 429 storm). Classify as MODEL_NOT_FOUND so the model
  // gets locked via the cooldown layer and retries stop. Request-scoped
  // resource errors are excluded because retrying another account/model cannot
  // make an unknown file/item id valid. (#6827)
  if (statusCode === 404) {
    if (isResourceNotFoundResponse(responseBody)) return null;
    return PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND;
  }

  if (statusCode === 401) {
    if (oauthInvalid) {
      return PROVIDER_ERROR_TYPES.OAUTH_INVALID_TOKEN;
    }
    // Some free-tier/aggregator providers return 401 (instead of 404) for a
    // model the account isn't entitled to, with a body like "Model X is not
    // supported". Without this check the error falls through to a generic
    // UNAUTHORIZED classification, which never triggers lockModel() in
    // chatCore.ts — auto-combo keeps re-selecting the same broken model on
    // every request. Detect the phrasing here, same as the 404 branch above
    // always does regardless of body content. (#7268)
    if (containsModelUnavailableMessage(bodyStr)) {
      return PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND;
    }
    return accountDeactivated
      ? PROVIDER_ERROR_TYPES.ACCOUNT_DEACTIVATED
      : PROVIDER_ERROR_TYPES.UNAUTHORIZED;
  }

  if (statusCode === 402) return PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED;

  // Google regional-availability refusal (400 FAILED_PRECONDITION "... location
  // is not supported ..."), scoped to the Google AI surfaces that emit it
  // (Cloud Code / Gemini Code Assist + Gemini Developer API — see
  // isGeoBlockEligibleProvider). Account-independent: every credential egresses
  // from the same server region, so fallback to another account cannot succeed
  // — but the connection must be cached as excluded so routing does not
  // re-select it on every request and surface a cryptic generic 400.
  // Non-terminal, like PROJECT_ROUTE_ERROR: the account becomes usable again
  // once egress is routed through a supported-region proxy.
  if (
    (statusCode === 400 || statusCode === 403) &&
    isGeoBlockEligibleProvider(provider) &&
    isGeoBlockedError(bodyStr)
  ) {
    return PROVIDER_ERROR_TYPES.GEO_BLOCKED;
  }

  if (statusCode === 403 && isCloudflareFingerprintRejection(bodyStr)) {
    // Cloudflare 1010 / error_name "browser_signature_banned": the CDN in front of the
    // upstream (e.g. opencode.ai/zen/v1) rejected the CLIENT's TLS/UA signature, not the
    // account's credentials. It says nothing about account health — a different client on
    // the same key succeeds (measured 2026-08-08: curl 200, urllib 403 on byte-identical
    // body). Marking it FORBIDDEN would flow through markAccountUnavailable to the
    // terminal "banned" state and, after two such calls, flip the whole free pool to
    // ALL_ACCOUNTS_INACTIVE. Classify it separately so account state stays untouched.
    return PROVIDER_ERROR_TYPES.FINGERPRINT_REJECTION;
  }
  if (statusCode === 403 && accountDeactivated) {
    return PROVIDER_ERROR_TYPES.ACCOUNT_DEACTIVATED;
  }
  if (statusCode === 403) {
    // Cloud Code / Antigravity (Gemini Code Assist) 403s are almost always a
    // RECOVERABLE project-config issue — the Cloud AI Companion API not enabled
    // on the project ("has not been used in project …", SERVICE_DISABLED,
    // accessNotConfigured), a stale/mismatched project, or PERMISSION_DENIED on
    // the project — NOT an account ban. Real account bans are already caught by
    // isAccountDeactivated above (→ ACCOUNT_DEACTIVATED). Classifying these as
    // PROJECT_ROUTE_ERROR keeps the account active and recoverable once the
    // project/API is fixed, instead of permanently disabling it on a single
    // fixable 403 (which previously required a full OAuth reconnect). (antigravity-403)
    const p = (provider || "").toLowerCase();
    const isCloudCodeProvider =
      p === "antigravity" ||
      p === "gemini-cli" ||
      p.includes("cloudcode") ||
      p.includes("cloud-code");
    const recoverableProject403 =
      bodyStr.includes("has not been used in project") ||
      bodyStr.includes("SERVICE_DISABLED") ||
      bodyStr.includes("accessNotConfigured") ||
      bodyStr.includes("PERMISSION_DENIED") ||
      /\bit is disabled\b/i.test(bodyStr) ||
      isCloudCodeProvider;
    if (recoverableProject403) {
      return PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR;
    }
    // #8813 — ChatGPT Web's Cloudflare Sentinel/Turnstile 403 is a TERMINAL
    // block: the user's IP/session needs a browser Turnstile challenge, and
    // retrying the same connection will keep 403ing. Classify as FORBIDDEN so
    // the connection gets banned and combo routing falls back to other providers.
    // Must be checked BEFORE the generic apikey-403→null return below, which
    // is designed for normal API-key auth 403s that ARE recoverable.
    if (
      bodyStr.includes("SENTINEL_BLOCKED") ||
      /\bSentinel\b[^\n]{0,80}\bblocked\b/i.test(bodyStr) ||
      /\bTurnstile required\b/i.test(bodyStr)
    ) {
      return PROVIDER_ERROR_TYPES.FORBIDDEN;
    }

    if (provider && getProviderCategory(provider) === "apikey") {
      return null;
    }
    // No-credential ("authType: none") providers — free, stateless per-request
    // token proxies like mimocode/theoldllm — have no real account/credential
    // to revoke. An unrecognized 403 from these is a transient upstream
    // rate-limit/blocklist signal, not an account ban: keep it recoverable so
    // the connection cooldown/retry layer handles it instead of a permanent
    // "banned" state on the first unmatched 403. (#6315, #6345)
    if (provider && getRegistryEntry(provider)?.authType === "none") {
      return null;
    }
    return PROVIDER_ERROR_TYPES.FORBIDDEN;
  }
  if (statusCode >= 500) return PROVIDER_ERROR_TYPES.SERVER_ERROR;

  // Antigravity BYOP fast-fail (executor emits 422 with code
  // gcp_project_required when the Google account must Bring Its Own GCP
  // Project). Account-specific and fixable by entering a Project ID in the
  // dashboard — classified separately so chatCore rotates to sibling accounts
  // and excludes the connection instead of locking the model or banning it.
  if (statusCode === 422 && bodyStr.includes("gcp_project_required")) {
    return PROVIDER_ERROR_TYPES.GCP_PROJECT_REQUIRED;
  }

  if (statusCode === 400) {
    if (isContextOverflow(bodyStr)) {
      return PROVIDER_ERROR_TYPES.CONTEXT_OVERFLOW;
    }
    // Some providers (e.g. Antigravity's Pro-fallback chain, #8136) return a
    // plain 400 for a model that is no longer available, instead of 404/401.
    // Without this check the error falls through to `return null`, so
    // lockModel() never fires and the same dead model gets retried on every
    // request. Detect the phrasing here, same as the 401 branch above (#7268).
    if (containsModelUnavailableMessage(bodyStr)) {
      return PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND;
    }
  }

  return null;
}
