import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bare-routing-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getModelInfoCore } = await import("../../open-sse/services/model.ts");

// #FIX: end-to-end precedence checks for bare model routing. These guard
// the contract that:
//  - Bare Codex-default model ids (gpt-5.6-sol, gpt-5.5, etc.) route to
//    `codex` ahead of any other provider that also catalogs them — bounded by
//    #9447 to installs where a codex connection is actually ACTIVE, so an
//    OpenAI-only install is not handed a provider it has no credentials for.
//    Ids that only codex catalogs (the tier variants) need no connection:
//    there is no alternative provider to preempt.
//  - Bare model ids shared between providers (e.g. claude-opus-5 across
//    anthropic/claude/github/agentrouter/etc.) never silently route to a
//    provider whose static registry does NOT actually catalog them (the
//    synced-catalog bug).
//  - Explicit `provider/model` prefixes always win over the bare inference.

test.before(async () => {
  await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "codex@example.com",
    providerSpecificData: { workspaceId: "ws-routing-fallback" },
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("bare gpt-5.6-sol routes to codex (precedence via CODEX_NATIVE_UNPREFIXED_MODELS)", async () => {
  const info = await getModelInfoCore("gpt-5.6-sol", null);
  assert.equal(
    info.provider,
    "codex",
    "bare gpt-5.6-sol must route to codex — the Codex CLI default"
  );
});

test("bare gpt-5.5 routes to codex", async () => {
  const info = await getModelInfoCore("gpt-5.5", null);
  assert.equal(info.provider, "codex");
});

test("bare gpt-5.6-sol-xhigh (a tier id) routes to codex", async () => {
  const info = await getModelInfoCore("gpt-5.6-sol-xhigh", null);
  assert.equal(info.provider, "codex");
});

test("explicit prefix overrides bare precedence (agentrouter/gpt-5.6-sol)", async () => {
  const info = await getModelInfoCore("agentrouter/gpt-5.6-sol", null);
  assert.equal(info.provider, "agentrouter");
});

test("explicit prefix overrides bare precedence (openai/gpt-5.6-sol)", async () => {
  const info = await getModelInfoCore("openai/gpt-5.6-sol", null);
  assert.equal(info.provider, "openai");
});
