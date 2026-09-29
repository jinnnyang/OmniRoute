import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, it } from "node:test";

// Pinned to the installed devDependency (package.json: opencode-ai 1.18.21).
// The schema assertions below (limit.output, max_output_tokens) are what #8849
// actually guards; the version equality pins binary+package drift.
const OPENCODE_VERSION = "1.18.21";
const require = createRequire(import.meta.url);
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-opencode-8849-"));
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;

process.env.HOME = testHome;

after(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function runOpencode(binary: string, args: string[]) {
  const xdgRoot = path.join(testHome, "xdg");
  const result = spawnSync(binary, args, {
    cwd: testHome,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: testHome,
      XDG_CONFIG_HOME: path.join(xdgRoot, "config"),
      XDG_DATA_HOME: path.join(xdgRoot, "data"),
      XDG_CACHE_HOME: path.join(xdgRoot, "cache"),
      XDG_STATE_HOME: path.join(xdgRoot, "state"),
      NO_COLOR: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  });

  assert.ifError(result.error);
  return result;
}

const packageJsonPath = require.resolve("opencode-ai/package.json");
const opencodeBinary = path.join(path.dirname(packageJsonPath), "bin", "opencode.exe");

// The npm package ships a 479-byte postinstall stub for bin/opencode.exe; the
// real binary is fetched by its postinstall.mjs, which is skipped under
// --ignore-scripts (local installs, Docker builder). This test validates the
// generated config against the REAL CLI, so a stub/unavailable binary must
// SKIP (environment class), not fail the suite.
function opencodeUsable(): boolean {
  if (!fs.existsSync(opencodeBinary)) return false;
  const probe = spawnSync(opencodeBinary, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
  return !probe.error && probe.status === 0;
}

it(
  "#8849 generated config is accepted by pinned OpenCode schema and startup",
  { skip: !opencodeUsable() && "opencode binary unavailable (postinstall stub)" },
  async () => {
    const version = runOpencode(opencodeBinary, ["--version"]);
    assert.strictEqual(version.status, 0, version.stderr);
    assert.strictEqual(version.stdout.trim(), OPENCODE_VERSION);

    const catalog = {
      object: "list",
      data: [
        { id: "context-only", context_length: 131072 },
        { id: "context-input", context_length: 131072, max_input_tokens: 100000 },
        {
          id: "context-input-output",
          context_length: 131072,
          max_input_tokens: 100000,
          max_output_tokens: 32768,
        },
        { id: "no-limit-metadata" },
      ],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const { generateOpencodeConfig } =
      await import("../../src/lib/cli-helper/config-generator/opencode.ts");
    const generatedConfig = await generateOpencodeConfig({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-test",
      providerId: "issue8849",
    });

    const configDir = path.join(testHome, "xdg", "config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), generatedConfig);

    const configCheck = runOpencode(opencodeBinary, ["debug", "config", "--pure"]);
    assert.strictEqual(configCheck.status, 0, configCheck.stderr);
    assert.doesNotMatch(configCheck.stderr, /Missing key .*\.limit\.output/);
    const resolvedConfig = JSON.parse(configCheck.stdout);
    assert.ok(resolvedConfig.provider.issue8849.models["context-only"].limit.output > 0);
    assert.strictEqual(
      resolvedConfig.provider.issue8849.models["context-input-output"].limit.output,
      32768
    );
    // 1.18.8 left no-metadata models with limit === undefined; 1.18.21 fills a
    // default (context 128000 / output 8192). Pin the invariant (present +
    // positive) instead of the version-specific value so future opencode defaults
    // do not re-break the suite.
    const noLimitLimit = resolvedConfig.provider.issue8849.models["no-limit-metadata"].limit;
    assert.ok(noLimitLimit && noLimitLimit.output > 0);

    const startup = runOpencode(opencodeBinary, ["debug", "startup", "--pure"]);
    assert.strictEqual(startup.status, 0, startup.stderr);
    assert.match(startup.stdout.trim(), /^\d+(?:\.\d+)?$/);
    assert.doesNotMatch(startup.stderr, /Missing key .*\.limit\.output/);
  }
);
