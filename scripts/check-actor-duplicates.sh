#!/usr/bin/env bash
# Pre-deploy check for migration m12 (docs/OPS.md checklist step 1a): read-only. Pages GET /api/actors and groups
# the rows by github_user_id client-side, ignoring NULL and '' (the partial unique index does too).
#
# Usage:  BEEHIVE_API_TOKEN=... ./scripts/check-actor-duplicates.sh
#   BEEHIVE_API_TOKEN   the API_AUTH_TOKEN value; required, never printed
#   BEEHIVE_API_URL     base URL of the edge (default: https://beehive.$WORKERS_SUBDOMAIN.workers.dev)
#   WORKERS_SUBDOMAIN   workers.dev subdomain (default: bz23711)
#
# Output is limited to the duplicate groups (github_user_id and actor ids; no names, no other actors).
# Exit status: 0 = no duplicates (safe to push), 1 = duplicates found, 2 = the check itself failed (do not push on 2).
# GET only. The token goes to curl through stdin, not argv; no X-Actor-ID header is sent.

set -u

: "${BEEHIVE_API_TOKEN:?BEEHIVE_API_TOKEN is not set (the API_AUTH_TOKEN value)}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
SUBDOMAIN="${WORKERS_SUBDOMAIN:-bz23711}"
BASE="${BEEHIVE_API_URL:-https://beehive.$SUBDOMAIN.workers.dev}"
LIMIT=500
MAX_PAGES=200

rows='[]'
offset=0
for ((page = 0; page < MAX_PAGES; page++)); do
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$BEEHIVE_API_TOKEN" |
    curl -sS -K - -m 30 -w '\n%{http_code}' "$BASE/api/actors?limit=$LIMIT&offset=$offset")" || {
    echo "request failed (offset $offset)" >&2
    exit 2
  }
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$code" != "200" ]; then
    echo "GET /api/actors answered $code at offset $offset (check not done)" >&2
    exit 2
  fi
  # A 200 whose body is not {success:true, data:[...]} is an error, never "empty"
  n="$(printf '%s' "$body" | jq -e 'if .success == true and (.data | type) == "array" then .data | length else error("bad body") end' 2>/dev/null)" || {
    echo "unexpected response body at offset $offset (check not done)" >&2
    exit 2
  }
  rows="$(jq -c -n --argjson a "$rows" --argjson b "$(printf '%s' "$body" | jq -c '[.data[] | {id, g: (.github_user_id // .githubUserId)}]')" '$a + $b')"
  [ "$n" -lt "$LIMIT" ] && break
  offset=$((offset + LIMIT))
done
if [ "$page" -ge "$MAX_PAGES" ]; then
  echo "stopped after $MAX_PAGES pages (check not done)" >&2
  exit 2
fi

total="$(printf '%s' "$rows" | jq 'length')"
dups="$(printf '%s' "$rows" | jq -c '
  map(select(.g != null and .g != ""))
  | group_by(.g) | map(select(length > 1) | {github_user_id: .[0].g, n: length, actor_ids: (map(.id) | sort)})')"
if [ "$(printf '%s' "$dups" | jq 'length')" -eq 0 ]; then
  echo "no duplicate github_user_id among $total actors"
  exit 0
fi
printf '%s' "$dups" | jq -r '.[] | "DUPLICATE github_user_id=\(.github_user_id | @json) n=\(.n) actor_ids=\(.actor_ids | join(","))"'
echo "$(printf '%s' "$dups" | jq 'length') duplicate group(s) among $total actors: do NOT push (docs/OPS.md step 1a)" >&2
exit 1
