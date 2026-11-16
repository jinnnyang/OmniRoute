#!/usr/bin/env bash
# scp-load.sh — deploy a released OmniRoute image to the production VPS.
#
# Release flow (fork policy, 2026-11-16): GitHub Actions builds, scans and publishes
# `jinnnyang/omniroute:<version>` to Docker Hub and attaches a `docker load`-able
# tarball to the GitHub Release. This script moves that tarball to the host and
# recreates the container from it — we deploy by scp + `docker load`, not by pulling.
#
# Usage:
#   ./scripts/deploy/scp-load.sh 3.9.0
#   ./scripts/deploy/scp-load.sh 3.9.0 --host root@155.103.156.145
#   ./scripts/deploy/scp-load.sh 3.9.0 --dry-run          # resolve + show the plan only
#   ./scripts/deploy/scp-load.sh 3.9.0 --tarball ./omniroute-3.9.0.tar.gz
#
# Requirements: gh (authenticated), ssh access to the host, docker on the host.
# The host keeps /opt/omniroute/recreate-omniroute.sh with a single `IMAGE=` line,
# which this script rewrites; the previous tag is printed as the rollback command.

set -euo pipefail

VERSION=""
HOST="root@155.103.156.145"
TARBALL=""
DRY_RUN=0
IMAGE_REPO="jinnnyang/omniroute"
REMOTE_DIR="/opt/omniroute"
RECREATE="${REMOTE_DIR}/recreate-omniroute.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) VERSION="$1"; shift ;;
  esac
done

[ -n "$VERSION" ] || { echo "usage: $0 <version> [--host <ssh-target>] [--tarball <file>] [--dry-run]" >&2; exit 2; }
TARBALL="${TARBALL:-omniroute-${VERSION}.tar.gz}"

if [ ! -f "$TARBALL" ]; then
  echo "==> downloading ${TARBALL} from the v${VERSION} release"
  gh release download "v${VERSION}" --pattern 'omniroute-*.tar.gz' --dir . --clobber
fi

if [ ! -f "$TARBALL" ]; then
  echo "error: ${TARBALL} not found (pass --tarball or publish the release asset)" >&2
  exit 1
fi

PREV_TAG=$(ssh "$HOST" "grep -m1 '^IMAGE=' '${RECREATE}' | sed 's/.*://'")
echo "==> current production tag: ${PREV_TAG}"
echo "==> target tag:             ${IMAGE_REPO}:${VERSION}"
echo "==> tarball:                ${TARBALL} ($(du -h "$TARBALL" | cut -f1))"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> dry run, stopping here"
  exit 0
fi

echo "==> uploading to ${HOST}:${REMOTE_DIR}/incoming/"
ssh "$HOST" "mkdir -p ${REMOTE_DIR}/incoming"
scp -C "$TARBALL" "${HOST}:${REMOTE_DIR}/incoming/${TARBALL}"

echo "==> docker load"
ssh "$HOST" "gunzip -c '${REMOTE_DIR}/incoming/${TARBALL}' | docker load | tail -3"

echo "==> repointing ${RECREATE} to ${IMAGE_REPO}:${VERSION}"
ssh "$HOST" "sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${VERSION}|' '${RECREATE}'"

echo "==> recreating the container"
ssh "$HOST" "sh '${RECREATE}'"

echo "==> waiting for health (setupComplete:true and status:healthy — see 坑 11)"
HEALTHY=0
for _ in $(seq 1 40); do
  BODY=$(ssh "$HOST" "curl -sk https://127.0.0.1/api/monitoring/health -H 'Host: aptapi.dev' || true")
  case "$BODY" in
    *'"status":"healthy"'*'"setupComplete":true'*|*'"setupComplete":true"'*'"status":"healthy"'*)
      echo "    ${BODY}"; HEALTHY=1; break ;;
  esac
  sleep 3
done

if [ "$HEALTHY" != "1" ]; then
  echo "!! health check did not pass. Last body: ${BODY:-<none>}" >&2
  echo "!! rollback with:" >&2
  echo "   ssh ${HOST} \"sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${PREV_TAG}|' '${RECREATE}' && sh '${RECREATE}'\"" >&2
  exit 1
fi

echo "==> deployed ${IMAGE_REPO}:${VERSION}"
echo "    rollback: ssh ${HOST} \"sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${PREV_TAG}|' '${RECREATE}' && sh '${RECREATE}'\""
