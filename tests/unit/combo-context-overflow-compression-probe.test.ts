import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Combo context-overflow contract after #10162 and the removal of the
 * #10225/#10503 deferral gate (knownContextOverflow.ts is gone):
 *
 * - Combo NEVER hard-400s an oversized request on approximate chars/4 estimates —
 *   the estimate is advisory; the request reaches chatCore, whose post-compression
 *   enforceOutputTokenBudget is the final context gate.
 * - chatCore's compression pipeline is what actually bounds oversized bodies:
 *   a genuinely compressible history dispatches COMPRESSED upstream; a body that
 *   still cannot fit is rejected locally with zero upstream dispatch.
 *
 * The former deferContextOverflowWhenCompressible / compressionExclusions /
 * sourceFormat threading existed only to feed the deleted preflight gate and is
 * removed with it.
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-overflow-compress-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { updateCompressionSettings } = await import("../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

test.after(() => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  clearModelsDevCapabilities();
});

function capabilityEntry(limitContext: number | null) {
  return {
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
  };
}

function target(modelStr: string) {
  return {
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

// A generic Responses-API body whose estimate lands near `tokens` tokens (4 chars/token).
// Uses `input:` (not `messages:`) to mirror the OpenCode/Codex Responses surface.
function bigResponsesBody(tokens: number) {
  return { input: [["user", "x".repeat(tokens * 4)]] };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

test("#10162 combo does not early-400 an over-limit request on advisory estimates", async () => {
  saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
  let dispatches = 0;

  const response = await handleComboChat({
    body: bigResponsesBody(275_000),
    combo: {
      name: "codex-compress-overflow",
      strategy: "priority",
      models: ["codex/gpt-5.6-terra"],
    },
    clientManagedResponsesContext: false,
    isModelAvailable: async () => true,
    handleSingleModel: async () => {
      dispatches += 1;
      return new Response("ok", { status: 200 });
    },
    log: noopLog,
  });

  assert.notEqual(response.status, 400, "compression-enabled request must reach chatCore");
  assert.equal(dispatches, 1, "must dispatch so chatCore compaction runs first");
});

test("#10162 combo dispatches an over-limit request even with compression disabled", async () => {
  saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
  let dispatches = 0;

  const response = await handleComboChat({
    body: bigResponsesBody(275_000),
    combo: {
      name: "codex-compress-disabled",
      strategy: "priority",
      models: ["codex/gpt-5.6-terra"],
    },
    clientManagedResponsesContext: false,
    isModelAvailable: async () => true,
    handleSingleModel: async () => {
      dispatches += 1;
      return new Response("ok", { status: 200 });
    },
    log: noopLog,
  });

  // #10162: approximate token estimates are advisory. Combo must not
  // hard-400 locally just because chars/4 exceeds a catalog window.
  assert.notEqual(response.status, 400, "advisory estimates must not hard-400 (#10162)");
  assert.equal(dispatches, 1, "request must reach handleSingleModel when estimates are advisory");
});

// #10501-sweep #10503 — the deferral above is NOT target-aware by default: it only
// checks operator-named compression exclusions, never whether chatCore will actually
// attempt compression for the resolved target. handleChatCore.ts unconditionally sets
// `compressionExcluded = nativeCodexPassthrough || ...` for a verified native Codex
// Responses passthrough target (open-sse/handlers/chatCore.ts) — deferring the
// preflight there means an oversized request sails past BOTH gates uncompressed. These
// tests pin the fix: a native-codex-passthrough target must never count toward "can
// compress", so the hard preflight stays active and no upstream dispatch happens.
// NOTE on `clientManagedResponsesContext: false` below: these tests deliberately do
// NOT set it, to isolate the fix from the PRE-EXISTING, unrelated early-return a few
// lines above in knownContextOverflow.ts ("Native Codex Responses clients compact
// their own item history") — that block ALSO returns null for an all-codex pool, but
// only when `clientManagedResponsesContext === true` (a VERIFIED native client). The
// bug this fix targets is broader: chatCore's `shouldUseNativeCodexPassthrough` short-
// circuits to true for `provider === "codex"` regardless of verification (see
// passthroughHelpers.ts), so an UNVERIFIED request that nonetheless targets a `codex`
// combo member over `/v1/responses` in openai-responses format still hits chatCore's
// compression bypass — exactly the gap `sourceFormat`/`endpointPath` (not the looser
// `clientManagedResponsesContext` flag) now closes.
test("#10162 combo does not hard-400 native-codex-passthrough pools on advisory estimates", async () => {
  saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
  let dispatches = 0;

  const response = await handleComboChat({
    body: bigResponsesBody(275_000),
    combo: {
      name: "codex-native-passthrough-overflow",
      strategy: "priority",
      models: ["codex/gpt-5.6-terra"],
    },

    isModelAvailable: async () => true,
    handleSingleModel: async () => {
      dispatches += 1;
      return new Response("ok", { status: 200 });
    },
    log: noopLog,
  });

  // #10162: combo no longer hard-400s on approximate overflow for native Codex
  // passthrough either. Fail-fast after compression (if any) lives in chatCore.
  assert.notEqual(response.status, 400, "advisory estimates must not hard-400 native Codex pools");
  assert.equal(dispatches, 1, "request must reach handleSingleModel");
});

// #10503 item 2 — drive the REAL chatCore compression pipeline end-to-end (not just the
// pure getKnownContextOverflow helper): a genuinely compressible multi-turn request must
// have chatCore's proactive/last-resort compression actually run and dispatch the
// COMPRESSED body upstream; a request that is STILL too large after compression must be
// rejected locally with zero upstream dispatch (fail-fast, matching the codex-passthrough
// case above in outcome, but via the "compression tried and wasn't enough" path instead
// of "compression was never eligible").
//
// Uses an unregistered synthetic provider + CONTEXT_LENGTH_<PROVIDER> env override
// (same technique as tests/unit/chatcore-combo-context-limit-8378.test.ts) so the
// context limit is small and deterministic without depending on any real catalog entry.
// Compression targets conversation HISTORY (older turns), not the current terminal
// message — this is why the fixtures below build many small history turns plus one
// short final turn (compressible case) vs one large, irreducible final turn
// (still-too-large case).
const CHATCORE_PROBE_PROVIDER = "combo10503probe";
const CHATCORE_PROBE_MODEL = "combo10503probemodel";
const CHATCORE_LIMIT_ENV = "CONTEXT_LENGTH_COMBO10503PROBE";

function buildHistoryBody(turns: number, finalMessageChars: number) {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: "You are a helpful assistant." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content: `Message number ${i}: Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mno pqr stu.`,
    });
    messages.push({
      role: "assistant",
      content: `Reply number ${i}: verbose filler answer with extra padding text for realism.`,
    });
  }
  messages.push({ role: "user", content: "FINAL: " + "z".repeat(finalMessageChars) });
  return { model: CHATCORE_PROBE_MODEL, messages, stream: false };
}

