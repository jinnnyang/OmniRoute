"use strict";

import assert from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import {
  isClientAbortError,
  shouldSwallowUncaught,
  attachRequestStreamGuards,
  installProcessCrashGuard,
} from "../../scripts/dev/httpClientAbortGuard.mjs";
import * as sharedGuard from "../../src/shared/utils/httpClientAbortGuard.mjs";

// The dev server imports from scripts/dev/httpClientAbortGuard.mjs, while the
// TypeScript servers (apiBridgeServer, liveServer, embedWsProxy) import from
// src/shared/utils/httpClientAbortGuard.mjs. The scripts/dev copy must be a pure
// re-export of the shared implementation — verify they are the SAME functions
// (single source of truth, no drift).
test("scripts/dev guard re-exports the shared src implementation (single source of truth)", () => {
  assert.equal(isClientAbortError, sharedGuard.isClientAbortError);
  assert.equal(shouldSwallowUncaught, sharedGuard.shouldSwallowUncaught);
  assert.equal(attachRequestStreamGuards, sharedGuard.attachRequestStreamGuards);
  assert.equal(installProcessCrashGuard, sharedGuard.installProcessCrashGuard);
  // And the shared module exposes everything the TS servers rely on.
  for (const name of [
    "isClientAbortError",
    "shouldSwallowUncaught",
    "attachRequestStreamGuards",
    "installProcessCrashGuard",
  ]) {
    assert.equal(typeof sharedGuard[name], "function", `shared guard must export ${name}`);
  }
});

// Minimal stand-ins for IncomingMessage / ServerResponse that expose the
// `error` event (Node's http streams are EventEmitters).
function makeReq() {
  return new EventEmitter();
}
function makeRes() {
  const res = new EventEmitter();
  res.end = () => res;
  res.write = () => true;
  return res;
}

test("isClientAbortError matches the exact production crash signature", () => {
  // Reproduces the Node `abortIncoming` error seen in the app log:
  //   uncaughtException: aborted / Error: aborted (no code)
  const aborted = Object.assign(new Error("aborted"), {});
  assert.equal(isClientAbortError(aborted), true, "plain 'aborted' must be absorbed");

  for (const code of [
    "ECONNRESET",
    "EPIPE",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTCONN",
    "ECANCELED",
  ]) {
    const err = Object.assign(new Error(code), { code });
    assert.equal(isClientAbortError(err), true, `${code} must be absorbed`);
  }
});

test("isClientAbortError rejects genuine server errors", () => {
  const real = Object.assign(new Error("boom"), { code: "ENOSPC" });
  assert.equal(isClientAbortError(real), false);
  const noCode = new Error("something else entirely");
  assert.equal(isClientAbortError(noCode), false);
});

test("attachRequestStreamGuards swallows a client abort on req without throwing", () => {
  const req = makeReq();
  const res = makeRes();
  attachRequestStreamGuards(req, res);

  // Must NOT throw / bubble as uncaughtException.
  assert.doesNotThrow(() => {
    req.emit("error", Object.assign(new Error("aborted"), {}));
    res.emit("error", Object.assign(new Error("aborted"), {}));
  });
});

