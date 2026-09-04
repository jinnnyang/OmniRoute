#!/usr/bin/env bash
#
# scripts/ops/backup-data.sh — preserve operator data across server rebuilds.
#
# OmniRoute keeps ALL operator state (provider connections + credentials,
# user-created API keys, combos, settings) in ONE SQLite database:
#
#   ${DATA_DIR}/storage.sqlite        (default ~/.omniroute/, or $DATA_DIR)
#
# Secrets that make that database readable live alongside it / in the app dir:
#
#   ${DATA_DIR}/server.env            (persisted on first boot: JWT_SECRET, ...)
#   ${APP_DIR}/.env                   (deployment config; STORAGE_ENCRYPTION_KEY!)
#
# Losing STORAGE_ENCRYPTION_KEY while keeping storage.sqlite = credentials
# become undecryptable. The bundle therefore always pairs db + env files.
#
# Usage:
#   backup-data.sh backup  [--out DIR] [--data-dir DIR] [--env-file PATH] [--keep N] [--force-copy]
#   backup-data.sh restore BUNDLE.tar.gz [--data-dir DIR] [--env-file PATH] [--owner USER] [--yes]
#
# Exit codes: 0 ok, 1 usage, 2 detection failure, 3 snapshot failure, 4 verify failure.

set -euo pipefail

APP_DIR_CANDIDATES=(
  "/usr/lib/node_modules/omniroute/app"   # bare-metal VPS (rsync target)
  "/opt/omniroute"                        # docker-compose host (env-file host path)
)
KEEP_DEFAULT=8
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORK=""   # global: the EXIT trap must see it even under set -u

