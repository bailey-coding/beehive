// Pilot rows A1-A5 (docs/SPEC-BACKTEST-PLAN.md section 6), as freeze inputs. `npm run backtest -- freeze` turns these
// into docs/backtest/corpus.json; after that the file, not this list, is the source of truth. No swaps.
import type { FreezeInput } from './corpus.ts';

export const PILOT_ROWS: FreezeInput[] = [
  {
    id: 'A1', sha: 'b024272', tier: 'A', obs: 'E', component: 'api router', kind: 'body',
    note: 'commit body (bug report); fix-listing bullets cut',
    keyTerms: ['roadmap'],
    corpusNote: "The base's vitest include covers only tests/** (6 tests), so the full-run oracle is nearly empty here: pre-merge rests on the acceptance tests and tsc; the held-out test file runs through a derived config.",
    acknowledgedDocHits: ['docs/README.md'], // lists "Roadmaps" as a doc category; says nothing about the route
  },
  {
    id: 'A2', sha: '57d91c7', tier: 'A', obs: 'E', component: 'spec-do, shadow-router', kind: 'body+doc',
    note: 'base finding SF-3 in docs/OPEN-QUESTIONS.md, problem clause only (the router-side mechanism sentence is not quoted)',
    docs: [{
      path: 'docs/OPEN-QUESTIONS.md',
      quote: 'The Spec DO accepts any `candidateId` and `url`, and the router trusted the id string',
    }, {
      path: 'docs/OPEN-QUESTIONS.md',
      quote: '**Open:** the Spec DO route itself still accepts anything (the trust boundary); validate there too.',
    }],
    keyTerms: ['applyCanaryRefs'],
    corpusNote: 'Base flaky: workers/shadow-router/tests/mirror-safety.test.ts has a fake-timer flake (reviewer-observed; did not fire in the 3-run base check). Kept; flaky tests are retried and never counted as red or as regressions.',
    // The agents can read the whole SF-3 paragraph in the tree; it states the router fix, which already exists at base.
    // Other hits (M3 SLO plan, RFC 0005) only mention the function as a code pointer.
    acknowledgedDocHits: ['docs/OPEN-QUESTIONS.md', 'docs/M3-CANARY-SLO-PLAN.md', 'docs/rfcs/0005-shadow-router-cache.md'],
  },
  {
    // A3 (c2d4906) was DROPPED: its base is genuinely red (49 failing tests answer 503 until c2d4906 is applied), so the
    // full-run oracle cannot be trusted there. Replaced by A11 (plan tier A, obs N control, CLI component: new to the
    // pilot, no parent link and no shared source file with A1/A2/A4/A5).
    id: 'A11', sha: 'de8817c', tier: 'A', obs: 'N', component: 'CLI', kind: 'subject',
    note: 'commit subject only (thin text); the `spec: review S4` it cites is unrelated and unresolvable, ignored; trailers stripped',
    keyTerms: ['ActorIdSchema'],
    corpusNote: 'Control row (N: not HTTP-visible): no probe replay, so conformance and shadow rungs do not run; oracles are the repo tests and the held-out CLI test. cli/ dependencies must be installed at the base.',
  },
  {
    id: 'A4', sha: '831d9db', tier: 'A', obs: 'W', component: 'canary-worker', kind: 'body',
    note: 'commit body. FINDING: base docs/M3-CANARY-SLO-PLAN.md:46-48 states the fix (defaults when unset, invalid config yields no verdict), so it is scrubbed from every agent checkout of this row',
    keyTerms: ['NaN'],
    // Reviewed: the other NaN hits (M8 recheck, do-bind-order review) concern issue-number parsing, not SLO thresholds.
    acknowledgedDocHits: ['docs/M8-PR1-RECHECK.md', 'docs/plans/do-bind-order-review.md'],
    scrubDocs: ['docs/M3-CANARY-SLO-PLAN.md'],
  },
  {
    id: 'A5', sha: 'e326b8c', tier: 'A', obs: 'E', component: 'preview-manager', kind: 'body+doc',
    note: 'commit subject plus base OPS.md/SETUP.md problem statements (production answers 501, stub is local-only)',
    docs: [{
      path: 'docs/OPS.md',
      quote: 'Do not set it in production; it would record versions that were never built.',
    }],
    keyTerms: ['BEEHIVE_LOCAL_DEV'],
  },
];
