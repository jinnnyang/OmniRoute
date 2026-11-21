import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureCursorAutoCatalogEntry } from "../../src/lib/providerModels/cursorAutoCatalog.ts";
import { resolveRequestedModel } from "../../open-sse/utils/cursorAgentProtobuf.ts";

describe("ensureCursorAutoCatalogEntry + resolveRequestedModel", () => {
  it("catalog auto stays aligned with wire default", () => {
    const models = ensureCursorAutoCatalogEntry([]);
    assert.equal(models[0].id, "auto");
    assert.deepEqual(resolveRequestedModel("auto"), { modelId: "default", parameters: [] });
  });

  it("auto-cost/balance/intelligence map to default + optimization parameter", () => {
    assert.deepEqual(resolveRequestedModel("auto-cost"), {
      modelId: "default",
      parameters: [{ id: "optimization", value: "cost" }],
    });
    assert.deepEqual(resolveRequestedModel("auto-balance"), {
      modelId: "default",
      parameters: [{ id: "optimization", value: "balance" }],
    });
    assert.deepEqual(resolveRequestedModel("auto-intelligence"), {
      modelId: "default",
      parameters: [{ id: "optimization", value: "intelligence" }],
    });
  });
});
