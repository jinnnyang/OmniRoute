/**
 * scripts/test/ark-live-smoke.mjs
 *
 * Real-egress smoke against Volcengine Ark (domestic endpoint) through the
 * FULL OmniRoute pipeline (route → auth → executor → fetch → response parse).
 *
 * Gate / key:
 *   Reads OMNIROUTE_TEST_ARK_API_KEY from the environment. If a file
 *   `.env.test` exists next to this repo's package.json, its
 *   OMNIROUTE_TEST_ARK_API_KEY=... line is used as a fallback (that file is
 *   gitignored — `.env*` — so the key never lands in git).
 *
 * Why the fetch shim:
 *   The `openai` provider's registry baseUrl is static (api.openai.com) and the
 *   unit-suite convention is to mock fetch, so we intercept at the fetch
 *   boundary only for this smoke: rewrite the URL to Ark's OpenAI-compatible
 *   path and the body `model` to the Ark model id. No production code changes.
 *
 * Usage:
 *   node scripts/test/ark-live-smoke.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 0. Key resolution: process env first, then .env.test fallback.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARK_MODEL = process.env.OMNIROUTE_TEST_ARK_MODEL || "ark-code-latest";
const ARK_BASE =
  process.env.OMNIROUTE_TEST_ARK_BASE || "https://ark.cn-beijing.volces.com/api/plan/v3";
const OPENAI_TARGET = "https://api.openai.com/v1/chat/completions";
const ARK_TARGET = `${ARK_BASE.replace(/\/+$/, "")}/chat/completions`;

function resolveKey() {
  if (process.env.OMNIROUTE_TEST_ARK_API_KEY) {
    return { key: process.env.OMNIROUTE_TEST_ARK_API_KEY, source: "process env" };
  }
  const envTestPath = path.join(REPO_ROOT, ".env.test");
  if (fs.existsSync(envTestPath)) {
    for (const line of fs.readFileSync(envTestPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*OMNIROUTE_TEST_ARK_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return { key: m[1].trim(), source: `.env.test (${envTestPath})` };
    }
  }
  return null;
}

const keyInfo = resolveKey();
if (!keyInfo) {
  console.error(
    [
      "[ark-live-smoke] No API key found.",
      "",
      "Create OmniRoute/.env.test (already gitignored via .env*) with:",
      "",
      "    OMNIROUTE_TEST_ARK_API_KEY=your-volcengine-ark-key",
      "",
      `Then re-run: node scripts/test/ark-live-smoke.mjs`,
      `(endpoint: ${ARK_TARGET}, model: ${ARK_MODEL})`,
    ].join("\n")
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Isolated storage + connection.
// ---------------------------------------------------------------------------
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ark-smoke-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ark-smoke-secret";
process.env.REQUIRE_API_KEY = "false";
process.env.DASHBOARD_PASSWORD = "";
delete process.env.JWT_SECRET;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const semanticCacheModule = await import("../../src/lib/semanticCache.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const { clearIdempotency } = await import("../../src/lib/idempotencyLayer.ts");

await settingsDb.updateSettings({ semanticCacheEnabled: false });
semanticCacheModule.clearCache();

const conn = await providersDb.createProviderConnection({
  provider: "openai",
  authType: "apikey",
  name: "ark-live-smoke",
  apiKey: keyInfo.key,
  isActive: true,
  testStatus: "active",
});
console.log(`[ark-live-smoke] connection ${conn.id} (key from ${keyInfo.source})`);

// ---------------------------------------------------------------------------
// 2. Fetch shim: rewrite openai URL + model to the Ark endpoint.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const urlStr = String(url);
  if (urlStr === OPENAI_TARGET || urlStr === OPENAI_TARGET + "/") {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    if (body && typeof body.model === "string") body.model = ARK_MODEL;
    const rewrittenInit = { ...init, body: JSON.stringify(body) };
    console.log(`[ark-live-smoke] fetch → ${ARK_TARGET} model=${body?.model}`);
    return originalFetch(ARK_TARGET, rewrittenInit);
  }
  return originalFetch(url, init);
};

// ---------------------------------------------------------------------------
// 3. Fire the real request.
// ---------------------------------------------------------------------------
function makeRequest(extraHeaders = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini", // rewritten to ARK_MODEL at the fetch boundary
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 16,
      stream: false,
      temperature: 0,
    }),
  });
}

let exitCode = 0;
try {
  const started = Date.now();
  const response = await chatRoute.POST(
    makeRequest({ "X-OmniRoute-No-Cache": "true", "X-Request-Id": `ark-smoke-${Date.now()}` })
  );
  const body = await response.json();
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);

  console.log(`[ark-live-smoke] HTTP ${response.status} in ${elapsed}s`);
  console.log("[ark-live-smoke] body:", JSON.stringify(body, null, 2));

  if (response.status !== 200) {
    console.error(`[ark-live-smoke] FAILED — expected 200, got ${response.status}`);
    exitCode = 1;
  } else {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      console.error("[ark-live-smoke] FAILED — no assistant content in 200 response");
      exitCode = 1;
    } else {
      console.log(`[ark-live-smoke] assistant: ${JSON.stringify(content)}`);
      console.log("[ark-live-smoke] PASSED — full pipeline reached Ark and parsed the response");
    }
  }
} catch (err) {
  console.error("[ark-live-smoke] FAILED with exception:", err?.message || err);
  exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  clearInflight();
  clearIdempotency();
  resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

process.exit(exitCode);
