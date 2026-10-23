#!/usr/bin/env bash
# Set the Workers Builds watch paths of the ten workers from scripts/builds-watch-paths.json.
# The Cloudflare Terraform provider has no Workers Builds resource, so this PATCHes the Builds API.
# Human-only, like the deploy push (AGENTS.md): it changes production build config.
#
# Usage:  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/builds-watch-paths.sh [--apply]
#   CLOUDFLARE_API_TOKEN   user-scoped token with Workers Builds edit access (account-scoped tokens
#                          answer "Invalid token"); never printed
#   CLOUDFLARE_ACCOUNT_ID  account that owns the workers
#   --apply                send the PATCH; without it the script only prints what would change
#
# For each worker: GET /workers/scripts for its tag, GET /builds/workers/<tag>/triggers for its
# triggers (production and preview), then PATCH /builds/triggers/<uuid> with path_includes and
# path_excludes only. Needs jq. Exit status 0 only if every worker was read (and patched, with --apply).
# Docs: https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/ (only `*` is a
# wildcard; excludes are checked first; a push of 20+ commits or 3000+ files always builds).

set -u

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set (user-scoped token)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

CONFIG="$(dirname "$0")/builds-watch-paths.json"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# api METHOD PATH [BODY]: prints the response body; the token goes to curl through stdin, not argv.
api() {
  local method="$1" path="$2" body="${3:-}"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    [ -n "$body" ] && printf 'data = "%s"\n' "$(printf '%s' "$body" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  } | curl -s -K - -m 30 -X "$method" "$API$path"
}

patch="$(jq -c '{path_includes, path_excludes}' "$CONFIG")"
echo "Target: $patch"
[ "$APPLY" -eq 1 ] || echo "(dry run: pass --apply to send the PATCH)"
echo

scripts="$(api GET /workers/scripts)"
if ! jq -e '.success' >/dev/null 2>&1 <<<"$scripts"; then
  echo "Could not list workers: $(jq -c '.errors' <<<"$scripts" 2>/dev/null || echo "$scripts")" >&2
  exit 1
fi

failed=0
for w in $(jq -r '.workers[]' "$CONFIG"); do
  tag="$(jq -r --arg w "$w" '.result[] | select(.id == $w) | .tag' <<<"$scripts")"
  if [ -z "$tag" ]; then
    printf '  FAIL  %-30s worker not found (1042 = not deployed yet)\n' "$w"; failed=1; continue
  fi
  triggers="$(api GET "/builds/workers/$tag/triggers")"
  if ! jq -e '.success' >/dev/null 2>&1 <<<"$triggers"; then
    printf '  FAIL  %-30s cannot read triggers: %s\n' "$w" "$(jq -c '.errors' <<<"$triggers" 2>/dev/null)"; failed=1; continue
  fi
  if [ "$(jq '.result | length' <<<"$triggers")" -eq 0 ]; then
    printf '  FAIL  %-30s no build triggers (worker not connected to Workers Builds)\n' "$w"; failed=1; continue
  fi
  while IFS=$'\t' read -r uuid name inc exc; do
    cur="{\"path_includes\":$inc,\"path_excludes\":$exc}"
    if [ "$cur" = "$patch" ]; then
      printf '  same  %-30s %s\n' "$w" "$name"; continue
    fi
    if [ "$APPLY" -eq 0 ]; then
      printf '  would %-30s %s: %s -> %s\n' "$w" "$name" "$cur" "$patch"; continue
    fi
    res="$(api PATCH "/builds/triggers/$uuid" "$patch")"
    if jq -e '.success' >/dev/null 2>&1 <<<"$res"; then
      printf '  set   %-30s %s\n' "$w" "$name"
    else
      printf '  FAIL  %-30s %s: %s\n' "$w" "$name" "$(jq -c '.errors' <<<"$res" 2>/dev/null)"; failed=1
    fi
  done < <(jq -r '.result[] | [.trigger_uuid, .trigger_name, (.path_includes // [] | tojson), (.path_excludes // [] | tojson)] | @tsv' <<<"$triggers")
done
exit "$failed"
