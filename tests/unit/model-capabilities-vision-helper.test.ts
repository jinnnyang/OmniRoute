/**
 * hasVisionCapability — the single shared verdict for "can this model accept
 * image input?" (auto-combo vision scoring design, task 1).
 *
 * Semantics under test:
 *  - resolved supportsVision === true  → true
 *  - resolved supportsVision === false → false. Authoritative verdicts
 *    (#9195 custom override, static registry/spec, synced catalog, modalities)
 *    must NEVER be overturned by the #4072 name heuristic — the flip bug that
 *    re-admitted known text-only models because their id contains "-vision".
 *  - resolved supportsVision === null  → isVisionModelId fallback (zero-touch
 *    path for brand-new vision models that no catalog knows yet).
 */
import test from "node:test";
import assert from "node:assert/strict";

const modelCapabilities = await import("../../src/lib/modelCapabilities.ts");

/** Snapshot with a fail-open DB stub so unit tests never touch real SQLite. */
function snapshotWithOverrides(
  entries: Array<{ provider: string; models: Array<{ id: string; supportsVision: boolean }> }>
) {
  const rows = entries.map((entry) => ({
    key: entry.provider,
    value: JSON.stringify(entry.models),
  }));
  return modelCapabilities.createModelCapabilityResolutionSnapshot({
    customModelVision: {
      getDatabase: () => ({
        prepare() {
          return {
            all: () => rows,
            get: () => rows[0] ?? undefined,
          };
        },
      }),
    },
  });
}

const NO_DB_SNAPSHOT = modelCapabilities.createModelCapabilityResolutionSnapshot({
  customModelVision: {
    getDatabase: () => {
      throw new Error("no sqlite in unit test");
    },
  },
});

test("explicit true from static registry wins", () => {
  assert.equal(modelCapabilities.hasVisionCapability("openai", "gpt-4o", NO_DB_SNAPSHOT), true);
  assert.equal(
    modelCapabilities.hasVisionCapability("minimax", "MiniMax-M3", NO_DB_SNAPSHOT),
    true
  );
});

test("name heuristic is the fallback for unknown entries (null → id fragments)", () => {
  // Unknown provider/model: resolution returns null → "-vision" fragment hit.
  assert.equal(
    modelCapabilities.hasVisionCapability("acme", "acme-ultra-vision", NO_DB_SNAPSHOT),
    true
  );
  // Unknown and no vision fragment in the id.
  assert.equal(modelCapabilities.hasVisionCapability("acme", "acme-text", NO_DB_SNAPSHOT), false);
});

test("#9195 explicit supportsVision:false is authoritative over the name heuristic", () => {
  const snapshot = snapshotWithOverrides([
    {
      provider: "acme",
      models: [{ id: "acme-ultra-vision", supportsVision: false }],
    },
  ]);
  // "-vision" fragment would match, but the operator override says text-only.
  assert.equal(modelCapabilities.hasVisionCapability("acme", "acme-ultra-vision", snapshot), false);
});
