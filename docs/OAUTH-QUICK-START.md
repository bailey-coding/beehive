---
category: integration
status: active
audience: human,agent
tags:
  - quick-start
  - oauth
---


## M4 Submission Requirements

For the competition submission deadline (2026-10-14), ensure:

**✅ Required:**
- Cloudflare API Token configured on all workers
- Cloudflare Account ID configured on all workers
- API_AUTH_TOKEN configured for worker-to-worker auth
- Artifacts integration functional

**⚠️ Optional:**
- GitHub OAuth App created and secrets set (done 2026-10-13)
- GitHub OAuth login implemented in `workers/api/ui.ts`

**Note:** `API_AUTH_TOKEN` still secures the REST API and worker-to-worker calls; the browser UI uses its own signed session.
