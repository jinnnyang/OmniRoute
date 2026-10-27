/**
 * `hideNoauthProviders` and `hideAllProviders` settings toggles filter the unified
 * `/v1/models` catalog. Both default to false (opt-in). Routing still works for
 * hidden ids; only the listing changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hide-noauth-all-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-hide-noauth-all-test-secret";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers/noauth.ts");

type CatalogRow = { id: string; owned_by?: string };

const NOAUTH_OWNERS = new Set<string>(
  Object.values(NOAUTH_PROVIDERS as Record<string, { id: string; alias?: string }>).flatMap((p) =>
    p.alias ? [p.id, p.alias] : [p.id]
  )
);

async function fetchCatalog(): Promise<CatalogRow[]> {
  // The catalog is cached by (prefix, client, key, flags); reset so each call rebuilds.
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const res = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", { method: "GET" })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: CatalogRow[] };
  return body.data;
}

const isNoauth = (row: CatalogRow) => NOAUTH_OWNERS.has(row.owned_by ?? "");
const isCombo = (row: CatalogRow) => row.owned_by === "combo" || row.id.startsWith("auto/");

test.before(async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-main",
    apiKey: "sk-test",
    isActive: true,
  });
});

test.beforeEach(async () => {
  await settingsDb.updateSettings({ hideNoauthProviders: false, hideAllProviders: false });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("hideNoauthProviders and hideAllProviders default to false", async () => {
  const defaults = await settingsDb.getSettings();
  assert.equal(defaults.hideNoauthProviders, false);
  assert.equal(defaults.hideAllProviders, false);
});

test("both toggles off: no-auth providers, connected providers and combos are all listed", async () => {
  const rows = await fetchCatalog();
  assert.ok(rows.some(isNoauth), "expected no-auth provider models in the default catalog");
  assert.ok(
    rows.some((r) => r.owned_by === "openai"),
    "expected the connected openai models"
  );
  assert.ok(rows.some(isCombo), "expected combos / auto/* ids");
});

test("hideNoauthProviders=true removes no-auth providers but keeps connected providers and combos", async () => {
  await settingsDb.updateSettings({ hideNoauthProviders: true });
  const rows = await fetchCatalog();

  const leaked = rows.filter(isNoauth).map((r) => r.id);
  assert.deepEqual(leaked, [], `no-auth models leaked: ${leaked.slice(0, 5).join(", ")}`);
  assert.ok(
    rows.some((r) => r.owned_by === "openai"),
    "connected provider models must remain"
  );
  assert.ok(rows.some(isCombo), "combos must remain");
});

test("hideAllProviders=true exposes only combos and auto/* ids", async () => {
  await settingsDb.updateSettings({ hideAllProviders: true });
  const rows = await fetchCatalog();

  assert.ok(rows.length > 0, "combos must still be listed");
  const leaked = rows.filter((r) => !isCombo(r)).map((r) => r.id);
  assert.deepEqual(leaked, [], `provider models leaked: ${leaked.slice(0, 5).join(", ")}`);
});

test("toggling a setting changes the cached catalog instead of serving the old one", async () => {
  // Both flags are part of the catalog cache key; without them a toggle would be
  // ignored until the TTL expired. Do not reset the builder between the two calls.
  const call = async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    return ((await res.json()) as { data: CatalogRow[] }).data;
  };

  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  const before = await call();
  assert.ok(before.some(isNoauth));

  await settingsDb.updateSettings({ hideNoauthProviders: true });
  const afterNoauth = await call();
  assert.deepEqual(afterNoauth.filter(isNoauth), []);

  await settingsDb.updateSettings({ hideNoauthProviders: false, hideAllProviders: true });
  const afterAll = await call();
  assert.deepEqual(
    afterAll.filter((r) => !isCombo(r)),
    []
  );
});