log()  { printf '[backup-data] %s\n' "$*"; }
warn() { printf '[backup-data] WARNING: %s\n' "$*" >&2; }
die()  { printf '[backup-data] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

cleanup() { [[ -n "${WORK:-}" && -d "${WORK:-}" ]] && rm -rf "$WORK"; }
trap cleanup EXIT

usage() {
  sed -n '2,27p' "$0"
  exit 1
}

# ── detection ────────────────────────────────────────────────────────────────

detect_data_dir() {
  if [[ -n "${DATA_DIR:-}" ]]; then
    printf '%s' "$DATA_DIR"
    return
  fi
  printf '%s/.omniroute' "${HOME:?HOME is not set}"
}

detect_app_dir() {
  local candidate
  for candidate in "${APP_DIR_CANDIDATES[@]}"; do
    if [[ -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf ''
}

find_env_file() {
  local data_dir="$1" override="${2:-}"
  if [[ -n "$override" ]]; then
    [[ -f "$override" ]] || die "env file not found: $override" 2
    printf '%s' "$override"
    return
  fi
  local candidate
  for candidate in \
    "${OMNIROUTE_ENV_FILE:-}" \
    "$(detect_app_dir)/.env" \
    "/opt/omniroute/.env" \
    "${data_dir}/server.env" \
    "${data_dir}/.env"
  do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf ''
}

# ── snapshot ─────────────────────────────────────────────────────────────────

# Produce a consistent copy of storage.sqlite into "$1". Uses the SQLite
# Online Backup API (sqlite3 CLI) when available — safe while the server runs.
# Without sqlite3, falls back to copying db + wal + shm and requires the
# service to be stopped (or accepts WAL-loss risk with --force-copy).
snapshot_db() {
  local db_file="$1" dest_dir="$2" force_copy="${3:-}"
  [[ -f "$db_file" ]] || die "database not found: $db_file — is DATA_DIR correct?" 2

  if command -v sqlite3 >/dev/null 2>&1; then
    log "snapshotting via sqlite3 Online Backup API (online-safe)"
    sqlite3 "$db_file" ".backup '${dest_dir}/storage.sqlite'"
    local integrity
    integrity="$(sqlite3 "${dest_dir}/storage.sqlite" 'PRAGMA integrity_check;')"
    [[ "$integrity" == "ok" ]] || die "integrity_check failed: $integrity" 4
    log "integrity_check: ok"
    return 0
  fi

  if [[ "$force_copy" != "--force-copy" ]]; then
    warn "sqlite3 CLI not found — file-copy fallback requires the service to be STOPPED"
    warn "so the WAL is checkpointed. Re-run with --force-copy to skip this check."
    die "refusing unsafe copy" 3
  fi
  warn "file-copy fallback: copying storage.sqlite + wal + shm"
  cp "$db_file" "${dest_dir}/storage.sqlite"
  local sidecar
  for sidecar in -wal -shm; do
    [[ -f "${db_file}${sidecar}" ]] && cp "${db_file}${sidecar}" "${dest_dir}/storage.sqlite${sidecar}"
  done
}

# The operator-relevant tables — prove the bundle actually carries them.
verify_tables() {
  local db_file="$1"
  if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 not available — skipping table-count verification"
    return 0
  fi
  local table count
  for table in provider_connections api_keys combos; do
    count="$(sqlite3 "$db_file" "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "?")"
    log "verify: ${table} = ${count} row(s)"
    if [[ "$count" == "?" ]]; then
      warn "table ${table} not readable"
      return 1
    fi
  done
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_backup() {
  local out_dir="" data_dir="" env_file="" keep="$KEEP_DEFAULT" force_copy=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out) out_dir="$2"; shift 2 ;;
      --data-dir) data_dir="$2"; shift 2 ;;
      --env-file) env_file="$2"; shift 2 ;;
      --keep) keep="$2"; shift 2 ;;
      --force-copy) force_copy="--force-copy"; shift ;;
      *) die "unknown backup option: $1" 1 ;;
    esac
  done
  [[ -z "$data_dir" ]] && data_dir="$(detect_data_dir)"
  [[ -d "$data_dir" ]] || die "data dir not found: $data_dir" 2
  [[ -z "$out_dir" ]] && out_dir="${data_dir}-backups"
  mkdir -p "$out_dir"

  # work lives next to the bundle (same volume); /tmp breaks native sqlite3 on
  # MSYS/Windows and cross-device moves elsewhere.
  WORK="$(mktemp -d "${out_dir}/.backup-work-XXXXXX")"

  local env_resolved=""
  env_resolved="$(find_env_file "$data_dir" "$env_file")"

  snapshot_db "${data_dir}/storage.sqlite" "$WORK" "$force_copy"
  verify_tables "${WORK}/storage.sqlite" || warn "table verification incomplete — check output above"

  # server.env lives inside the data dir — always include it.
  [[ -f "${data_dir}/server.env" ]] && cp "${data_dir}/server.env" "${WORK}/server.env"
  # Deployment .env (STORAGE_ENCRYPTION_KEY!) — include when found outside the data dir.
  if [[ -n "$env_resolved" && "$env_resolved" != "${data_dir}/"* ]]; then
    cp "$env_resolved" "${WORK}/dot-env"
  fi

  {
    echo "bundle: omniroute data preservation"
    echo "date: $(date -Is 2>/dev/null || date)"
    echo "host: $(hostname 2>/dev/null || echo unknown)"
    echo "source data dir: $data_dir"
    echo "env file: ${env_resolved:-<none found — CHECK MANUALLY>}"
    echo "contents:"
    ls -la "$WORK" | tail -n +2
  } > "${WORK}/MANIFEST.txt"

  local bundle="${out_dir}/omniroute-data-${TIMESTAMP}.tar.gz"
  # GNU tar parses a leading "C:" as host:path — pack via basename in a subshell
  (cd "$out_dir" && tar -czf "omniroute-data-${TIMESTAMP}.tar.gz" -C "$WORK" .)
  chmod 600 "$bundle" 2>/dev/null || true

  log "bundle: $bundle ($(du -h "$bundle" | cut -f1))"
  log "contents: $(cd "$(dirname "$bundle")" && tar -tzf "$(basename "$bundle")" | tr '\n' ' ')"

  # retention: keep the newest N bundles
  local old
  while IFS= read -r old; do
    [[ -z "$old" ]] && continue
    rm -f -- "$old"
    log "pruned old bundle: $old"
  done < <(ls -1t "${out_dir}"/omniroute-data-*.tar.gz 2>/dev/null | tail -n +"$((keep + 1))")

  log "done — restore with: backup-data.sh restore $bundle"
}

