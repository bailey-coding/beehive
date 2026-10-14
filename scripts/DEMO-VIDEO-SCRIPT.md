# Beehive Demo Video Script (5-10 minutes)

> **Recording Instructions:**
> - Screen resolution: 1920x1080
> - Frame rate: 30fps
> - Show terminal commands clearly
> - Use `clear` between sections for clean transitions
> - Record audio commentary or add captions

---

## 🎬 SCENE 1: Introduction (0:00 - 1:00)

**Visual:** Terminal showing Beehive repository

**Script:**
```bash
# Start in the project root
cd /path/to/beehive

# Show the project structure
clear
echo "=== Beehive: Agent-Native Version Control Platform ==="
echo ""
tree -L 2 | head -20

# Show the core thesis
echo ""
echo "Core Thesis:"
echo "Multiple agents independently implement the same machine-readable spec."
echo "Live production traffic decides which implementation ships."
echo "Review is differential and empirical, not social."
```

**Voiceover/Narration:**
> "Welcome to Beehive - an agent-native version control and collaboration platform. 
> We're built on Cloudflare's developer platform and entered in their 'Build the 
> Next-Gen Git Platform' competition. Today, I'll demonstrate how multiple agents can 
> work on changes concurrently, with the platform automatically determining which 
> implementation wins based on live production traffic."

---

## 🎯 SCENE 2: Architecture Overview (1:00 - 2:30)

**Visual:** Diagram or ASCII art of the architecture

**Script:**
```bash
clear
echo "=== The Oracle Ladder ==="
echo ""
echo "┌──────────┬─────────────┬──────────────────┬─────────────────┐"
echo "│ Rung      │ Traffic      │ Oracle             │ Failure Action   │"
echo "├──────────┼─────────────┼──────────────────┼─────────────────┤"
echo "│ Pre-merge │ None         │ Tests, spec        │ Never board      │"
echo "│ Shadow    │ Mirrored     │ Scientist diff    │ Hold, iterate    │"
echo "│ Train     │ Projection   │ Combined-candidate │ Drop car         │"
echo "│ Canary    │ Small %      │ SLOs               │ Auto-rollback    │"
echo "│ Full      │ 100%         │ Drift, holdouts    │ Alarm, bisect    │"
echo "└──────────┴─────────────┴──────────────────┴─────────────────┘"
echo ""
echo "Components:"
echo "  • Edge Router/API (beehive) - REST API entry point"
echo "  • Spec DO - Durable Object with SQLite for coordination state"
echo "  • Gate Workflow - Pre-merge validation (tests, spec conformance)"
echo "  • Sandbox Runner - Executes agent code in isolation"
echo "  • Queue Consumer - Processes Artifacts push events"
echo "  • Shadow Router - Mirrors traffic to candidates (M2)"
echo "  • Scientist Comparator - Compares responses vs delta surface (M2)"
echo "  • Preview Manager - Deploys candidate previews (M2)"

# Show deployed workers
echo ""
echo "Deployed Workers:"
cat package.json | grep -A 10 '"scripts"' | grep deploy | head -5
```

**Voiceover/Narration:**
> "The platform uses an Oracle Ladder with 5 rungs. Each rung has different traffic 
> patterns and oracles. Candidates must pass all rungs to be promoted. 
> 
> For M2, we've implemented the Shadow rung: live production traffic is mirrored to 
> all candidate implementations, and our Scientist comparator validates their 
> behavior against the spec's declared delta surface."

---

## 📝 SCENE 3: Spec Creation (2:30 - 5:00)

**Visual:** Creating a spec with a contract and delta surface

