# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automated deployment.

## Auto-Deploy Setup

The `deploy.yml` workflow automatically deploys all Cloudflare Workers whenever code is pushed to the `main` branch.

### Required GitHub Repository Secrets

To enable auto-deploy, you must configure the following secrets in your GitHub repository:

1. **`CLOUDFLARE_ACCOUNT_ID`** - Your Cloudflare account ID (e.g., `YOUR_CLOUDFLARE_ACCOUNT_ID`)
2. **`WORKERS_SUBDOMAIN`** - Your workers.dev subdomain (the part before `.workers.dev`). Used to build preview URLs; if unset, previews fall back to `https://<worker>.workers.dev`, which will not resolve
3. **`CLOUDFLARE_API_TOKEN`** - A Cloudflare API token with permissions:
   - Workers: Edit Cloudflare Workers
   - Workers Queues: Edit
   - Account: Read
   - Analytics: Edit

### How to Create the API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template
4. Select your account
5. Click "Create Token"
6. Copy the token value (you won't be able to see it again)

### How to Set Up Secrets in GitHub

1. Go to your repository on GitHub
2. Click Settings > Secrets and variables > Actions
3. Click "New repository secret"
4. Add `CLOUDFLARE_ACCOUNT_ID`, `WORKERS_SUBDOMAIN` and `CLOUDFLARE_API_TOKEN`

### Workers Deployed

The workflow deploys the following workers in order:

1. **beehive** (main API + Spec DO) - Must deploy first
2. **beehive-gate-workflow** - Pre-merge gate processing
3. **beehive-queue-consumer** - Queue message processing
4. **beehive-sandbox-runner** - Sandbox execution
5. **beehive-shadow-router** - Shadow traffic router
6. **beehive-canary-worker** - Canary deployments with SLO monitoring and auto-rollback
7. **beehive-promotion-worker** - Tournament and Merge-Train promotion modes
8. **beehive-scientist-comparator** - Scientist comparison for shadow rung
9. **beehive-preview-manager** - Preview Worker deployments
10. **beehive-candidate-service** - Candidate preview API

### Deployment Order

The workers are deployed sequentially to ensure dependencies are available:
- The main `beehive` worker hosts the SpecDO class and must be deployed first
- Other workers bind to it via `script_name = "beehive"` in their wrangler.toml

### Local Development

For local development, use the start scripts instead:
```bash
./scripts/start-all.sh
```

This starts all workers locally on ports 8787-8794.

### Troubleshooting

If deployments fail:
1. Check that all secrets are configured correctly
2. Verify your Cloudflare API token has the required permissions
3. Check the Actions tab in your GitHub repository for error logs
4. Run `npx wrangler deploy` locally to test deployment manually

See `docs/TROUBLESHOOTING.md` for more detailed troubleshooting.
