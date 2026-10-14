---
ADR-0001
---

# ADR: VCS Client Model

**Status:** Accepted · **Date:** 2026-10-09

### Context

Artifacts speaks Git only (smart HTTP v1+v2 fetch, v1 receive-pack). The platform needs a
client model for agents and humans.

### Decision

**Sapling-first.** Sapling is Git-compatible over the wire (`sl clone/pull/push` against
any Git smart-HTTP remote), and its stacked-commit model maps naturally onto candidate
work. Platform-layer translates stacks to branches → review objects (the same problem
GitHub solved with `sl push` → PRs).

**Mercurial rejected** as a first target: no hg wire protocol in Artifacts; hg's named
branches with multiple heads, phases, and obsolescence markers don't map onto git refs;
bridges (git-cinnabar) don't support evolve/phases.

### Consequences

- Sapling's `.git/sl` mutation metadata stays client-side; the platform models stacks itself.
- Partial clone (blobless) and sparse cone mode work unchanged — they're fetch-side (v2
  upload-pack), independent of v1-only receive-pack.
- Blobless clones require network+credentials for lazy fetches: use full prefetch or plain
  sparse checkout in credential-constrained validation runs.
