import test from "node:test";
import assert from "node:assert/strict";

const { getStaticModelsForProvider } = await import("../../src/lib/providers/staticModels.ts");
const { resolveModelAlias: resolveDeprecatedAlias } =
  await import("../../open-sse/services/modelDeprecation.ts");
const { normalizeThinkingLevel } = await import("../../open-sse/services/thinkingBudget.ts");
const { MODEL_SPECS, getModelSpec, capMaxOutputTokens, resolveModelAlias } =
  await import("../../src/shared/constants/modelSpecs.ts");

test("T31: antigravity static catalog exposes client-visible Gemini preview IDs", () => {
  // Antigravity exposes client-visible Gemini IDs even though the upstream still
  // accepts its internal model identifiers. #8013 (align official clients / callable
  // catalog) retired the `gemini-3-pro-preview` alias, so assert the current
  // client-visible top flash tier instead.
  const staticIds = (getStaticModelsForProvider("antigravity") || []).map((m) => m.id);
  assert.ok(staticIds.includes("gemini-3.7-flash-high"));
  assert.ok(!staticIds.includes("gemini-3-pro-preview"));
  // #3303 (agy parity, discussion #3184): the Gemini + Claude budget tiers ARE
  // client-visible on the Antigravity OAuth backend (Claude was never removed).
  assert.ok(staticIds.includes("gemini-3.1-pro-low"));
  assert.ok(staticIds.includes("claude-sonnet-4-6"));
  // The legacy cloaked Claude aliases remain absent.
  assert.ok(!staticIds.includes("gemini-claude-sonnet-4-5-thinking"));
  assert.ok(!staticIds.includes("gemini-claude-opus-4-5-thinking"));
});

// #11503 retargeted the -high alias from the dotted id to the hyphenated one, on the
// grounds that the catalog spells it that way and the dotted form is not routable.
// The two rungs therefore no longer share a spelling — pinned separately so a future
// re-unification is a deliberate edit here rather than a silent drift.
test("T31: legacy Gemini aliases resolve to Gemini 3.1 IDs", () => {
  assert.equal(resolveDeprecatedAlias("gemini-3-pro-high"), "gemini-3-1-pro-high");
  assert.equal(resolveDeprecatedAlias("gemini-3-pro-low"), "gemini-3.1-pro-low");
});

test("T33: thinkingLevel string is converted into numeric thinkingBudget", () => {
  const converted = normalizeThinkingLevel({
    model: "gemini-3.1-pro-high",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "HIGH" },
    },
  });

  assert.equal(converted.generationConfig.thinkingConfig.thinkingBudget, 24576);
  assert.equal(converted.generationConfig.thinkingConfig.thinkingLevel, undefined);
});

test("T34: max output tokens are capped by model spec", () => {
  assert.equal(capMaxOutputTokens("gpt-5.6", 200000), 128000);
  assert.equal(capMaxOutputTokens("gpt-5.6-luna", 200000), 128000);
  assert.equal(capMaxOutputTokens("claude-opus-5.5", 200000), 128000);
  assert.equal(capMaxOutputTokens("claude-sonnet-5.5", 200000), 128000);
  assert.equal(capMaxOutputTokens("anthropic.claude-opus-5.5", 200000), 128000);
  assert.equal(capMaxOutputTokens("claude-haiku-5.5", 200000), 64000);
  assert.equal(capMaxOutputTokens("gemini-4-argon", 131072), 65536);
  assert.equal(capMaxOutputTokens("glm-5.3", 200000), 131072);
  assert.equal(capMaxOutputTokens("deepseek-v4.1-flash", 500000), 384000);
  assert.equal(capMaxOutputTokens("minimax-m3.1-flash", 900000), 512000);
});

