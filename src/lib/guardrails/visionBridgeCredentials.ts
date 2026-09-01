/**
 * Shared provider-credential checks for the Vision Bridge guardrail.
 * Extracted from visionBridge.ts so visionBridgeRouter.ts can reuse the same
 * "is this connection actually usable" logic without a circular import
 * (visionBridge.ts already imports getBestVisionModel from visionBridgeRouter.ts).
 */

import { resolveProviderId } from "@/shared/constants/providers";
import { isNoAuthProviderKey } from "@/shared/utils/noAuthProviders";
import { getCircuitBreaker } from "@/shared/utils/circuitBreaker";
import { providerConnectionsDurablyUnhealthy } from "@/shared/utils/connectionHealth";
/**
 * True when a provider connection can actually authenticate upstream.
 * `noauth` with no real API key is NOT usable (opencode-zen free tier often
 * surfaces as noauth and then 401 "Missing API key").
 */
export type ProviderConnectionLike = {
  authType?: string | null;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  testStatus?: string | null;
};

const TERMINAL_CONNECTION_STATUSES = new Set(["disabled", "banned", "expired"]);
// Free/noauth only counts when a real key is still present; apikey/cookie need the same.
const KEY_ONLY_AUTH_TYPES = new Set(["noauth", "none", "", "apikey", "cookie"]);
const TOKEN_AUTH_TYPES = new Set(["oauth", "access_token", "external_idp"]);

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOAuthCredential(connection: ProviderConnectionLike): boolean {
  return (
    hasNonEmptyString(connection.refreshToken) ||
    hasNonEmptyString(connection.accessToken) ||
    hasNonEmptyString(connection.idToken)
  );
}

/** True when the connection row carries a terminal status (disabled/banned/expired). */
export function hasTerminalConnectionStatus(connection: ProviderConnectionLike): boolean {
  const status = String(connection.testStatus || "").toLowerCase();
  return TERMINAL_CONNECTION_STATUSES.has(status);
}

export function isProviderConnectionUsable(connection: ProviderConnectionLike): boolean {
  if (hasTerminalConnectionStatus(connection)) {
    return false;
  }

  const auth = String(connection.authType || "").toLowerCase();
  const hasKey = hasNonEmptyString(connection.apiKey);

  if (KEY_ONLY_AUTH_TYPES.has(auth)) {
    return hasKey;
  }
  if (TOKEN_AUTH_TYPES.has(auth)) {
    return hasOAuthCredential(connection) || hasKey;
  }
  return hasKey;
}

// Memoize the dynamic import itself (not just call it inline per-invocation).
// getVisionCapableModels() fans out to this function once per vision-capable
// catalog entry via Promise.all — tens of concurrent calls on every
// getBestVisionModel()/getFallbackModels() invocation. Issuing a fresh
// `await import(...)` per call means dozens of concurrent first-resolution
// import() calls for the *same* specifier land in the module loader at once;
// under Vitest/vite-node this observably races (some callers resolve against
// the mocked module, others against a real one loaded via a different
// resolution path such as readCache.ts's own relative `./providers` import —
// see tests/unit/guardrails/visionBridgeRouter.test.tsx). Resolving the
// import exactly once and reusing the settled module for every subsequent
// call removes the concurrent-first-load race entirely (and is strictly
// cheaper at runtime too — one module resolution instead of N).
let providersModulePromise: Promise<typeof import("@/lib/db/providers")> | null = null;
function loadProvidersModule(): Promise<typeof import("@/lib/db/providers")> {
  if (!providersModulePromise) {
    providersModulePromise = import("@/lib/db/providers");
  }
  return providersModulePromise;
}

/**
 * Candidate provider ids a `prefix/model` id may live under.
 *
 * Resolution is ID-based, in this order:
 *   1. the static alias→canonical id (`resolveProviderId`, #10702);
 *   2. the verbatim prefix (legacy rows sometimes store it directly);
 *   3. the operator-configured provider node that owns the prefix
 *      (`provider_nodes.prefix` → node id via `getProviderPrefixIndex()`),
 *      so `vcp/kimi-k2.7-code` resolves to the compatible node's connection
 *      row even though the node id is an internal UUID. The index only maps
 *      unique non-reserved winners, so a node can never shadow a built-in
 *      provider prefix.
 */
export interface PrefixNodeIndexLike {
  prefixToNode?: ReadonlyMap<string, string>;
}

export function resolveProviderIdsForModelPrefix(
  rawProvider: string,
  staticProviderId: string,
  prefixIndex?: PrefixNodeIndexLike | null
): string[] {
  const ids = new Set<string>();
  if (staticProviderId) ids.add(staticProviderId);
  if (rawProvider) ids.add(rawProvider);
  const nodeId = prefixIndex?.prefixToNode?.get(rawProvider);
  if (nodeId) ids.add(nodeId);
  return [...ids];
}

/**
 * Credential verdict for a `provider/model` id.
 *  - `keyed`:    at least one active connection with a real credential;
 *  - `noauth`:   no-auth provider (its effective credential is synthetic);
 *  - `unusable`: definitively unreachable (no usable active connection);
 *  - `unknown`:  credential store unavailable (unit tests / early boot).
 */
export type ModelCredentialVerdict = "keyed" | "noauth" | "unusable" | "unknown";