test("attachRequestStreamGuards is idempotent (no double listeners / no throw)", () => {
  const req = makeReq();
  const res = makeRes();
  attachRequestStreamGuards(req, res);
  assert.doesNotThrow(() => attachRequestStreamGuards(req, res));
  // A second abort must also be absorbed quietly.
  assert.doesNotThrow(() => {
    req.emit("error", Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
  });
});

test("shouldSwallowUncaught absorbs the real 'aborted' uncaughtException signature", () => {
  // The exact error Node raises from http.Server#abortIncoming in the log:
  //   uncaughtException: aborted / Error: aborted (no code)
  const abortErr = new Error("aborted");
  assert.equal(shouldSwallowUncaught(abortErr, "uncaughtException"), true);
  assert.equal(shouldSwallowUncaught(abortErr, undefined), true);
  assert.equal(
    shouldSwallowUncaught(
      Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
      "uncaughtException"
    ),
    true
  );
});

test("shouldSwallowUncaught preserves crash semantics for genuine errors", () => {
  const realErr = new Error("genuine failure");
  assert.equal(shouldSwallowUncaught(realErr, "uncaughtException"), false);
  const realErr2 = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  assert.equal(shouldSwallowUncaught(realErr2, "uncaughtException"), false);
});

test("installProcessCrashGuard does not throw on import and is idempotent", () => {
  assert.doesNotThrow(() => installProcessCrashGuard(() => {}));
  assert.doesNotThrow(() => installProcessCrashGuard(() => {}));
});

// Incident 2026-09-04 (production exit-7 crash loop): combo hedge cancellation
// and per-target timeout aborts surface at process level as
// `Error [AbortError]: <reason>` with a string `cause`, e.g.
//   Error [AbortError]: hedge-cancelled { [cause]: 'hedge-cancelled' }
// These are race-losers of internal coordination — benign by the same
// rationale as client aborts — yet the old allowlist missed them and the
// process died 174 times (175 restarts).
test("isClientAbortError matches the hedge-cancelled production crash signature", () => {
  const hedgeAbort = Object.assign(new Error("hedge-cancelled"), {
    name: "AbortError",
    cause: "hedge-cancelled",
  });
  assert.equal(sharedGuard.isClientAbortError(hedgeAbort), true);
  assert.equal(shouldSwallowUncaught(hedgeAbort, "uncaughtException"), true);

  // Plain Error carrying a benign coordination reason as string cause.
  const causeOnly = Object.assign(new Error("dispatch failed"), {
    cause: "hedge-cancelled",
  });
  assert.equal(sharedGuard.isClientAbortError(causeOnly), true);

  // AbortError without a cause (DOMException-style abort).
  const plainAbort = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  assert.equal(sharedGuard.isClientAbortError(plainAbort), true);

  // AbortError chaining down to a genuine client-abort error stays benign.
  const chained = Object.assign(new Error("aborted"), {
    name: "AbortError",
    cause: Object.assign(new Error("aborted"), {}),
  });
  assert.equal(sharedGuard.isClientAbortError(chained), true);

  // Genuine faults must still surface: AbortError with a real Error cause that
  // is itself not abort-like, and plain non-abort errors.
  const genuine = Object.assign(new Error("boom"), {
    name: "AbortError",
    cause: new Error("db corrupt"),
  });
  assert.equal(sharedGuard.isClientAbortError(genuine), false);
  assert.equal(sharedGuard.isClientAbortError(new Error("boom")), false);
});

// ---------------------------------------------------------------------------
// Incident 2026-09-05 (production new server): omniroute was killed 6 times in
// 9 minutes, then twice more after the operator raised maxWaitMs 15s -> 60s.
// Every crash carried the SAME signature:
//
//   Error: Request exceeded OmniRoute's local rate-limit execution expiration
//          (legacy resilienceSettings.requestQueue.maxWaitMs=15000ms) for
//          volcengine-coding-plan/glm-5.3-flash
//     code: 'RATE_LIMIT_EXECUTION_TIMEOUT', status: 504
//     [cause]: Error: This job timed out after 15000 ms.
//         at doExpire ... at listOnTimeout
//
// Bottleneck rejects the scheduled promise from a bare setTimeout; when the
// awaiting caller already walked away (combo hedge cancel / per-target timeout
// / client disconnect) the rejection is orphaned -> unhandledRejection -> the
// guard rethrew it -> process death. That the crashes CONTINUED after the
// config change is the proof this must be fixed in code, not configuration.
// ---------------------------------------------------------------------------

/** Rebuild the exact production error object, expiry value configurable. */
function makeRateLimitExpiryError(maxWaitMs = 15000) {
  return Object.assign(
    new Error(
      `Request exceeded OmniRoute's local rate-limit execution expiration ` +
        `(legacy resilienceSettings.requestQueue.maxWaitMs=${maxWaitMs}ms) for ` +
        `volcengine-coding-plan/glm-5.3-flash. Bottleneck applies this deadline only ` +
        `after dispatch; it does not bound queue wait and is not an upstream-generated timeout.`
    ),
    {
      code: "RATE_LIMIT_EXECUTION_TIMEOUT",
      status: 504,
      cause: Object.assign(new Error(`This job timed out after ${maxWaitMs} ms.`), {}),
    }
  );
}

test("orphaned local rate-limit expiry must NOT kill the process (2026-09-05 incident)", () => {
  const err = makeRateLimitExpiryError(15000);

  assert.equal(
    sharedGuard.isLocalRateLimitTimeoutError(err),
    true,
    "the production crash signature must be recognised"
  );
  assert.equal(
    shouldSwallowUncaught(err, "unhandledRejection"),
    true,
    "an orphaned 504 business outcome must be swallowed, not rethrown"
  );
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);

  // Raising maxWaitMs (the operator's stop-gap) changes nothing about the race.
  assert.equal(shouldSwallowUncaught(makeRateLimitExpiryError(60000), "unhandledRejection"), true);

  // It is NOT a client abort — the two categories stay distinct.
  assert.equal(
    sharedGuard.isClientAbortError(err),
    false,
    "a rate-limit expiry is a business outcome, not a client abort"
  );
});

test("local rate-limit recognition is corroborated, not code-string-only", () => {
  // Status alone (as stamped by markLocalRateLimitError) corroborates.
  assert.equal(
    sharedGuard.isLocalRateLimitTimeoutError(
      Object.assign(new Error("x"), { code: "RATE_LIMIT_EXECUTION_TIMEOUT", status: 504 })
    ),
    true
  );

  // A bare code with NO corroboration must not be able to silence a crash —
  // provider-controlled error bodies must never buy immortality.
  assert.equal(
    sharedGuard.isLocalRateLimitTimeoutError(
      Object.assign(new Error("upstream said boom"), { code: "RATE_LIMIT_EXECUTION_TIMEOUT" })
    ),
    false,
    "code alone, with no status and no Bottleneck cause, must not be swallowed"
  );

  // Wrong code entirely -> never matched.
  assert.equal(
    sharedGuard.isLocalRateLimitTimeoutError(
      Object.assign(new Error("This job timed out after 15000 ms."), { status: 504 })
    ),
    false
  );

  // Non-objects and nullish inputs are safe.
  for (const junk of [null, undefined, "RATE_LIMIT_EXECUTION_TIMEOUT", 42]) {
    assert.equal(sharedGuard.isLocalRateLimitTimeoutError(junk), false);
  }
});

test("genuine faults still crash the process after the rate-limit carve-out", () => {
  // The sibling local-limit codes are deliberately NOT swallowed here: only the
  // execution-expiry path is known to orphan itself.
  for (const code of ["RATE_LIMIT_QUEUE_FULL", "RATE_LIMIT_QUEUE_WEDGED", "SQLITE_CORRUPT"]) {
    const err = Object.assign(new Error(code), { code, status: 500 });
    assert.equal(
      shouldSwallowUncaught(err, "uncaughtException"),
      false,
      `${code} must keep its crash semantics`
    );
  }
  assert.equal(shouldSwallowUncaught(new Error("genuine failure"), "uncaughtException"), false);
});
