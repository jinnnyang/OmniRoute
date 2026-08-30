import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  getCachedProviderConnectionById,
  updateProviderConnection,
  isCloudEnabled,
  resolveProxyForConnection,
} from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { validateProviderApiKey } from "@/lib/providers/validation";
import { getCliRuntimeStatus } from "@/shared/services/cliRuntime";
import { buildQoderCliNotFoundHint } from "@omniroute/open-sse/services/qoderCliResolve.ts";
import { saveCallLog } from "@/lib/usageDb";
import { shouldHideLogs } from "@/lib/tokenHealthCheck";
import { logProxyEvent } from "@/lib/proxyLogger";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { providerAllowsOptionalApiKey } from "@/shared/constants/providers";
import { shouldUseApiKeyConnectionTest } from "./webSessionTestDispatch";
import { testCodexAppServerConnection, makeDiagnosis } from "./codexAppServerHealth";
import { recoverKeyHealth } from "@omniroute/open-sse/services/apiKeyRotator.ts";
import { shouldClearErrorStateOnValidProbe } from "@/lib/usage/providerLimits";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { classifyAmbiguousOrAuthError, type ClassifyFailureArgs } from "./mistralAmbiguousAuth";
import { buildApiKeyConnectionTestResult } from "./apiKeyTestResult";

import { CLI_RUNTIME_PROVIDER_MAP } from "./cliRuntimeProviderMap";

/** POST body is optional; when present, only known fields are validated. */
const providerConnectionTestBodySchema = z.object({
  validationModelId: z.string().max(500).optional(),
});

