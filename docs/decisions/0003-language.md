---
ADR-0003
---

# ADR: Language Strategy

**Status:** Accepted · **Date:** 2026-10-09

**TypeScript** for ~95%: best-represented in agent training data (token efficiency),
native to the V8-isolate runtime, first-class typed bindings. **Zig→WASM** only for
measured CPU-bound kernels (high-volume comparator hashing) — the same pattern as
Cloudflare's own Artifacts git engine. **Python** lives only inside Sandboxes where
coding agents do candidate work. Explicitly not: Rust (token-poor), Go (weak fit).
