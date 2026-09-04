import test from "node:test";
import assert from "node:assert/strict";
import { hasVolcConsoleSession } from "../../src/lib/providers/volcenginePlanModelDiscovery.ts";

// Incident 2026-09-05: the sync-models gate for Volcano plan providers used
// `toNonEmptyString(x) !== ""`, but toNonEmptyString returns **null** for a
// missing field — and null !== "" is true. A manually created API-key
// connection (empty providerSpecificData) therefore passed the gate as if it
// had a console session, and model import failed with
// "Volcano console cookie or csrfToken is missing — re-bind the plan".
test("hasVolcConsoleSession: missing fields -> false (no console session)", () => {
  assert.equal(hasVolcConsoleSession({}), false);
  assert.equal(hasVolcConsoleSession({ volcConsoleCookie: "a=1" }), false);
  assert.equal(hasVolcConsoleSession({ volcCsrfToken: "t" }), false);
  assert.equal(hasVolcConsoleSession(undefined), false);
  assert.equal(hasVolcConsoleSession(null), false);
});

test("hasVolcConsoleSession: blank strings are not a console session", () => {
  assert.equal(hasVolcConsoleSession({ volcConsoleCookie: "  ", volcCsrfToken: "t" }), false);
  assert.equal(hasVolcConsoleSession({ volcConsoleCookie: "a=1", volcCsrfToken: "" }), false);
});

test("hasVolcConsoleSession: cookie + csrf present -> true", () => {
  assert.equal(hasVolcConsoleSession({ volcConsoleCookie: "a=1", volcCsrfToken: "t" }), true);
});
