import { test } from "node:test";
import assert from "node:assert/strict";
import { VOLCENGINE_AGENT_PLAN_MODELS } from "../../open-sse/config/providers/registry/volcengine/agent/index.ts";

/**
 * Volcengine Agent Plan registry invariants after the 2026-11-20 generation
 * cleanup. The Plan API (/api/plan/v3) has no /models listing endpoint, so this
 * static registry IS the catalog — a stale entry silently routes users to a
 * model the upstream no longer serves.
 */
test("volcengine agent-plan: the routed current generation is advertised with windows", () => {
  const ids = new Set(VOLCENGINE_AGENT_PLAN_MODELS.map((m) => m.id));
  for (const current of [
    "glm-5.3",
    "glm-5.3-flash",
    "kimi-k3",
    "doubao-seed-2.1-turbo",
    "doubao-seed-evolving",
    "deepseek-v4.1-flash",
    "deepseek-v4-1-flash-economy-261017",
  ]) {
    assert.ok(ids.has(current), `current model "${current}" must be advertised`);
  }
  // Additive policy: rows for models the Plan API still serves stay in the catalog
  // so they resolve real windows instead of the 128K fallback.
  for (const stillServed of ["minimax-m3", "kimi-k2.7-code", "deepseek-v4-flash"]) {
    assert.ok(ids.has(stillServed), `"${stillServed}" is still served and must keep its row`);
  }
});

test("volcengine agent-plan: every advertised model declares a context window", () => {
  for (const model of VOLCENGINE_AGENT_PLAN_MODELS) {
    assert.equal(
      typeof model.contextLength,
      "number",
      `"${model.id}" must declare contextLength — otherwise the request gate falls back to 128K`
    );
  }
});

test("volcengine agent-plan: GLM-5.3 vision flags match live upstream behavior", () => {
  const glm53 = VOLCENGINE_AGENT_PLAN_MODELS.find((m) => m.id === "glm-5.3");
  assert.ok(glm53, "glm-5.3 entry must exist");
  assert.equal(
    glm53.supportsVision,
    false,
    "glm-5.3 upstream rejects images (live-verified) — the explicit false stops name " +
      "heuristics from advertising vision"
  );

  const glm53Flash = VOLCENGINE_AGENT_PLAN_MODELS.find((m) => m.id === "glm-5.3-flash");
  assert.ok(glm53Flash, "glm-5.3-flash entry must exist");
  assert.equal(glm53Flash.supportsVision, true, "glm-5.3-flash accepts images");
});

test("volcengine agent-plan: DeepSeek V4.1 entries carry a 1M window", () => {
  for (const id of ["deepseek-v4.1-flash", "deepseek-v4-1-flash-economy-261017"]) {
    const entry = VOLCENGINE_AGENT_PLAN_MODELS.find((m) => m.id === id);
    assert.ok(entry, `${id} entry must exist`);
    assert.equal(entry.contextLength, 1048576, `${id} must advertise 1M context`);
  }
});
