#!/usr/bin/env node
// scripts/build/tls-client-fetch.mjs
// Fetch the pinned bogdanfinn/tls-client native library for linux-x64 builds.
//
// Why this exists (2026-09-04, 3.8.53): upstream renamed release assets from
// `tls-client-linux-ubuntu-amd64-<v>.so` (<=1.8.0) to `tls-client-xgo-<v>-linux-amd64.so`
// (>=1.9), while tls-client-node's postinstall still looks for the legacy name.
// The runtime loader (tls-client-node/dist/binary.js) resolves bin/ entries by the
// LEGACY prefix, so we download the xgo asset and write it under the legacy name.
//
// The version is pinned to 1.15.1 — the native library version the installed
// tls-client-node@0.2.0 was shipped and tested against (its own windows bin is
// tls-client-windows-64-1.15.1.dll).
import fs from "node:fs";
import path from "node:path";

const VERSION = process.env.TLS_CLIENT_VERSION || "1.15.1";
const REPO = "bogdanfinn/tls-client";
const BIN_DIR = path.resolve("node_modules", "tls-client-node", "bin");
const RUNTIME_NAME = `tls-client-linux-ubuntu-amd64-${VERSION}.so`;
const CANDIDATE_ASSETS = [
  `tls-client-linux-ubuntu-amd64-${VERSION}.so`, // legacy naming
  `tls-client-xgo-${VERSION}-linux-amd64.so`, // xgo naming (>=1.9)
];
const HEADERS = { "User-Agent": "omniroute-build", Accept: "application/vnd.github+json" };

const dest = path.join(BIN_DIR, RUNTIME_NAME);
if (fs.existsSync(dest)) {
  console.log(`[tls-client-fetch] ${RUNTIME_NAME} already present`);
  process.exit(0);
}

// Direct release-asset download first. The unauthenticated api.github.com lookup is
// rate-limited per runner IP (60/hr) and shared GitHub-hosted runners hit it often:
// 2026-11-16 the docker-smoke job died with "release lookup failed: HTTP 403".
// The download URL does not go through the API rate limiter, so trying it first makes
// the build independent of the API quota. TLS_CLIENT_ASSET overrides the asset name.
const forcedAsset = process.env.TLS_CLIENT_ASSET;
const directCandidates = forcedAsset ? [forcedAsset] : CANDIDATE_ASSETS;
for (const name of directCandidates) {
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${name}`;
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) {
    console.log(`[tls-client-fetch] direct ${name}: HTTP ${res.status}`);
    continue;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[tls-client-fetch] ${RUNTIME_NAME} <- ${name} (direct)`);
  process.exit(0);
}

const authHeaders = process.env.GITHUB_TOKEN
  ? { ...HEADERS, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : HEADERS;
const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}`, {
  headers: authHeaders,
});
if (!releaseRes.ok) {
  console.error(
    `[tls-client-fetch] release lookup failed: HTTP ${releaseRes.status} for v${VERSION}`
  );
  process.exit(1);
}
const release = await releaseRes.json();
const assetName = CANDIDATE_ASSETS.find((name) => release.assets?.some((a) => a.name === name));
if (!assetName) {
  console.error(
    `[tls-client-fetch] none of ${CANDIDATE_ASSETS.join(", ")} found in v${VERSION} assets`
  );
  process.exit(1);
}
const asset = release.assets.find((a) => a.name === assetName);

const binRes = await fetch(asset.browser_download_url, {
  headers: { "User-Agent": "omniroute-build" },
});
if (!binRes.ok) {
  console.error(`[tls-client-fetch] asset download failed: HTTP ${binRes.status}`);
  process.exit(1);
}
const buf = Buffer.from(await binRes.arrayBuffer());
if (buf.length < 1024 * 1024) {
  console.error(`[tls-client-fetch] downloaded binary suspiciously small (${buf.length} bytes)`);
  process.exit(1);
}
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.writeFileSync(dest, buf);
fs.chmodSync(dest, 0o755);
console.log(`[tls-client-fetch] wrote ${dest} (${buf.length} bytes) from ${assetName}`);
