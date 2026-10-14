#!/bin/bash
# Create Agent Forks Script
# 
# Creates 3 simulated agent forks for demo purposes.
# Each "fork" is a directory with a simple Worker implementation
# that demonstrates concurrent development against the same spec.
#
# Usage: ./scripts/create-agent-forks.sh [agent-1 agent-2 agent-3]
# Default: Creates agent-1, agent-2, agent-3

set -e

echo "=========================================="
echo "  CREATING AGENT FORKS FOR DEMO"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_DIR="/tmp/beehive-demo-forks"
SPEC_NAME="demo-calculator"
SPEC_VERSION="v1.0.0"
DEFAULT_AGENTS=("agent-1" "agent-2" "agent-3")

# Parse arguments
AGENTS=("${@:-${DEFAULT_AGENTS[@]}}")

# Clean up previous forks
cleanup() {
    echo -e "${YELLOW}Cleaning up previous demo forks...${NC}"
    rm -rf "$BASE_DIR"
    mkdir -p "$BASE_DIR"
    echo -e "${GREEN}Clean!${NC}\n"
}

# Create spec file
create_spec() {
    local spec_dir="$BASE_DIR/$SPEC_NAME"
    mkdir -p "$spec_dir"
    
    cat > "$spec_dir/spec.json" << 'SPEC_EOF'
{
  "name": "demo-calculator",
  "version": "v1.0.0",
  "description": "Simple calculator service for demo purposes",
  "contract": {
    "endpoint": "/api/calculate",
    "method": "POST",
    "input": {
      "type": "object",
      "properties": {
        "operation": { "type": "string", "enum": ["add", "subtract", "multiply", "divide"] },
        "a": { "type": "number" },
        "b": { "type": "number" }
      },
      "required": ["operation", "a", "b"]
    },
    "output": {
      "type": "object",
      "properties": {
        "result": { "type": "number" },
        "operation": { "type": "string" }
      },
      "required": ["result", "operation"]
    }
  },
  "declaredDeltaSurface": {
    "allowedBehaviorChanges": ["performance", "logging"],
    "forbiddenBehaviorChanges": ["output_format", "error_handling"],
    "allowedFields": ["result", "operation"],
    "tolerance": {
      "numeric": 0.001,
      "latencyMs": 100
    }
  },
  "acceptanceCriteria": {
    "tests": [
      "test_addition",
      "test_subtraction", 
      "test_multiplication",
      "test_division"
    ],
    "passingScore": 80
  }
}
SPEC_EOF

    cat > "$spec_dir/wrangler.toml" << 'WRANGLER_EOF'
name = "demo-calculator"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[build]
command = "npm run build"
watch = { pattern = "src/**/*.ts" }

[build.upload]
format = "modules"
main = "./dist/index.mjs"

[vars]
SPEC_NAME = "demo-calculator"
WRANGLER_ENV = "production"
WRANGLER_EOF

    cat > "$spec_dir/package.json" << 'PACKAGE_EOF'
{
  "name": "demo-calculator",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@cloudflare/workers-types": "^5.20261006.1"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "wrangler": "^4.149.0"
  }
}
PACKAGE_EOF

    echo -e "${GREEN}Created spec: $spec_dir/spec.json${NC}"
}

# Create agent fork
create_agent_fork() {
    local agent_name="$1"
    local fork_dir="$BASE_DIR/$SPEC_NAME-$agent_name"
    
    echo -e "${BLUE}Creating fork for $agent_name...${NC}"
    
    # Copy spec directory as baseline
    cp -r "$BASE_DIR/$SPEC_NAME" "$fork_dir"
    
    # Create src directory
    mkdir -p "$fork_dir/src"
    
    # Create a unique implementation for each agent
    # Agent 1: Basic implementation
    # Agent 2: Fast implementation (with caching)
    # Agent 3: Verbose implementation (with logging)
    
    local implementation=""
    case "$agent_name" in
        "agent-1")
            implementation='
