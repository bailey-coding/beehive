#!/usr/bin/env bash
# Verifies the promotion worker's candidate routes against PRODUCTION (promotion-routes-fix).
# WRITES to the live ledger: a test org tree, a tournament, a candidate stage change. Run it by hand, once, on purpose.
#
# Usage:
#   BEEHIVE_API_TOKEN=... MAINTAINER_ACTOR_ID=<your actor id> CONFIRM_PROD_WRITE=yes ./scripts/prod-verify-promotion.sh
#   WORKERS_SUBDOMAIN   workers.dev subdomain (default: bz23711)
#
# What it does (AGENTS.md: no production e2e without human approval, the ledger has tombstone + purge now):
#   1. creates test-org-e2e-prodcheck-<ts> -> repo -> spec -> two candidates (a real tree: the winner is recorded
#      on a real candidate, so made-up ids would correctly fail)
#   2. places both candidates on the shadow rung (the master-tier stage PATCH, the documented break-glass) and gives them shadow scores
#      (60 and 90) through the maintainer-only edge route: production candidates have none until the shadow-router follow-up
#      (docs/plans/promotion-gaps-plan.md), and the tournament refuses without them
#   3. sets the promotion mode to tournament, asks to promote both to train (first 202 waiting, second 200 decided), restores the mode
#   4. checks the tournament is `completed` and that the HIGHER score won (not the first arrival) with stage `passed_shadow`
#   5. tombstones the test org (maintainer-only). Purge by prefix later, after PURGE_MIN_AGE_HOURS (docs/OPS.md).
# The token goes to curl through stdin, not argv. Exit 0 = PASS.

set -u

: "${BEEHIVE_API_TOKEN:?BEEHIVE_API_TOKEN is not set}"
: "${MAINTAINER_ACTOR_ID:?MAINTAINER_ACTOR_ID is not set (needed to tombstone the test org)}"
[ "${CONFIRM_PROD_WRITE:-}" = "yes" ] || { echo "Refusing: this writes to PRODUCTION. Set CONFIRM_PROD_WRITE=yes to proceed." >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

SUB="${WORKERS_SUBDOMAIN:-bz23711}"
API="https://beehive.$SUB.workers.dev"
PROMO="https://beehive-promotion-worker.$SUB.workers.dev"
TS="$(date +%s)"

call() { # method base path [json-body] [actor-id]
  local m="$1" base="$2" p="$3" b="${4:-}" a="${5:-}"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$BEEHIVE_API_TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    [ -n "$a" ] && printf 'header = "X-Actor-ID: %s"\n' "$a"
  } | curl -s -K - -X "$m" -m 60 ${b:+-d "$b"} "$base$p"
}
fail() { echo "FAIL: $*" >&2; RESULT=1; }
RESULT=0
ORG="" ; ORIGINAL_MODE=""

cleanup() {
  if [ -n "$ORIGINAL_MODE" ] && [ "$ORIGINAL_MODE" != "null" ]; then
    call POST "$PROMO" /mode "{\"mode\":\"$ORIGINAL_MODE\"}" >/dev/null && echo "restored promotion mode: $ORIGINAL_MODE"
  fi
  if [ -n "$ORG" ]; then
    r="$(call DELETE "$API" "/api/organizations/$ORG" '{"reason":"prod verification of promotion-routes-fix"}' "$MAINTAINER_ACTOR_ID")"
    echo "tombstoned test org $ORG: $(echo "$r" | jq -c '.data // .error' 2>/dev/null)"
  fi
}
trap cleanup EXIT

id_of() { jq -r '.data.id // empty'; }

