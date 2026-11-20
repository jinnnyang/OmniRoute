/**
 * OpenCode Go model catalog after the 2026-11-20 generation cleanup.
 *
 * Only the current generation is advertised (GLM-5.3 / Kimi K3 / DeepSeek V4.1 /
 * Claude 5.5 / MiniMax M3.1 / Qwen3.8). The previously ported decolua/9router
 * alignment (glm-5.2, kimi-k2.7-code) is intentionally retired: those rows were
 * previous-generation ids and their windows (200K provider default) were wrong
 * for the models users actually route today.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { opencode_goProvider } =
  await import("../../open-sse/config/providers/registry/opencode/go/index.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");

function modelIds(): string[] {
  return (opencode_goProvider.models ?? []).map((m) => m.id);
}

test("opencode-go advertises the current generation only", () => {
  const ids = modelIds();
  for (const current of [
    "glm-5.3",
    "glm-5.3-flash",
    "kimi-k3",
    "deepseek-v4.1-flash",
    "claude-haiku-5-5",
    "minimax-m3.1-flash",
    "qwen3.8-max",
    "grok-4.6",
  ]) {
    assert.ok(
      ids.includes(current),
      `expected ${current} in opencode-go catalog, got: ${ids.join(", ")}`
    );
  }
  for (const retired of [
    "glm-5.2",
    "glm-5.2-high",
    "glm-5.2-max",
    "glm-5.1",
    "glm-5",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2.7-code",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2-pro",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "grok-4.5",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ]) {
    assert.ok(!ids.includes(retired), `${retired} is previous-generation and must be gone`);
  }
});

test("opencode-go keeps the /messages routing for minimax and qwen", () => {
  // Routing through the /messages endpoint is OmniRoute's declarative
  // equivalent of upstream's MESSAGES_FORMAT_MODELS set.
  const byId = new Map(
    (opencode_goProvider.models ?? []).map((m) => [m.id, m as Record<string, unknown>])
  );
  assert.equal(byId.get("minimax-m3.1-flash")?.targetFormat, "claude");
  assert.equal(byId.get("qwen3.8-max")?.targetFormat, "claude");
});

test("opencode-go current models resolve 1M windows (regression #context-gate)", () => {
  for (const modelId of ["glm-5.3", "glm-5.3-flash", "deepseek-v4.1-flash", "claude-haiku-5-5"]) {
    assert.equal(
      getResolvedModelCapabilities(`opencode-go/${modelId}`).contextWindow,
      1000000,
      `${modelId} should resolve a 1M context window`
    );
  }
  assert.equal(
    getResolvedModelCapabilities("opencode-go/minimax-m3.1-flash").contextWindow,
    1048576
  );
  assert.equal(getResolvedModelCapabilities("opencode-go/grok-4.6").contextWindow, 500000);
});

test("opencode-go hy3 variants expose their context window to combo compatibility filtering", () => {
  for (const modelId of ["hy3", "hy3-none", "hy3-low", "hy3-high"]) {
    assert.equal(
      getResolvedModelCapabilities(`opencode-go/${modelId}`).contextWindow,
      256000,
      `${modelId} should resolve a 256K context window`
    );
  }
});

test("opencode-go exposes Muse Spark Contributor effort aliases with a 1M context", () => {
  const museModelIds = [
    "muse-spark-1.2-contributor",
    "muse-spark-1.2-contributor-minimal",
    "muse-spark-1.2-contributor-low",
    "muse-spark-1.2-contributor-medium",
    "muse-spark-1.2-contributor-high",
    "muse-spark-1.2-contributor-xhigh",
  ];
  for (const modelId of museModelIds) {
    assert.ok(
      modelIds().includes(modelId),
      `expected ${modelId} in opencode-go catalog, got: ${modelIds().join(", ")}`
    );
    assert.equal(
      getResolvedModelCapabilities(`opencode-go/${modelId}`).contextWindow,
      1048576,
      `${modelId} should resolve a 1M context window`
    );
  }
});
