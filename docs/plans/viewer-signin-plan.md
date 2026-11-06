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
  now on the allowlist, so a promoted user signs in again and gets an actor row.
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

## Mixed-version window

UI-only; no schema, DO route or service-binding change. An older `beehive` worker reading a viewer
cookie rejects it (empty `actorId`) and sends the browser to `/login`, where the old code refuses a
non-member: a viewer can never act as a member on old code. Member cookies are unchanged.

## Not covered / follow-ups

- **Read load.** Every viewer page fans out several 500-row list reads on the single Spec DO, and GitHub
  sign-in is the only throttle. Before announcing the instance widely, add a Workers rate-limiting
  binding on `/app` for viewer sessions (the `bh_usr_` limiter is per isolate, best effort).
- **Data shown.** Viewers see what members see minus internal/private issues: actor names, candidate
  ids and preview URLs, gate verdicts. No mirrored request bodies are rendered in the UI today; keep it so.
- REST API access for viewers (a read-only user token) is out of scope; tokens need an actor row.

## Next: anonymous read (planned, not scheduled)

The maintainer wants `/app` to become publicly readable without sign-in later (2026-11-06; tracked in
`docs/MILESTONES.md` Future / Optional). Viewer sessions are built so this is a small step: an anonymous
request would render with the same viewer rules (`viewer: true`, no actor, GET/HEAD only, `issueHiddenFrom`).
Before it ships:
- The rate limit above, keyed per IP for anonymous requests (no GitHub identity to throttle on).
- What anonymous visitors see: whether actor names, GitHub-linked logins and candidate preview URLs are
  redacted or shown; `robots.txt` / `noindex` for crawlers.
- Caching: anonymous pages are identical for everyone, so a short edge cache would take read load off the
  Spec DO (a viewer page cannot be cached today because the account area names the login).
- A switch like `OPEN_VIEWER_SIGNIN`, off by default, so the deploy and the opening are separate steps.

Tests: `workers/api/tests/ui-viewer.test.ts`.
