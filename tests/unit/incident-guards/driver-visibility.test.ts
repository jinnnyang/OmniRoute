/**
 * Guard: T2-P1-1 — a database driver degradation must be observable from outside.
 *
 * Findings (code-arch P1-1, ci-reliability P1-5, upstream-diff "neither side has it"):
 * a silent fallback to the sql.js WASM driver ran for days in 2026-09 (17 篇) and only
 * showed up as heap exhaustion. `getDriverInfo()` exists (src/lib/db/core.ts) but is dead
 * code, and /api/monitoring/health does not report the driver.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("current: getDriverInfo is exported but unused by the health surface", async () => {
  const fs = await import("node:fs");
  const core = fs.readFileSync(new URL("../../../src/lib/db/core.ts", import.meta.url), "utf8");
  assert.match(core, /export function getDriverInfo/);
  const route = fs.readFileSync(
    new URL("../../../src/app/api/monitoring/health/route.ts", import.meta.url),
    "utf8"
  );
  assert.ok(!/getDriverInfo|dbDriver|driver:/.test(route), "health route does not report the driver yet");
});

test(
  "target: health reports the active driver and a degraded flag",
  { todo: "T2-P1-1: add dbDriver to the health payload and assert native driver at boot" },
  async () => {
    const { buildHealthPayload } = await import("../../../src/lib/monitoring/observability.ts");
    const payload = await buildHealthPayload({});
    assert.ok("dbDriver" in payload);
  }
);