test("T38: modelSpecs exposes centralized helpers with alias and prefix lookup", () => {
  assert.equal(getModelSpec("gpt-5.6").contextWindow, 1050000);
  assert.equal(getModelSpec("gpt-5.6-sol").maxOutputTokens, 128000);
  assert.equal(typeof MODEL_SPECS["gemini-4-argon"], "object");
  assert.equal(getModelSpec("claude-opus-5.5").contextWindow, 1000000);
  assert.equal(getModelSpec("anthropic.claude-opus-5.5").maxOutputTokens, 128000);
  assert.equal(getModelSpec("claude-sonnet-5-5").contextWindow, 1000000);
  assert.equal(getModelSpec("claude-haiku-5-5").contextWindow, 1000000);
  assert.equal(getModelSpec("bedrock/us.anthropic.claude-haiku-5-5").contextWindow, 1000000);
  assert.equal(getModelSpec("glm-5.3-flash").contextWindow, 1000000);
  assert.equal(getModelSpec("glm-5-3-flash-260828").contextWindow, 1000000);
  assert.equal(getModelSpec("deepseek-v4-1-flash-economy-261017").contextWindow, 1000000);
  assert.equal(getModelSpec("deepseek-v4.1-flash").maxOutputTokens, 384000);
  assert.equal(getModelSpec("qwen3.8-max-preview").contextWindow, 1000000);
  assert.equal(resolveModelAlias("qwen3.8-max-preview"), "qwen3.8-max");
  assert.equal(getModelSpec("grok-4.6").contextWindow, 500000);
  assert.equal(getModelSpec("doubao-seed-2-1-lite-260915").contextWindow, 262144);
  assert.equal(getModelSpec("doubao-seed-2.1-turbo").contextWindow, 262144);
  assert.equal(getModelSpec("minimax-m3.1-flash").contextWindow, 1048576);
  assert.equal(getModelSpec("kimi-k3").contextWindow, 1048576);
  assert.equal(getModelSpec("mimo-v2.6-flash").supportsVision, true);
});

test("T38: MiMo vision flags stay correct per generation (additive policy)", () => {
  assert.equal(MODEL_SPECS["mimo-v2.6-pro"].supportsVision, true);
  assert.equal(MODEL_SPECS["mimo-v2.6-flash"].supportsVision, true);
  // Legacy rows stay for providers that still serve them; the *-pro chat models
  // remain text-only (models.dev mislabels them, hermes-agent#18884).
  assert.equal(MODEL_SPECS["mimo-v2.5"].supportsVision, true);
  assert.equal(MODEL_SPECS["mimo-v2-pro"].supportsVision, false);
});

test("opencode-go family: current-generation specs match upstream docs", () => {
  // Qwen3.8 Max: 1M context, 65K output (Bailian)
  assert.equal(getModelSpec("qwen3.8-max").contextWindow, 1000000);
  assert.equal(getModelSpec("qwen3.8-max").maxOutputTokens, 65536);
  assert.equal(getModelSpec("qwen3.8-max-preview").contextWindow, 1000000);

  // GLM-5.3 family: 1M context, 128K output
  assert.equal(getModelSpec("glm-5.3").contextWindow, 1000000);
  assert.equal(getModelSpec("glm-5.3-flash").contextWindow, 1000000);
  assert.equal(getModelSpec("glm-5.3").maxOutputTokens, 131072);

  // DeepSeek V4.1 Flash: 1M context, 384K output
  assert.equal(getModelSpec("deepseek-v4.1-flash").contextWindow, 1000000);
  assert.equal(getModelSpec("deepseek-v4.1-flash").maxOutputTokens, 384000);
  assert.equal(getModelSpec("deepseek-v4-1-flash-261017").contextWindow, 1000000);

  // Claude 5.5 family: 1M context
  assert.equal(getModelSpec("claude-haiku-5.5").contextWindow, 1000000);
  assert.equal(getModelSpec("claude-sonnet-5.5").contextWindow, 1000000);
  assert.equal(getModelSpec("claude-opus-5.5").contextWindow, 1000000);

  // Grok 4.6: 500K context (operator-confirmed 2026-11-20)
  assert.equal(getModelSpec("grok-4.6").contextWindow, 500000);

  // MiniMax M3.1 Flash: 1M context
  assert.equal(getModelSpec("minimax-m3.1-flash").contextWindow, 1048576);

  // Tencent Hunyuan 3 Preview: 262K context/output
  assert.equal(getModelSpec("hy3-preview").contextWindow, 262144);
  assert.equal(getModelSpec("hy3-preview").maxOutputTokens, 262144);

  // Additive policy (2026-11-20): spec rows for models providers still serve are
  // kept so they resolve real windows instead of the 128K fallback.
  for (const stillServed of [
    "glm-5.2",
    "claude-opus-4-5",
    "claude-sonnet-5",
    "kimi-k2.6",
    "minimax-m3",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "mimo-v2.5",
  ]) {
    assert.equal(
      typeof MODEL_SPECS[stillServed],
      "object",
      `${stillServed} must keep a spec row (capability knowledge for providers that still serve it)`
    );
  }
});

test("opencode-go family: capMaxOutputTokens uses the current specs", () => {
  assert.equal(capMaxOutputTokens("qwen3.8-max", 100000), 65536);
  assert.equal(capMaxOutputTokens("glm-5.3", 200000), 131072);
  assert.equal(capMaxOutputTokens("deepseek-v4.1-flash", 500000), 384000);
  assert.equal(capMaxOutputTokens("minimax-m3.1-flash", 900000), 512000);
  assert.equal(capMaxOutputTokens("hy3-preview", 300000), 262144);
});
