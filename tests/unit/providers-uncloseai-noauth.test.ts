import { test } from "node:test";
import assert from "node:assert/strict";

test("uncloseai should be treated as a no-auth provider", () => {
  const allowsOptionalKey = providerAllowsOptionalApiKey("uncloseai");

  assert.equal(
    isNoAuthRegistered || allowsOptionalKey,
    true,
    "so the dashboard doesn't force users to enter a key for a no-auth provider"
  );
  assert.equal(
    isNoAuthRegistered,
    true,
    "so the dashboard renders the NoAuthProviderControls flow"
  );
});
