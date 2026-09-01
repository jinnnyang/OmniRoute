/**
 * Vision Bridge Auto-Router
 * Automatically selects the fastest vision-capable model from available models.
 */
/**
 * Vision Bridge Auto-Router
 * Automatically selects the fastest vision-capable model from available models.
 *
 * Candidate reliability rule (#vision-bridge-vcp): selection is driven by REAL
 * credentials, never by hardcoded provider-name tables. Keyed connections win,
 * no-auth free relays are excluded by default (`excludeNoAuth`), and
 * indeterminate credential stores fail open. Candidates come from the static
 * registry PLUS every active connection's models that carry an explicit vision
 * marker (synced row flag or the dashboard #9195 override) — upstream naming is
 * never guessed.
 */

import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels";
import {
  classifyModelCredentials,
  hasUsableCredentialsForModel,
  isModelProviderDurablyUnhealthy,
  type ModelCredentialVerdict,
} from "./visionBridgeCredentials";
import { isVisionBridgeForcedModel } from "@/shared/constants/visionBridgeDefaults";

/** Minimal row shapes so tests can inject pure data instead of mocking the DB. */
export interface RouterConnectionLike {
  id?: string;
  provider?: string | null;
  isActive?: boolean | null;
  [key: string]: unknown;
}
export interface RouterNodeLike {
  id?: string;
  name?: string | null;
  prefix?: string | null;
  type?: string | null;
}
export interface RouterSyncedModelLike {
  id: string;
  supportsVision?: boolean | null;
  [key: string]: unknown;
}
export type RouterVisionOverrideMap = ReadonlyMap<string, ReadonlyMap<string, boolean>>;
export interface VisionModelCandidate {
  modelId: string;
  fullName: string; // provider/model format
  priority: number; // lower = better (local models first)
  averageLatencyMs: number;
  lastUsedAt: number;
  successRate: number;
}

export interface LatencyRecord {
  modelId: string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
}

export interface VisionBridgeRouterConfig {
  /** Fixed model to use (overrides auto-routing) */
  fixedModel?: string;
  /** Maximum number of fallback attempts */
  maxFallbackAttempts: number;
  /** Cache TTL for selection decisions (ms) */
  selectionCacheTtlMs: number;
  /** Minimum number of latency samples before trusting average */
  minLatencySamples: number;
  /** Models to exclude from auto-routing */
  excludedModels: string[];
  /**
   * Exclude no-auth providers (free relays, e.g. cloudflare-playground) from
   * auto-selection. Default `true` — a free relay that hallucinates a describe
   * poisons every downstream text target. Opt back in explicitly.
   */
  excludeNoAuth?: boolean;
}

const DEFAULT_ROUTER_CONFIG: VisionBridgeRouterConfig = {
  maxFallbackAttempts: 3,
  selectionCacheTtlMs: 60_000, // 1 minute
  minLatencySamples: 5,
  excludedModels: [],
  excludeNoAuth: true,
};

/** Candidate priority tiers — lower wins. Keyed connections beat everything. */
const PRIORITY_KEYED = 30;
const PRIORITY_UNKNOWN = 75; // credential store unreadable — fail open
const PRIORITY_NOAUTH = 95; // only selectable when excludeNoAuth=false

// In-memory latency tracker (would be Redis in production)
const latencyStore = new Map<string, LatencyRecord[]>();
const selectionCache = new Map<string, { modelId: string; expiresAt: number }>();

/**
 * Record a latency measurement for a model.
 */
export function recordLatency(modelId: string, latencyMs: number, success: boolean): void {
  const records = latencyStore.get(modelId) || [];
  records.push({
    modelId,
    latencyMs,
    timestamp: Date.now(),
    success,
  });

  // Keep only last 100 records per model
  if (records.length > 100) {
    records.splice(0, records.length - 100);
  }

  latencyStore.set(modelId, records);
}

/**
 * Calculate average latency for a model, considering only recent records.
 */
