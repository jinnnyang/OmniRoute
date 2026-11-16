/**
 * Guard: T2-P0-2 — the attempt budget must belong to the root request, not to a layer.
 *
 * Findings (code-arch P0-2): `globalAttempts` is a function-local counter in
 * open-sse/services/combo.ts (declared twice, once per entry point), so a nested combo
 * starts a fresh budget, pre-dispatch skips are free, and the flattened target list has
 * no upper bound. The 2026-10 incident made 21 upstream calls — inside the default 30.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("current: the shared budget default is 30 and stays clamped", async () => {
  const { MAX_GLOBAL_ATTEMPTS, MAX_GLOBAL_ATTEMPTS_HARD_CAP, clampGlobalAttempts } = await import(
    "../../../open-sse/services/combo.ts"
  );
  assert.equal(MAX_GLOBAL_ATTEMPTS, 30);
  assert.equal(MAX_GLOBAL_ATTEMPTS_HARD_CAP, 200);
  assert.equal(clampGlobalAttempts(0), 30, "0 must not disable the budget");
});

test.todo(
  "target: a nested combo shares the root request's budget (dispatches <= maxGlobalAttempts across all layers)"
);
test.todo(
  "target: targets skipped by pre-dispatch filters still count against the budget"
);
test.todo(
  "target: the flattened target list is bounded before dispatch (no unbounded expansion)"
);
