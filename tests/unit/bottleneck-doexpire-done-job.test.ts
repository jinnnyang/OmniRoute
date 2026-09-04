import test from "node:test";
import assert from "node:assert/strict";
import Bottleneck from "bottleneck";
import {
  applyBottleneckDoExpirePatch,
  buildFixedDoExpire,
} from "../../open-sse/services/bottleneckPatch.ts";

// Incident 2026-09-04 (production exit-7 crash loop, RestartCount 175):
// when a job finishes (or is dropped by the abort race) BEFORE its
// `expiration` timer fires, Bottleneck's original Job#doExpire hits
// _assertStatus("EXECUTING") INSIDE the setTimeout callback. A throw there is
// an uncaughtException and kills the whole process. The existing patch fixed
// the RUNNING capacity leak but still unconditionally called the original
// doExpire — the DONE-job path remained fatal.
test("doExpire firing on an already-DONE job must not throw (exit-7 crash loop regression)", async () => {
  applyBottleneckDoExpirePatch();

  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => {
    uncaught.push(err);
  };
  process.on("uncaughtException", onUncaught);
  try {
    const limiter = new Bottleneck({ maxConcurrent: 1 });
    const result = await limiter.schedule({ expiration: 30 }, async () => "fast");
    assert.equal(result, "fast");

    // Let the 30ms expiration timer fire well after the job completed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      uncaught.length,
      0,
      `unexpected uncaughtException(s): ${uncaught.map(String).join(" | ")}`
    );
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

// The pre-existing RUNNING-stuck fix must keep working: a job still RUNNING
// when expiration fires is advanced to EXECUTING and expires normally.
test("doExpire on a RUNNING job still advances state and expires (original patch behavior)", async () => {
  applyBottleneckDoExpirePatch();

  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => {
    uncaught.push(err);
  };
  process.on("uncaughtException", onUncaught);
  try {
    const limiter = new Bottleneck({ maxConcurrent: 1 });
    const slow = limiter.schedule({ expiration: 40 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return "slow";
    });
    await assert.rejects(slow, /timed out|expiration/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uncaught.length, 0);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});
// Direct unit coverage for the crash-safe doExpire wrapper (pure, log-injected):
// only RUNNING (advance then expire) and EXECUTING (expire) may reach the
// original doExpire — DONE/CANCELLED/null must bail out safely, because the
// original's _assertStatus("EXECUTING") throws inside a setTimeout callback
// (uncaughtException -> process exit; incident 2026-09-04).
test("buildFixedDoExpire: RUNNING advances to EXECUTING then expires", () => {
  const transitions: string[] = [];
  const states = {
    jobStatus: (_id: string) => (transitions.length === 0 ? "RUNNING" : "EXECUTING"),
    next: (id: string) => transitions.push(id),
  };
  const logs: string[] = [];
  let originalCalled = false;
  const fixed = buildFixedDoExpire(
    "job-1",
    states,
    () => {
      originalCalled = true;
    },
    (m) => logs.push(m)
  );

  fixed(
    () => {},
    () => {},
    () => {}
  );
  assert.equal(transitions.length, 1);
  assert.equal(originalCalled, true);
  assert.equal(logs.length, 1);
});

test("buildFixedDoExpire: EXECUTING expires normally (unchanged path)", () => {
  const states = { jobStatus: (_id: string) => "EXECUTING", next: () => {} };
  let originalCalled = false;
  const fixed = buildFixedDoExpire(
    "job-2",
    states,
    () => {
      originalCalled = true;
    },
    () => {}
  );
  fixed(
    () => {},
    () => {},
    () => {}
  );
  assert.equal(originalCalled, true);
});

test("buildFixedDoExpire: DONE job skips original doExpire (exit-7 crash loop regression)", () => {
  const states = { jobStatus: (_id: string) => "DONE", next: () => {} };
  let originalCalled = false;
  const fixed = buildFixedDoExpire(
    "job-3",
    states,
    () => {
      originalCalled = true;
    },
    () => {}
  );
  assert.doesNotThrow(() =>
    fixed(
      () => {},
      () => {},
      () => {}
    )
  );
  assert.equal(originalCalled, false);
});

test("buildFixedDoExpire: removed state (null status) skips original doExpire", () => {
  const states = { jobStatus: (_id: string) => null, next: () => {} };
  let originalCalled = false;
  const fixed = buildFixedDoExpire(
    "job-4",
    states,
    () => {
      originalCalled = true;
    },
    () => {}
  );
  assert.doesNotThrow(() =>
    fixed(
      () => {},
      () => {},
      () => {}
    )
  );
  assert.equal(originalCalled, false);
});
