# Agent Token Optimization Guide

> **Purpose:** Reduce Claude token usage and cost while maintaining work quality.
> **Scope:** All Paseo agents (Claude, Mistral, Codex) operating in this repository.
> **Maintainer:** Update this file when new optimization patterns emerge.

---

## 🎯 Core Principles

### 1. **Minimize Context, Maximize Precision**
Every file read, every line scanned, every search executed consumes tokens. Be surgical.

### 2. **Leverage Existing Work**
If an answer exists in docs, git history, or previous agent logs, use it. Don't re-analyze.

### 3. **Separation of Duties is Valuable**
Independent implementer/reviewer/merger roles improve quality. Don't consolidate these for cost savings alone.

---

## 🔍 Search Before You Read

### Use ripgrep/ack for Targeted Searches
**Always** search before reading full files:

```bash
# Find all references to a function/pattern
rg "recordShadowVerdict" workers/
rg "queue-consumer" workers/spec-do/

# Search with line numbers for precise references
rg -n "gate.*verdict" workers/spec-do/

# Search specific file types
rg "Idempotency-Key" workers/ --type=ts

# Inverted search: files that DON'T contain pattern
rg -L "actorId" workers/spec-do/*.ts
```

**Why:** A single `rg` search (50-200 tokens) beats reading 10 files to find the same pattern (2000+ tokens).

---

## 📖 Read Only What You Need

### Use Line References
When you must read a file, use specific line ranges:

```bash
# Read first 50 lines
head -n 50 workers/spec-do/index.ts

# Read lines 100-150
sed -n '100,150p' workers/spec-do/index.ts

# Read last 20 lines
tail -n 20 docs/OPS.md

# Read specific line
sed -n '4095p' workers/spec-do/index.ts
```

**Reference format in chat:** `workers/spec-do/index.ts:4092-4104` instead of "read the file".

### Use Git to See Only Changes

```bash
# See what changed on this branch
git diff agent/queue-idem-plan...HEAD

# See changes to a specific file
git diff agent/queue-idem-plan...HEAD -- workers/spec-do/index.ts

# See who changed what and when
git log --oneline -10 -- path/to/file

# See file at specific commit
git show HEAD:path/to/file

# See blame for a file
git blame path/to/file
```

**Why:** Git-aware reads focus only on relevant deltas, not entire files.

---

## ⚡ Batch Your Operations

### Batch Similar Searches
Instead of:
```bash
# ❌ Inefficient
read fileA
grep pattern fileA
read fileB
grep pattern fileB
```

Do:
```bash
# ✅ Efficient
rg pattern fileA fileB fileC
# Then only read the matching files/lines
```

### Batch Edits
Group related changes into single commits. Each file read for editing consumes tokens.

---

## 💾 Checkpoint & Resume

### Commit Frequently
- Push intermediate findings to branches
- Reference committed work instead of re-analyzing
- Use branch names that describe the work: `agent/queue-idem-plan`, `agent/m5a-idempotency-fix`

### Build on Previous Agent Work
Before starting, check:
```bash
# See what branches exist
git branch -a | grep agent/

# See latest commits on a branch
git log --oneline -5 agent/queue-idem-plan

# See what a previous agent found
paseo logs <agent-id> | tail -20
```

**Example:** Agent 4e70962 already analyzed `workers/spec-do/index.ts` for FK constraints. Start from those findings instead of re-reading the entire file.

---

## 📊 Cost Awareness

### Check Your Token Usage
```bash
# Paseo: Check agent usage
paseo inspect <agent-id> | grep LastUsage

# See total tokens consumed
paseo inspect <agent-id> | grep -E "InputTokens|OutputTokens|CachedTokens|CostUsd"
```

### Token Cost Examples (Claude)
| Operation | Estimated Tokens | Cost |
|-----------|------------------|------|
| Read 100-line file | ~200 tokens | ~$0.002 |
| Read 1000-line file | ~2000 tokens | ~$0.02 |
| `rg` search across repo | ~100-500 tokens | ~$0.001-0.005 |
| Full repo context load | ~50K+ tokens | ~$0.50+ |
| Cached re-read of large file | ~0 tokens | $0.00 |