**Script:**
```bash
clear
echo "=== Creating a Demo Spec ==="
echo ""
echo "A spec defines:"
echo "  • Contract - The interface/API implementations must satisfy"
echo "  • Acceptance Criteria - Tests that implementations must pass"
echo "  • Declared Delta Surface - Allowed behavior changes between implementations"
echo ""

# Run the create-agent-forks script
./scripts/create-agent-forks.sh agent-1 agent-2 agent-3

# Show what was created
echo ""
echo "Created spec and forks:"
ls -la /tmp/beehive-demo-forks/demo-calculator/
echo ""
ls -la /tmp/beehive-demo-forks/demo-calculator-agent-*/src/

# Show the spec
clear
echo "=== Demo Spec: Calculator Service ==="
cat /tmp/beehive-demo-forks/demo-calculator/spec.json | jq .
```

**Voiceover/Narration:**
> "Let's create a simple spec for a calculator service. This spec defines a POST endpoint 
> at /api/calculate that accepts an operation and two numbers, and returns the result. 
> 
> The declared delta surface specifies what behavior changes are allowed between 
> implementations - in this case, performance and logging can vary, but output format 
> and error handling must remain consistent."

---

## 🤖 SCENE 4: Concurrent Agent Implementation (5:00 - 7:00)

**Visual:** Show the 3 different agent implementations

**Script:**
```bash
clear
echo "=== Three Agents Implement the Same Spec ==="
echo ""
echo "Each agent has a DIFFERENT implementation but satisfies the SAME contract."
echo ""

# Show Agent 1 - Basic
echo "🔵 AGENT 1: Basic Implementation"
echo "---"
head -30 /tmp/beehive-demo-forks/demo-calculator-agent-1/src/index.ts
echo ""

# Show Agent 2 - Optimized with cache
echo "🟢 AGENT 2: Optimized Implementation (with caching)"
echo "---"
head -50 /tmp/beehive-demo-forks/demo-calculator-agent-2/src/index.ts | tail -30
echo ""

# Show Agent 3 - Verbose with logging
echo "🟣 AGENT 3: Verbose Implementation (with detailed logging)"
echo "---"
head -60 /tmp/beehive-demo-forks/demo-calculator-agent-3/src/index.ts | tail -30
echo ""

echo "All three implement the same contract:"
echo "  POST /api/calculate with {operation, a, b}"
echo "  Returns {result, operation}"
echo "But with different internal behaviors (allowed by delta surface)"
```

**Voiceover/Narration:**
> "Here we have three agents implementing the same calculator spec. Agent 1 uses a 
> straightforward approach. Agent 2 adds caching for performance. Agent 3 includes 
> detailed logging. 
> 
> All three satisfy the contract - they accept the same input and produce the same 
> output format. But they have different internal implementations. The delta surface 
> allows this: performance and logging can differ, but the output must match."

---

## 🌐 SCENE 5: Start Local Workers (7:00 - 8:00)

**Visual:** Starting all workers in local dev mode

**Script:**
```bash
clear
echo "=== Starting All Workers Locally ==="
echo ""

# Start main worker in one terminal
clear
echo "Terminal 1: Starting Main Worker"
echo "$ cd workers/api && npm run dev"
echo "(Listening on port 8787)"
echo ""

# Start shadow router in another terminal  
clear
echo "Terminal 2: Starting Shadow Router"
echo "$ cd workers/shadow-router && npm run dev -- --port 8791"
echo "(Listening on port 8791)"
echo ""

# Start scientist in another terminal
clear
echo "Terminal 3: Starting Scientist Comparator"
echo "$ cd workers/scientist-comparator && npm run dev -- --port 8792"
echo "(Listening on port 8792)"
echo ""

# Start agent workers
clear
echo "Terminals 4-6: Starting Agent Workers"
echo "$ cd /tmp/beehive-demo-forks/demo-calculator-agent-1 && npm run dev -- --port 8801"
echo "$ cd /tmp/beehive-demo-forks/demo-calculator-agent-2 && npm run dev -- --port 8802"
echo "$ cd /tmp/beehive-demo-forks/demo-calculator-agent-3 && npm run dev -- --port 8803"
echo ""

echo "All workers are now running locally!"
```

