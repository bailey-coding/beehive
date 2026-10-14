# Beehive Demo - Quick Start Guide

> **5-10 minute demo of concurrent agent development**

---

## 🚀 Fastest Path to Demo

### 1. Clone and Setup (2 minutes)

```bash
# Clone the repository
git clone https://github.com/bailey-coding/beehive.git
cd beehive

# Install dependencies
npm install
```

### 2. Create Agent Forks (1 minute)

```bash
# Creates 3 agent forks with different implementations
# Each fork has a unique approach but satisfies the same spec
./scripts/create-agent-forks.sh agent-1 agent-2 agent-3

# Forks created at: /tmp/beehive-demo-forks/
```

### 3. Run the Demo (2-5 minutes)

```bash
# Run with local dev servers (no deployment needed)
./scripts/demo-end-to-end.sh --local

# Or with deployed workers (requires tokens)
./scripts/demo-end-to-end.sh --remote
```

---

## 🎯 What the Demo Shows

| Time | Scene | What's Demonstrated |
|------|-------|---------------------|
| 0:00-1:00 | Project Overview | Architecture, Oracle Ladder, Components |
| 1:00-2:30 | Spec Creation | Contract, acceptance criteria, delta surface |
| 2:30-5:00 | 3 Agents Implement | Different approaches, same contract |
| 5:00-7:00 | Traffic Mirroring | Shadow Router fans out to all candidates |
| 7:00-8:30 | Scientist Comparison | Validates vs declared delta surface |
| 8:30-9:30 | Winner Selection | Scores aggregated, winner promoted |
| 9:30-10:00 | Wrap-up | Why this changes software delivery |

---

## 🤖 The 3 Agents

| Agent | Implementation | Special Feature |
|-------|----------------|-----------------|
| agent-1 | Basic | Simple, straightforward |
| agent-2 | Optimized | Caching for performance |
| agent-3 | Verbose | Detailed logging |

All satisfy the same spec contract but with different internal behaviors (allowed by the delta surface).

---

## 🎥 Recording Your Demo Video

### Before Recording

```bash
# Clean terminal
clear

# Increase font size for readability
# Use dark theme with good contrast

# Test your setup
./scripts/create-agent-forks.sh
./scripts/demo-end-to-end.sh --local --clean
```

### Recording Commands

```bash
# Start recording (macOS)
# Use OBS, QuickTime, or your preferred tool

# Or use ffmpeg
ffmpeg -f avfoundation -i "1" -t 600 -vcodec libx264 -preset ultrafast -crf 23 output.mp4
# (Stops after 600 seconds = 10 minutes)
```

### Scene-by-Scene Script

See `scripts/DEMO-VIDEO-SCRIPT.md` for complete narration and commands.

---

## 📊 Demo Checklist

- [ ] All 3 agent forks created
- [ ] Workers start without errors
- [ ] All health checks pass
- [ ] Calculator endpoint works for each agent
- [ ] Shadow router mirrors traffic to all candidates
- [ ] Scientist comparator processes comparisons
- [ ] All candidates pass validation
- [ ] Winner selection works

---

## 🛠️ Troubleshooting

### Workers Won't Start

```bash
# Check if ports are in use
lsof -i :8787
lsof -i :8791
lsof -i :8792
lsof -i :8801
lsof -i :8802
lsof -i :8803

# Kill conflicting processes
pkill -f "wrangler dev"
pkill -f "node"
```

### Auth Token Issues

For local demo, the auth gate is bypassed. For remote:

```bash
# Verify tokens are set
echo $BEEHIVE_API_TOKEN
echo $CLOUDFLARE_API_TOKEN
echo $CLOUDFLARE_ACCOUNT_ID

# If not set
export BEEHIVE_API_TOKEN=your-token
export CLOUDFLARE_API_TOKEN=your-cf-token
export CLOUDFLARE_ACCOUNT_ID=your-account-id
```

### Workers Not Deployed

Deploy all workers first:

```bash
npm run deploy
npm run deploy:gate
npm run deploy:sandbox
npm run deploy:queue
npm run deploy:shadow
npm run deploy:scientist
npm run deploy:preview
npm run deploy:candidate
```

---

## 📝 Key Points to Emphasize

### During the Demo, Highlight:

1. **Concurrency**
   - All 3 agents work independently
   - No coordination needed between agents
   - Each has its own fork

2. **Same Contract, Different Implementations**
   - All return the same result for the same input
   - Internal behavior can differ (delta surface)
   - Output format is consistent

3. **Live Traffic as Oracle**
   - Shadow router mirrors to all candidates
   - Scientist validates against spec
   - No human review needed

4. **Automatic Promotion**
   - Scores aggregated automatically
   - Winner selected based on data
   - Rollback if issues detected

---

## 🎓 Understanding the Spec

The demo spec (`demo-calculator`) defines:

**Contract:**
```json
{
  "endpoint": "/api/calculate",
  "method": "POST",
  "input": {"operation": "string", "a": "number", "b": "number"},
  "output": {"result": "number", "operation": "string"}
}
```

**Declared Delta Surface:**
```json
{
  "allowedBehaviorChanges": ["performance", "logging"],
  "forbiddenBehaviorChanges": ["output_format", "error_handling"]
}
```

This means:
- ✅ Performance can vary (Agent 2 is faster with caching)
- ✅ Logging can vary (Agent 3 has detailed logging)
- ❌ Output format must be the same
- ❌ Error handling must be consistent

---

## 🏆 Competition Requirements Met

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Build your project | ✅ | 8+ Workers deployed |
| Create new way for multiple agents to work concurrently | ✅ | 3 agents, independent forks |
| Submit by Oct 14 | ⏳ | This guide helps you submit |

---

## 📞 Need Help?

- **Full documentation:** `README.md`
- **Architecture details:** `docs/ARCHITECTURE.md`
- **M2 implementation:** `docs/M2-PLAN.md`
- **Demo video script:** `scripts/DEMO-VIDEO-SCRIPT.md`
- **Issues:** Open a GitHub Issue

---

**Ready to demo!** 🚀