function calculateAverageLatency(modelId: string, windowMs: number = 300_000): number {
  const records = latencyStore.get(modelId) || [];
  const cutoff = Date.now() - windowMs;
  const recentRecords = records.filter((r) => r.timestamp > cutoff && r.success);

  if (recentRecords.length === 0) {
    return Infinity; // No data = assume slow
  }

  const sum = recentRecords.reduce((acc, r) => acc + r.latencyMs, 0);
  return sum / recentRecords.length;
}

/**
 * Calculate success rate for a model.
 */
function calculateSuccessRate(modelId: string): number {
  const records = latencyStore.get(modelId) || [];
  if (records.length === 0) return 1.0; // No data = assume good

  const recentRecords = records.slice(-50); // Last 50 attempts
  const successes = recentRecords.filter((r) => r.success).length;
  return successes / recentRecords.length;
}

/**
 * Injectable dependencies for the router's data sources.
 * Defaults to the real DB-backed loaders. Tests inject pure stubs instead of
 * mocking the `@/lib/db/providers` module boundary — this project's Node native
 * test runner (`node:test`) has no supported ESM module-mocking mechanism, so
 * DI is the only way to exercise the credential-exclusion branch under
 * `npm run test:unit`.
 */
export interface VisionBridgeRouterDeps {
  hasUsableCredentials?: (model: string) => Promise<boolean | null>;
  classifyCredentials?: (model: string) => Promise<ModelCredentialVerdict>;
  /**
   * Provider health gate (#vision-bridge-health): return true when the
   * candidate's provider is DURABLY down (circuit OPEN, terminal statuses,
   * repeated backoff, long rate-limit). Active on the real (dep-free) path;
   * hermetic unit tests that inject other deps skip it unless they provide
   * this stub too.
   */
  isProviderUnhealthy?: (model: string) => Promise<boolean>;
  listConnections?: () => Promise<RouterConnectionLike[]>;
  listProviderNodes?: () => Promise<RouterNodeLike[]>;
  listModelsByConnection?: (providerId: string) => Promise<Record<string, RouterSyncedModelLike[]>>;
  listCustomVisionOverrides?: () => Promise<RouterVisionOverrideMap>;
}

async function defaultListConnections(): Promise<RouterConnectionLike[]> {
  try {
    const { getProviderConnections } = await import("@/lib/db/providers");
    const rows = await getProviderConnections({ isActive: true });
    return Array.isArray(rows) ? (rows as RouterConnectionLike[]) : [];
  } catch {
    return [];
  }
}

async function defaultListProviderNodes(): Promise<RouterNodeLike[]> {
  try {
    const { getProviderNodes } = await import("@/lib/db/providers/nodes");
    const rows = await getProviderNodes();
    return Array.isArray(rows) ? (rows as RouterNodeLike[]) : [];
  } catch {
    return [];
  }
}

async function defaultListModelsByConnection(
  providerId: string
): Promise<Record<string, RouterSyncedModelLike[]>> {
  try {
    const { getSyncedAvailableModelsByConnection } = await import("@/lib/db/models");
    const byConnection = await getSyncedAvailableModelsByConnection(providerId);
    return (byConnection ?? {}) as unknown as Record<string, RouterSyncedModelLike[]>;
  } catch {
    return {};
  }
}

async function defaultListCustomVisionOverrides(): Promise<RouterVisionOverrideMap> {
  try {
    const { listCustomModelVisionOverrides } = await import("@/lib/db/models");
    return listCustomModelVisionOverrides();
  } catch {
    return new Map();
  }
}

/**
 * Enumerate models on active connections that carry an EXPLICIT vision marker:
 *   - the dashboard #9195 per-model override (`customModels` key_value row,
 *     keyed by the connection's provider id);
 *   - the synced catalog row's own `supportsVision` flag (captured at sync);
 *   - the resolved capability chain (`getResolvedModelCapabilities`) for
 *     registry/synced metadata.
 * Nothing is inferred from the model name here — upstream naming is not ours
 * to guess, so an unmarked model simply never becomes a candidate.
 */