cmd_restore() {
  local bundle="" data_dir="" env_file="" owner="" assume_yes=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --data-dir) data_dir="$2"; shift 2 ;;
      --env-file) env_file="$2"; shift 2 ;;
      --owner) owner="$2"; shift 2 ;;
      --yes) assume_yes="1"; shift ;;
      -*) die "unknown restore option: $1" 1 ;;
      *) bundle="$1"; shift ;;
    esac
  done
  [[ -n "$bundle" && -f "$bundle" ]] || die "bundle required: restore BUNDLE.tar.gz" 1
  [[ -z "$data_dir" ]] && data_dir="$(detect_data_dir)"

  WORK="$(mktemp -d "$(dirname "$bundle")/.restore-work-XXXXXX")"
  (cd "$(dirname "$bundle")" && tar -xzf "$(basename "$bundle")" -C "$WORK")

  [[ -f "${WORK}/storage.sqlite" ]] || die "bundle has no storage.sqlite — wrong bundle?" 4
  if command -v sqlite3 >/dev/null 2>&1; then
    local integrity
    integrity="$(sqlite3 "${WORK}/storage.sqlite" 'PRAGMA integrity_check;')"
    [[ "$integrity" == "ok" ]] || die "bundle database failed integrity_check: $integrity" 4
    log "bundle integrity_check: ok"
  fi

  log "restore target data dir: $data_dir"
  log "restore env file to:     ${env_file:-<data dir>}"
  if [[ -z "$assume_yes" ]]; then
    local answer
    read -r -p "Proceed? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted"
  fi

  mkdir -p "$data_dir"

  # Safety net: never destroy the current db without a backup next to it.
  if [[ -f "${data_dir}/storage.sqlite" ]]; then
    cp "${data_dir}/storage.sqlite" "${data_dir}/storage.sqlite.pre-restore-${TIMESTAMP}"
    log "existing db backed up as storage.sqlite.pre-restore-${TIMESTAMP}"
  fi

  # Remove stale sidecars so the restored db is not "recovered" against them.
  rm -f "${data_dir}/storage.sqlite-wal" "${data_dir}/storage.sqlite-shm"
  cp "${WORK}/storage.sqlite" "${data_dir}/storage.sqlite"
  local sidecar
  for sidecar in -wal -shm; do
    [[ -f "${WORK}/storage.sqlite${sidecar}" ]] && cp "${WORK}/storage.sqlite${sidecar}" "${data_dir}/storage.sqlite${sidecar}"
  done

  # server.env → data dir (bootstrap reads it from there on boot)
  if [[ -f "${WORK}/server.env" ]]; then
    cp "${WORK}/server.env" "${data_dir}/server.env"
    log "restored server.env"
  fi
  # dot-env (deployment .env) → --env-file path or data dir
  if [[ -f "${WORK}/dot-env" ]]; then
    local target="${env_file:-${data_dir}/.env}"
    mkdir -p "$(dirname "$target")"
    cp "${WORK}/dot-env" "$target"
    log "restored .env → $target"
  fi

  if [[ -n "$owner" ]]; then
    chown -R "$owner" "$data_dir"
    log "chowned $data_dir → $owner"
  fi

  warn "next steps: start the service, then log in and check Providers / API Keys / Combos."
  log "restore complete"
}

# ── main ─────────────────────────────────────────────────────────────────────

[[ $# -ge 1 ]] || usage
case "$1" in
  backup)  shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  help|-h|--help) usage ;;
  *) die "unknown command: $1 (use backup|restore)" 1 ;;
esac
