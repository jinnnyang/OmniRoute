/**
 * Regression: GET /api/resilience must return a shape that PATCH accepts.
 *
 * Incident 2026-09-05 (production dashboard): the "Request Queue" and "Combo
 * Cooldown Wait" cards on /dashboard/settings/resilience could not be saved at
 * all — every attempt answered `400 Invalid request`. Root cause was not the
 * values the operator typed but a READ/WRITE CONTRACT DRIFT: each card loads its
 * draft from GET /api/resilience and PATCHes the draft back verbatim, yet the
 * PATCH Zod schemas had fallen behind the settings shape GET serves:
 *
 *   1. #11493 added `requestQueue.globalConcurrentRequests` to the type, the
 *      normalizer, the defaults and the UI — but only to
 *      `legacyResilienceDefaultsSchema`, not to `requestQueueSettingsSchema`.
 *      Because that object is `.strict()`, the field GET had just emitted came
 *      back as `Unrecognized key: "globalConcurrentRequests"`.
 *   2. #8213 (#7360 follow-up) raised the comboCooldownWait normalizer ceiling
 *      to 5min and set the default `maxWaitMs` to 90000, while
 *      `comboCooldownWaitSettingsSchema` kept `.max(30000)` — so the DEFAULT
 *      value was rejected as `Too big: expected number to be <=30000`.
 *
 * Both are the same class of bug and both shipped unnoticed because the existing
 * coverage (resilience-tab-response-fields.test.ts) only checks that section
 * NAMES survive the round-trip, never that the section CONTENTS re-validate.
 * The parameterized round-trip below is the actual guard: any future field added
 * to a resolved section, or any normalizer bound widened past its schema, fails
 * here instead of in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveResilienceSettings,
  type ResilienceSettings,
} from "../../src/lib/resilience/settings.ts";
import { updateResilienceSchema } from "../../src/shared/validation/schemas.ts";

/**
 * The PATCH-able sections of the GET /api/resilience payload, projected exactly
 * as src/app/api/resilience/route.ts serves them (waitForCooldown is narrowed to
 * its three client-facing fields there; every other section is passed through).
 */
function buildGetPayload(resilience: ResilienceSettings): Record<string, unknown> {
  return {
    requestQueue: resilience.requestQueue,
    connectionCooldown: resilience.connectionCooldown,
    providerBreaker: resilience.providerBreaker,
    waitForCooldown: {
      enabled: resilience.waitForCooldown.enabled,
      maxRetries: resilience.waitForCooldown.maxRetries,
      maxRetryWaitSec: resilience.waitForCooldown.maxRetryWaitSec,
    },
    comboCooldownWait: resilience.comboCooldownWait,
    quotaShareConcurrencyLimit: resilience.quotaShareConcurrencyLimit,
    providerCooldown: resilience.providerCooldown,
    providerQuotaOverrides: resilience.providerQuotaOverrides,
  };
}

// Mirrors how each dashboard card saves: `savePatch(section, { [section]: draft })`.
for (const section of Object.keys(buildGetPayload(resolveResilienceSettings({})))) {
  test(`PATCH /api/resilience accepts the "${section}" section exactly as GET serves it`, () => {
    const payload = buildGetPayload(resolveResilienceSettings({}));
    const parsed = updateResilienceSchema.safeParse({ [section]: payload[section] });
    assert.equal(
      parsed.success,
      true,
      `GET returns a ${section} block that PATCH rejects: ` +
        JSON.stringify(parsed.success ? [] : parsed.error.issues)
    );
  });
}

test("PATCH /api/resilience accepts the whole GET payload in one body", () => {
  const parsed = updateResilienceSchema.safeParse(buildGetPayload(resolveResilienceSettings({})));
  assert.equal(
    parsed.success,
    true,
    `full-payload round-trip rejected: ` + JSON.stringify(parsed.success ? [] : parsed.error.issues)
  );
});

// Stored (non-default) values must round-trip too: the incident was reported on a
// server whose persisted requestQueue had been tuned away from the defaults.
test("PATCH accepts a tuned requestQueue round-tripped through resolve (incident values)", () => {
  const resolved = resolveResilienceSettings({
    resilienceSettings: {
      requestQueue: {
        autoEnableApiKeyProviders: true,
        requestsPerMinute: 60,
        minTimeBetweenRequestsMs: 350,
        concurrentRequests: 6,
        globalConcurrentRequests: 0,
        maxWaitMs: 60000,
        maxQueueDepth: 100,
      },
    },
  });
  assert.equal(resolved.requestQueue.maxWaitMs, 60000);
  assert.equal(resolved.requestQueue.maxQueueDepth, 100);
  const parsed = updateResilienceSchema.safeParse({ requestQueue: resolved.requestQueue });
  assert.equal(parsed.success, true, "tuned requestQueue must be re-savable");
});

// --- The two specific fields, pinned so a revert is caught by name ---

test("requestQueueSettingsSchema accepts globalConcurrentRequests (#11493 parity)", () => {
  const parsed = updateResilienceSchema.safeParse({
    requestQueue: { globalConcurrentRequests: 12 },
  });
  assert.equal(parsed.success, true);
});

test("comboCooldownWait.maxWaitMs accepts its own 90s default (#7360 ceiling parity)", () => {
  const parsed = updateResilienceSchema.safeParse({ comboCooldownWait: { maxWaitMs: 90000 } });
  assert.equal(parsed.success, true);
});

// --- Widening must not disable the guard rails ---

test("schema bounds still mirror the normalizers (no blanket passthrough)", () => {
  const rejected = [
    ["negative globalConcurrentRequests", { requestQueue: { globalConcurrentRequests: -1 } }],
    [
      "globalConcurrentRequests over 100000",
      { requestQueue: { globalConcurrentRequests: 100_001 } },
    ],
    ["non-integer globalConcurrentRequests", { requestQueue: { globalConcurrentRequests: 1.5 } }],
    [
      "comboCooldownWait.maxWaitMs over the 5min ceiling",
      { comboCooldownWait: { maxWaitMs: 300_001 } },
    ],
    ["unknown key inside requestQueue", { requestQueue: { nope: 1 } }],
    ["unknown key inside comboCooldownWait", { comboCooldownWait: { nope: 1 } }],
  ] as const;

  for (const [label, body] of rejected) {
    assert.equal(
      updateResilienceSchema.safeParse(body).success,
      false,
      `${label} must still be rejected`
    );
  }
});