function toSafeMessage(value: any, fallback = "Unknown error"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

/**
 * A provider/account that the upstream has deactivated (vs. a revoked/expired token).
 * #1444: a Codex account can have a perfectly healthy OAuth refresh while its ChatGPT
 * account is deactivated, in which case the API returns 401 — mislabeling that as
 * "Token invalid or revoked" hides the real cause. Mirrors the deactivation phrases the
 * account-fallback classifier already trusts.
 */
function isAccountDeactivatedMessage(text: string): boolean {
  const n = (text || "").toLowerCase();
  return n.includes("account_deactivated") || (n.includes("deactivat") && n.includes("account"));
}

export function classifyFailure({
  error,
  statusCode = null,
  refreshFailed = false,
  unsupported = false,
  provider,
}: ClassifyFailureArgs) {
  const message = toSafeMessage(error, "Connection test failed");
  const normalized = message.toLowerCase();
  const numericStatus = Number.isFinite(statusCode) ? Number(statusCode) : null;

  if (unsupported) {
    return makeDiagnosis("unsupported", "validation", message, "unsupported");
  }

  if (refreshFailed || normalized.includes("refresh failed")) {
    return makeDiagnosis("token_refresh_failed", "oauth", message, "refresh_failed");
  }

  // #1444: a deactivated account is distinct from a revoked/expired token — surface it
  // as account_deactivated (which the dashboard renders as "Account Deactivated") before
  // the generic 401/403 branch below would mark it "upstream_auth_error".
  if (isAccountDeactivatedMessage(normalized)) {
    return makeDiagnosis("account_deactivated", "account", message, "account_deactivated");
  }

  if (numericStatus === 401 || numericStatus === 403) {
    return classifyAmbiguousOrAuthError(provider, normalized, message, numericStatus);
  }

  if (numericStatus === 429) {
    return makeDiagnosis("upstream_rate_limited", "upstream", message, "429");
  }

  if (numericStatus && numericStatus >= 500) {
    return makeDiagnosis("upstream_unavailable", "upstream", message, String(numericStatus));
  }

  if (normalized.includes("token expired") || normalized.includes("expired")) {
    return makeDiagnosis("token_expired", "oauth", message, "token_expired");
  }

  if (
    normalized.includes("invalid api key") ||
    normalized.includes("token invalid") ||
    normalized.includes("revoked") ||
    normalized.includes("access denied") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden")
  ) {
    return makeDiagnosis(
      "upstream_auth_error",
      "upstream",
      message,
      numericStatus ? String(numericStatus) : "auth_failed"
    );
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("too many requests")
  ) {
    return makeDiagnosis(
      "upstream_rate_limited",
      "upstream",
      message,
      numericStatus ? String(numericStatus) : "rate_limited"
    );
  }

  if (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econn") ||
    normalized.includes("enotfound") ||
    normalized.includes("socket")
  ) {
    return makeDiagnosis("network_error", "upstream", message, "network_error");
  }

  return makeDiagnosis(
    "upstream_error",
    "upstream",
    message,
    numericStatus ? String(numericStatus) : "upstream_error"
  );
}

function hasQoderToken(connection: any): boolean {
  if (typeof connection?.apiKey === "string" && connection.apiKey.trim().length > 0) return true;
  const psd = connection?.providerSpecificData;
  if (psd && typeof psd === "object") {
    const pat =
      (psd as Record<string, unknown>).personalAccessToken ??
      (psd as Record<string, unknown>).pat ??
      (psd as Record<string, unknown>).accessToken;
    if (typeof pat === "string" && pat.trim().length > 0) return true;
  }
  return false;
}

async function getProviderRuntimeStatus(connection: any) {
  const provider = typeof connection?.provider === "string" ? connection.provider : "";
  let toolId = CLI_RUNTIME_PROVIDER_MAP[provider];

  // Issue #2247: detect Qoder in OAuth/CLI-flavored mode with a PAT pasted
  // BEFORE the CLI-runtime early-return below, otherwise the disambiguation
  // message never reaches the user (they keep seeing the generic "CLI not
  // installed" + 401 cascade). For Qoder, this short-circuits the runtime
  // check entirely with an actionable diagnosis.
  const isQoderOauthWithToken =
    provider === "qoder" && connection?.authType !== "apikey" && hasQoderToken(connection);
  if (isQoderOauthWithToken) {
    const message =
      "Qoder OAuth/Local CLI mode is selected but a Personal Access Token is stored on this connection. Switch this connection to API Key auth instead.";
    return {
      installed: false,
      runnable: false,
      reason: "qoder_oauth_with_token",
      diagnosis: makeDiagnosis("runtime_error", "local", message, "qoder_oauth_with_token"),
      error: message,
    };
  }

  if (provider === "qoder" && connection?.authType !== "apikey") {
    toolId = null;
  }
  if (!toolId) return null;

  try {
    const runtime = await getCliRuntimeStatus(toolId);
    if (runtime.installed && runtime.runnable) {
      return runtime;
    }

    const runtimeMessage = runtime.installed
      ? `Local CLI runtime is installed but not runnable (${runtime.reason || "healthcheck_failed"})`
      : provider === "qoder"
        ? buildQoderCliNotFoundHint(runtime.reason || "not_found")
        : "Local CLI runtime is not installed";

    return {
      ...runtime,
      diagnosis: makeDiagnosis(
        "runtime_error",
        "local",
        runtimeMessage,
        runtime.reason || "runtime_error"
      ),
      error: runtimeMessage,
    };
  } catch (error) {
    const runtimeMessage = `Failed to check local CLI runtime: ${(error as any)?.message || "runtime_check_failed"}`;
    return {
      installed: false,
      runnable: false,
      reason: "runtime_check_failed",
      diagnosis: makeDiagnosis("runtime_error", "local", runtimeMessage, "runtime_check_failed"),
      error: runtimeMessage,
    };
  }
}

/**
 * Refresh OAuth token using the shared open-sse getAccessToken.
 * This shares the in-flight promise cache with the SSE layer,
 * preventing race conditions where two code paths attempt to
 * refresh the same token concurrently.
 *
 * @returns {object} { accessToken, expiresIn, refreshToken } or null if failed
 */
/**
 * Fallback expiry persisted when a successful refresh returns neither
 * expiresAt nor expiresIn: keeps a NULL expires_at (treated as expired by
 * isTokenExpired) from forcing a token rotation on every subsequent test.
 * 30 minutes — the historical Google/OAuth default window, well inside any

/**
 * Sync to cloud if enabled
 */
async function syncToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing to cloud after token refresh:", error);
  }
}

/**
 * Test OAuth connection by calling provider API
 * Auto-refreshes token if expired
 * @returns {{ valid: boolean, error: string|null, refreshed: boolean, newTokens: object|null }}
 */
async function testApiKeyConnection(connection: any) {
  const requiresApiKey = !providerAllowsOptionalApiKey(connection.provider);
  if (requiresApiKey && !connection.apiKey) {
    const error = "Missing API key";
    return {
      valid: false,
      error,
      diagnosis: makeDiagnosis("auth_missing", "local", error, "missing_api_key"),
    };
  }

  const result = await validateProviderApiKey({
    provider: connection.provider,
    apiKey: connection.apiKey,
    providerSpecificData: connection.providerSpecificData,
  });

  if (result.unsupported) {
    const error = "Provider test not supported";
    return {
      valid: false,
      skipped: true,
      error,
      diagnosis: classifyFailure({ error, unsupported: true, provider: connection.provider }),
    };
  }

  const error = result.valid ? null : result.error || "Invalid API key";
  const diagnosis = result.valid
    ? makeDiagnosis("ok", "upstream", null, null)
    : classifyFailure({ error, statusCode: result.statusCode, provider: connection.provider });

  return buildApiKeyConnectionTestResult(result, error, diagnosis);
}

