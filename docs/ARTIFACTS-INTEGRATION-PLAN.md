---
category: setup
status: active
audience: human,agent
tags:
  - integration
  - artifacts
---


## Commit Message Template

```
step: implement Artifacts integration for spec claim | task: artifacts-integration | spec: n/a | confidence: 0.95

- Add artifacts.ts client with createFork() and createRepoToken()
- Update claimSpec() to create real Artifacts repos
- Update API router to pass through real repo data
- Add CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN env vars
- Include integration test script
```
