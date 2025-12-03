# Master Orchestrator Architecture

## Yes! There IS a Master Orchestrator

The EV supply chain system has a **Router Agent** (`router-agent.ts`) that intelligently routes questions between two specialized agents:

1. **Docking Agent** - Real-time dock operations (Python FastAPI)
2. **SQL Agent** - Complex analytics and queries (TypeScript/Node)

## Architecture Diagram

```
                        ┌─────────────────────┐
                        │   USER QUESTION     │
                        └──────────┬──────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ 🎯 ROUTER AGENT              │
                    │ (router-agent.ts)            │
                    │                              │
                    │ • Uses LLM (Gemini) to       │
                    │   analyze question           │
                    │ • Decides which agent to use │
                    │ • Synthesizes final answer   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴────────────────┐
                    │                               │
                    ▼                               ▼
        ┌────────────────────────┐    ┌────────────────────────┐
        │  🔧 DOCKING AGENT      │    │  🗄️ SQL ORCHESTRATOR   │
        │  (Python FastAPI)      │    │  (TypeScript/Node)     │
        │  Port: 8088            │    │  src/agent.ts          │
        │                        │    │                        │
        │  For:                  │    │  For:                  │
        │  • Door schedules      │    │  • Complex analytics   │
        │  • Assignments         │    │  • Historical queries  │
        │  • Reassignments       │    │  • Aggregations        │
        │  • ETAs                │    │  • Comparisons         │
        │  • Optimization        │    │  • Multi-step analysis │
        └────────────────────────┘    └────────────────────────┘
                 │                              │
                 │                              │
                 ▼                              ▼
        ┌──────────────────┐          ┌──────────────────┐
        │ Database:        │          │ Database:        │
        │ • dock_doors     │          │ • suppliers      │
        │ • dock_assignments│         │ • components     │
        │ • inbound_trucks │          │ • purchase_orders│
        │ • outbound_loads │          │ • inventory      │
        │ • dock_events    │          │ • quality_control│
        └──────────────────┘          └──────────────────┘
```

## Key Components

### 1. Master Router (`router-agent.ts`)

**Location:** `/router-agent.ts`

**Purpose:** Top-level intelligent router that decides which agent to call

**How It Works:**
1. Receives user question
2. Uses Gemini LLM with two tool schemas
3. LLM decides which tool to call based on question type
4. Calls the chosen agent
5. Synthesizes final answer

**Tool Schemas:**

```typescript
DOCKING_TOOL_SCHEMA = {
  name: "docking_agent_api",
  description: "Use for real-time docking and logistics information. 
               Suitable for door schedules, reassignments, status queries.
               ONLY use this for real-time schedule questions."
}

SQL_TOOL_SCHEMA = {
  name: "sql_orchestrator_agent",
  description: "Use for complex analytical, historical, aggregated, 
               or comparative questions requiring database queries.
               Suitable for counts, averages, totals, costs, 
               inventory levels, multi-step analysis."
}
```

**Example Code:**

```typescript
export async function runRouterAgent(question: string): Promise<string> {
    // Use LLM with tool schemas to decide
    let chat = ai.chats.create({
        model: MODEL,
        config: {
            tools: [{ functionDeclarations: [DOCKING_TOOL_SCHEMA, SQL_TOOL_SCHEMA] }],
        },
    });

    let response = await chat.sendMessage({ message: question });

    // Execute the tool the LLM chose
    if (toolName === "docking_agent_api") {
        return await callDockingAgent(question);
    } else if (toolName === "sql_orchestrator_agent") {
        return await callSQLOrchestrator(question);
    }
}
```

### 2. Docking Agent (Python)

**Location:** `docking_agent/api.py`

**Endpoint:** `POST http://localhost:8088/qa`

**Purpose:** Handles real-time dock operations

**Capabilities:**
- Door schedules by location
- Assignment status and tracking
- Why reassignments happened (event inference)
- Earliest ETAs for parts/trucks
- Count queries (how many inbound/outbound)
- Optimization scheduling

**Example:**
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the schedule for Shanghai doors?"}'
```

### 3. SQL Orchestrator (TypeScript)

**Location:** `src/agent.ts`

**Function:** `runOrchestrator(question, contextHistory)`

**Purpose:** Handles complex analytical queries

**Capabilities:**
- Multi-step SQL query planning
- Schema linking and analysis
- KPI calculations (averages, totals, comparisons)
- Error correction for failed queries
- Visualization generation
- Historical data analysis

**Example:**
```typescript
const result = await runOrchestrator(
    "What is the average order to deliver time per warehouse?"
);
```

## Routing Decision Logic

### When Router Chooses Docking Agent

**Keywords/Patterns:**
- "schedule", "door", "dock", "assignment"
- "reassigned", "why", "reason"
- Location names: "Shanghai", "Fremont", "Austin"
- Door IDs: "FCX-D01", "SHA-D04"
- "inbound", "outbound", "truck", "load"
- "ETA", "arrival", "next"
- "optimize"

**Example Questions:**
- "What's happening at Shanghai doors?"
- "Why was door 4 reassigned?"
- "How many inbound at Fremont CA?"
- "When is the next truck arriving?"
- "Show me the schedule for Austin TX"

### When Router Chooses SQL Agent

**Keywords/Patterns:**
- "average", "total", "count", "sum"
- "compare", "across", "by supplier/warehouse/location"
- "cost", "inventory", "component", "quality"
- "delayed", "defect", "reliability"
- "last 30 days", "historical", "trend"

**Example Questions:**
- "What is the average order to delivery time per warehouse?"
- "Total cost of delayed components excluding China"
- "Compare battery inventory across all locations"
- "Which suppliers have the most defects?"
- "Show me purchase order trends for the last quarter"

## Integration Pattern

### How They Work Together

```python
# Example: User asks a question
user_question = "What's the schedule for Shanghai doors?"

