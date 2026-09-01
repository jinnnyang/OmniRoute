/**
 * callVisionModel fallback behavior — Integration test (PR #3377, Rule #18)
 *
 * Verifies (line numbering is approximate — see the fallback tests below) that
 * when the primary vision model fails, callVisionModel falls
 * through to the next model in the fallback list, and that when ALL models
 * fail it throws the last error (not a silent empty result).
 *
 * Run: node --import tsx/esm --test tests/unit/guardrails/vision-bridge-callmodel.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vision-bridge-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Prevent vision bridge from routing through a real API
process.env.VISION_BRIDGE_ENABLED = "false";

const { callVisionModel } = await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");

// PR #8433 taught getFallbackModels() to exclude any candidate without a
// usable active connection (see visionBridgeRouter.ts::getVisionCapableModels).
// This test's isolated DATA_DIR starts with zero provider connections, so
// without a seeded connection every fallback candidate is confirmed
// unusable and callVisionModel has nothing left to retry — seed one
// credentialed connection so the fallback-retry mechanics under test here
// stay independent of that (unrelated) credential-filtering behavior.
await createProviderConnection({
  provider: "anthropic",
  authType: "apikey",
  name: "vision-bridge-callmodel-test-fallback",
  apiKey: "sk-test-anthropic-fallback",
  isActive: true,
});

const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  // Close the SQLite handle before rmdir, or Windows refuses with EPERM
  // (learned: DB-handle cleanup rule — see AGENTS.md PII learnings §3).
  try {
    const { closeDbInstance } = await import("../../../src/lib/db/core.ts");
    closeDbInstance();
  } catch {
    // already closed / never opened
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Helper: build a minimal OpenAI-compat image data URI
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("callVisionModel falls through to next model when primary fails", async () => {
  let fetchCallCount = 0;
  // The fallback candidate can legitimately resolve to either an OpenAI-compatible
  // model (POST .../chat/completions, { choices: [{ message: { content } }] }) or an
  // Anthropic model (POST .../v1/messages, { content: [{ type: "text", text }] }) —
  // vision-bridge router priority (#7204) now ranks credentialed providers (openai/
  // anthropic) ahead of opencode-*, so the mock must match whichever shape the
  // fallback attempt actually requests instead of assuming OpenAI's shape.
  const FALLBACK_TEXT = "fallback model description";

  globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      // First call (primary model) — simulate API error
      throw new Error("mock: primary model unavailable");
    }
    // Second call (fallback model) — return a valid response shaped for whichever
    // API the fallback model actually calls.
    const urlStr = typeof url === "string" ? url : url.toString();
    const isAnthropicCall = urlStr.includes("/v1/messages");
    const body = isAnthropicCall
      ? JSON.stringify({ content: [{ type: "text", text: FALLBACK_TEXT }] })
      : JSON.stringify({ choices: [{ message: { content: FALLBACK_TEXT } }] });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await callVisionModel(
    TINY_PNG,
    { model: "openai/gpt-4o-mini", prompt: "Describe this image." },
    "sk-test-key",
    { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 2 }
  );

  assert.equal(fetchCallCount, 2, "must have attempted exactly 2 models (primary + 1 fallback)");
  assert.equal(result, FALLBACK_TEXT, "must return the fallback model's response");
});

test("callVisionModel throws when ALL models fail", async () => {
  let fetchCallCount = 0;

  globalThis.fetch = async () => {
    fetchCallCount++;
    throw new Error(`mock: model-${fetchCallCount} unavailable`);
  };

  await assert.rejects(
    () =>
      callVisionModel(
        TINY_PNG,
        { model: "openai/gpt-4o-mini", prompt: "Describe this image." },
        "sk-test-key",
        { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 2 }
      ),
    (err: Error) => {
      assert.ok(
        err.message.includes("unavailable") || err.message.includes("All vision models failed"),
        `error should indicate failure, got: ${err.message}`
      );
      return true;
    }
  );

  assert.ok(fetchCallCount >= 1, "must have attempted at least 1 model");
});

// ── usage_history persistence (#vision-bridge-health) ───────────────────────
//
// Every describe attempt (success OR failure) must land in usage_history so
// the rolling success-rate stats (getModelLatencyStats) that auto-combo
// routing consumes include vision-bridge failures, and so the signal survives
// restarts (the in-memory latencyStore is 5-minute, last-50 only).

const { callVisionModel: callVisionModel2 } =
  await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");
const { createProviderConnection: createOpenAIConnection } =
  await import("../../../src/lib/db/providers.ts");
// Persist tests target the openai candidate explicitly (fixedModel), so seed
// an openai connection — the file already seeds anthropic for the fallback tests.
await createOpenAIConnection({
  provider: "openai",
  authType: "apikey",
  name: "vision-bridge-callmodel-test-persist",
  apiKey: "sk-test-openai-persist",
  isActive: true,
});

test("callVisionModel persists success AND failure attempts via persistUsage", async () => {
  const persisted: Array<{
    provider: string;
    model: string;
    success: boolean;
    errorCode: string | null;
  }> = [];

  let fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount++;
    if (fetchCallCount === 1) throw new Error("mock: primary flaked");
    return new Response(
      JSON.stringify({
        // The fallback candidate is an Anthropic-wire model (claude-*) — the
        // /v1/messages answer shape is what callVisionModelSingle parses.
        content: [{ type: "text", text: "A convincing detailed image description." }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const result = await callVisionModel2(
    TINY_PNG,
    {
      model: "openai/gpt-4o-mini",
      prompt: "Describe this image.",
      persistUsage: async (entry) => {
        persisted.push({
          provider: entry.provider,
          model: entry.model,
          success: entry.success,
          errorCode: entry.errorCode ?? null,
        });
      },
    },
    "sk-test-key",
    { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 2 }
  );

  assert.equal(result, "A convincing detailed image description.");
  assert.equal(persisted.length, 2, "both the failed and the successful attempt must persist");
  assert.deepEqual(persisted[0], {
    provider: "openai",
    model: "gpt-4o-mini",
    success: false,
    errorCode: "mock: primary flaked",
  });
  // The fallback chain resolves to a different describer (anthropic/claude-fable-5)
  // once the openai primary fails — the success row must reflect the model that
  // ACTUALLY produced the description.
  assert.deepEqual(persisted[1], {
    provider: "anthropic",
    model: "claude-fable-5",
    success: true,
    errorCode: null,
  });
});

test("persistUsage receives meta-response attempts as failures", async () => {
  const persisted: Array<{ success: boolean; errorCode: string | null }> = [];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: "I will analyze the image for you right away, my friend." } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  await assert.rejects(
    () =>
      callVisionModel2(
        TINY_PNG,
        {
          model: "openai/gpt-4o-mini",
          prompt: "Describe this image.",
          persistUsage: async (entry) => {
            persisted.push({ success: entry.success, errorCode: entry.errorCode ?? null });
          },
        },
        "sk-test-key",
        { fixedModel: "openai/gpt-4o-mini", maxFallbackAttempts: 1 }
      ),
    /meta response/
  );

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].success, false);
  assert.equal(persisted[0].errorCode, "vision_bridge_meta_response");
});
