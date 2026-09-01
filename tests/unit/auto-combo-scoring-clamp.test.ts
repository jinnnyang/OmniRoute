/**
 * tests/unit/auto-combo-scoring-clamp.test.ts
 *
 * Regression hardening: `calculateScore` summed weighted factors with NO final
 * clamp and NO NaN guard, and `calculateFactors` lower-bounded none of its
 * factors. A single NaN/negative input (bad telemetry, negative quota, negative
 * cost) could yield a NaN or out-of-[0,1] score that sinks a candidate
 * nondeterministically (NaN sorts unpredictably) or distorts ranking.
 *
 * Fix: clamp every factor to [0,1] in calculateFactors and clamp the final
 * score to [0,1] (clamp01 maps non-finite → 0).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateScore,
  calculateFactors,
  DEFAULT_WEIGHTS,
  normalizeScoringWeights,
  validateWeights,
} from "../../open-sse/services/autoCombo/scoring.ts";
import type {
  ScoringFactors,
  ProviderCandidate,
} from "../../open-sse/services/autoCombo/scoring.ts";

const ONES: ScoringFactors = {
  quota: 1,
  health: 1,
  costInv: 1,
  latencyInv: 1,
  taskFit: 1,
  stability: 1,
  tierPriority: 1,
  tierAffinity: 1,
  specificityMatch: 1,
  contextAffinity: 1,
  resetWindowAffinity: 1,
  connectionDensity: 1,
  quality: 1,
  reliability: 1,
};

function candidate(partial: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    provider: "p",
    model: "m",
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
    accountTier: "standard",
    quotaResetIntervalSecs: 86400,
    ...partial,
  };
}

test("calculateScore — NaN factor yields a finite [0,1] score (no NaN propagation)", () => {
  const score = calculateScore({ ...ONES, quota: NaN }, DEFAULT_WEIGHTS);
  assert.ok(Number.isFinite(score), "score must be finite even with a NaN factor");
  assert.ok(score >= 0 && score <= 1, `score in [0,1], got ${score}`);
});

test("calculateScore — clamps to [0,1]; all-ones with normalized weights ≈ 1", () => {
  const score = calculateScore(ONES, DEFAULT_WEIGHTS);
  assert.ok(score >= 0 && score <= 1);
  assert.ok(Math.abs(score - 1) < 1e-6, "normalized weights × all-ones ≈ 1");
});

test("calculateScore — negative factors cannot drive the score below 0", () => {
  const score = calculateScore({ ...ONES, costInv: -5, latencyInv: -5 }, DEFAULT_WEIGHTS);
  assert.ok(score >= 0, `score floored at 0, got ${score}`);
});

test("calculateFactors — negative quotaRemaining clamps the quota factor to [0,1]", () => {
  const c = candidate({ quotaRemaining: -50 });
  const f = calculateFactors(c, [c], "default", () => 0.5);
  assert.ok(f.quota >= 0 && f.quota <= 1, `quota factor must be in [0,1], got ${f.quota}`);
});

test("calculateFactors — negative cost cannot push costInv above 1", () => {
  const c = candidate({ costPer1MTokens: -100 });
  const f = calculateFactors(c, [c], "default", () => 0.5);
  assert.ok(f.costInv >= 0 && f.costInv <= 1, `costInv must be in [0,1], got ${f.costInv}`);
});

test("calculateFactors — out-of-range contextAffinity is clamped", () => {
  const c = candidate({ contextAffinity: 5 });
  const f = calculateFactors(c, [c], "default", () => 0.5);
  assert.ok(
    f.contextAffinity >= 0 && f.contextAffinity <= 1,
    `contextAffinity must be in [0,1], got ${f.contextAffinity}`
  );
});

test("calculateFactors — cache affinity is clamped and can be weighted", () => {
  const factors = calculateFactors(candidate({ cacheAffinity: 4 }), [], "default", () => 0.5);
  assert.equal(factors.cacheAffinity, 1);
  const weights = Object.fromEntries(
    Object.keys(DEFAULT_WEIGHTS).map((key) => [key, key === "cacheAffinity" ? 1 : 0])
  ) as typeof DEFAULT_WEIGHTS;
  assert.equal(calculateScore(factors, weights), 1);
});

test("normalizeScoringWeights keeps independent UI values proportional", () => {
  const normalized = normalizeScoringWeights({
    ...DEFAULT_WEIGHTS,
    cacheAffinity: 0.5,
  });
  const total = Object.values(normalized).reduce((sum, value) => sum + Number(value), 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok((normalized.cacheAffinity ?? 0) > normalized.health);
});

test("normalizeScoringWeights does not inject hidden weights into saved configs", () => {
  const normalized = normalizeScoringWeights({ health: 0.2, cacheAffinity: 0.5 });
  assert.equal(normalized.connectionDensity, 0);
  assert.equal(normalized.quota, 0);
  assert.ok(Math.abs(normalized.health - 2 / 7) < 1e-9);
  assert.ok(Math.abs((normalized.cacheAffinity ?? 0) - 5 / 7) < 1e-9);
});

test("calculateFactors — connectionDensity is clamped to [0,1] and NaN-safe", () => {
  // A large pool ((1000-1)/10 = 99.9) must not exceed 1 and skew the weighted score.
  const big = calculateFactors(
    candidate({ connectionPoolSize: 1000 }),
    [candidate()],
    "default",
    () => 0.5
  );
  assert.ok(
    big.connectionDensity >= 0 && big.connectionDensity <= 1,
    `connectionDensity must be in [0,1], got ${big.connectionDensity}`
  );
  // A non-finite pool size must map to 0 (clamp01), not propagate NaN into the score.
  const nan = calculateFactors(
    candidate({ connectionPoolSize: NaN }),
    [candidate()],
    "default",
    () => 0.5
  );
  assert.ok(
    Number.isFinite(nan.connectionDensity),
    `connectionDensity must be finite (clamp01 maps NaN→0), got ${nan.connectionDensity}`
  );
});

// ── reliability factor (#vision-bridge-health) ──────────────────────────────
//
// "A candidate's score should heavily depend on its request success rate":
// the reliability factor (1 - errorRate from usage_history rolling stats,
// including persisted vision-bridge describe failures) gives observed request
// success a first-class vote in candidate ranking, alongside the breaker-state
// health factor that only expresses short-term circuit state.

test("calculateFactors — reliability = 1 - errorRate", () => {
  const c = candidate({ errorRate: 0.3 });
  const f = calculateFactors(c, [c], "default", () => 0.5);
  assert.ok(Math.abs(f.reliability - 0.7) < 1e-9, `reliability must be 0.7, got ${f.reliability}`);
});

test("calculateFactors — errorRate is clamped, reliability stays in [0,1]", () => {
  const c = candidate({ errorRate: 1.7 });
  const f = calculateFactors(c, [c], "default", () => 0.5);
  assert.equal(f.reliability, 0, "reliability clamps at 0 for errorRate > 1");
});

test("calculateScore — a flaky candidate scores below an identical reliable one", () => {
  const flakyFactors = calculateFactors(candidate({ errorRate: 0.25 }), [], "default", () => 0.5);
  const cleanFactors = calculateFactors(candidate({ errorRate: 0 }), [], "default", () => 0.5);
  const flaky = calculateScore(flakyFactors, DEFAULT_WEIGHTS);
  const clean = calculateScore(cleanFactors, DEFAULT_WEIGHTS);
  assert.ok(clean > flaky, `clean (${clean}) must outrank flaky (${flaky})`);
  // 25pp of failure rate × 0.0705 weight ≈ 0.0176 score gap
  assert.ok(Math.abs(clean - flaky - 0.25 * 0.0705) < 1e-9);
});

test("calculateScore — weights remain a valid distribution after adding reliability", () => {
  assert.ok(validateWeights(DEFAULT_WEIGHTS), "DEFAULT_WEIGHTS must sum to ~1.0");
  const normalized = normalizeScoringWeights({ health: 1, reliability: 1 });
  const score = calculateScore({ ...ONES }, normalized);
  assert.ok(Math.abs(score - 1) < 1e-6, "normalized all-ones weights × all-ones factors ≈ 1");
});