async function getConnectionVisionModels(
  deps: Required<
    Pick<
      VisionBridgeRouterDeps,
      | "listConnections"
      | "listProviderNodes"
      | "listModelsByConnection"
      | "listCustomVisionOverrides"
    >
  >
): Promise<string[]> {
  const [connections, nodes, overrides] = await Promise.all([
    deps.listConnections().catch(() => [] as RouterConnectionLike[]),
    deps.listProviderNodes().catch(() => [] as RouterNodeLike[]),
    deps.listCustomVisionOverrides().catch(() => new Map() as RouterVisionOverrideMap),
  ]);

  // Public prefix for each connection's provider id: the operator-configured
  // node prefix wins; static providers fall back to their registry alias.
  const prefixByProvider = new Map<string, string>();
  for (const node of nodes) {
    const nodeId = typeof node?.id === "string" ? node.id : null;
    const prefix = typeof node?.prefix === "string" ? node.prefix.trim() : "";
    if (nodeId && prefix) prefixByProvider.set(nodeId, prefix);
  }

  const found = new Set<string>();
  for (const connection of connections) {
    if (connection?.isActive === false) continue;
    const providerId = typeof connection?.provider === "string" ? connection.provider : null;
    if (!providerId) continue;
    const alias =
      prefixByProvider.get(providerId) ?? PROVIDER_ID_TO_ALIAS[providerId] ?? providerId;

    const modelIds = new Set<string>();

    // 1. Dashboard #9195 explicit supportsVision overrides.
    const overrideMap = overrides.get(providerId);
    if (overrideMap) {
      for (const [modelId, supportsVision] of overrideMap) {
        if (supportsVision === true) modelIds.add(modelId);
      }
    }

    // 2. Synced catalog rows with an explicit vision flag.
    const byConnection = await deps.listModelsByConnection(providerId).catch(() => ({}));
    for (const rows of Object.values(byConnection ?? {})) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row?.id && row.supportsVision === true) modelIds.add(row.id);
      }
    }

    for (const modelId of modelIds) {
      const fullName = `${alias}/${modelId}`;
      if (isVisionBridgeForcedModel(fullName)) continue;
      if (found.has(fullName)) continue;
      found.add(fullName);
    }
  }

  return [...found];
}

/**
 * Get all vision-capable models that also have a usable active connection on
 * this instance: static-registry candidates PLUS operator-marked models on
 * active connections.
 *
 * Without this credential check, a model with no working connection (e.g. the
 * hardcoded default `openai/gpt-4o-mini` on an instance with no `openai`
 * provider connected) could win selection, fail the describe call, and leave
 * the guardrail's describe-failure fallback to forward the raw image to a
 * non-vision backend, which rejects it with an opaque upstream error.
 */