echo "== seed (test-org-e2e-prodcheck-$TS)"
ACTOR="$(call POST "$API" /api/actors "{\"type\":\"agent\",\"name\":\"prodcheck-$TS\"}" | id_of)"
[ -n "$ACTOR" ] || { fail "could not create actor"; exit 1; }
ORG="$(call POST "$API" /api/organizations "{\"name\":\"test-org-e2e-prodcheck-$TS\",\"type\":\"artifacts\"}" "$ACTOR" | id_of)"
[ -n "$ORG" ] || { fail "could not create org"; exit 1; }
REPO="$(call POST "$API" /api/repositories "{\"name\":\"repo\",\"organizationId\":\"$ORG\",\"repoType\":\"baseline\",\"remoteUrl\":\"https://example.invalid/r.git\",\"namespace\":\"prodcheck\"}" "$ACTOR" | id_of)"
SPEC="$(call POST "$API" /api/specs "{\"name\":\"spec\",\"contract\":\"{}\",\"declaredDeltaSurface\":[],\"organizationId\":\"$ORG\"}" "$ACTOR" | id_of)"
C1="$(call POST "$API" /api/candidates "{\"specId\":\"$SPEC\",\"repositoryId\":\"$REPO\",\"commitSha\":\"sha1\",\"baseCommitSha\":\"base\"}" "$ACTOR" | id_of)"
C2="$(call POST "$API" /api/candidates "{\"specId\":\"$SPEC\",\"repositoryId\":\"$REPO\",\"commitSha\":\"sha2\",\"baseCommitSha\":\"base\"}" "$ACTOR" | id_of)"
[ -n "$REPO" ] && [ -n "$SPEC" ] && [ -n "$C1" ] && [ -n "$C2" ] || { fail "seed incomplete (repo=$REPO spec=$SPEC c1=$C1 c2=$C2)"; exit 1; }
echo "org=$ORG spec=$SPEC candidates=$C1 $C2"

echo "== place the candidates on the shadow rung and give them shadow scores"
for c in "$C1" "$C2"; do
  [ "$(call PATCH "$API" "/api/candidates/$c/stage" '{"stage":"passed_premerge","notes":"prod-verify fixture"}' "$ACTOR" | jq -r '.data.stage // empty')" = "passed_premerge" ] || fail "could not place $c on the shadow rung"
done
samples() { jq -nc --arg p "$1" --argjson s "$2" '{samples: [range(0;20) | {requestId: ($p + "-" + (. | tostring)), score: $s, matched: false, diffs: []}]}'; }
for pair in "$C1:60" "$C2:90"; do
  c="${pair%%:*}"; score="${pair##*:}"
  [ "$(call POST "$API" "/api/candidates/$c/shadow-samples" "$(samples "prodcheck-$TS-$c" "$score")" "$ACTOR" | jq -r '.data.sampleCount // empty')" = "20" ] || fail "could not post shadow samples for $c"
done

echo "== promote in tournament mode (shadow -> train)"
ORIGINAL_MODE="$(call GET "$PROMO" /mode | jq -r '.mode // empty')"
echo "original mode: ${ORIGINAL_MODE:-unknown}"
[ "$(call POST "$PROMO" /mode '{"mode":"tournament"}' | jq -r '.mode // empty')" = "tournament" ] || fail "could not set tournament mode"
for c in "$C1" "$C2"; do
  r="$(call POST "$PROMO" /promote "{\"candidateId\":\"$c\",\"specId\":\"$SPEC\",\"toRung\":\"train\",\"actorId\":\"$ACTOR\"}")"
  echo "promote $c: $(echo "$r" | jq -c '{success, outcome, code, message}' 2>/dev/null || echo "$r")"
  [ "$(echo "$r" | jq -r '.success // false')" = "true" ] || fail "promote $c did not succeed"
done

echo "== check the ledger and the candidate"
T="$(call GET "$PROMO" /tournament | jq -c --arg s "$SPEC" '[.tournaments[]? | select(.specId==$s)][0]')"
STATUS="$(echo "$T" | jq -r '.status // empty')"; WINNER="$(echo "$T" | jq -r '.winner // empty')"
echo "tournament: status=$STATUS winner=$WINNER"
[ "$STATUS" = "completed" ] || fail "tournament status is '$STATUS', expected completed"
[ -n "$WINNER" ] || fail "tournament has no winner"
[ "$WINNER" = "$C2" ] || fail "the winner is $WINNER, expected $C2 (the higher shadow score, 90, which arrived second)"
if [ -n "$WINNER" ]; then
  STAGE="$(call GET "$API" "/api/candidates/$WINNER" | jq -r '.data.stage // empty')"
  echo "winner stage: $STAGE"
  [ "$STAGE" = "passed_shadow" ] || fail "winner stage is '$STAGE', expected passed_shadow"
fi
LOSER_STAGE="$(call GET "$API" "/api/candidates/$C1" | jq -r '.data.stage // empty')"
[ "$LOSER_STAGE" = "passed_premerge" ] || fail "the loser's stage is '$LOSER_STAGE', expected passed_premerge"

echo
[ "$RESULT" -eq 0 ] && echo "PASS: the higher shadow score won the tournament and only the winner moved." || echo "FAILED: see messages above."
exit "$RESULT"
