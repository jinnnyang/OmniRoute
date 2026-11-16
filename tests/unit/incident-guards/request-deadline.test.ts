/**
 * Guard: T2-P0-1 — a request needs a total deadline.
 *
 * Findings (reviews/20261116-less/code-arch.md P0-1): `comboTimeoutMs` defaults to 0
 * (no deadline), and the only backstop is a 10-minute loop safety constant. Combined
 * with the heavy-request admission rule (one in flight, 2s queue) a stuck combo can hold
 * the instance for ~10 minutes.
 *
 * The green assertions below lock in today's behaviour so the gap is executable. The
 * `todo` tests are the acceptance criteria for the fix: strip the todo flag when the
 * behaviour lands (node:test reports todo failures without failing the run).
 */
import test from "node:test";
import assert from "node:assert/strict";

test("current: default combo config has no total deadline (comboTimeoutMs = 0)", async () => {
  const { getDefaultComboConfig } = await import("../../../open-sse/services/comboConfig.ts");
  assert.equal(getDefaultComboConfig().comboTimeoutMs, 0);
});

test("current: the only backstop is the 10-minute loop safety constant", async () => {
  const { COMBO_LOOP_SAFETY_TIMEOUT_MS } = await import(
    "../../../open-sse/services/combo/comboPredicates.ts"
  );
  assert.equal(COMBO_LOOP_SAFETY_TIMEOUT_MS, 10 * 60 * 1000);
});

test(
  "target: the default combo config carries a nonzero request deadline",
  { todo: "T2-P0-1: pick a default (e.g. 180000ms) and make it configurable per combo" },
  async () => {
    const { getDefaultComboConfig } = await import("../../../open-sse/services/comboConfig.ts");
    assert.ok(getDefaultComboConfig().comboTimeoutMs > 0);
  }
);

test.todo(
  "target: when the deadline trips, the request returns 504 and no further target is dispatched"
);
