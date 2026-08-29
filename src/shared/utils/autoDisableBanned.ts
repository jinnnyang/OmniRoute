/**
 * Auto-disable on permanent ban signals.
 *
 * Login seats (paid subscriptions and free accounts) can be locked by the
 * upstream if OmniRoute keeps retrying after a ToS / "verify your account"
 * 403. Paid prepaid API keys do not have that failure mode: a 429 is a
 * cooldown and an empty wallet is a failover, not a reason to flip
 * isActive=false.
 *
 * Per-provider and per-account overrides are the durable design. This helper
 * is the global first cut: all connections vs login-style connections only.
 */

export const AUTO_DISABLE_BANNED_SCOPES = ["all", "subscription"] as const;
export type AutoDisableBannedScope = (typeof AUTO_DISABLE_BANNED_SCOPES)[number];

const API_KEY_AUTH_TYPES = new Set(["apikey", "api_key"]);
const SUBSCRIPTION_AUTH_TYPES = new Set(["oauth", "cookie", "access_token", "session", "web"]);

export function normalizeAutoDisableBannedScope(value: unknown): AutoDisableBannedScope {
  return value === "subscription" ? "subscription" : "all";
}

export function isApiKeyAuthType(authType: string | null | undefined): boolean {
  return API_KEY_AUTH_TYPES.has(
    String(authType || "")
      .trim()
      .toLowerCase()
  );
}

export function isSubscriptionAuthType(authType: string | null | undefined): boolean {
  return SUBSCRIPTION_AUTH_TYPES.has(
    String(authType || "")
      .trim()
      .toLowerCase()
  );
}

export function isSubscriptionStyleConnection(input: {
  authType?: string | null;
  providerId?: string | null;
}): boolean {
  if (isSubscriptionAuthType(input.authType)) return true;
  if (isApiKeyAuthType(input.authType)) return false;
  // Unknown auth types keep today's conservative behavior.
  return true;
}

export function shouldAutoDisableBannedConnection(input: {
  enabled?: boolean | null;
  scope?: unknown;
  authType?: string | null;
  providerId?: string | null;
}): boolean {
  if (!input.enabled) return false;
  if (normalizeAutoDisableBannedScope(input.scope) === "all") return true;
  return isSubscriptionStyleConnection(input);
}