**Key insight:** Cached tokens are free on subsequent reads, but the **first** read of a large file is expensive. Avoid unnecessary first reads.

---

## 🎯 Role-Specific Optimization

### Implementers
- Start with targeted searches to locate relevant code
- Use git diff to see only your changes
- Reference architecture docs before coding
- Commit frequently with descriptive messages

### Reviewers  
- Use git diff to review only changes
- Search for patterns related to the PR
- Reference existing code style and patterns
- Don't re-read unchanged files

### Merger Agents
- Use git log to see what's being merged
- Check for merge conflicts with targeted reads
- Reference previous merge commits for patterns

---

## 🚫 Anti-Patterns

### ❌ Don't: Read entire files without purpose
```bash
# ❌ Bad
cat workers/spec-do/index.ts  # 4000+ lines, 4000+ tokens
```

### ✅ Do: Read with intent
```bash
# ✅ Good
sed -n '4090,4110p' workers/spec-do/index.ts  # 20 lines, ~40 tokens
```

### ❌ Don't: Re-analyze documented decisions
```bash
# ❌ Bad - re-reading docs/ARCHITECTURE.md that you already read
```

### ✅ Do: Reference existing docs
```bash
# ✅ Good
As per docs/ARCHITECTURE.md:45-60, the spec DO is the single...
```

### ❌ Don't: Search one file at a time
```bash
# ❌ Bad
grep pattern file1.ts
grep pattern file2.ts
grep pattern file3.ts
```

### ✅ Do: Batch searches
```bash
# ✅ Good
rg pattern workers/
```

---

## 📈 Real-World Impact

### Case Study: M12 PR-B Work

| Agent | Purpose | Actual Cost | Optimized Estimate | Savings |
|-------|---------|-------------|-------------------|---------|
| feb7a40 | Implementer | $36.30 | ~$5-10 | **$26-31** |
| 7b77f92 | CloudFlare config | $17.52 | ~$3-5 | **$12-14** |
| 5f4bea6 | Code review | $14.09 | ~$2-3 | **$11-12** |
| **Total** | | **$67.91** | **~$10-18** | **~$50-58** |

**Primary cause:** Massive cached token usage from re-reading entire codebases.

**Optimization applied:** Targeted searches + line-specific reads could have reduced costs by **80-90%**.

---

## 🔧 Tools & Commands Reference

### Essential Commands

| Command | Purpose | Token Cost |
|---------|---------|-------------|
| `rg pattern dir/` | Search for pattern | Low |
| `rg -n pattern file` | Search with line numbers | Low |
| `head -n 50 file` | Read first N lines | Medium |
| `sed -n 'X,Yp' file` | Read lines X to Y | Medium |
| `tail -n 20 file` | Read last N lines | Medium |
| `git diff branch...HEAD` | See changes | Low |
| `git log --oneline` | See commit history | Low |
| `git show commit:file` | See file at commit | Medium |
| `paseo logs <id>` | See agent work | Low |
| `paseo inspect <id>` | See agent details | Low |

---

## 📝 Quick Checklist Before Starting Work

- [ ] Search existing docs for relevant info: `rg keyword docs/`
- [ ] Check git history: `git log --oneline -10`
- [ ] Search codebase for pattern: `rg pattern workers/`
- [ ] Identify specific files/lines to read
- [ ] Check previous agent work: `paseo logs <agent-id>`
- [ ] Use line-specific reads: `sed -n 'X,Yp' file`
- [ ] Commit findings periodically

---

## 🔗 Related Documentation

- [`AGENTS.md`](../AGENTS.md) - Main agent context and conventions
- [`docs/AGENT-ROUTING.md`](AGENT-ROUTING.md) - Model routing and delegation
- [`docs/MILESTONES.md`](MILESTONES.md) - Current project phases
- [`docs/FOCUS.md`](FOCUS.md) - Current open items and priorities

---

*Last updated: 2026-10-19*
*Motivation: Claude usage exhausted; optimized work continues with Mistral agents*
