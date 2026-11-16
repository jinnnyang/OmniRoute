/**
 * Guard: T2-P1-2 — call_logs amplification.
 *
 * Findings (code-arch P1-2): every *attempt* writes a row plus a payload artifact, and
 * rotation drains only CALL_LOG_ROTATE_BATCH_SIZE (100) rows per pass, once a minute.
 * Production reached 522 MB + 525 MB WAL in 2.5 months. A 30-attempt combo therefore
 * turns one request into 30 rows and 30 artifacts.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("current: rotation drains in fixed 100-row batches", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../../../src/lib/usage/callLogRotation.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /const CALL_LOG_ROTATE_BATCH_SIZE = 100;/);
  assert.match(src, /trimCallLogsToMaxRows\(getCallLogsTableMaxRows\(\), CALL_LOG_ROTATE_BATCH_SIZE\)/);
});

test.todo(
  "target: one request produces one call_log row (attempts aggregated), with artifacts bounded per request"
);
test.todo("target: rotateCallLogs drains an over-quota table in a single pass, not 100 rows/pass");
