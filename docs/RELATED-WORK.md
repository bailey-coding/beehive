# Related work

Positioning notes against adjacent systems. Claims about other products come from the cited
source only; re-check before quoting publicly.

## Entire Trails (2026-10-26)

Source: The New Stack, "Ex-GitHub CEO launches a GitHub rival that reinvents the pull request"
(`https://thenewstack.io/entire-trails-agentic-code-review/`), based on a Dohmke interview and
keynote. Not verified against Entire's own docs or a running product.

### What it is (as reported)

- Git-compatible, regionally hosted forge. Private repos only at launch; public repos and
  self-hosted nodes are roadmap.
- **Trails** replaces the pull request: agent-scored evals (risk, intent drift, an internal
  "stop cop") run on every push. Findings reach the coding agent, which pushes a revision.
  The original request, the session history and the code are all part of the review.
- Stated merge rule: evals green and confidence high, then merge without detailed human review.
- Eval agents are configurable in JSON, on Claude and OpenAI models. Users pay token cost at market
  rates after a $100 credit.
- Continuous Memory syncs agent sessions into the repo for later agents to query.

### Where it overlaps with Beehive

- Same diagnosis: review, not code generation, is the bottleneck.
- Same move: the intent of a change (Beehive: the spec; Entire: the original request) is a
  first-class review input, not a PR description.
- Same direction: automated verdicts replace social review.

### Where it differs

| | Entire Trails | Beehive |
|---|---|---|
| Unit of review | one change, iterated on by one agent | N candidates against one spec |
| Oracle | LLM-scored evals on a push | oracle ladder: deterministic gates, shadow diff, canary SLOs, then full traffic |
| Ground truth | model judgment of the diff and session | observed behavior on mirrored and live traffic |
| Scope | any change | changes expressible as a machine-readable spec with a declared delta surface |
| Coordination state | repo-synced session memory | spec DO (SQLite); git notes for provenance only |
| Rollback | not described in the source | ref operation |

### Honest read

- Trails covers changes Beehive cannot: anything without a spec or a measurable traffic signal.
- Our inference, not a reported finding: an LLM-judge eval can be wrong in ways correlated with the
  agent that wrote the code, especially when both read the same session. Beehive's gates and traffic
  oracle do not share that failure mode, but they only apply where a spec exists.
- The two compose: an LLM eval is a plausible pre-merge rung, below shadow, for specs whose
  conformance tests are thin. Beehive does not need to claim Trails is wrong, only that "green evals"
  is a weaker oracle than "observed in production".
- Open: Entire's source gives no accuracy or false-green data for the evals. Do not claim they are
  unreliable without it.
