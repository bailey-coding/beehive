#!/usr/bin/env bash
# Local SPIKE Validation (Miniflare mode)
#
# Validates the foundational workflow against `wrangler dev` (local Miniflare),
# requiring NO Cloudflare credentials:
#   create org/actor/spec -> claim spec x2 (creates candidate fork repos)
#   -> verify repositories/candidates/history recorded in the Spec DO
#
# The remote Artifacts variant (cf CLI + real namespaces) is spike-validation.sh.
#
# Usage: ./spike-local.sh [base-url]
# Example: ./spike-local.sh http://localhost:8787

set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"

# Load local dev auth token (same value wrangler dev reads from .dev.vars);
# an externally set API_AUTH_TOKEN takes precedence.
DEV_VARS="$(cd "$(dirname "$0")/.." && pwd)/.dev.vars"
if [ -f "$DEV_VARS" ] && [ -z "${API_AUTH_TOKEN:-}" ]; then
  set -a
  source "$DEV_VARS"
  set +a
fi

PASS=0
FAIL=0

ok()   { echo -e "\033[0;32m[PASS]\033[0m $1"; PASS=$((PASS+1)); }
bad()  { echo -e "\033[0;31m[FAIL]\033[0m $1"; FAIL=$((FAIL+1)); }

# POST helper: post <path> <json> <actor>
post() {
  BASE_URL="$BASE_URL" node --input-type=module -e '
    const base = process.env.BASE_URL;
    const [path, body, actor] = process.argv.slice(1);
    const headers = {
      "Content-Type": "application/json",
      "X-Actor-ID": actor,
      "Authorization": "Bearer " + process.env.API_AUTH_TOKEN,
    };
    const res = await fetch(base + path, {
      method: "POST",
      headers,
      body,
    });
    const json = await res.json().catch(() => null);
    console.log(JSON.stringify({ status: res.status, json }));
  ' "$1" "$2" "$3"
}

get() {
  BASE_URL="$BASE_URL" node --input-type=module -e '
    const base = process.env.BASE_URL;
    const [path] = process.argv.slice(1);
    const res = await fetch(base + path, {
      headers: {
        "X-Actor-ID": "spike",
        "Authorization": "Bearer " + process.env.API_AUTH_TOKEN,
      },
    });
    const json = await res.json().catch(() => null);
    console.log(JSON.stringify({ status: res.status, json }));
  ' "$1"
}

echo "=== Beehive SPIKE (local Miniflare) ==="
echo "Target: $BASE_URL"

# 1. Health
HEALTH=$(get "/health")
echo "$HEALTH" | grep -q '"status":"healthy"' && ok "health check" || bad "health check: $HEALTH"

# 2. Create org
ORG=$(post "/api/organizations" '{"name":"spike-local","type":"artifacts"}' "spike-founder")
echo "$ORG" | grep -q '"status":201' && ok "create organization" || bad "create organization: $ORG"
ORG_ID=$(echo "$ORG" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log(d.json?.data?.id||"")')

# 3. Create agent actor
ACTOR=$(post "/api/actors" '{"type":"agent","name":"spike-agent"}' "spike-founder")
echo "$ACTOR" | grep -q '"status":201' && ok "create agent actor" || bad "create agent actor: $ACTOR"
ACTOR_ID=$(echo "$ACTOR" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log(d.json?.data?.id||"")')

# 4. Create spec
SPEC=$(post "/api/specs" "{\"name\":\"spike-spec-$(date +%s)\",\"description\":\"spike\",\"contract\":\"{}\",\"declaredDeltaSurface\":[\"/shorten\"],\"organizationId\":\"$ORG_ID\",\"createdBy\":\"$ACTOR_ID\"}" "$ACTOR_ID")
echo "$SPEC" | grep -q '"status":201' && ok "create spec" || bad "create spec: $SPEC"
SPEC_ID=$(echo "$SPEC" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log(d.json?.data?.id||"")')

# 5. Claim spec twice -> two candidate forks
CLAIM1=$(post "/api/specs/$SPEC_ID/claim" "{\"agentId\":\"$ACTOR_ID\"}" "$ACTOR_ID")
echo "$CLAIM1" | grep -q '"candidateId":"[0-9a-f-]' && ok "claim #1 creates fork repo" || bad "claim #1: $CLAIM1"
CLAIM2=$(post "/api/specs/$SPEC_ID/claim" "{\"agentId\":\"$ACTOR_ID\"}" "$ACTOR_ID")
echo "$CLAIM2" | grep -q '"candidateId":"[0-9a-f-]' && ok "claim #2 creates fork repo" || bad "claim #2: $CLAIM2"
echo "$CLAIM1" | grep -q '"repositoryUrl":"https://artifacts.dev/default/candidate-' && ok "claim returns repositoryUrl" || bad "claim repositoryUrl: $CLAIM1"
echo "$CLAIM1" | grep -q '"token":"[0-9a-f-]' && ok "claim returns token" || bad "claim token: $CLAIM1"
echo "$CLAIM1" | grep -q '"tokenExpiresAt":' && ok "claim returns token + expiry" || bad "claim token: $CLAIM1"
CAND_ID=$(echo "$CLAIM1" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log(d.json?.data?.candidateId||"")')

# 6. Repositories recorded (>= 2 candidate forks)
REPOS=$(get "/api/repositories?limit=10")
REPO_COUNT=$(echo "$REPOS" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log((d.json?.data||[]).length)')
[ "${REPO_COUNT:-0}" -ge 2 ] && ok "fork repositories recorded ($REPO_COUNT)" || bad "fork repositories recorded ($REPO_COUNT): $REPOS"

# 7. Candidates recorded
CANDS=$(get "/api/candidates?limit=10")
CAND_COUNT=$(echo "$CANDS" | node --input-type=module -e 'const d=JSON.parse(await import("node:fs").then(fs=>fs.readFileSync(0,"utf8")));console.log((d.json?.data||[]).length)')
[ "${CAND_COUNT:-0}" -ge 2 ] && ok "candidates recorded ($CAND_COUNT)" || bad "candidates recorded ($CAND_COUNT): $CANDS"

# 8. Entity history recorded for the claim
HIST=$(get "/api/entities/candidate/$CAND_ID/history")
echo "$HIST" | grep -q '"notes":"Candidate claimed spec"' && ok "entity history records claim" || bad "entity history: $HIST"

# 9. Gate verdict recorded
VERDICT=$(post "/api/gate-verdicts" "{\"candidateId\":\"$CAND_ID\",\"gate\":\"pre-merge\",\"status\":\"pass\",\"score\":95,\"complexityDelta\":1.2,\"notes\":\"spike-local\"}" "$ACTOR_ID")
echo "$VERDICT" | grep -q '"status":201' && ok "pre-merge verdict recorded" || bad "pre-merge verdict: $VERDICT"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