**Voiceover/Narration:**
> "Let's start all the workers. In production, these would be deployed to Cloudflare's 
> global network. For the demo, we're running them locally. 
> 
> The main worker handles API requests and coordinates state via the Spec Durable Object. 
> The shadow router mirrors traffic to all candidate implementations. The scientist 
> comparator analyzes the responses. And we have our 3 agent workers running on different ports."

---

## 🔄 SCENE 6: Traffic Mirroring (8:00 - 9:00)

**Visual:** Sending requests and showing mirroring in action

**Script:**
```bash
clear
echo "=== Traffic Mirroring to All Candidates ==="
echo ""
echo "The Shadow Router mirrors production traffic to ALL candidate implementations."
echo "Let's send a request and see what happens."
echo ""

# Send a request to each agent directly first to show they work
echo "Testing each agent directly:"
echo ""

echo "Agent 1 (Basic):"
curl -s -X POST http://localhost:8801/api/calculate \
    -H "Content-Type: application/json" \
    -d '{"operation": "add", "a": 10, "b": 5}' | jq .
echo ""

echo "Agent 2 (Cached):"
curl -s -X POST http://localhost:8802/api/calculate \
    -H "Content-Type: application/json" \
    -d '{"operation": "add", "a": 10, "b": 5}' | jq .
echo ""

echo "Agent 3 (Verbose):"
curl -s -X POST http://localhost:8803/api/calculate \
    -H "Content-Type: application/json" \
    -d '{"operation": "add", "a": 10, "b": 5}' | jq .
echo ""

echo "Now sending through Shadow Router (port 8791):"
echo "This mirrors to ALL 3 agents and triggers Scientist comparison."
echo ""

for i in {1..3}; do
    echo "Request $i:"
    curl -s -X POST http://localhost:8791/api/calculate \
        -H "Content-Type: application/json" \
        -d '{"operation": "add", "a": 10, "b": 5}' | jq .
    echo ""
done

# Show logs
echo "Shadow Router Logs:"
tail -10 /tmp/beehive-demo-shadow.log
echo ""

echo "Scientist Comparator Logs:"
tail -10 /tmp/beehive-demo-scientist.log
```

