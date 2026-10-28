# beehive-gate-spike (throwaway) — DONE 2026-10-28

**Historical record.** S1-S5 were run and the worker, its container application and the queue were deleted. Results: `docs/OPEN-QUESTIONS.md` (two entries dated 2026-10-28) and
`docs/REAL-GATE-IMPL-PLAN.md` §2. The deploy steps below are obsolete (wrangler 4.151.1 also rejects the `docker.io` image they assumed; the run used a digest-pinned managed-registry image).

Answers S1-S5 of `docs/REAL-GATE-IMPL-PLAN.md`. **Maintainer-only: agents must not deploy it.** It is a separate Worker with its own
container application; it touches none of the ten workers and no ledger. It is outside `workers/`, so CI, typecheck and Workers
Builds ignore it.

## Deploy (no local Docker needed: the image is a registry image)

```
cd spikes/gate-spike
npx wrangler@4.151.1 queues create beehive-gate-spike-q          # once (S5)
npx wrangler@4.151.1 secret put SPIKE_TOKEN                      # any long random string; bearer for every route
npx wrangler@4.151.1 secret put CLOUDFLARE_API_TOKEN             # the Artifacts-scoped token (same as sandbox-runner's); only S1/S2 use it
npx wrangler@4.151.1 deploy
```

## Run (each prints JSON; read `steps[].out`)

```
U=https://beehive-gate-spike.<subdomain>.workers.dev; A="Authorization: Bearer $SPIKE_TOKEN"
# S4 first, before anything runs candidate code: control row shows https-registry OK, every other row ERR; the second block must be all ERR
curl -sS -H "$A" -d '{"action":"egress","size":"standard-2"}' $U/run
# S1 + S2: a real commit of this repo on Artifacts (repo name + 40-hex sha); same input for each size
curl -sS -m 700 -H "$A" -d '{"action":"measure","size":"standard-1","repo":"<repo>","commitSha":"<sha>"}' $U/run
curl -sS -m 700 -H "$A" -d '{"action":"measure","size":"standard-2","repo":"<repo>","commitSha":"<sha>"}' $U/run
# S3: start 25 containers at once (lite, 30 s each); look for which indexes fail and with what error
curl -sS -m 300 -H "$A" -d '{"n":25}' $U/flood
# S5: one 590 s call over HTTP, then through a queue consumer (poll status after ~10 min)
curl -sS -m 700 -H "$A" -d '{"action":"hold","size":"lite","seconds":590}' $U/run
curl -sS -H "$A" -d '{"seconds":590}' $U/enqueue; curl -sS -H "$A" "$U/status?name=hold-q"
```

Record `peak_mem_bytes`, `disk_mb`, wall `ms` per size, the flood result, and the S5 outcome in `docs/OPEN-QUESTIONS.md`.

## Delete (always)

```
npx wrangler@4.151.1 delete --name beehive-gate-spike
npx wrangler@4.151.1 containers list                             # then: containers delete <id> for the spike's application
npx wrangler@4.151.1 queues delete beehive-gate-spike-q
```
