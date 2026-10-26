#!/bin/bash
# Snapshot every historical workers/spec-do/schema.sql (T1 fixtures for the legacy-migration matrix).
# Git only: no network, no wrangler, no production access. Output is committed; tests never call git.
# Usage: ./scripts/snapshot-schema-fixtures.sh   (run from anywhere in the repo; needs full history)
# Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 3.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
OUT=workers/spec-do/tests/fixtures/legacy
SCHEMA=workers/spec-do/schema.sql

# <commit> <schema_version a ledger created by that commit's code is at>
# Versions: the code's LATEST_SCHEMA_VERSION at that commit (bbccf9e..c27628a predate the constant: the
# highest version its migration chain reaches, read from the migration code).
COMMITS=(
  "bbccf9e m3"
  "d8e09bb m4"
  "48a5f54 m5"
  "aeec713 m6"
  "c27628a m7"
  "fbc9fb5 m8"
  "af1165f m9"
  "d34db95 m9"
  "469389b m10"
  "98d43df m10"
  "19705f8 m11"
)

mkdir -p "$OUT"
for entry in "${COMMITS[@]}"; do
  read -r sha version <<<"$entry"
  git cat-file -e "$sha:$SCHEMA" 2>/dev/null || { echo "missing $sha:$SCHEMA (fetch full history)" >&2; exit 1; }
  git show "$sha:$SCHEMA" >"$OUT/$version-$sha.sql"
  echo "$OUT/$version-$sha.sql"
done
