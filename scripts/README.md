# Beehive SPIKE Validation Scripts

Synthetic monitoring scripts for validating the foundational Cloudflare Artifacts workflow.

## Scripts

### `spike-validation.sh`
**Purpose:** One-shot validation of the SPIKE exit criteria.

**Exit Criteria:**
- 3 forks created via binding
- 3 pushes attempted (first writer wins, second rejected for concurrent push)
- 3 events simulated for queue delivery
- Zero manual steps

**Usage:**
```bash
chmod +x scripts/spike-validation.sh
./scripts/spike-validation.sh [namespace] [baseline-repo-name] [agent-prefix]

# Example:
./scripts/spike-validation.sh default beehive-url-shortener agent
```

**What it tests:**
1. Creates namespace if not exists
2. Creates baseline repo
3. Creates 3 fork repos
4. Clones first fork, makes commit, pushes (should succeed)
5. Clones second fork, makes commit, pushes (should be rejected - concurrent push ordering)
6. Clones third fork, makes commit, pushes (should succeed - different repo)
7. Simulates queue events

**Environment Variables:**
- `CLOUDFLARE_ACCOUNT_ID` (required)
- `CLOUDFLARE_API_TOKEN` (required)

---

### `synthetic-monitoring.sh`
**Purpose:** Continuous synthetic monitoring of the SPIKE workflow components.

**Checks performed every N seconds:**
1. Cloudflare authentication
2. Namespace accessibility
3. Baseline repo existence
4. Fork creation via binding
5. Token creation for repos
6. Git operations (clone, commit, push)

**Usage:**
```bash
chmod +x scripts/synthetic-monitoring.sh
./scripts/synthetic-monitoring.sh [namespace] [baseline-repo] [interval-seconds]

# Example: Run checks every 5 minutes
./scripts/synthetic-monitoring.sh default beehive-url-shortener 300
```

**Environment Variables:**
- `CLOUDFLARE_ACCOUNT_ID` (required)
- `CLOUDFLARE_API_TOKEN` (required)

---

## Design Principles Tested

### First Writer Wins
The concurrent push test validates that Cloudflare Artifacts enforces ordering:
- First agent to push to a repo: **accepted**
- Second agent to push to the same repo: **rejected**
- This ensures the "fork, don't contend" rule works as expected

### Zero Manual Steps
Both scripts are fully automated:
- No human intervention required
- All operations use cf CLI and git with auth headers
- Tokens are created and cleaned up automatically

---

## Future Enhancements

As functionality is built on top of SPIKE:

1. **Queue Consumer Integration** - Replace the simulated events with actual Worker-based queue consumers
2. **Event Delivery Verification** - Add checks that events are actually received and processed
3. **Performance Metrics** - Track timing of fork creation, clone, push operations
4. **Concurrent Push Analysis** - More sophisticated testing of edge cases in concurrent scenarios
5. **Artifacts FS** - Consider using Cloudflare's Artifacts filesystem for partial clones/sparse checkouts alternative

---

## Notes on Open Questions

| Question | Addressed By |
|---|---|
| Concurrent push ordering | `spike-validation.sh` tests first-writer-wins pattern |
| 10 GB per repo limit | Trusted to stay under for now; monitoring can alert if approaching |
| Event delivery guarantees | `synthetic-monitoring.sh` provides at-least-once delivery pattern; docs cover assumptions |
| Blobless clones + credentials | Artifacts FS noted as interesting alternative for future |