async function loadPrefixNodeIndex(): Promise<PrefixNodeIndexLike | null> {
  try {
    const { getProviderPrefixIndex } = await import("@/lib/providerNodePrefixes");
    return await getProviderPrefixIndex();
  } catch {
    return null;
  }
}

/**
 * Classify whether `provider/model` can actually authenticate upstream.
 * Returns `unknown` when the credential store is unavailable (unit tests /
 * early boot) so callers can fail open.
 *
 * The provider prefix is resolved through static aliases AND operator-configured
 * provider nodes before querying `provider_connections` (rows store the
 * canonical id — or, for compatible nodes, the node id — never the public
 * prefix). No-auth providers (NOAUTH_PROVIDERS) need no stored API key: their
 * effective credential is the synthetic "noauth" connection, so an empty
 * active set is usable for them (unlike keyed providers). A stored row with a
 * terminal status (disabled/banned/expired) still blocks the provider; any
 * other row is treated as usable (the key requirement does not apply — a
 * noauth row carries no API key by design).
 */
export async function classifyModelCredentials(
  model: string,
  prefixIndex?: PrefixNodeIndexLike | null
): Promise<ModelCredentialVerdict> {
  const rawProvider = typeof model === "string" ? model.split("/")[0]?.trim() : "";
  if (!rawProvider) return "unknown";
  const provider = resolveProviderId(rawProvider);
  const isNoAuth = isNoAuthProviderKey(rawProvider, provider);
  try {
    const { getProviderConnections } = await loadProvidersModule();
    const index = prefixIndex === undefined ? await loadPrefixNodeIndex() : prefixIndex;
    const providerIds = resolveProviderIdsForModelPrefix(rawProvider, provider, index);

    // A terminal-status row blocks a no-auth provider (#10702 companion rule).
    // Multiple candidate ids may match the same prefix (alias + verbatim + node);
    // a blocked candidate must not be flipped back to usable by an empty
    // candidate set, so track it instead of returning early.
    let noauthBlocked = false;
    for (const providerId of providerIds) {
      const connections = await getProviderConnections({ provider: providerId, isActive: true });
      if (!Array.isArray(connections)) return "unknown";
      if (connections.length === 0) continue;
      if (isNoAuth) {
        // No-auth rows store no API key (authType "noauth" + empty apiKey would
        // fail the generic key check) — only a terminal status blocks them.
        if (connections.some((c: any) => hasTerminalConnectionStatus(c))) {
          noauthBlocked = true;
        } else {
          return "noauth";
        }
      } else if (connections.some((c: any) => isProviderConnectionUsable(c))) {
        return "keyed";
      }
    }
    if (isNoAuth) return noauthBlocked ? "unusable" : "noauth";
    return "unusable";
  } catch {
    return "unknown";
  }
}

/**
 * Resolve whether `provider/model` has at least one usable active connection.
 * Returns `null` when the credential store is unavailable (unit tests / early boot).
 */
export async function hasUsableCredentialsForModel(
  model: string,
  prefixIndex?: PrefixNodeIndexLike | null
): Promise<boolean | null> {
  const verdict = await classifyModelCredentials(model, prefixIndex);
  if (verdict === "keyed" || verdict === "noauth") return true;
  if (verdict === "unusable") return false;
  return null;
}

/**
 * True when EVERY candidate provider id for `model` is DURABLY down:
 * circuit breaker OPEN, terminal connection statuses
 * (credits_exhausted / banned / expired), accumulated backoff
 * (`backoffLevel >= 2` ≈ consecutive failures), or a rate-limit beyond the
 * transient grace window — the same verdict the context-cache pin uses before
 * honoring a pinned dispatch (Fix #679, extracted to
 * `@/shared/utils/connectionHealth`).
 *
 * The Vision Bridge must not be built on top of guaranteed failure (#vision-bridge-health):
 * a candidate whose provider is disabled, quota-drained, or circuit-open would
 * turn every describe call into a guaranteed timeout/error chain. Fails OPEN
 * (returns `false`) on any lookup error so a transient DB/breaker hiccup never
 * silently removes candidates — the describe call itself remains the final
 * arbiter and already records failures into the router's success-rate stats.
 */
export async function isModelProviderDurablyUnhealthy(
  model: string,
  prefixIndex?: PrefixNodeIndexLike | null
): Promise<boolean> {
  try {
    const rawProvider = typeof model === "string" ? model.split("/")[0]?.trim() : "";
    if (!rawProvider) return false;
    const provider = resolveProviderId(rawProvider);
    const { getProviderConnections } = await loadProvidersModule();
    const index = prefixIndex === undefined ? await loadPrefixNodeIndex() : prefixIndex;
    const providerIds = resolveProviderIdsForModelPrefix(rawProvider, provider, index);
    if (providerIds.length === 0) return false;
    for (const providerId of providerIds) {
      let circuitState: string | undefined;
      try {
        circuitState = getCircuitBreaker(providerId)?.getStatus?.()?.state;
      } catch {
        circuitState = undefined;
      }
      let connections: ProviderConnectionLike[];
      try {
        const rows = await getProviderConnections({ provider: providerId, isActive: true });
        connections = Array.isArray(rows) ? (rows as ProviderConnectionLike[]) : [];
      } catch {
        return false; // fail open — connection store unreadable
      }
      if (!providerConnectionsDurablyUnhealthy(circuitState, connections, Date.now())) {
        return false; // at least one candidate provider is healthy
      }
    }
    return true; // every candidate provider is durably down
  } catch {
    return false;
  }
}