async function getVisionCapableModels(
  deps: VisionBridgeRouterDeps = {},
  excludeNoAuth: boolean = true
): Promise<VisionModelCandidate[]> {
  const classify = deps.classifyCredentials ?? classifyModelCredentials;
  const candidates: VisionModelCandidate[] = [];
  const seen = new Set<string>();
  const checks: Array<Promise<void>> = [];

  // Health gate (#vision-bridge-health): drop candidates whose provider is
  // durably down (circuit OPEN, terminal statuses, repeated backoff, long
  // rate-limit) — the bridge must not be built on top of guaranteed failure.
  // Skipped when a test injects other deps WITHOUT a health stub (hermetic
  // unit tests have no DB); active on the real dep-free path.
  const healthCheck =
    deps.isProviderUnhealthy ??
    (deps.classifyCredentials || deps.hasUsableCredentials
      ? null
      : isModelProviderDurablyUnhealthy);

  const pushCandidate = async (
    fullName: string,
    modelId: string,
    verdict: ModelCredentialVerdict
  ) => {
    if (seen.has(fullName)) return;
    seen.add(fullName);
    if (verdict === "unusable") return;
    if (verdict === "noauth" && excludeNoAuth) return;
    if (healthCheck) {
      let unhealthy = false;
      try {
        unhealthy = await healthCheck(fullName);
      } catch {
        unhealthy = false; // fail open on health-lookup errors
      }
      if (unhealthy) return;
    }
    const priority =
      verdict === "keyed"
        ? PRIORITY_KEYED
        : verdict === "noauth"
          ? PRIORITY_NOAUTH
          : PRIORITY_UNKNOWN;
    candidates.push({
      modelId,
      fullName,
      priority,
      averageLatencyMs: calculateAverageLatency(fullName),
      lastUsedAt: 0,
      successRate: calculateSuccessRate(fullName),
    });
  };

  const classifyWithFallback = async (fullName: string): Promise<ModelCredentialVerdict> => {
    if (deps.classifyCredentials) return deps.classifyCredentials(fullName);
    // Legacy boolean injection (existing tests): derive the verdict from it.
    if (deps.hasUsableCredentials) {
      const usable = await deps.hasUsableCredentials(fullName);
      if (usable === true) return "keyed";
      if (usable === false) return "unusable";
      return "unknown";
    }
    return classify(fullName);
  };

  for (const [providerAlias, models] of Object.entries(PROVIDER_MODELS)) {
    if (!Array.isArray(models)) continue;

    for (const model of models) {
      if (!model?.id) continue;

      const fullModelId = `${providerAlias}/${model.id}`;
      const caps = getResolvedModelCapabilities(fullModelId);

      if (caps.supportsVision === true && !isVisionBridgeForcedModel(fullModelId)) {
        checks.push(
          classifyWithFallback(fullModelId).then((verdict) => {
            pushCandidate(fullModelId, model.id, verdict);
          })
        );
      }
    }
  }

  await Promise.all(checks);

  // Connection-backed candidates (operator-marked custom models, synced vision
  // flags) — classified through the same credential verdict path.
  const connectionDeps = {
    listConnections: deps.listConnections ?? defaultListConnections,
    listProviderNodes: deps.listProviderNodes ?? defaultListProviderNodes,
    listModelsByConnection: deps.listModelsByConnection ?? defaultListModelsByConnection,
    listCustomVisionOverrides: deps.listCustomVisionOverrides ?? defaultListCustomVisionOverrides,
  };
  const dynamicIds = await getConnectionVisionModels(connectionDeps);
  const dynamicChecks = dynamicIds.map(async (fullName) => {
    const verdict = await classifyWithFallback(fullName);
    pushCandidate(fullName, fullName.split("/").slice(1).join("/"), verdict);
  });
  await Promise.all(dynamicChecks);

  return candidates;
}

/**
 * Candidate score — lower is better.
 *
 * Reliability dominates (#vision-bridge-health): the describe call is the
 * foundation the bridge is built on, so a candidate's recent success rate
 * (last 50 describe attempts, including bridge failures recorded via
 * recordLatency) must outweigh latency and credential-tier preferences:
 *   * every 1% of failure rate costs 100 points (total failure = 10_000);
 *   * latency contributes at most 1_000 points (10s+ ≈ a 10% failure rate);
 *   * credential priority (keyed 30 / unknown 75 / noauth 95) is only a
 *     final tie-breaker (~130-point spread).
 */
const RELIABILITY_WEIGHT = 10_000;
const LATENCY_SCORE_CAP = 1_000;
export function scoreCandidate(c: VisionModelCandidate): number {
  const latencyScore = Math.min(c.averageLatencyMs / 10, LATENCY_SCORE_CAP);
  return (1 - c.successRate) * RELIABILITY_WEIGHT + latencyScore + c.priority * 2;
}

/**
 * Select the best vision model based on success rate, latency, and priority.
 */
function selectBestModel(
  candidates: VisionModelCandidate[],
  config: VisionBridgeRouterConfig
): VisionModelCandidate | null {
  const filtered = candidates.filter((c) => {
    // Exclude explicitly excluded models
    if (config.excludedModels.includes(c.fullName)) return false;
    if (config.excludedModels.includes(c.modelId)) return false;

    // Exclude models with poor success rate (< 50%)
    if (c.successRate < 0.5) return false;

    return true;
  });

  if (filtered.length === 0) return null;

  const scored = filtered.map((c) => ({ ...c, score: scoreCandidate(c) }));

  scored.sort((a, b) => a.score - b.score);

  return scored[0];
}