async function invokeChatCoreCapturingUpstream(body: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  let dispatched = false;
  let sentBodyJson: string | null = null;
  globalThis.fetch = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    dispatched = true;
    sentBodyJson = init.body ? String(init.body) : null;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-10503",
        object: "chat.completion",
        model: CHATCORE_PROBE_MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const result = await handleChatCore({
      body,
      modelInfo: {
        provider: CHATCORE_PROBE_PROVIDER,
        model: CHATCORE_PROBE_MODEL,
        extendedContext: false,
      },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
    } as never);
    return { result, dispatched, sentBodyJson };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("#10503 real chatCore path: a compressible request dispatches the COMPRESSED (not raw) body upstream", async () => {
  const originalEnv = process.env[CHATCORE_LIMIT_ENV];
  process.env[CHATCORE_LIMIT_ENV] = "500";
  await updateCompressionSettings({
    enabled: true,
    defaultMode: "standard",
    autoTriggerTokens: 1,
    autoTriggerMode: "standard",
    engines: { rtk: { enabled: true }, caveman: { enabled: true } },
  } as never);
  try {
    const body = buildHistoryBody(150, 50);
    const rawLen = JSON.stringify(body.messages).length;

    const { dispatched, sentBodyJson } = await invokeChatCoreCapturingUpstream(body);

    assert.ok(
      dispatched,
      "compression must let a genuinely compressible request reach chatCore's dispatch"
    );
    assert.ok(sentBodyJson, "the dispatched request must carry a body");
    assert.ok(
      sentBodyJson!.length < rawLen * 0.5,
      `expected the DISPATCHED body (${sentBodyJson!.length} chars) to be substantially ` +
        `smaller than the raw request (${rawLen} chars) — proves compression actually ran ` +
        `and its output (not the raw body) is what reached upstream`
    );
  } finally {
    if (originalEnv === undefined) delete process.env[CHATCORE_LIMIT_ENV];
    else process.env[CHATCORE_LIMIT_ENV] = originalEnv;
  }
});

test("#10503 real chatCore path: STILL too large after compression → local rejection, ZERO upstream dispatch", async () => {
  const originalEnv = process.env[CHATCORE_LIMIT_ENV];
  process.env[CHATCORE_LIMIT_ENV] = "50";
  await updateCompressionSettings({
    enabled: true,
    defaultMode: "standard",
    autoTriggerTokens: 1,
    autoTriggerMode: "standard",
    engines: { rtk: { enabled: true }, caveman: { enabled: true } },
  } as never);
  try {
    // The final turn alone (1000 chars, irreducible — compression trims HISTORY, not
    // the current terminal message) already exceeds the 50-token limit, so no amount
    // of history compaction can make this fit.
    const body = buildHistoryBody(150, 1000);

    const { result, dispatched } = await invokeChatCoreCapturingUpstream(body);

    assert.equal(
      dispatched,
      false,
      "fail-fast: a request that cannot fit even after compression must never reach fetch()"
    );
    assert.equal((result as { success: boolean }).success, false);
    const failure = result as { success: false; error?: string; rawMessage?: string };
    const message = failure.rawMessage ?? failure.error ?? "";
    assert.match(message, /exceeds/i);
  } finally {
    if (originalEnv === undefined) delete process.env[CHATCORE_LIMIT_ENV];
    else process.env[CHATCORE_LIMIT_ENV] = originalEnv;
  }
});
