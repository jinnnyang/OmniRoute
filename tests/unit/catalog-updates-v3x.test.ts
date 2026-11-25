import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { resolveCanonicalProviderModel } from "../../open-sse/services/model.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { DEFAULT_PRICING } from "../../src/shared/constants/pricing.ts";

test("Pollinations catalog mirrors the current public text model lineup", () => {
  const models = getModelsByProviderId("pollinations");
  const ids = new Set(models.map((model) => model.id));
  const names = models.map((model) => model.name);

  assert.ok(ids.has("openai-fast"));
  assert.ok(ids.has("openai-large"));
  assert.ok(ids.has("perplexity-fast"));
  assert.ok(ids.has("qwen-coder-large"));
  assert.ok(ids.has("claude-large"));
  assert.equal(ids.has("llama"), false);
  assert.equal(
    names.some((name) => /GPT-5 via Pollinations/i.test(name)),
    false
  );
});

test("NVIDIA catalog includes the verified 2026 additions and GPT OSS 20B alias resolution", () => {
  const ids = new Set(getModelsByProviderId("nvidia").map((model) => model.id));

  assert.ok(ids.has("openai/gpt-oss-20b"));
  assert.ok(ids.has("nvidia/nemotron-3-super-120b-a12b"));
  assert.ok(ids.has("mistralai/mistral-large-3-675b-instruct-2512"));
  assert.ok(ids.has("qwen/qwen3.5-397b-a17b"));
  assert.ok(ids.has("mistralai/devstral-2-123b-instruct-2512"));

  assert.deepEqual(resolveCanonicalProviderModel("nvidia", "gpt-oss-20b"), {
    provider: "nvidia",
    model: "openai/gpt-oss-20b",
  });
});

test("cc channel exposes the current flagship Opus 5.5 with pricing", () => {
  const ccIds = new Set(getModelsByProviderId("cc").map((m) => m.id));
  assert.ok(ccIds.has("claude-opus-5.5"), "cc must expose the current flagship claude-opus-5.5");

  const ccPricing = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).cc;
  assert.ok(ccPricing["claude-opus-5.5"], "cc pricing must include claude-opus-5.5");
});

test("Opus 5.5 is wired on the first-party Claude channel only", () => {
  // The claude (OAuth) channel moved to the 5.5 generation; no other shipped catalog
  // advertises Opus 5.5 yet.
  for (const providerId of ["cc", "claude"]) {
    const model = getModelsByProviderId(providerId).find((entry) => entry.id === "claude-opus-5.5");
    assert.ok(model, `${providerId} must expose claude-opus-5.5`);
  }

  const claude = getModelsByProviderId("claude").find((entry) => entry.id === "claude-opus-5.5");
  assert.equal(claude?.contextLength, 1000000);
  assert.equal(claude?.maxOutputTokens, 128000);
  assert.ok(
    getStaticModelsForProvider("claude")?.some((entry) => entry.id === "claude-opus-5.5"),
    "claude OAuth discovery must expose claude-opus-5.5"
  );

  const price = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).cc[
    "claude-opus-5.5"
  ] as { input: number; output: number };
  assert.equal(price.input, 5.0, "cc Opus 5.5 input price");
  assert.equal(price.output, 25.0, "cc Opus 5.5 output price");
});

test("Sonnet 5.5 is wired on the first-party Claude channel with Sonnet-tier pricing", () => {
  // The cc channel now advertises the 5.5 generation: 1M ctx / 128K out and the
  // Sonnet-tier $3/$15 sticker (NOT the Opus/Fable $15/$75).
  for (const providerId of ["cc", "claude"]) {
    const ids = new Set(getModelsByProviderId(providerId).map((m) => m.id));
    assert.ok(ids.has("claude-sonnet-5.5"), `${providerId} must expose claude-sonnet-5.5`);
  }

  const claudeSonnet55 = getModelsByProviderId("claude").find((m) => m.id === "claude-sonnet-5.5");
  assert.equal(claudeSonnet55?.contextLength, 1000000);
  assert.equal(claudeSonnet55?.maxOutputTokens, 128000);

  const ccPricing = (DEFAULT_PRICING as Record<string, Record<string, unknown>>).cc;
  const sonnet55Price = ccPricing["claude-sonnet-5.5"] as { input: number; output: number };
  assert.ok(sonnet55Price, "cc pricing must include claude-sonnet-5.5");
  assert.equal(sonnet55Price.input, 3.0);
  assert.equal(sonnet55Price.output, 15.0);
});

test("Every OpenAI registry model resolves a non-zero pricing row (alias: openai)", async () => {
  const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
  const models = getModelsByProviderId("openai");
  assert.ok(models.length > 0, "openai must expose models");

  for (const model of models) {
    const pricing = getPricingForModel("openai", model.id) as {
      input?: number;
      output?: number;
    } | null;
    assert.ok(pricing, `openai pricing must include "${model.id}"`);
    assert.equal(
      typeof pricing?.input === "number" && typeof pricing?.output === "number",
      true,
      `openai pricing for "${model.id}" must have numeric input/output`
    );
  }
});

test("Every Codex registry model resolves a non-zero pricing row (alias: cx)", async () => {
  const { getPricingForModel } = await import("../../src/shared/constants/pricing.ts");
  const models = getModelsByProviderId("codex");
  assert.ok(models.length > 0, "codex must expose models");

  for (const model of models) {
    // Codex pricing lives under the "cx" alias (its DEFAULT_PRICING key).
    const pricing = getPricingForModel("cx", model.id) as {
      input?: number;
      output?: number;
    } | null;
    assert.ok(pricing, `cx pricing must include codex model "${model.id}"`);
    assert.equal(
      typeof pricing?.input === "number" && typeof pricing?.output === "number",
      true,
      `cx pricing for "${model.id}" must have numeric input/output`
    );
  }
});