/**
 * Agent 1 Implementation - Basic Calculator
 * Simple, straightforward implementation
 */

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({ 
        status: "healthy", 
        agent: "agent-1",
        timestamp: Date.now() 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // Calculator endpoint
    if (url.pathname === "/api/calculate" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { operation, a, b } = body;
      
      // Validate
      if (!operation || a === undefined || b === undefined) {
        return new Response(JSON.stringify({ error: "Missing parameters" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      let result: number;
      switch (operation) {
        case "add":
          result = a + b;
          break;
        case "subtract":
          result = a - b;
          break;
        case "multiply":
          result = a * b;
          break;
        case "divide":
          if (b === 0) {
            return new Response(JSON.stringify({ error: "Division by zero" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          result = a / b;
          break;
        default:
          return new Response(JSON.stringify({ error: "Invalid operation" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
      }
      
      return new Response(JSON.stringify({
        result,
        operation,
        agent: "agent-1"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
'
            ;;
        "agent-2")
            implementation='
/**
 * Agent 2 Implementation - Optimized Calculator with Caching
 * Uses a simple in-memory cache for repeated operations
 */

interface CacheEntry {
  input: string;
  result: { result: number; operation: string };
  timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 5000; // 5 second cache

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({ 
        status: "healthy", 
        agent: "agent-2",
        timestamp: Date.now(),
        cacheSize: cache.size
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // Calculator endpoint
    if (url.pathname === "/api/calculate" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { operation, a, b } = body;
      
      // Validate
      if (!operation || a === undefined || b === undefined) {
        return new Response(JSON.stringify({ error: "Missing parameters" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // Check cache
      const cacheKey = JSON.stringify({ operation, a, b });
      const cached = cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return new Response(JSON.stringify({
          ...cached.result,
          agent: "agent-2",
          cached: true
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // Calculate
      let result: number;
      switch (operation) {
        case "add":
          result = a + b;
          break;
        case "subtract":
          result = a - b;
          break;
        case "multiply":
          result = a * b;
          break;
        case "divide":
          if (b === 0) {
            return new Response(JSON.stringify({ error: "Division by zero" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          result = a / b;
          break;
        default:
          return new Response(JSON.stringify({ error: "Invalid operation" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
      }
      
      // Cache result
      cache.set(cacheKey, {
        input: cacheKey,
        result: { result, operation },
        timestamp: Date.now()
      });
      
      return new Response(JSON.stringify({
        result,
        operation,
        agent: "agent-2",
        cached: false
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
'
            ;;
        "agent-3")
            implementation='
/**
 * Agent 3 Implementation - Verbose Calculator with Logging
 * Adds detailed logging and validation
 */

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const startTime = Date.now();
    
    // Log all requests
    console.log(`[Agent-3] ${request.method} ${url.pathname} from ${request.headers.get("CF-Connecting-IP" || "unknown")}`);
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      const latencyMs = Date.now() - startTime;
      console.log(`[Agent-3] Health check completed in ${latencyMs}ms`);
      return new Response(JSON.stringify({ 
        status: "healthy", 
        agent: "agent-3",
        timestamp: Date.now(),
        latencyMs
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // Calculator endpoint
    if (url.pathname === "/api/calculate" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { operation, a, b } = body;
      
      // Log operation
      console.log(`[Agent-3] Processing: ${operation}(${a}, ${b})`);
      
      // Validate with more detail
      if (!operation || a === undefined || b === undefined) {
        const error = "Missing parameters: required fields are operation, a, b";
        console.error(`[Agent-3] Validation error: ${error}`);
        return new Response(JSON.stringify({ 
          error,
          agent: "agent-3",
          timestamp: Date.now()
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // Validate numeric types
      if (typeof a !== "number" || typeof b !== "number" || isNaN(a) || isNaN(b)) {
        const error = "Invalid parameters: a and b must be valid numbers";
        console.error(`[Agent-3] Type error: ${error}`);
        return new Response(JSON.stringify({ 
          error,
          agent: "agent-3",
          timestamp: Date.now()
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // Calculate
      let result: number;
      switch (operation) {
        case "add":
          result = a + b;
          console.log(`[Agent-3] Addition result: ${result}`);
          break;
        case "subtract":
          result = a - b;
          console.log(`[Agent-3] Subtraction result: ${result}`);
          break;
        case "multiply":
          result = a * b;
          console.log(`[Agent-3] Multiplication result: ${result}`);
          break;
        case "divide":
          if (b === 0) {
            const error = "Division by zero";
            console.error(`[Agent-3] ${error}`);
            return new Response(JSON.stringify({ 
              error,
              agent: "agent-3",
              timestamp: Date.now()
            }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          result = a / b;
          console.log(`[Agent-3] Division result: ${result}`);
          break;
        default:
          const error = `Invalid operation: ${operation}`;
          console.error(`[Agent-3] ${error}`);
          return new Response(JSON.stringify({ 
            error,
            agent: "agent-3",
            timestamp: Date.now()
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
      }
      
      const latencyMs = Date.now() - startTime;
      console.log(`[Agent-3] Request completed in ${latencyMs}ms`);
      
      return new Response(JSON.stringify({
        result,
        operation,
        agent: "agent-3",
        timestamp: Date.now(),
        latencyMs
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ 
      error: "Not found",
      agent: "agent-3",
      timestamp: Date.now()
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
'
            ;;
        *)
            # Default implementation for custom agent names
            implementation='
/**
 * Custom Agent Implementation - Basic Calculator
 */

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({ 
        status: "healthy", 
        agent: "'$agent_name'",
        timestamp: Date.now() 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname === "/api/calculate" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { operation, a, b } = body;
      
      if (!operation || a === undefined || b === undefined) {
        return new Response(JSON.stringify({ error: "Missing parameters" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      let result: number;
      switch (operation) {
        case "add": result = a + b; break;
        case "subtract": result = a - b; break;
        case "multiply": result = a * b; break;
        case "divide": 
          if (b === 0) {
            return new Response(JSON.stringify({ error: "Division by zero" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          result = a / b;
          break;
        default:
          return new Response(JSON.stringify({ error: "Invalid operation" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
      }
      
      return new Response(JSON.stringify({
        result,
        operation,
        agent: "'$agent_name'"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
'
            ;;
    esac
    
    # Write implementation
    cat > "$fork_dir/src/index.ts" "$implementation"
    
    # Create tsconfig
    cat > "$fork_dir/tsconfig.json" << 'TSCONFIG_EOF'
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2021"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
TSCONFIG_EOF

    # Add agent identifier
    mkdir -p "$fork_dir/.beehive"
    cat > "$fork_dir/.beehive/agent.json" << AGENT_EOF
{
  "agentName": "$agent_name",
  "specName": "$SPEC_NAME",
  "specVersion": "$SPEC_VERSION",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "forkFrom": "$SPEC_NAME"
}
AGENT_EOF

    echo -e "${GREEN}Created fork: $fork_dir${NC}"
    echo -e "  Agent: $agent_name"
    echo -e "  Spec: $SPEC_NAME@$SPEC_VERSION"
    echo ""
}

# Main execution
main() {
    cleanup
    create_spec
    
    echo -e "${BLUE}Creating ${#AGENTS[@]} agent forks...${NC}\n"
    
    for agent in "${AGENTS[@]}"; do
        create_agent_fork "$agent"
    done
    
    echo -e "${GREEN}=========================================="
echo "  AGENT FORKS CREATED SUCCESSFULLY"
echo "=========================================="
echo ""
echo "Forks created at: $BASE_DIR"
echo ""
echo "Each fork contains:"
echo "  - spec.json (the spec contract)"
echo "  - wrangler.toml (Worker configuration)"
echo "  - src/index.ts (unique implementation)"
echo "  - .beehive/agent.json (agent metadata)"
echo ""
echo "To test locally:"
echo "  cd $BASE_DIR/demo-calculator-agent-1"
echo "  npm install"
echo "  npm run dev"
echo ""
echo "Then send requests to:"
echo "  POST http://localhost:8787/api/calculate"
echo '  Body: {"operation": "add", "a": 5, "b": 3}'
echo ""
}

main
