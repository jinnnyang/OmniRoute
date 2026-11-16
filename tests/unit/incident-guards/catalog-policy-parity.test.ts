/**
 * Guard: T2-P1-4 — /v1/models and request-time authorization must share one policy.
 *
 * Findings (code-arch P1-4, 014 篇): the catalog filter applies allowedModels and
 * allowedQuotas but not allowedCombos, while the request path rejects on allowedCombos.
 * Users therefore see ids they cannot call, and (per 014) a combo can be listed but
 * 403/503 at call time.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("current: the request-side policy entry point exists", async () => {
  const { validateApiKeyRoutingTarget } = await import("../../../src/shared/utils/apiKeyPolicy.ts");
  assert.equal(typeof validateApiKeyRoutingTarget, "function");
});

test("current: the catalog filter checks per-model permission but not allowedCombos", async () => {
  const fs = await import("node:fs");
  const catalog = fs.readFileSync(
    new URL("../../../src/app/api/v1/models/catalog.ts", import.meta.url),
    "utf8"
  );
  // Model-level permission IS consulted (isModelAllowedForKey → allowed/blocked models)…
  assert.match(catalog, /isModelAllowedForKey/);
  // …but the combo allow-list never is, so a combo a key cannot call is still listed.
  assert.ok(!/allowedCombos/.test(catalog), "catalog filtering does not consult allowedCombos yet");
});

test.todo(
  "target: every id returned by /v1/models passes validateApiKeyRoutingTarget for that key"
);
test.todo(
  "target: a combo that the request path rejects (allowedCombos) never appears in /v1/models"
);
