---
category: verification
status: active
audience: human,agent
tags:
  - verification
  - testing
---


## 📞 Troubleshooting

### No push events received
1. Verify queue consumer is running: `curl http://localhost:8789/health`
2. Verify queue exists: `npm run queue:create`
3. Check Artifacts webhook configuration

### Gate workflow not triggered
1. Verify service binding in Spec DO: `GATE_WORKFLOW: Service`
2. Check queue consumer logs for errors
3. Verify gate workflow is running: `curl http://localhost:8788/health`

### Artifacts fork not created
1. Verify `CLOUDFLARE_API_TOKEN` has correct permissions
2. Verify `CLOUDFLARE_ACCOUNT_ID` is set
3. Check `workers/shared/artifacts.ts` for API call errors

### Permission errors
1. Set `API_AUTH_TOKEN` for all workers: `wrangler secret put API_AUTH_TOKEN`
2. For local dev: set `API_AUTH_TOKEN=dev-local-spike-token` in `.dev.vars`
