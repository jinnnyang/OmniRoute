---
title: "Data Backup & Restore — Server Rebuild Survival"
lastUpdated: 2026-09-04
---

# Data Backup & Restore — Server Rebuild Survival

> **TL;DR**: ALL operator state (provider connections + credentials, user-created
> API keys, combos) lives in ONE SQLite file: `${DATA_DIR}/storage.sqlite`. Pair it
> with the env files (especially `STORAGE_ENCRYPTION_KEY`) or the data is unreadable.
> Use `scripts/ops/backup-data.sh` — one command to bundle, one to restore.

## What lives where

OmniRoute persists everything in a single SQLite database (WAL journaling):

```
${DATA_DIR}/storage.sqlite      ← provider_connections, api_keys, combos, settings, …
${DATA_DIR}/server.env          ← first-boot secrets (JWT_SECRET, …), written by bootstrap
${APP_DIR}/.env                 ← deployment config (STORAGE_ENCRYPTION_KEY!)
```

- **Bare-metal VPS**: `APP_DIR=/usr/lib/node_modules/omniroute/app`, `DATA_DIR` defaults
  to `~/.omniroute` of the service user (root → `/root/.omniroute`), or the explicit
  `DATA_DIR` env var.
- **Docker** (VM guide layout): host `.env` at `/opt/omniroute/.env`, data volume mounted
  at `/app/data` inside the container.

## Keep / delete on rebuild

| Path                                  | Verdict                    | Why                                                                                                                             |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `${DATA_DIR}/storage.sqlite`          | **KEEP**                   | The three things operators care about — provider connections + credentials, user API keys, combos — are tables in this one file |
| `${DATA_DIR}/server.env`              | **KEEP**                   | First-boot secrets; bootstrap refuses to boot without its JWT_SECRET                                                            |
| `${APP_DIR}/.env`                     | **KEEP**                   | `STORAGE_ENCRYPTION_KEY` encrypts credentials at rest — losing it makes every stored provider key undecryptable                 |
| `storage.sqlite-wal` / `-shm`         | Keep if service was killed | Normal shutdown checkpoints them away; a hard kill may leave un-checkpointed data inside                                        |
| `${APP_DIR}/` (program itself)        | delete                     | Rebuild = redeploy; `dist/` is replaced by the release artifact                                                                 |
| `${DATA_DIR}/call_logs/`              | delete                     | Call-log payload artifacts; largest, no operator value                                                                          |
| `${DATA_DIR}/logs/`                   | delete                     | Server logs                                                                                                                     |
| `${DATA_DIR}/backups/`, `db_backups/` | prune                      | Keep the newest archive as insurance, delete the rest                                                                           |
| `${DATA_DIR}/plugins/`                | delete                     | Unless a plugin must survive the rebuild                                                                                        |

## The script

```bash
# Bundle db snapshot + env files into a dated tar.gz (default: ${DATA_DIR}-backups/)
scripts/ops/backup-data.sh backup

# Keep only the 3 newest bundles, snapshot while the service is running
# (needs the sqlite3 CLI — uses the Online Backup API, online-safe)
scripts/ops/backup-data.sh backup --keep 3

# Explicit layout (Docker host: data is inside the volume, env on the host)
scripts/ops/backup-data.sh backup \
  --data-dir /var/lib/docker/volumes/omniroute-data/_data \
  --env-file /opt/omniroute/.env

# On a rebuilt server: unpack, verify, install (backs up any existing db first)
scripts/ops/backup-data.sh restore omniroute-data-20260904-191704.tar.gz \
  --data-dir /root/.omniroute \
  --env-file /usr/lib/node_modules/omniroute/app/.env \
  --owner root
```

What `backup` does, in order:

1. Resolves the data dir (`$DATA_DIR` or `~/.omniroute`).
2. Snapshots `storage.sqlite` via the **SQLite Online Backup API** (`sqlite3 .backup`)
   — consistent even while the server is running — and runs `PRAGMA integrity_check`.
3. Without the `sqlite3` CLI: falls back to a file copy of `db + wal + shm` and
   **refuses to run unless the service is stopped** (override: `--force-copy`).
4. Verifies the operator tables are actually present and prints their row counts
   (`provider_connections`, `api_keys`, `combos`).
5. Adds `server.env` (data dir) and the deployment `.env` (app dir) to the bundle.
6. Packs a `chmod 600` tar.gz with a `MANIFEST.txt` and prunes old bundles
   (`--keep N`, default 8).

`restore` mirrors the flow: extract → `integrity_check` → confirm prompt
(`--yes` skips) → back up any existing db as `storage.sqlite.pre-restore-<ts>` →
remove stale WAL sidecars → install files → optional `--owner` chown.

## Gotchas that have bitten people

1. **Copy the db without the env files** → credentials decrypt to garbage.
   `STORAGE_ENCRYPTION_KEY` is the single most important line in `.env`.
2. **Hard-killed service + db-only copy** → the `-wal` file may hold the newest
   writes. Either stop the service cleanly first, bundle the sidecars, or let the
   script's sqlite3 path handle it.
3. **Busy database** → `sqlite3 .backup` handles concurrent writers; a plain `cp`
   during live traffic does not.
4. **Ownership after restore** → the SQLite file must be writable by the service
   user; `--owner` fixes it in one step.

## Related

- [DATABASE_GUIDE.md](./DATABASE_GUIDE.md) — schema, in-app backup export/import
- [VM_DEPLOYMENT_GUIDE.md](./VM_DEPLOYMENT_GUIDE.md) — Docker layout this script supports
- `src/lib/db/backup.ts` — dashboard-driven JSON export/import (per-table, UI flow)
