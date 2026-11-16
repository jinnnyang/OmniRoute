#!/usr/bin/env node
/**
 * unit-ratchet — fail the CI gate only on *new* unit-test failures.
 *
 * The `less` baseline carries a known-failing set (config/quality/unit-known-failures.json):
 * tests that are red on a clean checkout for reasons unrelated to the change under review
 * (environment-dependent provider catalogs, OAuth routes, docs drift checks, ...). Without a
 * ratchet the only options are "red gate nobody reads" or "make the job non-blocking", and the
 * second one is exactly the SKIP-green pattern this fork's review calls out.
 *
 * Usage:
 *   node scripts/quality/unit-ratchet.mjs <test-log> [--baseline <file>] [--exit-code <n>] [--update]
 *
 * Exit codes: 0 = no new failures, 1 = new failures (or the runner died without reporting any
 * failure, which would otherwise look like a clean run).
 */

import fs from "node:fs";
import path from "node:path";

const ANSI = /\x1b\[[0-9;]*m|\^\[\[[0-9;]*m/g;

function parseArgs(argv) {
  const args = { log: null, baseline: "config/quality/unit-known-failures.json", exitCode: 0, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--exit-code") args.exitCode = Number(argv[++i] ?? 0);
    else if (a === "--update") args.update = true;
    else if (!args.log) args.log = a;
  }
  return args;
}

/**
 * Extract failing test names from node:test output.
 *
 * Only lines that carry the spec reporter's trailing duration — `✖ name (12.3ms)` — count.
 * Application logs are printed with the same ✖ glyph (e.g. `✖ Failed to configure Qwen Code:
 * Expected property name...`), and their text changes between runs; treating those as test
 * names produced a "new failure" on an unchanged baseline. TAP output (`not ok N - name`) is
 * also accepted so switching reporters does not silently disable the ratchet.
 */
export function extractFailures(text) {
  const names = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "");
    if (!line.includes("✖") && !/^not ok\s/.test(line)) continue;
    const spec = line.match(/✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/);
    if (spec) {
      names.add(spec[1].trim());
      continue;
    }
    const tap = line.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/);
    if (tap) names.add(tap[1].trim());
  }
  return names;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.log) {
    console.error("usage: unit-ratchet <test-log> [--baseline <file>] [--exit-code <n>] [--update]");
    process.exit(2);
  }

  const logText = fs.readFileSync(args.log, "utf8");
  const observed = extractFailures(logText);

  let baseline = new Set();
  if (fs.existsSync(args.baseline)) {
    const data = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
    baseline = new Set(Array.isArray(data.failures) ? data.failures : []);
  }

  const fresh = [...observed].filter((n) => !baseline.has(n)).sort();
  const fixed = [...baseline].filter((n) => !observed.has(n)).sort();

  console.log(`unit-ratchet: baseline=${baseline.size} observed=${observed.size} new=${fresh.length} fixed=${fixed.length} runnerExit=${args.exitCode}`);

  if (fresh.length > 0) {
    console.log("\nNEW failures (not in the baseline):");
    for (const n of fresh.slice(0, 60)) console.log(`  + ${n}`);
    if (fresh.length > 60) console.log(`  ...and ${fresh.length - 60} more`);
    process.exit(1);
  }

  if (fixed.length > 0) {
    console.log(`\n${fixed.length} baseline entries no longer fail — run with --update to shrink the baseline:`);
    for (const n of fixed.slice(0, 20)) console.log(`  - ${n}`);
    if (fixed.length > 20) console.log(`  ...and ${fixed.length - 20} more`);
    if (args.update) {
      const next = {
        ...JSON.parse(fs.existsSync(args.baseline) ? fs.readFileSync(args.baseline, "utf8") : "{}"),
        count: observed.size,
        failures: [...observed].sort(),
        updatedAt: new Date().toISOString().slice(0, 10),
      };
      fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`baseline updated -> ${path.relative(process.cwd(), args.baseline)}`);
    }
  }

  if (args.exitCode !== 0 && observed.size === 0) {
    console.error("\nrunner exited non-zero but reported no test failures — treating as a hard failure (crash / OOM / setup error)");
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("unit-ratchet.mjs")) {
  main();
}
