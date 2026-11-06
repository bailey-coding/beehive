---
category: planning
status: implemented
audience: human,agent
---

# Read-only viewer sign-in

**Goal.** Let anyone with a GitHub account look around the web UI (orgs, repos, specs, candidates,
trials, public issues) without being on `ALLOWED_GITHUB_USERS`. First step toward a human community
(conversation 2026-11-05: "open sign-up for read before the governance work is finished").

**Decisions (maintainer, 2026-11-05):** GitHub sign-in required (no anonymous `/app`); viewers get
**no actor row**, so untrusted users never write to the ledger (untrusted creation stays closed until
PR-G/PR-H, `docs/FOCUS.md`).

## Design

- **Switch.** `OPEN_VIEWER_SIGNIN = "true"` on the `beehive` worker turns it on. Unset (the default,
  and today's `wrangler.toml`) keeps the old behavior: a non-member gets "Access denied".
- **Sign-in** (`workers/api/ui.ts` `finishLogin`). Member (on the allowlist): unchanged, `ensureActor`
  then a member cookie. Non-member with the switch on: a cookie `{ login, actorId: '', viewer: true,
  iat, exp }`, same HMAC and 12 h TTL; no Spec DO call.
- **Cookie validity** (`readSession`). A member cookie needs a non-empty `actorId` and no `viewer`; a
  viewer cookie needs `viewer === true` and `actorId === ''`. Anything else is signed out. A viewer
  cookie is also dropped (redirect to `/login`, cookie cleared) when the switch is off or the login is
  now on the allowlist, so a promoted user signs in again and gets an actor row. A member cookie is dropped
  when its login is no longer on the allowlist (review finding 2: before, a removed member kept writing for
  up to 12 h).
- **Read-only enforcement** (`handleUi`). Before any Spec DO call or body read: every non-GET/HEAD
  request and every `/app/settings/tokens` route is 403 "Read-only access". The new-issue form is 403.
  Viewers skip the actor lookup, and their DO reads carry no `X-Actor-ID`.
- **Visibility.** `issueHiddenFrom(session, issue)` (`ui-pages.ts`): private for everyone, `internal`
  for viewers. Applied at the source of every issue list (org, repo, spec pages: tabs, search,
  changelog), the repo issue list, the issue page and the legacy `/app/issues/:id`. Side effect for
  members: private issues no longer reach the org/repo/spec search index and changelog (they were
  already hidden from lists and the issue page).
- **Pages.** Viewers see "(read-only)" next to their login, no API tokens link, no create forms on the
  dashboard, no "New Issue" button, no comment or close/reopen form, and a note on how to become a
  contributor.
- **Artifacts.** Viewers get the placeholder file tree on the repo "files" tab: no Artifacts API call with
  the platform token per viewer page view (review finding 1), and repo source is not exposed to strangers
  yet. Revisit with the rate limit; showing real code is what a community would want.

## Mixed-version window

UI-only; no schema, DO route or service-binding change. An older `beehive` worker reading a viewer
cookie rejects it (empty `actorId`) and sends the browser to `/login`, where the old code refuses a
non-member: a viewer can never act as a member on old code. Member cookies are unchanged. During the window
a viewer can bounce between `/login` on an old worker (which does not clear the cookie) and `/app` on a new
one until the deploy settles: harmless, no privilege gain.

## Not covered / follow-ups

- **Read load: done (2026-11-06).** Every viewer page fans out several 500-row list reads on the single
  Spec DO. The `VIEWER_RATE_LIMITER` binding (`[[ratelimits]]` in root `wrangler.toml`, namespace `4101`,
  60 requests / 60 s) limits each viewer session by `viewer:<login lowercased>` before any Spec DO call,
  refused writes included; over the limit is a 429 with `Retry-After: 60`. It fails closed: a missing
  binding or a limiter error is a 503 for viewers (logged `viewer_rate_limiter_missing` /
  `viewer_rate_limiter_error`), never unthrottled access. Members are not limited. The binding is loose
  (per Cloudflare location, eventually consistent): it stops scraping, not a determined client. Not
  limited: the OAuth callback (`/auth/callback` writes nothing for non-members but calls GitHub twice);
  add a per-IP key there with anonymous read.
- **Data shown.** Viewers see what members see minus internal/private issues: actor names, candidate
  ids and preview URLs, gate verdicts. No mirrored request bodies are rendered in the UI today; keep it so.
- REST API access for viewers (a read-only user token) is out of scope; tokens need an actor row.

## Next: anonymous read (planned, not scheduled)

The maintainer wants `/app` to become publicly readable without sign-in later (2026-11-06; tracked in
`docs/MILESTONES.md` Future / Optional). Viewer sessions are built so this is a small step: an anonymous
request renders with the same viewer rules (`viewer: true`, no actor, GET/HEAD only, `issueHiddenFrom`).

**Decisions (maintainer, 2026-11-06):**
- **Switch: Cloudflare Flagship.** A boolean flag (e.g. `anonymous-read`) read through a `flagship` binding on
  `beehive` with `getBooleanValue(key, false)`; Flagship returns the default on any evaluation error, so a
  Flagship outage keeps anonymous read off (fail closed). Deploy and opening stay separate steps, and turning it
  off needs no deploy. First Flagship use in Beehive (`docs/OPEN-QUESTIONS.md` 2026-10-18 entry was "deferred").
  `OPEN_VIEWER_SIGNIN` stays a var for now; moving it to Flagship too is optional.
- **Rate limiting and caching by Cloudflare,** not hand-rolled: a Workers rate-limiting binding keyed on the
  client IP for anonymous requests (and on the login for viewer sessions), plus a short edge cache.
- **Short edge cache** for anonymous pages only (they are identical for everyone): about 60 s, keyed on the URL,
  never for a request with a session cookie, and the account area renders "Sign in" instead of a login so the
  page carries nothing per user.
- **No search engine indexing:** `X-Robots-Tag: noindex, nofollow` on every `/app` response and a `robots.txt`
  disallowing `/app`.
- **Candidate preview URLs hidden** from anonymous visitors (candidate and repo pages; ids still shown).
  Signed-in viewers keep seeing them.
- **Actor names and GitHub logins are shown** to anonymous visitors.
- **Custom domain: longer term.** Until then anonymous read runs on `workers.dev`, which may mean no edge cache
  (see below); the rate limit must hold the load on its own in that case.

**Cache rules (review 2026-11-06):** never cache a request carrying `?ok=` / `?error=` flash parameters (or
strip them from the key, else one visitor's flash is served to others), any request with a cookie, or any
response that sets one. Anonymous requests must not trigger Artifacts API calls (placeholder tree, as for
viewers). Hiding preview URLs keeps them from crawlers and drive-by visitors only: any free GitHub account
sees them as a viewer, so this is not secrecy.

**Unverified, check before planning the implementation** (`docs/OPEN-QUESTIONS.md` 2026-11-06):
- The Cache API appears not to work on `*.workers.dev` (cache is per zone; a Cloudflare community answer, not
  official docs). Production is `beehive.bz23711.workers.dev`, so the edge cache probably needs a custom domain.
  The same goes for WAF rate-limiting rules; the Workers rate-limiting binding should not need a zone (confirm).
- Flagship binding config and pricing on this account (`docs/ARTIFACTS-SETUP.md`-style setup note needed).

Tests: `workers/api/tests/ui-viewer.test.ts`.
