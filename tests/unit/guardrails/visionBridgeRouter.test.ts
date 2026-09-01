/**
 * Vision Bridge Auto-Router Tests
 *
 * Moved from visionBridgeRouter.test.tsx (which was only collected by the
 * advisory `test:vitest:ui` script, never by the blocking `test:unit` /
 * `test:vitest` gates — see tests/unit/guardrails/*.test.ts glob in
 * package.json vs the `.tsx`-only include in vitest.config.ts). This file
 * has no JSX and needs no jsdom environment, so it belongs under node:test.
 *
 * Credential-usability checks are exercised via the `deps.hasUsableCredentials`
 * injection point on getBestVisionModel()/getFallbackModels() rather than by
 * mocking the `@/lib/db/providers` module: this project's Node native test
 * runner (`node:test`) has no supported ESM module-mocking mechanism (see
 * the "mock.module() is unavailable" notes across tests/unit/*.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  getBestVisionModel,
  getFallbackModels,
  recordLatency,
  clearSelectionCache,
  getLatencyStats,
} = await import("../../../src/lib/guardrails/visionBridgeRouter.ts");
type VisionBridgeRouterDepsT =
  import("../../../src/lib/guardrails/visionBridgeRouter.ts").VisionBridgeRouterDeps;

// Fail-open default: credential store "unreadable" (indeterminate `null`),
// matching hasUsableCredentialsForModel's real behavior when the DB call
// throws. This mirrors pre-existing test expectations — every catalog
// candidate is still eligible when the credential store can't be checked.
const FAIL_OPEN_DEPS: VisionBridgeRouterDepsT = {
  hasUsableCredentials: async () => null,
};

test.beforeEach(() => {
  clearSelectionCache();
});

// ── getBestVisionModel ──────────────────────────────────────────────────────

test("getBestVisionModel — should return a vision-capable model", async () => {
  const model = await getBestVisionModel({}, FAIL_OPEN_DEPS);
  assert.ok(model);
  assert.equal(typeof model, "string");
});

test("getBestVisionModel — should respect fixed model override", async () => {
  const fixedModel = "openai/gpt-4o-mini";
  const model = await getBestVisionModel({ fixedModel }, FAIL_OPEN_DEPS);
  assert.equal(model, fixedModel);
});

test("getBestVisionModel — should exclude specified models", async () => {
  const model = await getBestVisionModel(
    { excludedModels: ["openai/gpt-4o-mini", "openai/gpt-4o"] },
    FAIL_OPEN_DEPS
  );
  assert.notEqual(model, "openai/gpt-4o-mini");
  assert.notEqual(model, "openai/gpt-4o");
});

test("getBestVisionModel — excludes a candidate with no usable active connection", async () => {
  // Every candidate reports a confirmed-unusable connection (`false`) ->
  // no candidate survives -> returns null instead of an unreachable default.
  const model = await getBestVisionModel({}, { hasUsableCredentials: async () => false });
  assert.equal(model, null);
});

test("getBestVisionModel — selects a credentialed candidate over an uncredentialed higher-priority one", async () => {
  // openai (priority 50, would normally win) has no usable connection;
  // every other vision-capable provider does.
  const model = await getBestVisionModel(
    {},
    {
      hasUsableCredentials: async (fullModelId) => fullModelId.split("/")[0] !== "openai",
    }
  );
  assert.equal(model.startsWith("openai/"), false);
});

// ── getFallbackModels ───────────────────────────────────────────────────────

test("getFallbackModels — should return fallback models excluding the primary", async () => {
  const primary = "openai/gpt-4o-mini";
  const fallbacks = await getFallbackModels(primary, {}, FAIL_OPEN_DEPS);
  assert.ok(!fallbacks.includes(primary));
  assert.ok(fallbacks.length > 0);
});

test("getFallbackModels — should respect max fallback attempts", async () => {
  const fallbacks = await getFallbackModels(
    "openai/gpt-4o-mini",
    { maxFallbackAttempts: 2 },
    FAIL_OPEN_DEPS
  );
  assert.ok(fallbacks.length <= 2);
});

test("getFallbackModels — does not include candidates with a confirmed-unusable connection", async () => {
  const fallbacks = await getFallbackModels(
    "openai/gpt-4o-mini",
    {},
    { hasUsableCredentials: async (fullModelId) => fullModelId.split("/")[0] !== "anthropic" }
  );
  assert.ok(!fallbacks.some((m) => m.startsWith("anthropic/")));
});

// ── recordLatency / getLatencyStats ─────────────────────────────────────────

test("recordLatency — should record latency measurements", () => {
  recordLatency("test-model", 100, true);
  recordLatency("test-model", 150, true);
  recordLatency("test-model", 200, false);

  const stats = getLatencyStats();
  assert.ok(stats["test-model"]);
  assert.equal(stats["test-model"].samples, 3);
});

test("getLatencyStats — should return latency statistics", () => {
  recordLatency("model-a", 100, true);
  recordLatency("model-a", 120, true);
  recordLatency("model-b", 200, true);

  const stats = getLatencyStats();
  assert.ok(stats["model-a"]);
  assert.ok(stats["model-b"]);
  assert.equal(stats["model-a"].avg, 110);
  assert.equal(stats["model-a"].successRate, 1);
});

// ── reliability-based selection (#vision-bridge-vcp) ────────────────────────
//
// The old auto-router scored candidates by hardcoded provider-name priority
// (openai=50, opencode-*=95, other=75) and only enumerated the static
// PROVIDER_MODELS registry. Operator-marked models on custom compatible
// connections (e.g. `vcp/kimi-k2.7-code`) were invisible to auto-selection,
// and no-auth free relays (cfp) could win. The router now:
//   * classifies candidates by real credentials (keyed > unknown, noauth
//     excluded by default via `excludeNoAuth`),
//   * additionally enumerates active connections' models that carry an
//     explicit vision marker (synced row flag or #9195 dashboard override).

test("no-auth candidates are excluded by default (excludeNoAuth)", async () => {
  // cloudflare-playground (cfp) is a no-auth provider in the static registry;
  // with no injection the router classifies via classifyModelCredentials —
  // here we inject a classify stub to make the scenario deterministic.
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) =>
        id.startsWith("cfp/") || id.startsWith("cloudflare-playground/")
          ? "noauth"
          : id.startsWith("openai/")
            ? "keyed"
            : "unusable",
    }
  );
  assert.ok(model, "a keyed candidate must exist in the static registry");
  assert.equal(model.startsWith("cfp/"), false);
  assert.equal(model.startsWith("cloudflare-playground/"), false);
});

test("excludeNoAuth:false keeps no-auth candidates as last resort", async () => {
  const model = await getBestVisionModel(
    { excludeNoAuth: false },
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "unusable" : "noauth"),
    }
  );
  assert.ok(model, "noauth candidate must be selectable when nothing keyed exists");
});

test("keyed candidates outrank indeterminate ones regardless of provider name", async () => {
  const model = await getBestVisionModel(
    {},
    {
      // openai is indeterminate (credential store unreadable), everything else keyed.
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "unknown" : "keyed"),
    }
  );
  assert.ok(model);
  assert.equal(model.startsWith("openai/"), false, "keyed must beat unknown");
});

test("connection-backed custom models are enumerated as candidates", async () => {
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id === "vcp/kimi-k2.7-code" ? "keyed" : "unusable"),
      listConnections: async () => [
        { id: "conn-1", provider: "node-vcp", isActive: true, authType: "apikey", apiKey: "k" },
      ],
      listProviderNodes: async () => [
        { id: "node-vcp", name: "Volcengine Coding", prefix: "vcp", type: "openai-compatible" },
      ],
      listModelsByConnection: async () => ({
        "conn-1": [
          { id: "kimi-k2.7-code", name: "Kimi", source: "imported", supportsVision: true },
        ],
      }),
      listCustomVisionOverrides: async () => new Map(),
    }
  );
  assert.equal(model, "vcp/kimi-k2.7-code");
});

test("dashboard #9195 vision overrides are enumerated as candidates", async () => {
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id === "vcp/glm-5.3-flash" ? "keyed" : "unusable"),
      listConnections: async () => [
        { id: "conn-1", provider: "node-vcp", isActive: true, authType: "apikey", apiKey: "k" },
      ],
      listProviderNodes: async () => [
        { id: "node-vcp", name: "Volcengine Coding", prefix: "vcp", type: "openai-compatible" },
      ],
      listModelsByConnection: async () => ({ "conn-1": [] }),
      listCustomVisionOverrides: async () =>
        new Map([["node-vcp", new Map([["glm-5.3-flash", true]])]]),
    }
  );
  assert.equal(model, "vcp/glm-5.3-flash");
});

test("custom models without an explicit vision marker are not auto-selected", async () => {
  const model = await getBestVisionModel(
    {},
    {
      // deepseek-v4-flash has no vision marker anywhere — the operator's own
      // naming/registry cannot be guessed. Everything static is unusable too.
      classifyCredentials: async () => "keyed",
      listConnections: async () => [
        { id: "conn-1", provider: "node-vcp", isActive: true, authType: "apikey", apiKey: "k" },
      ],
      listProviderNodes: async () => [
        { id: "node-vcp", name: "Volcengine Coding", prefix: "vcp", type: "openai-compatible" },
      ],
      listModelsByConnection: async () => ({
        "conn-1": [
          { id: "deepseek-v4-flash", name: "DS", source: "imported", supportsVision: false },
        ],
      }),
      listCustomVisionOverrides: async () => new Map(),
    }
  );
  // No static registry candidate may leak in here either: the stub says every
  // static model is keyed, but this assertion only holds if NO dynamic
  // unmarked model got selected. A dynamic unmarked model must not appear.
  assert.notEqual(model, "vcp/deepseek-v4-flash");
});

test("forced bridge models never become the auto-selected describer", async () => {
  const model = await getBestVisionModel(
    {},
    {
      // A static opencode-go connection exposes deepseek-v4-flash with a synced
      // vision flag — but opencode-go backends have no native vision, so the
      // forced list must keep it out of the describer seat.
      classifyCredentials: async (id) => (id.startsWith("opencode-go/") ? "keyed" : "unusable"),
      listConnections: async () => [
        { id: "conn-1", provider: "opencode-go", isActive: true, authType: "apikey", apiKey: "k" },
      ],
      listProviderNodes: async () => [],
      listModelsByConnection: async () => ({
        "conn-1": [
          { id: "deepseek-v4-flash", name: "DS", source: "imported", supportsVision: true },
        ],
      }),
      listCustomVisionOverrides: async () => new Map(),
    }
  );
  assert.notEqual(model, "opencode-go/deepseek-v4-flash");
});

// ── provider health gate (#vision-bridge-health) ────────────────────────────
//
// The bridge must not be built on top of guaranteed failure: a candidate whose
// provider is durably down (circuit OPEN, terminal statuses, repeated backoff,
// long rate-limit) is excluded before it can win selection — same verdict the
// context-cache pin uses (Fix #679, shared via src/shared/utils/connectionHealth).

const { scoreCandidate } = await import("../../../src/lib/guardrails/visionBridgeRouter.ts");

test("candidates whose provider is durably down are excluded from selection", async () => {
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "keyed" : "unusable"),
      isProviderUnhealthy: async (id) => id.startsWith("openai/"),
    }
  );
  assert.equal(model, null, "no candidate may survive when every keyed provider is down");
});

test("health gate keeps healthy candidates and drops only the unhealthy one", async () => {
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "keyed" : "unusable"),
      isProviderUnhealthy: async (id) => id === "openai/gpt-4o-mini",
    }
  );
  assert.notEqual(model, "openai/gpt-4o-mini");
  assert.ok(model, "another keyed candidate must take over");
});

test("health-lookup errors fail open (candidate kept)", async () => {
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "keyed" : "unusable"),
      isProviderUnhealthy: async () => {
        throw new Error("breaker store unavailable");
      },
    }
  );
  assert.ok(model, "a keyed candidate must survive a health-lookup error");
});

test("getFallbackModels also excludes durably-down providers", async () => {
  const fallbacks = await getFallbackModels(
    "openai/gpt-4o",
    {},
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "keyed" : "unusable"),
      isProviderUnhealthy: async (id) => id === "openai/gpt-4o-mini",
    }
  );
  assert.ok(!fallbacks.includes("openai/gpt-4o-mini"));
});

// ── reliability-dominant scoring ─────────────────────────────────────────────
//
// Score = (1 - successRate) * 10_000 + min(latencyMs, 10_000) / 10 + priority * 2.
// Success rate (including bridge describe failures) must outweigh latency and
// credential tier; priority is only a final tie-breaker.

const baseCandidate = {
  modelId: "m",
  fullName: "p/m",
  lastUsedAt: 0,
};

test("scoreCandidate — a 10% failure rate outweighs a large latency and tier advantage", () => {
  const flakyKeyed = {
    ...baseCandidate,
    priority: 30,
    averageLatencyMs: 10,
    successRate: 0.9,
  };
  const cleanUntested = {
    ...baseCandidate,
    priority: 95,
    averageLatencyMs: 8_000,
    successRate: 1,
  };
  // flaky: 1000 + 1 + 60 = 1061; clean: 0 + 800 + 190 = 990
  assert.ok(
    scoreCandidate(flakyKeyed) > scoreCandidate(cleanUntested),
    "reliability must dominate latency + tier"
  );
});

test("scoreCandidate — no-data latency cap (Infinity) equals the 10s ceiling", () => {
  const noData = { ...baseCandidate, priority: 30, averageLatencyMs: Infinity, successRate: 1 };
  const tenSeconds = { ...baseCandidate, priority: 30, averageLatencyMs: 10_000, successRate: 1 };
  assert.equal(scoreCandidate(noData), scoreCandidate(tenSeconds));
});

test("scoreCandidate — priority breaks ties among equally reliable candidates", () => {
  const keyed = { ...baseCandidate, priority: 30, averageLatencyMs: 500, successRate: 1 };
  const unknown = { ...baseCandidate, priority: 75, averageLatencyMs: 500, successRate: 1 };
  assert.ok(scoreCandidate(keyed) < scoreCandidate(unknown));
});

test("selection prefers a proven candidate over one with heavy recent failures", async () => {
  // openai/gpt-4o-mini: 87.5% success over 40 describe attempts.
  for (let i = 0; i < 40; i++) recordLatency("openai/gpt-4o-mini", 50, i < 35);
  const model = await getBestVisionModel(
    {},
    {
      classifyCredentials: async (id) => (id.startsWith("openai/") ? "keyed" : "unusable"),
      isProviderUnhealthy: async () => false,
    }
  );
  assert.ok(model);
  // gpt-4o-mini: (1-0.875)*10000 + 5 + 60 = 1315; every other openai model is
  // clean with no latency data: 0 + 1000 + 60 = 1060 → must lose to them.
  assert.notEqual(model, "openai/gpt-4o-mini");
});
