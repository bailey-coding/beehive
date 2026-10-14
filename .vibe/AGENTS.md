# Project-Local Agent Instructions

These instructions supplement the project-specific rules in the repo root `AGENTS.md`.
They provide general workflow and quality guidelines for any agent working in this codebase.

## Communication Style

- Distinguish **facts** from **hypotheses** from **proposed next steps** — label them when ambiguity matters.
- Recommend **one path**, not a menu of options, unless the user explicitly asks for alternatives.
- Be concise and technical. Skip generic best-practice lectures.
- When proposing a fix, briefly explain *why* it works.
- If a request is based on a misconception, say so — don't silently comply with a flawed premise.

### Structure (adapted from Google developer documentation style guide)

- **Put the goal before the instruction.** "To rotate the token, run X" reads better than "Run X to rotate the token."
- **Number a sequence, bullet a set.** Use a numbered list only when order matters.
- **Name the referent.** Write "the `config` in `wrangler.toml`" rather than "this" or "the above".
- **Report what you did, not what you are about to do.** Narrate an action only when the user must decide something before it runs.
- **Give the number or the condition.** Replace hedges with a count, a threshold, or the specific case. "3 of 7 tests failed" beats "some tests failed".
- **Use first person for your own actions.** "I ran the tests and 2 failed" names the actor.
- **Use time-relative language about live state.** "The token expired 127 days ago" is more useful than a timeless paraphrase.

## Investigation Discipline

When tests fail or behavior is wrong, do not try random fixes until green. A passing test is not understanding.

1. **Establish facts** — what IS happening vs. what SHOULD happen?
2. **Narrow scope systematically** — where exactly does correct become incorrect?
3. **Understand root cause** before writing any fix.
4. If a fix works but you can't explain *why*, you haven't fixed it — you've masked it.
5. **Treat remembered tool syntax as unverified.** CLI field names change between
   versions (e.g., wrangler service bindings take `binding`, never `name`). Validate
   configs by running the installed tool (`wrangler dev` boot, `--dry-run`) rather
   than trusting memory or stale docs.

Accidental fixes create hidden debt. One-line fixes born from understanding beat hundred-line workarounds born from flailing.

## Change Scope

- Smallest diff that fully solves the root cause.
- No unrelated cleanup in the same change unless it directly unblocks the fix.
- Don't hand-edit generated files unless the repo treats them as source-of-truth.
- Preserve existing public APIs unless the task explicitly changes them.

## Git Conventions

- Prefix feature branches with `<username>/` (e.g., `username/feature-name`).
- Never use a different username prefix as a branch namespace unless it's yours.
- For force pushes in partial clones: use `--force-with-lease=<branch>:<expected-remote-sha>` after confirming the remote SHA with `git ls-remote origin refs/heads/<branch>`.

## Execution Boundaries

**Proceed without asking** for: small reversible code changes, focused tests, file reads/searches, formatting/lint fixes, local builds.

**Ask first** for:
- dependency adds/removes/version changes
- schema or data migrations
- destructive git ops (`reset --hard`, `checkout --`, force push, mass deletes)
- infra/Terraform/database state changes
- auth/security-sensitive code
- cross-service API contract changes

**Never** without explicit user request:
- push to `main` / `master` / shared branches
- bypass safety checks (`--no-verify`, `--force` without prior discussion)
- override commit signing; use the repo's signing config as-is
- commit secrets, credentials, or `.env` files

If requirements are ambiguous but a safe default exists, state the assumption briefly and proceed. If no safe assumption exists, stop and ask.

## Validation & Honest Reporting

- Run the **narrowest meaningful check** while iterating (single file → package → whole repo).
- Before declaring work complete, run the most relevant verification the repo supports.
- Always report: **what you ran, what passed, what failed, what you did not run.** Never imply success you didn't verify.
- Don't make tests pass by hard-coding values, special-casing, or masking the real problem.

## Build & Test Commands

- **TypeScript**: prefer per-file checks (`tsc --noEmit path/to/file.ts`, `eslint --fix path/to/file.ts`) over full project builds for fast iteration.
- **Workers/Cloudflare**: use `wrangler dev` for local development, `wrangler deploy` for production.

## CLI Tool Preferences

When these tools are available, prefer them:

- `rg` (ripgrep) over `grep` for searching files.
- `fd` over `find` for filename lookups.
- `fastmod` over `sed` / `codemod` for find-and-replace.
- `eza` over `ls` for listing.
- `bat` over `cat` when syntax highlighting helps.
- `delta` for diff viewing if installed.

## Git Workflow Notes

### Sparse Checkouts

When a package or directory appears missing but is referenced in the codebase, check `git ls-tree HEAD <path>` — it may exist in the repo but be excluded from the sparse-checkout. Use `git sparse-checkout add <path>` to restore it.

### Partial Clones and Narrow Refspecs

- To work with a colleague's branch, fetch it explicitly: `git fetch origin <branch>:refs/remotes/origin/<branch>`.
- Don't widen the refspec back to `+refs/heads/*`; a many-branch remote makes every fetch and push advertise and negotiate far more refs than needed.
- If a push hangs, first check for a `pre-push` hook: `git config core.hooksPath` and `cat .husky/pre-push` (or similar).

## Never Downgrade Without Asking

Don't use downgrades, legacy module formats, or deprecated APIs as the first-line fix:

- Don't pin to older versions to fix a problem.
- Don't replace ESM `import` with CJS `require` to make tests pass.
- Don't revert to deprecated APIs.

If forward-fix isn't obvious, ask before regressing.

For ESM stubbing/mocking issues, use the spread pattern or library-level barrel spreading — don't fall back to CJS.

## Self-Improvement

When useful patterns, preferences, or conventions emerge during a thread — preferred code style, common commands, project-specific workflows, or debugging approaches — proactively suggest adding them to the relevant instructions file (this file or the repo root `AGENTS.md`) so they persist.

When a preventable mistake occurs, suggest a corresponding **Boundary** addition to prevent recurrence.
