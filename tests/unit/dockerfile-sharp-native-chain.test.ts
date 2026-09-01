/**
 * Guards the Dockerfile's sharp native-chain reconciliation and standalone
 * smoke check.
 *
 * npm >= 12 silently skips sharp's SECOND-level optional dependencies
 * (`@img/sharp-libvips-*` — the libvips .so runtimes the first-level
 * `@img/sharp-linux-*` bindings dlopen) during `npm ci`, while still
 * installing the bindings themselves. The first `next build` import of sharp
 * then dies with `ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open
 * shared object file` — observed 2026-09-01 on linux-x64, killing the image
 * build at page-data collection.
 *
 * The Dockerfile therefore:
 *   1. re-installs `@img/sharp-libvips-linux-x64` explicitly, with the version
 *      read from the committed package-lock.json (always matches the pinned
 *      sharp line), before `npm run build`;
 *   2. smoke-requires sharp in the builder node_modules immediately after;
 *   3. smoke-requires sharp from the standalone tree AFTER the build — sharp
 *      is not explicitly COPY'd into the runner (unlike better-sqlite3), so it
 *      must survive Next's tracing into .build/next/standalone/node_modules
 *      together with its @img runtime. A tracing gap would otherwise only
 *      surface as ERR_DLOPEN_FAILED on the first image request (the same
 *      "source tests green, artifact broken" class as the v3.8.50
 *      better-sqlite3 driver regression).
 *
 * Asserted statically (the sandbox cannot run `docker build`), following the
 * dockerfile-dashboard-embed-arg-10273.test.ts pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lines = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8").split("\n");

/** Line indices bounding a named stage: its FROM up to the next FROM. */
function stageRange(name: string): { start: number; end: number } {
  const start = lines.findIndex((l) =>
    new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\b`, "i").test(l.trim())
  );
  assert.ok(start >= 0, `Dockerfile must declare a \`${name}\` stage`);
  const after = lines.slice(start + 1).findIndex((l) => /^FROM\s+/i.test(l.trim()));
  return { start, end: after === -1 ? lines.length : start + 1 + after };
}

test("builder reconciles @img/sharp-libvips-linux-x64 from the lockfile before the build", () => {
  const { start, end } = stageRange("builder");
  const stage = lines.slice(start, end);

  const lockReadIdx = stage.findIndex(
    (l) => /package-lock\.json/.test(l) && /sharp-libvips-linux-x64/.test(l)
  );
  assert.ok(
    lockReadIdx >= 0,
    "builder must read the @img/sharp-libvips-linux-x64 version from package-lock.json " +
      "(hardcoding it would drift from the pinned sharp line)"
  );

  const installIdx = stage.findIndex((l) =>
    /@img\/sharp-libvips-linux-x64@\$\{LIBVIPS_X64\}/.test(l)
  );
  assert.ok(
    installIdx > lockReadIdx,
    "builder must `npm install` @img/sharp-libvips-linux-x64 at the lockfile-derived version " +
      "after reading it — npm >= 12 skips this second-level optional dep during `npm ci`"
  );
  assert.ok(
    /--no-save/.test(stage[installIdx] ?? "") || /--no-save/.test(stage[installIdx - 1] ?? ""),
    "the reconcile install must be --no-save (package.json/lockfile must not be mutated)"
  );
  assert.ok(
    /--ignore-scripts/.test(stage[installIdx] ?? "") ||
      /--ignore-scripts/.test(stage[installIdx - 1] ?? ""),
    "the reconcile install must keep --ignore-scripts (install-script policy is build-wide)"
  );
});

test("builder smoke-requires sharp before `npm run build`", () => {
  const { start, end } = stageRange("builder");
  const stage = lines.slice(start, end);

  const smokeIdx = stage.findIndex((l) => /const sharp = require\('sharp'\)/.test(l));
  assert.ok(
    smokeIdx >= 0,
    "builder must require('sharp') and assert the libvips version right after the reconcile " +
      "install — the smoke check fails the BUILD loudly instead of shipping a broken native chain"
  );
  assert.ok(
    /versions/.test(stage[smokeIdx] ?? "") || /vips/.test(stage[smokeIdx + 1] ?? ""),
    "the builder smoke check must assert the libvips runtime loaded, not just that sharp resolved"
  );

  const buildIdx = stage.findIndex((l) => /\bnpm run build\b/.test(l));
  assert.ok(
    buildIdx > smokeIdx,
    "the sharp reconcile + smoke must run BEFORE `npm run build` — page-data collection imports " +
      "sharp, so an unreconciled tree kills the build at that phase"
  );
});

test("standalone tree is smoke-tested for the sharp native chain after the build", () => {
  const { start, end } = stageRange("builder");
  const stage = lines.slice(start, end);

  const buildIdx = stage.findIndex((l) => /\bnpm run build\b/.test(l));

  const standaloneSmokeIdx = stage.findIndex(
    (l) => /resolve\('sharp'\)/.test(l) && /standalone/.test(l) && /versions\.vips|\.vips\b/.test(l)
  );
  assert.ok(
    standaloneSmokeIdx >= 0,
    "the builder must resolve sharp from the .build/next/standalone root and assert its libvips " +
      "runtime — sharp is not explicitly COPY'd into the runner (unlike better-sqlite3), so a " +
      "Next tracing gap would otherwise ship an image that only fails on first request"
  );
  assert.ok(
    standaloneSmokeIdx > buildIdx,
    "the standalone sharp smoke must run AFTER `npm run build` (it verifies the artifact)"
  );

  const standaloneRootAnchor = stage.findIndex((l) =>
    /createRequire\('\/app\/\.build\/next\/standalone\/package\.json'\)/.test(l)
  );
  assert.ok(
    standaloneRootAnchor >= 0,
    "the standalone smoke must anchor resolution at the standalone package.json (same mechanism " +
      "as the existing js-tiktoken check)"
  );
});

test("runner-base explicitly COPYs better-sqlite3 (the sharp check must not replace it)", () => {
  const { start, end } = stageRange("runner-base");
  const stage = lines.slice(start, end);

  const copyIdx = stage.findIndex((l) =>
    /^COPY --from=builder \/app\/node_modules\/better-sqlite3 /.test(l.trim())
  );
  assert.ok(
    copyIdx >= 0,
    "runner-base must keep the explicit better-sqlite3 COPY — the v3.8.50 standalone driver " +
      "regression shipped because that package depended on tracing alone"
  );
});