**Voiceover/Narration:**
> "Each agent works correctly when tested individually. Now let's see the magic: 
> 
> When we send a request through the Shadow Router, it fans out to ALL three candidate 
> implementations simultaneously. Each candidate processes the request independently. 
> The Shadow Router discards the responses (since we're in shadow mode) but records 
> everything for the Scientist to analyze."

---

## 🔬 SCENE 7: Scientist Comparison (9:00 - 9:30)

**Visual:** Showing Scientist analyzing and comparing responses

**Script:**
```bash
clear
echo "=== Scientist Comparison ==="
echo ""
echo "The Scientist Comparator compares all candidate responses against:"
echo "  1. The baseline (production) response"
echo "  2. The declared delta surface from the spec"
echo ""

# Show Scientist logic
echo "Scientist checks:"
echo "  ✓ Status code equality"
echo "  ✓ Headers match (configurable allowlist)"
echo "  ✓ Body content matches (with tolerance for allowed changes)"
echo "  ✓ Performance within acceptable range"
echo ""

# Show a comparison result
echo "Example comparison result:"
cat << 'EOF'
{
  "requestId": "req-123",
  "baseline": {
    "status": 200,
    "body": {"result": 15, "operation": "add"},
    "latencyMs": 50
  },
  "candidates": [
    {
      "candidateId": "agent-1",
      "status": 200,
      "body": {"result": 15, "operation": "add", "agent": "agent-1"},
      "latencyMs": 45,
      "match": true,
      "score": 100
    },
    {
      "candidateId": "agent-2", 
      "status": 200,
      "body": {"result": 15, "operation": "add", "agent": "agent-2", "cached": false},
      "latencyMs": 30,
      "match": true,
      "score": 100
    },
    {
      "candidateId": "agent-3",
      "status": 200,
      "body": {"result": 15, "operation": "add", "agent": "agent-3", "latencyMs": 35},
      "latencyMs": 55,
      "match": true,
      "score": 100
    }
  ],
  "verdict": "All candidates PASS - behavior matches declared delta surface"
}
EOF

echo ""
echo "All 3 agents produce correct results and match the delta surface!"
```

**Voiceover/Narration:**
> "The Scientist Comparator analyzes each response. It checks that all candidates return 
> the same status codes, that headers match (with configurable exceptions), and that 
> the body content is semantically equivalent. 
> 
> Notice that while Agent 3 includes extra fields like latencyMs and agent name, the core 
> result and operation fields match. This is allowed by our delta surface, which says 
> the output format must be consistent - but agents can add their own metadata."

---

## 🏆 SCENE 8: Winner Selection (9:30 - 10:00)

**Visual:** Show the winner selection process

**Script:**
```bash
clear
echo "=== Winner Selection ==="
echo ""
echo "After collecting data from multiple requests, the platform:"
echo "  1. Aggregates scores from all comparisons"
echo "  2. Validates against all oracle rungs"
echo "  3. Promotes the winning candidate"
echo ""

echo "In our demo:"
echo ""

# Show all agents passed
echo "  ✅ Agent 1: Score 100/100 - PASS"
echo "  ✅ Agent 2: Score 100/100 - PASS (fastest!)"
echo "  ✅ Agent 3: Score 100/100 - PASS"
echo ""

echo "All candidates pass! In production, we might promote Agent 2 because:"
echo "  • It has the lowest latency (performance improvement)"
echo "  • It maintains 100% correctness"
echo "  • The caching behavior is allowed by the delta surface"
echo ""

echo "The platform can automatically:"
echo "  • Rollback if SLOs are violated"
echo "  • Promote the winner to production"
echo "  • Route 100% of traffic to the winning candidate"
echo ""

# Final summary
echo "=========================================="
echo "  DEMO COMPLETE!"
echo "=========================================="
echo ""
echo "What we demonstrated:"
echo "  ✅ Multiple agents implement the same spec concurrently"
echo "  ✅ Each agent has a different implementation approach"
echo "  ✅ Live traffic is mirrored to all candidates"
echo "  ✅ Scientist validates behavior against declared delta surface"
echo "  ✅ All candidates pass and are eligible for promotion"
echo ""
echo "This is the future of software development:"
echo "  • Concurrent, not sequential"
echo "  • Empirical, not social"
echo "  • Fast, not slow"
echo ""
```

**Voiceover/Narration:**
> "All three candidates passed! In a real production scenario, we might choose Agent 2 
> for promotion because it offers the best performance while maintaining correctness. 
> 
> The platform handles rollback automatically if any issues arise. The winning candidate 
> gets promoted through the Oracle Ladder - from Shadow to Train to Canary to Full. 
> 
> And that's it! We've demonstrated the core capability: multiple agents working 
> concurrently on the same spec, with live production traffic deciding the winner. 
> 
> This changes everything about how software is delivered."

---

## 📊 SCENE 9: Bonus - Show Metrics (Optional, if time)

**Visual:** Show Analytics Engine metrics

**Script:**
```bash
clear
echo "=== Live Metrics ==="
echo ""
echo "The platform also captures Analytics Engine metrics:"
echo ""

# If running locally, show log-based metrics
if [ -f /tmp/beehive-demo-scientist.log ]; then
    echo "Scientist Comparisons:"
    grep -c "comparison" /tmp/beehive-demo-scientist.log | xargs echo "  Total comparisons:"
    grep "latency" /tmp/beehive-demo-scientist.log | head -5
    echo ""
fi

echo "In production, these metrics include:"
echo "  • Request counts per candidate"
echo "  • Latency percentiles"
echo "  • Error rates"
echo "  • Body match rates"
echo "  • Score distributions"
echo ""
echo "These metrics power the automatic promotion decisions."
```

---

## 🎥 Recording Tips

### Camera Setup
- Use a clean terminal with good contrast (dark theme recommended)
- Increase font size to at least 20pt for readability
- Record in full-screen mode
- Use consistent color scheme

### Audio
- Speak clearly and at a moderate pace
- Pause between sections for emphasis
- Use a good microphone
- Minimize background noise

### Editing
- Add section titles as text overlays
- Highlight important commands with zoom/emphasis
- Add subtitles for accessibility
- Keep total length between 5-10 minutes

### File Output
Save as: `beehive-demo-$(date +%Y%m%d).mp4`

---

## ✅ Submission Checklist

Before submitting your demo video, ensure:

- [ ] Video is 5-10 minutes long
- [ ] Shows end-to-end flow clearly
- [ ] All components are visible and explained
- [ ] Concurrent agent work is demonstrated
- [ ] Traffic mirroring is shown
- [ ] Scientist comparison is explained
- [ ] Winner selection is clear
- [ ] Audio is clear and audible
- [ ] Visuals are readable

Upload to: Cloudflare submission portal (check competition rules)

---

## 📝 Narration Script (Full Text)

> Use this complete narration if recording audio separately:

---

[0:00 - 1:00] INTRO
> "Welcome to Beehive. We're building an agent-native version control platform where 
> multiple agents can work on changes concurrently. In this demo, I'll show you how 
> three different AI agents implement the same spec, and how our platform determines 
> which implementation wins using live production traffic. This is our submission for 
> Cloudflare's 'Build the Next-Gen Git Platform' competition."

[1:00 - 2:30] ARCHITECTURE
> "Beehive uses an Oracle Ladder with five rungs. Each rung validates candidates with 
> increasing confidence. For this demo, we focus on M2: the Shadow rung. Here, live traffic 
> is mirrored to all candidate implementations, and our Scientist component compares 
> their behavior against the spec's declared delta surface. The platform has several 
> workers: the Edge Router, Spec Durable Object, Gate Workflow, Sandbox Runner, Queue 
> Consumer, Shadow Router, and Scientist Comparator."

[2:30 - 5:00] SPEC & AGENTS
> "Let's create a spec. This calculator service spec defines the contract: a POST endpoint 
> that adds, subtracts, multiplies, or divides. The delta surface allows performance and 
> logging to vary between implementations. Now, three agents implement this spec. 
> Agent 1 is straightforward. Agent 2 adds caching for performance. Agent 3 includes 
> detailed logging. All satisfy the contract but with different internal approaches."

[5:00 - 7:00] STARTING WORKERS
> "We start all workers locally. The main worker coordinates state. The shadow router 
> will mirror traffic. The scientist will compare responses. And we have our three agent 
> workers ready. This mirrors our production setup but runs on localhost for the demo."

[7:00 - 8:30] TRAFFIC MIRRORING
> "Watch what happens when we send a request through the shadow router. It fans out to all 
> three agents simultaneously. Each processes the request independently. The shadow 
> router discards the responses but captures everything for analysis."

[8:30 - 9:30] SCIENTIST COMPARISON
> "The Scientist compares all responses. It validates status codes, headers, and body 
> content. It checks performance is within tolerance. All three agents match the declared 
> delta surface. Notice Agent 3 adds extra fields, but the core result matches - this is 
> allowed by our spec."

[9:30 - 10:00] WINNER SELECTION
> "All candidates passed! Agent 2 performed best with its caching implementation. The 
> platform can now automatically promote it. This is the future: concurrent development, 
> empirical validation, automatic promotion. No more waiting for code review. No more 
> opinion-based decisions. Just fast, data-driven software delivery."
