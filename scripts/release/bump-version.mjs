#!/usr/bin/env node
/**
 * bump-version — move the fork's version in the three places release-less.yml checks.
 *
 *   node scripts/release/bump-version.mjs 3.9.0
 *
 * The release workflow refuses a tag that disagrees with package.json, so the three
 * files must move together. This script is the one place that knows which files those are.
 */
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/release/bump-version.mjs <semver>   e.g. 3.9.0");
  process.exit(2);
}

const targets = [
  { file: "package.json", apply: (t) => t.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`) },
  { file: "open-sse/package.json", apply: (t) => t.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`) },
  { file: "docs/openapi.yaml", apply: (t) => t.replace(/^(\s*version:\s*)\S+$/m, `$1${version}`) },
];

for (const { file, apply } of targets) {
  const p = path.resolve(file);
  const before = fs.readFileSync(p, "utf8");
  const after = apply(before);
  if (after === before) {
    console.error(`no version field changed in ${file}`);
    process.exit(1);
  }
  fs.writeFileSync(p, after);
  console.log(`updated ${file}`);
}

console.log(`\nnext: git commit -am "release: ${version}" && git tag v${version} && git push origin less --tags`);