# Step 1: Router Agent analyzes with LLM
router_result = runRouterAgent(user_question)
# LLM decides: Use docking_agent_api

# Step 2: Router calls Docking Agent
docking_response = await callDockingAgent(user_question)
# Docking Agent: POST http://localhost:8088/qa
# Returns: {"answer": [...schedule items...], "explanation": "..."}

# Step 3: Router synthesizes final answer
final_answer = synthesize(docking_response)
# Returns to user: "The Shanghai door schedule shows..."
```

## Running the Full System

### 1. Start Docking Agent

```bash
cd docking_agent
uvicorn api:app --reload --port 8088
```

### 2. Start SQL Agent (included in router)

The SQL orchestrator is imported directly in `router-agent.ts`:

```typescript
import { runOrchestrator } from '../ev-supply-chain-sql-agent/dist/agent.js';
```

### 3. Run Router Agent

```bash
npm run router-demo
# Or directly:
ts-node router-agent.ts
```

### 4. Test Routing

```typescript
// This will automatically route to the right agent
await runRouterAgent("What's Shanghai schedule?");        // → Docking Agent
await runRouterAgent("Average delivery time per warehouse?"); // → SQL Agent
```

## Orchestrator Features

### Docking Orchestrator (`docking_agent/orchestrator.py`)

Provides standardized tool interface for integration:

```python
from docking_agent.orchestrator import DockingOrchestrator, ToolCall

orchestrator = DockingOrchestrator()

# Call as a tool
result = orchestrator.call_tool(ToolCall(
    tool_name="answer_docking_question",
    parameters={"question": "What's the schedule?"}
))

print(result.result)
```

**Available Tools:**
- `answer_docking_question` - Natural language QA
- `allocate_inbound_truck` - Assign truck to door
- `allocate_outbound_load` - Assign load to door
- `optimize_dock_schedule` - Run optimization
- `analyze_reassignment` - Analyze why events
- `analyze_delays` - Analyze delay patterns
- `analyze_utilization` - Analyze dock usage
- `get_door_schedule` - Get schedule for specific door
- `check_door_availability` - Check door availability
- `get_operational_status` - Get current status

## Evaluation Pipeline Integration

The new **LLM-as-a-judge evaluation pipeline** logs calls to BOTH agents:

```python
# In agent_call_logs table:
# - target_agent = "docking" or "sql"
# - router_intent = intent from routing decision
# - handler_name = which agent function was called

# This allows you to:
# 1. Track which agent handles which questions
# 2. Evaluate routing accuracy
# 3. Compare agent performance
# 4. Identify which agent needs improvement
```

## Demo Queries

The router includes demo queries showing the routing:

```typescript
const ROUTER_DEMO_QUERIES = [
    'What is the schedule for Shanghai doors?',          // → Docking
    'How many inbound at Fremont CA?',                   // → Docking
    'Why was door FCX-D10 reassigned?',                  // → Docking
    'What is the average order to deliver time per warehouse?', // → SQL
];
```

## Benefits of This Architecture

### 1. **Specialized Agents**
- Docking Agent: Optimized for real-time operations
- SQL Agent: Optimized for complex analytics

### 2. **Intelligent Routing**
- LLM decides based on question semantics
- Not rule-based, adapts to natural language variations

### 3. **Independent Scaling**
- Scale docking and SQL agents independently
- Deploy on different servers if needed

### 4. **Modular Development**
- Improve docking agent without touching SQL agent
- Add new agents without changing existing ones

### 5. **Unified Interface**
- User doesn't need to know which agent to use
- Single entry point for all questions

## Summary

**Yes, there IS a master orchestrator!**

- **File:** `router-agent.ts`
- **Method:** LLM-based tool selection with Gemini
- **Agents:** Docking Agent (Python) + SQL Agent (TypeScript)
- **Integration:** REST API (Docking) + Direct Import (SQL)
- **Status:** ✅ Fully implemented and operational

The router intelligently decides based on question semantics whether to use real-time dock operations or complex SQL analytics.

