#!/usr/bin/env node
/**
 * osv-ratchet — fail the gate only on *new* dependency advisories.
 *
 * The fork's lockfile deliberately carries a small set of known advisories (all dev-only) that
 * cannot be fixed without a major bump through dev tooling. Freezing that set in
 * config/quality/osv-baseline.json keeps the check honest: it stays green on what we have
 * accepted, and turns red the moment a dependency picks up something new.
 *
 * Why the OSV API directly instead of osv-scanner: the scanner ships as a Docker image (a pull
 * plus a wrapper to get a machine-readable file out of it), while the lockfile→OSV batch query
 * is the same call it makes internally. `npm audit` is not an option here — the npm registry in
 * use answers [NOT_IMPLEMENTED] for the advisories endpoint.
 *
 * Usage:
 *   node scripts/quality/osv-ratchet.mjs [--lockfile package-lock.json]
 *        [--baseline config/quality/osv-baseline.json] [--update]
 *
 * Exit codes: 0 = no new advisories, 1 = new advisories, 2 = could not reach the OSV API.
 */

import fs from "node:fs";

const OSV_ENDPOINT = "https://api.osv.dev/v1/querybatch";
const CHUNK = 500;

function parseArgs(argv) {
  const args = { lockfile: "package-lock.json", baseline: "config/quality/osv-baseline.json", update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--lockfile") args.lockfile = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--update") args.update = true;
  }
  return args;
}

/** Unique {name, version, dev} triples from a v2/v3 npm lockfile. */
export function readLockfile(file) {
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  const seen = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || !meta?.version || meta.link) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    seen.set(`${name}@${meta.version}`, { name, version: meta.version, dev: Boolean(meta.dev) });
  }
  return [...seen.values()];
}

async function queryBatch(entries) {
  const response = await fetch(OSV_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: entries.map((e) => ({ package: { name: e.name, ecosystem: "npm" }, version: e.version })),
    }),
  });
  if (!response.ok) throw new Error(`OSV ${response.status} ${response.statusText}`);
  return (await response.json()).results ?? [];
}

/** Every advisory that affects the lockfile, attributed to the package version that pulled it. */
export async function scan(file) {
  const entries = readLockfile(file);
  const findings = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const results = await queryBatch(chunk);
    results.forEach((result, index) => {
      const entry = chunk[index];
      for (const vuln of result.vulns ?? []) {
        findings.push({ package: entry.name, version: entry.version, dev: entry.dev, id: vuln.id });
      }
    });
  }
  return { entries: entries.length, findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let scanned;
  try {
    scanned = await scan(args.lockfile);
  } catch (error) {
    console.error(`osv-ratchet: OSV query failed — ${error.message}`);
    process.exit(2);
  }

  const observed = [...new Set(scanned.findings.map((f) => f.id))].sort();
  let baseline = { advisories: [], findings: [] };
  if (fs.existsSync(args.baseline)) baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
  const known = new Set(baseline.advisories ?? []);

  const fresh = observed.filter((id) => !known.has(id));
  const fixed = [...known].filter((id) => !observed.includes(id)).sort();
  const freshFindings = scanned.findings.filter((f) => fresh.includes(f.id));

  console.log(
    `osv-ratchet: packages=${scanned.entries} findings=${scanned.findings.length} advisories=${observed.length} ` +
      `baseline=${known.size} new=${fresh.length} fixed=${fixed.length}`
  );

  const group = (rows) => {
    const byPackage = new Map();
    for (const row of rows) {
      const key = `${row.package}@${row.version}`;
      byPackage.set(key, [...(byPackage.get(key) ?? []), row]);
    }
    return [...byPackage.entries()].sort((a, b) => b[1].length - a[1].length);
  };

  if (fresh.length > 0) {
    console.log("\nNEW advisories (not in the baseline):");
    for (const [key, rows] of group(freshFindings)) {
      console.log(`  + ${key}${rows[0].dev ? " (dev)" : ""}`);
      for (const row of rows) console.log(`      ${row.id}`);
    }
    if (args.update) {
      const next = {
        count: scanned.findings.length,
        advisories: observed,
        findings: scanned.findings,
        updatedAt: new Date().toISOString().slice(0, 10),
        note: baseline.note,
      };
      fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`\nbaseline updated -> ${args.baseline}`);
      process.exit(0);
    }
    console.log("\nEach id above must be fixed, or accepted by running this script with --update.");
    process.exit(1);
  }

  if (fixed.length > 0) {
    console.log(`\n${fixed.length} baseline advisories no longer affect the lockfile — run with --update to shrink the baseline:`);
    for (const id of fixed) console.log(`  - ${id}`);
  }

  if (args.update) {
    const next = {
      count: scanned.findings.length,
      advisories: observed,
      findings: scanned.findings,
      updatedAt: new Date().toISOString().slice(0, 10),
      note: baseline.note,
    };
    fs.writeFileSync(args.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline updated -> ${args.baseline}`);
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("osv-ratchet.mjs")) {
  main();
}
