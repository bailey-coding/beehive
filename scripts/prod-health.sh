#!/usr/bin/env bash
# Health check for the ten deployed Beehive workers (production; read-only GETs).
#
# Usage:  BEEHIVE_API_TOKEN=... ./scripts/prod-health.sh
#   BEEHIVE_API_TOKEN   the API_AUTH_TOKEN value; required, never printed
#   WORKERS_SUBDOMAIN   workers.dev subdomain (default: bz23711)
#
# Two kinds of check:
#   /health on every worker: the worker is deployed and the token matches.
#   GET /api/organizations?limit=1 on beehive: the only check that reaches the Spec DO. The edge
#   /health is static (it answers 'durableObject: ok' without calling the DO), so it cannot see a
#   failed migration. This request is the first DO call after a deploy, so it also runs the
#   migrations (docs/OPS.md checklist step 4): 200 = the ledger initialised, 500 = a migration
#   failed (read the beehive logs: `Migration to m[4-8] failed`).
#
# Exit status 0 only if every check answered 200. The token goes to curl through stdin, not argv.

set -u

: "${BEEHIVE_API_TOKEN:?BEEHIVE_API_TOKEN is not set (the API_AUTH_TOKEN value)}"
SUBDOMAIN="${WORKERS_SUBDOMAIN:-bz23711}"

WORKERS=(
  beehive
  beehive-gate-workflow
  beehive-queue-consumer
  beehive-shadow-router
  beehive-scientist-comparator
  beehive-preview-manager
  beehive-candidate-service
  beehive-canary-worker
  beehive-promotion-worker
  beehive-sandbox-runner
)

status_of() {
  printf 'header = "Authorization: Bearer %s"\n' "$BEEHIVE_API_TOKEN" |
    curl -s -K - -o /dev/null -m 20 -w '%{http_code}' "$1"
}

failed=0
check() {
  local label="$1" url="$2" code
  code="$(status_of "$url")"
  if [ "$code" = "200" ]; then
    printf '  ok    %-34s %s\n' "$label" "$code"
  else
    printf '  FAIL  %-34s %s\n' "$label" "$code"
    failed=1
  fi
}

echo "Workers (/health):"
for w in "${WORKERS[@]}"; do
  check "$w" "https://$w.$SUBDOMAIN.workers.dev/health"
done

echo
echo "Spec DO (runs the migrations on its first call after a deploy):"
check "beehive -> Spec DO" "https://beehive.$SUBDOMAIN.workers.dev/api/organizations?limit=1"

echo
if [ "$failed" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Some checks failed. 401: wrong API_AUTH_TOKEN or a worker not redeployed yet; 500 on the Spec DO line:"
  echo "a migration failed (docs/OPS.md checklist step 4); 000: no response."
fi
exit "$failed"