/**
 * Core test logic — reusable by test-batch without HTTP self-calls.
 * @param {string} connectionId
 * @param {string} validationModelId Optional custom model ID to test connection with
 * @returns {Promise<object>} Test result (same shape as the JSON response)
 */
export async function testSingleConnection(connectionId: string, validationModelId?: string) {
  const connection = await getCachedProviderConnectionById(connectionId);

  if (!connection) {
    return { valid: false, error: "Connection not found", diagnosis: null, latencyMs: 0 };
  }

  if (await isConnectionUnavailableToAuxiliaryActivity(connectionId)) {
    const error = "Connection test deferred while an exclusive session lease is active";
    return {
      valid: false,
      skipped: true,
      error,
      diagnosis: makeDiagnosis("lease_active", "local", error, "exclusive_lease_active"),
      latencyMs: 0,
    };
  }

  const provider = typeof connection.provider === "string" ? connection.provider : "";
  if (!provider) {
    return {
      valid: false,
      error: "Connection provider is invalid",
      diagnosis: makeDiagnosis(
        "validation_error",
        "local",
        "Connection provider is invalid",
        "provider_invalid"
      ),
      latencyMs: 0,
    };
  }

  // Resolve proxy for this connection (key → combo → provider → global → direct)
  let proxyInfo: any = null;
  try {
    proxyInfo = await resolveProxyForConnection(connectionId);
  } catch (proxyErr: any) {
    console.log(`[ConnectionTest] Failed to resolve proxy for ${connectionId}:`, proxyErr?.message);
  }

  let result;
  const startTime = Date.now();
  const runtime = await getProviderRuntimeStatus(connection);

  // Codex app-server connections carry no validatable OpenAI token (the codex
  // app-server process self-manages its own OAuth). Probe the app-server's
  // /readyz liveness endpoint instead of the meaningless token check — otherwise
  // every sweep reports a false "Token invalid or revoked" 401 and cools the
  // connection down. Returns null for non-app-server connections (fall through).
  const appServerResult = await testCodexAppServerConnection(connection);

  if ((runtime as any)?.diagnosis) {
    result = {
      valid: false,
      error: (runtime as any).error,
      refreshed: false,
      diagnosis: (runtime as any).diagnosis,
    };
  } else if (appServerResult) {
    result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      Promise.resolve(appServerResult)
    );
  } else if (shouldUseApiKeyConnectionTest(connection.authType, provider)) {
    const enrichedConnection = validationModelId
      ? {
          ...connection,
          providerSpecificData: {
            ...((connection.providerSpecificData as any) || {}),
            validationModelId,
          },
        }
      : connection;
    result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      testApiKeyConnection(enrichedConnection)
    );
  } else {
    result = {
      valid: false,
      error: "Provider test not supported",
      refreshed: false,
    };
  }

  const latencyMs = Date.now() - startTime;

  // Unsupported validation capability is neutral: the probe established that
  // this provider cannot be verified through the generic test surface, not
  // that its credential is invalid. Do not mutate persisted credential health
  // (testStatus/lastError/etc.) — but DO activate it if it isn't already: a
  // connection that can never be health-checked would otherwise stay hidden
  // from /v1/models forever under the "only advertise tested connections"
  // default (isActive starts false on creation — see POST /api/providers),
  // silently regressing every provider without a test surface.
  if (result.skipped === true) {
    if (connection.isActive !== true) {
      try {
        await updateProviderConnection(connectionId, { isActive: true });
      } catch (activateError) {
        console.log(
          `[ConnectionTest] Failed to activate unverifiable connection ${connectionId}:`,
          (activateError as any)?.message || activateError
        );
      }
    }
    return {
      ...result,
      latencyMs,
      runtime: runtime || null,
      testedAt: null,
    };
  }

  // Build update data
  const now = new Date().toISOString();
  const diagnosis =
    result.diagnosis ||
    (result.valid
      ? makeDiagnosis("ok", "local", null, null)
      : classifyFailure({ error: result.error, statusCode: result.statusCode, provider }));

  // #9623: a failed connection test must not paint the connection permanently red.
  // Previously a non-terminal failure wrote `testStatus: "error"` with
  // `rateLimitedUntil: null` — since the cooldown filter only ever skips entries
  // whose rateLimitedUntil is in the future, a null cooldown left the connection
  // permanently unavailable after a transient outage. Give non-terminal test
  // failures a short cooldown so the lazy-recovery path retries them.
  const terminalTestStatuses = new Set(["banned", "expired", "credits_exhausted"]);
  const isTerminalFailure =
    !result.valid &&
    terminalTestStatuses.has(String(diagnosis.code ?? diagnosis.type ?? "").toLowerCase());
  const testFailureCooldownMs = result.valid ? 0 : 30_000; // 30s retry window

  // A successful credential probe proves the KEY is valid. It does NOT prove the
  // quota window reopened: the probe is a cheap auth/models call that never touches
  // the chat quota a weekly cap applies to. Clearing an ACTIVE cooldown here — which
  // the credential-health scheduler triggers for every connection every 300s — put
  // `zai/glm-5.3` back to `active` / `rate_limited_until = NULL` within 30s of every
  // restart, so combo dispatched it straight into the same weekly 429. Same rule as
  // maybeClearRecoveredQuotaState: a future rateLimitedUntil is the 429 handler's
  // hard statement and no poller may overrule it. Once it elapses, the next probe
  // clears it normally.
  const clearErrorState = shouldClearErrorStateOnValidProbe(
    connection as { rateLimitedUntil?: string | null },
    result.valid
  );

  const updateData: Record<string, any> = {
    testStatus: clearErrorState ? "active" : result.valid ? connection.testStatus : "error",
    // A passing test is the sole activation signal under the "only advertise
    // tested-working connections" default — see POST /api/providers, which
    // now creates connections isActive:false. Only ever flips ON here: a
    // failing test intentionally leaves isActive untouched (a transient
    // failure on an already-active, already-working connection must not take
    // it out of rotation — that's what the cooldown/rateLimitedUntil below is
    // for), so this never deactivates anything.
    ...(result.valid ? { isActive: true } : {}),
    lastError: clearErrorState ? null : result.valid ? connection.lastError : result.error,
    lastErrorAt: clearErrorState ? null : result.valid ? connection.lastErrorAt : now,
    lastTested: now,
    lastErrorType: clearErrorState
      ? null
      : result.valid
        ? connection.lastErrorType
        : diagnosis.type,
    lastErrorSource: clearErrorState
      ? null
      : result.valid
        ? connection.lastErrorSource
        : diagnosis.source,
    errorCode: clearErrorState
      ? null
      : result.valid
        ? connection.errorCode
        : diagnosis.code || result.statusCode || null,
    rateLimitedUntil: clearErrorState
      ? null
      : isTerminalFailure
        ? connection.rateLimitedUntil || null
        : result.valid
          ? connection.rateLimitedUntil || null
          : new Date(Date.now() + testFailureCooldownMs).toISOString(),
  };

  if (clearErrorState) {
    updateData.backoffLevel = 0;
  }

  if (result.valid && (connection.apiKey || connection.accessToken)) {
    const recovered = recoverKeyHealth(connectionId, "primary", connection.providerSpecificData);
    if (recovered) updateData.providerSpecificData = recovered;
  }

  // If token was refreshed, update tokens in DB
  if (result.refreshed && result.newTokens) {
    updateData.accessToken = result.newTokens.accessToken;
    if (result.newTokens.refreshToken) {
      updateData.refreshToken = result.newTokens.refreshToken;
    }
    if (result.newTokens.expiresIn) {
      updateData.expiresAt = new Date(Date.now() + result.newTokens.expiresIn * 1000).toISOString();
    }
  }

  // Update status in db
  await updateProviderConnection(connectionId, updateData);

  // Sync to cloud if token was refreshed
  if (result.refreshed) {
    await syncToCloudIfEnabled();
  }

  // Log to Logger tab (call_logs table)
  try {
    const hideLogs = await shouldHideLogs();
    if (!hideLogs) {
      saveCallLog({
        method: "POST",
        path: "/api/providers/test",
        status: result.valid ? 200 : result.statusCode || 401,
        model: "connection-test",
        provider,
        connectionId,
        duration: latencyMs,
        error: result.valid ? null : result.error || null,
        sourceFormat: "test",
        targetFormat: "test",
      }).catch(() => {});
    }
  } catch {}

  // Log to Proxy tab (proxy_logs table)
  try {
    logProxyEvent({
      status: result.valid ? "success" : "error",
      proxy: proxyInfo?.proxy || null,
      level: proxyInfo?.level || "provider-test",
      levelId: proxyInfo?.levelId || null,
      provider,
      targetUrl: `${provider}/connection-test`,
      latencyMs,
      error: result.valid ? null : result.error || null,
      connectionId,
      comboId: null,
      account: connectionId?.slice(0, 8) || null,
      tlsFingerprint: false,
    });
  } catch {}

  return {
    valid: result.valid,
    error: result.error,
    warning: result.warning || null,
    refreshed: result.refreshed || false,
    diagnosis,
    latencyMs,
    statusCode: result.statusCode || null,
    runtime: runtime || null,
    testedAt: now,
  };
}

// POST /api/providers/[id]/test - Test connection
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      // Empty or non-JSON body — treat as {}
    }
    const validation = validateBody(providerConnectionTestBodySchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { validationModelId } = validation.data;

    const data = await testSingleConnection(id, validationModelId);

    if (data.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.log("Error testing connection:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
