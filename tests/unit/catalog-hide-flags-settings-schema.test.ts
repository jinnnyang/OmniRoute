import test from "node:test";
import assert from "node:assert/strict";

import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

const CATALOG_HIDE_FLAGS = [
  "hideAutoCombos",
  "hideNoThinkVariants",
  "hideNoauthProviders",
  "hideAllProviders",
] as const;

for (const flag of CATALOG_HIDE_FLAGS) {
  test(`${flag} is accepted and preserved by the settings PATCH schema`, () => {
    for (const value of [true, false]) {
      const validation = updateSettingsSchema.safeParse({ [flag]: value });

      assert.equal(validation.success, true);
      if (!validation.success) continue;
      assert.equal(validation.data[flag], value);
    }
  });

  test(`${flag} is undefined when not provided`, () => {
    const validation = updateSettingsSchema.safeParse({});

    assert.equal(validation.success, true);
    if (!validation.success) return;
    assert.equal(validation.data[flag], undefined);
  });

  test(`${flag} rejects non-boolean values`, () => {
    assert.equal(updateSettingsSchema.safeParse({ [flag]: "true" }).success, false);
  });
}
