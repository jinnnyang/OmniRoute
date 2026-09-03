import { test } from "node:test";
import assert from "node:assert/strict";
import { VOLCENGINE_AGENT_PLAN_MODELS } from "../../open-sse/config/providers/registry/volcengine/agent-plan/index.ts";

/**
 * Volcengine Agent Plan registry invariants after the 2026-09-03 operator
 * catalog refresh. The Plan API (/api/plan/v3) has no /models listing endpoint,
 * so this static registry IS the catalog — a stale entry silently routes users
 * to a model the upstream no longer serves.
 */
test("volcengine agent-plan: model IDs are unversioned family aliases", () => {
  const ids = VOLCENGINE_AGENT_PLAN_MODELS.map((m) => m.id);
  for (const id of ids) {
    assert.doesNotMatch(
      id,
      /-\d{6}$/,
      `"${id}" still carries a date suffix — the Plan API accepts unversioned family IDs, ` +
        "and pinned dates go stale when upstream rotates the build"
    );
  }
});

test("volcengine agent-plan: retired models are absent, current ones present", () => {
  const ids = new Set(VOLCENGINE_AGENT_PLAN_MODELS.map((m) => m.id));
  for (const retired of ["minimax-m2.7", "kimi-k2.6"]) {
    assert.ok(!ids.has(retired), `retired model "${retired}" must not be advertised`);
  }
  for (const current of ["doubao-seed-2.0-lite", "glm-5.3", "glm-5.3-flash", "kimi-k2.7-code"]) {
    assert.ok(ids.has(current), `current model "${current}" must be advertised`);
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
