import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import type { ComboLogger } from "../../open-sse/services/combo/types.ts";

const noopLog: ComboLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Incident 2026-09-04: hedge cancellation aborts the losing target's child
// signal from inside a listener on the parent signal. If ANY listener on the
// child signal throws (e.g. a broken disconnect handler), the throw propagates
// synchronously through child.abort() -> the parent listener -> whoever called
// parent.abort() — which in production is a timer/abort context, becoming an
// uncaughtException (exit code 7).
test("throwing sibling abort listener must not escape hedge cancellation", async () => {
  const parent = new AbortController();
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async (_b, _m, target) => {
      const signal = (target as { modelAbortSignal?: AbortSignal }).modelAbortSignal;
      signal?.addEventListener("abort", () => {
        throw new Error("broken sibling listener");
      });
      await new Promise(() => {}); // hang; the per-target timeout resolves the race
      return new Response("unreachable");
    },
    comboTargetTimeoutMs: 150,
    log: noopLog,
  });

  const promise = runner({}, "test/model", { modelAbortSignal: parent.signal });

  // Hedge winner cancels the loser. The abort() call itself must never throw.
  assert.doesNotThrow(() => parent.abort(new Error("hedge-cancelled")));

  const res = await promise;
  assert.equal(res.status, 504);
});
