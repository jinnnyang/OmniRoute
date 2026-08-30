import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";
import { parse } from "@formatjs/icu-messageformat-parser";

/**
 * Regression guard for next-intl INVALID_MESSAGE: UNCLOSED_TAG on the
 * Feature Flags page and the CLI onboarding block.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(__dirname, "..", "..", "src", "i18n", "messages");

/** Keys whose values are rendered as plain text by next-intl on the settings pages. */
const PLAIN_TEXT_KEYS = [
  "featureFlags.definitions.OMNIROUTE_AUTO_SYNC_CLAUDE_PROFILES.description",
  "featureFlagExposeFunctionalGatewayMirrorsDescription",
  "featureFlagExposeCcDiscoveryAliasesDescription",
  "cliTools.ccOnboardingKeyPlaceholder",
] as const;

function localeFiles(): string[] {
  return readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function readLocale(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(MESSAGES_DIR, file), "utf8")) as Record<string, unknown>;
}

/** Deep-walk a message object and collect every leaf string value. */
function collectStrings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectStrings(item, out);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, out);
  }
  return out;
}

/** Resolve a dotted key path against a message object. */
function getByPath(obj: Record<string, unknown>, keyPath: string): unknown {
  let cur: unknown = obj;
  for (const part of keyPath.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * True when the formatjs ICU parser rejects the string as an unclosed tag.
 * This is the exact failure mode that surfaced as INVALID_MESSAGE on the client.
 */
function isUnclosedTag(value: string): boolean {
  try {
    parse(value);
    return false;
  } catch (err) {
    return String((err as Error).message).includes("UNCLOSED_TAG");
  }
}

test("no locale message file contains a raw string that the ICU parser rejects as UNCLOSED_TAG", () => {
  const offenders: string[] = [];
  for (const file of localeFiles()) {
    const messages = readLocale(file);
    for (const str of collectStrings(messages)) {
      if (isUnclosedTag(str)) {
        offenders.push(`${file}: ${str.slice(0, 120)}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `ICU UNCLOSED_TAG across locales must be fixed (renders INVALID_MESSAGE on client):\n${offenders.join("\n")}`
  );
});

test("en.json feature-flag description keys contain no raw unclosed fragments", () => {
  const en = readLocale("en.json");
  for (const key of PLAIN_TEXT_KEYS) {
    const value = getByPath(en, key);
    assert.equal(typeof value, "string", `${key} must be a string in en.json`);
    // A message that mixes raw fragments with ICU escaping still fails to parse.
    assert.equal(isUnclosedTag(value as string), false, `${key} must not be an unclosed tag`);
  }
});

test("createTranslator accepts feature-flag & CLI keys in every locale without UNCLOSED_TAG", () => {
  const errors: Array<{
    locale: string;
    code?: string;
    originalMessage?: string;
    message?: string;
  }> = [];

  for (const file of localeFiles()) {
    const locale = file.replace(/\.json$/, "");
    const messages = readLocale(file);
    const onError = (err: unknown) => {
      errors.push({
        locale,
        ...(err as { code?: string; originalMessage?: string; message?: string }),
      });
    };

    // Dynamic message objects defeat next-intl's literal key inference (keys become
    // `never`), so cast to a minimal translator surface that still exercises the
    // real runtime path (parse + rich-text render) with onError capture.
    const translator = createTranslator({ locale, messages, onError }) as unknown as {
      has: (key: string) => boolean;
      (key: string): string;
    };
    for (const key of PLAIN_TEXT_KEYS) {
      if (translator.has(key)) {
        const value = translator(key);
        assert.ok(
          typeof value === "string" && value.length > 0,
          `${locale}: ${key} must render to a non-empty string`
        );
      }
    }
  }

  const bad = errors.filter(
    (e) =>
      e.code === "INVALID_MESSAGE" ||
      String(e.originalMessage ?? e.message ?? "").includes("UNCLOSED_TAG")
  );
  assert.equal(
    bad.length,
    0,
    `next-intl INVALID_MESSAGE/UNCLOSED_TAG on feature-flag keys:\n${bad
      .map((e) => `${e.locale}: ${e.code}: ${e.originalMessage ?? e.message}`)
      .join("\n")}`
  );
});
