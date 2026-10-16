---
category: agents
status: active
audience: human,agent
---

# Agent routing and delegation

Moved out of `AGENTS.md` (2026-10-15) so it is not resent every turn. Read this when choosing
a model for a task or spawning agents.

**Agent in the original setup**: `Vibe Code` running on `mistral-medium-3-5` (previously
`Vibe Nuage Agent`). Confirm which models the platform's own agents use before relying on this.

### Model routing (match model to task)

Applies to agents running `mistral-medium-3-5`. Tiers are conceptual; map each to whichever Mistral model is configured for the provider.

| Tier | Use for | Model |
|---|---|---|
| Heavy | Hard debugging, wide cross-cutting refactors, spec/architecture decisions, promotion-train logic | `mistral-medium-3-5`, plan first; escalate to a larger model only if one is configured and the task justifies it |
| Default | Features, tests, known-bug fixes, refactors within one worker | `mistral-medium-3-5` |
| Light | Lookups, grep/search, simple edits, formatting, scripted or high-volume runs | `mistral-medium-3-5`, or a smaller Mistral model if one is configured; keep these prompts short |

- Rule of thumb: spend heavy-tier effort on planning, not on re-running large diffs.
- Do not spawn a heavy-tier agent for a light-tier task. Check which models are configured before assuming a cheaper model exists.

### Agent Delegation & Spawning

- **In an agent orchestrator**: Spawn agents through the orchestrator's own API so they are tracked and visible in its UI. You can specify different models and thinking options.
- **In Cloudflare Workers**: Do **not** use the orchestrator's agent spawning. Worker-based bees should either run solo or use Vibe's native `tools.subagent` namespace if parallelism is needed—these subagents are not visible in the orchestrator, and Workers lack its UI access anyway.

### Branches and review

- **Branch every task from `main`, never from another agent branch.** Ten "independent" agent branches
  turned out to be one linear stack: the top branch carried everything beneath it, so per-branch review
  and merge of the lower layers meant nothing. Check `git branch --contains <commit>` before fanning out
  reviewers, and review the stack as one unit (plus each layer's own commit).
- **Read-only reviewers work well**: one agent per worktree, told not to commit, push or deploy, finishing
  in minutes. Have each report a verdict, rule violations, test results and `git merge-tree --write-tree
  main HEAD` conflicts. A reviewer without `node_modules` cannot run tests (`npm ci` needs a lockfile,
  which the repo lacks; `npm install --no-package-lock` leaves no tracked changes).
- **Archiving a workspace removes its directory.** First confirm each branch is an ancestor of
  `origin/main` or is on `origin`, and the worktree has no uncommitted changes.
- **MCP servers authorised mid-session are not visible until a new session**; tool schemas load lazily
  (ToolSearch) but results stay in context, so narrow every query or delegate log-heavy reads.
