#!/usr/bin/env bash
# deploy.sh — put a released OmniRoute image into production.
#
# Release pipeline (fork policy): GitHub Actions builds, scans and publishes
# `jinnnyang/omniroute:<version>` to Docker Hub and attaches a `docker load`-able
# tarball to the GitHub Release. Deployment is `docker load` from that tarball, not a
# registry pull, so the artifact that lands on the host is the exact one CI scanned.
#
# Usage:
#   ./scripts/deploy/scp-load.sh 3.9.0 --dry-run     # show the plan, change nothing
#   ./scripts/deploy/scp-load.sh 3.9.0               # deploy (tarball fetched on the host)
#   ./scripts/deploy/scp-load.sh 3.9.0 --transfer scp --tarball ./omniroute-3.9.0.tar.gz
#   ./scripts/deploy/scp-load.sh 3.9.0 --no-rollback # do not auto-revert on failure
#
# Transfer modes:
#   server (default) — the host downloads the release asset itself. Preferred: the
#                      tarball is ~345 MB and the operator uplink is the slow leg.
#   scp              — upload a local tarball (slow; use only when the host cannot
#                      reach GitHub).
#
# Safety: the previous `IMAGE=` line is captured before the swap; if the container is
# not healthy afterwards the script re-points it at the previous tag and recreates,
# then exits non-zero.

set -euo pipefail

# SSH identity: set OMNIROUTE_SSH_KEY=/path/to/key when the key is not the agent default.
SSH_OPTS=(-o BatchMode=yes)
[ -n "${OMNIROUTE_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${OMNIROUTE_SSH_KEY}")
ssh_do() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

VERSION=""
HOST="root@155.103.156.145"
TARBALL=""
DRY_RUN=0
TRANSFER="server"
ROLLBACK_ON_FAIL=1
IMAGE_REPO="jinnnyang/omniroute"
RELEASE_REPO="jinnnyang/OmniRoute"
REMOTE_DIR="/opt/omniroute"
RECREATE="${REMOTE_DIR}/recreate-omniroute.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --transfer) TRANSFER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-rollback) ROLLBACK_ON_FAIL=0; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) VERSION="$1"; shift ;;
  esac
done

[ -n "$VERSION" ] || { echo "usage: $0 <version> [--dry-run] [--transfer server|scp] [--tarball <file>] [--host <ssh>]" >&2; exit 2; }
TARBALL_NAME="omniroute-${VERSION}.tar.gz"
TARBALL="${TARBALL:-${TARBALL_NAME}}"
ASSET_URL="https://github.com/${RELEASE_REPO}/releases/download/v${VERSION}/${TARBALL_NAME}"
REMOTE_TARBALL="${REMOTE_DIR}/incoming/${TARBALL_NAME}"

PREV_TAG=$(ssh_do "grep -m1 '^IMAGE=' '${RECREATE}' | sed 's/.*://'")
echo "==> current production tag : ${PREV_TAG}"
echo "==> target tag             : ${IMAGE_REPO}:${VERSION}"
echo "==> host                   : ${HOST}"
echo "==> transfer               : ${TRANSFER}"
if [ "$TRANSFER" = "scp" ]; then echo "==> tarball                : ${TARBALL}"; else echo "==> asset url              : ${ASSET_URL}"; fi

if [ "$DRY_RUN" = "1" ]; then
  echo "==> dry run: nothing was downloaded, transferred or restarted"
  ssh_do "curl -sI -L '${ASSET_URL}' | head -1" || true
  exit 0
fi

health_ok() {
  local body
  for _ in $(seq 1 40); do
    body=$(ssh_do "curl -sk https://127.0.0.1/api/monitoring/health -H 'Host: aptapi.dev' || true")
    case "$body" in
      *'"status":"healthy"'*'"setupComplete":true'*) return 0 ;;
    esac
    sleep 3
  done
  echo "!! last health body: ${body:-<none>}" >&2
  return 1
}

echo "==> fetching ${TARBALL_NAME} on the host"
ssh_do "mkdir -p '${REMOTE_DIR}/incoming' && curl -fsSL '${ASSET_URL}' -o '${REMOTE_TARBALL}.part' && mv '${REMOTE_TARBALL}.part' '${REMOTE_TARBALL}' && ls -lh '${REMOTE_TARBALL}'"

echo "==> docker load"
ssh_do "gunzip -c '${REMOTE_TARBALL}' | docker load | tail -3"
ssh_do "docker image inspect '${IMAGE_REPO}:${VERSION}' >/dev/null && echo '    image present: ${IMAGE_REPO}:${VERSION}'"

echo "==> repointing ${RECREATE} to ${IMAGE_REPO}:${VERSION}"
ssh_do "cp -a '${RECREATE}' '${RECREATE}.bak-\$(date +%Y%m%d%H%M%S)' && sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${VERSION}|' '${RECREATE}'"

echo "==> recreating the container"
ssh_do "sh '${RECREATE}'"

if health_ok; then
  echo "==> deployed ${IMAGE_REPO}:${VERSION} (previous: ${PREV_TAG})"
  echo "    rollback: ./scripts/deploy/scp-load.sh ${PREV_TAG} --no-rollback    (or: ssh ${HOST} \"sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${PREV_TAG}|' '${RECREATE}' && sh '${RECREATE}'\")"
  exit 0
fi

if [ "$ROLLBACK_ON_FAIL" = "1" ] && [ -n "${PREV_TAG}" ]; then
  echo "!! health check failed — rolling back to ${PREV_TAG}" >&2
  ssh_do "sed -i 's|^IMAGE=.*|IMAGE=${IMAGE_REPO}:${PREV_TAG}|' '${RECREATE}' && sh '${RECREATE}'"
  if health_ok; then
    echo "!! rolled back to ${PREV_TAG}; production is serving again" >&2
  else
    echo "!! rollback also unhealthy — manual intervention required" >&2
  fi
fi
exit 1