/**
 * Get the best vision model for image description.
 * Respects fixed model override if configured, but validates it has usable
 * credentials before short-circuiting — a fixedModel that is confirmed
 * unreachable on this instance falls through to auto-selection.
 * Returns `null` when no vision-capable candidate has usable credentials.
 */
export async function getBestVisionModel(
  config: Partial<VisionBridgeRouterConfig> = {},
  deps: VisionBridgeRouterDeps = {}
): Promise<string | null> {
  const fullConfig = { ...DEFAULT_ROUTER_CONFIG, ...config };

  // If fixed model is configured, validate it has usable credentials first.
  // (#8430) An unreachable fixedModel (e.g. the default "openai/gpt-4o-mini"
  // on an instance with no OpenAI connection/key) must not short-circuit the
  // credential check — fall through to auto-selection instead.
  // (#8430) An unreachable fixedModel (e.g. the default "openai/gpt-4o-mini"
  // on an instance with no OpenAI connection/key) must not short-circuit the
  // credential check — fall through to auto-selection instead.
  if (fullConfig.fixedModel) {
    const checkCreds = deps.hasUsableCredentials ?? hasUsableCredentialsForModel;
    const usable = await checkCreds(fullConfig.fixedModel);
    // Only skip credential validation when the check is indeterminate (null).
    // A confirmed `false` means fall through to auto-selection.
    if (usable !== false) {
      return fullConfig.fixedModel;
    }
  }

  // Check selection cache — key includes excluded models AND the no-auth
  // policy to prevent cache pollution across different configurations
  const excludeNoAuth = fullConfig.excludeNoAuth !== false;
  const cacheKey =
    fullConfig.excludedModels.length > 0
      ? `excl:${[...fullConfig.excludedModels].sort().join(",")}|noauth:${excludeNoAuth}`
      : `default|noauth:${excludeNoAuth}`;
  const cached = selectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.modelId;
  }

  // Get all vision-capable candidates
  const candidates = await getVisionCapableModels(deps, excludeNoAuth);

  // Select best model
  const best = selectBestModel(candidates, fullConfig);

  if (!best) {
    // No vision-capable candidate has usable credentials on this instance
    return null;
  }

  // Cache the selection
  selectionCache.set(cacheKey, {
    modelId: best.fullName,
    expiresAt: Date.now() + fullConfig.selectionCacheTtlMs,
  });

  return best.fullName;
}

/**
 * Get fallback models for retry logic.
 */
export async function getFallbackModels(
  excludeModel: string,
  config: Partial<VisionBridgeRouterConfig> = {},
  deps: VisionBridgeRouterDeps = {}
): Promise<string[]> {
  const fullConfig = { ...DEFAULT_ROUTER_CONFIG, ...config };
  const candidates = await getVisionCapableModels(deps, fullConfig.excludeNoAuth !== false);

  const filtered = candidates.filter(
    (c) =>
      c.fullName !== excludeModel &&
      !fullConfig.excludedModels.includes(c.fullName) &&
      c.successRate >= 0.5
  );

  // Same reliability-dominant ordering as selectBestModel (#vision-bridge-health)
  const scored = filtered.map((c) => ({ ...c, score: scoreCandidate(c) }));

  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, fullConfig.maxFallbackAttempts - 1).map((c) => c.fullName);
}

/**
 * Clear the selection cache (e.g., after config change).
 */
export function clearSelectionCache(): void {
  selectionCache.clear();
}

/**
 * Get latency statistics for debugging.
 */
export function getLatencyStats(): Record<
  string,
  { avg: number; samples: number; successRate: number }
> {
  const stats: Record<string, { avg: number; samples: number; successRate: number }> = {};

  for (const [modelId, records] of latencyStore.entries()) {
    const recentRecords = records.filter((r) => r.timestamp > Date.now() - 300_000);
    if (recentRecords.length === 0) continue;

    const avg = recentRecords.reduce((acc, r) => acc + r.latencyMs, 0) / recentRecords.length;
    const successRate = recentRecords.filter((r) => r.success).length / recentRecords.length;

    stats[modelId] = {
      avg: Math.round(avg),
      samples: recentRecords.length,
      successRate: Math.round(successRate * 100) / 100,
    };
  }

  return stats;
}
