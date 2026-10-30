// Pilot rows A1-A5 (docs/SPEC-BACKTEST-PLAN.md section 6), as freeze inputs. `npm run backtest -- freeze` turns these
// into docs/backtest/corpus.json; after that the file, not this list, is the source of truth. No swaps.
import type { FreezeInput } from './corpus.ts';

export const PILOT_IDS = ['A1', 'A2', 'A11', 'A4', 'A5'];

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
    // Other hits (M3 SLO plan, RFD 0005) only mention the function as a code pointer.
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

/**
 * Corpus growth (2026-10-28): the plan's remaining tier-A rows A6-A10, frozen without any model call. Issue texts are NOT
 * generated here: that spends calls and the maintainer reads each one. A3 stays dropped (red base). Only 10 strict rows
 * exist: no commit since the first freeze passes the plan's filters (the only new non-merge commit touching code, 4bda598, is
 * a migration: spine work with 17 files), and every other commit that passes filter 1 is bundled, chained, spine or a refactor.
 */
export const GROWTH_ROWS: FreezeInput[] = [
  {
    id: 'A6', sha: '6d1771a', tier: 'A', obs: 'E', component: 'issue UI', kind: 'body+doc',
    note: 'commit subject plus the base problem statement in docs/FOCUS.md (code review N1, problem clause only); the commit cites `spec: code-review N1`, ignored. Base docs/AGENTS-REVIEWER.md:68 ("Origin check before every DO read") states the fix, so it is scrubbed from every agent checkout of this row.',
    docs: [{
      path: 'docs/FOCUS.md',
      quote: 'a cross-origin non-write request to an issue route (e.g. POST to',
    }],
    keyTerms: ['sameOrigin'],
    // M12/PRB docs name sameOrigin as a code pointer in unrelated token/UI work, not as this issue's fix.
    acknowledgedDocHits: ['docs/FOCUS.md', 'docs/M12-IMPL-PLAN-REVIEW.md', 'docs/M12-IMPL-PLAN.md', 'docs/M12-PRB-REVIEW.md', 'docs/M8-PR2-REVIEW.md', 'docs/plans/m6-ui-plan.md'],
    // The M8 plan and its review say "call sameOrigin once, before any DO read" for the write routes: close to the fix, so scrubbed too.
    scrubDocs: ['docs/AGENTS-REVIEWER.md', 'docs/M8-UI-ISSUES-PLAN.md', 'docs/M8-UI-ISSUES-PLAN-REVIEW.md', 'docs/M9-NAV-CODE-REVIEW.md'],
    corpusNote: 'Issue UI component: the plan kept it out of the pilot (issue/lifecycle route) but it is a normal full-run row.',
  },
  {
    id: 'A7', sha: 'bcca5bc', tier: 'A', obs: 'E', component: 'issue API', kind: 'subject',
    note: 'commit subject only (thin, mechanism-heavy). The OPEN-QUESTIONS line "nothing could close or reopen an issue" and docs/M8-UI-ISSUES-PLAN.md were both added after this base (post-change docs): not cited.',
    keyTerms: ['reopen'],
    acknowledgedDocHits: [],
    corpusNote: 'Adds a new route (PATCH issue status): acceptance must declare it isNew; the delta surface lists the new route.',
  },
  {
    id: 'A8', sha: '3790070', tier: 'A', obs: 'E', component: 'issue UI', kind: 'subject',
    note: 'commit subject only (mechanism-heavy: it names both routes; the rewrite must drop them). The base docs/FEATURE-PARITY.md names the real route and the cause, so it is scrubbed from every agent checkout of this row.',
    keyTerms: ['issue_comments'],
    // spec-do table name and route pointers elsewhere; FEATURE-PARITY is scrubbed
    acknowledgedDocHits: ['docs/OPEN-QUESTIONS.md', 'docs/ARCHITECTURE.md', 'docs/M8-UI-ISSUES-PLAN.md'],
    scrubDocs: ['docs/FEATURE-PARITY.md'],
    corpusNote: 'UI row: observable as an HTML page and a form post, so probes record status and a text body.',
  },
  {
    id: 'A9', sha: '746c42c', tier: 'A', obs: 'W', component: 'shadow-router', kind: 'subject',
    note: 'commit subject only; mechanism-heavy (a TTL cache, an env name, stale-on-error): the rewrite must state only that every mirrored request pays a Spec DO read for the live deploy refs',
    keyTerms: ['LIVE_REFS_CACHE_TTL_MS', 'LiveRefsCache'],
    acknowledgedDocHits: [],
    corpusNote: 'Worker-to-worker timing/config row (W): weak for the traffic rungs; a mechanism-heavy subject is the main leakage risk.',
  },
  {
    id: 'A10', sha: 'c0cfa86', tier: 'A', obs: 'W', component: 'shadow-router', kind: 'body+doc',
    note: 'commit subject plus the base problem statement in docs/OPEN-QUESTIONS.md (the unflushed tail of a short burst), problem clause only',
    docs: [{
      path: 'docs/OPEN-QUESTIONS.md',
      quote: 'a short burst leaves its last <20 samples unsent until the next canary request',
    }],
    keyTerms: ['unflushed'],
    acknowledgedDocHits: ['docs/OPEN-QUESTIONS.md'],
    corpusNote: 'Worker-internal timing row (W): the observable is how many samples are recorded after a burst.',
  },
];

export const ALL_ROWS: FreezeInput[] = [...PILOT_ROWS, ...GROWTH_ROWS];
