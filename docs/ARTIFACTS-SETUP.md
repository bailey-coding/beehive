---
category: setup
status: active
audience: human,agent
tags:
  - cloudflare
  - artifacts
---


## Worker Deployment Configuration

Each worker's `wrangler.toml` includes the Artifacts configuration:

```toml
[vars]
CLOUDFLARE_ACCOUNT_ID = "@cf-account-id"
```

After deployment, set the secret:
```bash
wrangler secret put CLOUDFLARE_API_TOKEN
```

The secret is per-worker and does not propagate automatically.

