---
category: deprecated
status: deprecated
audience: human
tags:
  - review-needed
---


## Notes

- Use `unknown` instead of `any` when the type is truly unknown/dynamic
- Prefer explicit interfaces over `Record<string, any>`
- For Cloudflare bindings (ARTIFACTS, SANDBOX), `unknown` is acceptable
- Test files can use `unknown` for mock data
- All external-facing types should be properly defined
