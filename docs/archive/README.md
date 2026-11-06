---
category: archive
status: archived
audience: human,agent
---

# Archive

Finished records, kept for history and provenance. Nothing here describes how Beehive works today; for that,
start at [../README.md](../README.md) and [../ARCHITECTURE.md](../ARCHITECTURE.md).

What lives here (moved 2026-11-06, `git log --follow` shows each file's history):

- **Phase and milestone records:** `PHASE-1..4` plans, reviews and merge reports; the M1, M2 and M4 plans
  (milestones complete or submitted, `../MILESTONES.md`).
- **Reviews, reports and results** of merged work: M2-M12 reviews and rechecks, implementation results,
  verification results, the test audit, the deploy-failure report, the submission review.
- **Custom request types** (PR #1): plan, implementation notes and both reviews.
- **Deprecated plans:** removing `any` types (two plans) and the zod migration.

Implemented designs that code still cites (M8, M9, M12, SF-8, the canary SLO plan and others) stay in `docs/`.
Backtest data (`docs/backtest/corpus.json`, `tools/backtest/pilot-rows.ts`) keeps the old paths on purpose: those
rows point into historical commits, where the files were still at `docs/<NAME>.md`.

Archive a document once its work is merged and nothing current depends on it. Use `git mv` and update links
(`tests/docs-links.test.ts` fails on a broken relative link).
