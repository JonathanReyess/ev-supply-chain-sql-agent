# Router Orchestrator - How It Works

## 🎯 Overview

The **Router Agent** (`router-agent.ts`) is a meta-agent that intelligently routes user questions to the appropriate specialized agent:

1. **Docking Agent** (Python/FastAPI) - Real-time schedules, door assignments, operational queries
2. **SQL Agent** (TypeScript) - Analytical queries, aggregations, historical analysis, KPIs

## 🏗️ Architecture

```
User Question
      ↓
┌─────────────────┐
│  Router Agent   │ ← Uses Gemini LLM to decide
│  (router-agent) │
└────────┬────────┘
         │
    ┌────┴─────┐
    ↓          ↓
┌─────────┐  ┌──────────┐
│ Docking │  │   SQL    │
│  Agent  │  │ Orchestr.│
│ (API)   │  │ (agent.ts)│
└─────────┘  └──────────┘
```

## 🔧 How It Works (Step-by-Step)

### 1. **User Asks Question**
```typescript
runRouterAgent("What is the schedule at Fremont?")
```

### 2. **Router Agent Analyzes Question**
The Router uses Gemini with **function calling** (tool use):
- Registers 2 tools: `docking_agent_api` and `sql_orchestrator_agent`
- LLM analyzes the question and chooses which tool to call
- Decision criteria:
  - **Docking Agent** → Real-time schedules, door status, reassignments
  - **SQL Agent** → Counts, averages, totals, historical analysis, comparisons

### 3. **Calls Appropriate Agent**

**If Docking Agent is chosen:**
```typescript
callDockingAgent(question)
  → HTTP POST to http://localhost:8088/qa
  → Returns schedule data
```

**If SQL Agent is chosen:**
```typescript
callSQLOrchestrator(question)
  → Runs the full SQL orchestrator pipeline:
     1. Load schema
     2. Schema linking
     3. KPI decomposition / subproblem identification
     4. Query planning
     5. SQL generation
     6. Execution
     7. (Optional) Visualization
  → Returns final answer
```

### 4. **Returns Unified Answer**
Router receives result from specialized agent and formats a final response for the user.

## 🛠️ Key Components

### `router-agent.ts`
**Lines 28-51**: Tool schemas (defines the two agents as "tools")
```typescript
DOCKING_TOOL_SCHEMA - For real-time schedule questions
SQL_TOOL_SCHEMA - For analytical/aggregation questions
```

**Lines 55-88**: `callDockingAgent()` - HTTP client to Docking Agent API
**Lines 90-106**: `callSQLOrchestrator()` - Calls SQL agent's main orchestrator
**Lines 110-173**: `runRouterAgent()` - Main routing logic with Gemini function calling

### Tool Decision Logic

The **Gemini LLM** automatically decides based on these descriptions:

**Docking Agent Tool**:
- "real-time docking and logistics information"
- "door schedules, reassignments, direct location/door status"
- "ONLY use this for real-time schedule questions"

**SQL Agent Tool**:
- "complex analytical, historical, aggregated, or comparative questions"
- "questions involving counts, averages, totals, costs, inventory levels"
- "multi-step analysis"

## 📊 Example Routing Decisions

| Question | Routes To | Reasoning |
|----------|-----------|-----------|
| "What is the schedule at Fremont?" | **Docking** | Real-time schedule query |
| "Why was door 4 reassigned?" | **Docking** | Operational/reasoning query |
| "How many inbound trucks at Fremont?" | **SQL** | Counting/aggregation |
| "What's the average order-to-delivery time?" | **SQL** | Analytical/KPI calculation |
| "Compare battery costs across suppliers" | **SQL** | Multi-table analysis |

## 🔄 Complete Flow Example

```
User: "What is the average cost of delayed components?"
      ↓
Router Agent analyzes with Gemini
      ↓
LLM decides: This requires analytical query → Use SQL Agent
      ↓
callSQLOrchestrator("What is the average cost...")
      ↓
SQL Agent Pipeline:
  1. Load schema (components, purchase_orders, etc.)
  2. Schema linking (identify relevant tables)
  3. Query planning (create execution steps)
  4. SQL generation (generate query)
  5. Execute: SELECT AVG(unit_cost) FROM components...
  6. Return result: "$45.32"
      ↓
Router formats final answer
      ↓
User receives: "The average cost of delayed components is $45.32"
```

## 🚀 Running the System

### Start Services

**Terminal 1 - Docking Agent:**
```bash
cd docking_agent
uvicorn api:app --port 8088
```

**Terminal 2 - Router Agent:**
```bash
npx ts-node router-agent.ts
```

### Test Queries

```bash
# Query 0: Docking schedule
npx ts-node router-agent.ts 0
# "What is the schedule for Shanghai doors?"

# Query 1: SQL aggregation
npx ts-node router-agent.ts 1
# "How many inbound at Fremont CA?"

# Query 2: Docking analysis
npx ts-node router-agent.ts 2
# "Why was door FCX-D10 reassigned?"

# Query 3: SQL analytical
npx ts-node router-agent.ts 3
# "What is the average order to deliver time?"
```

## 🎨 Why This Design?

### Advantages:
1. **Separation of Concerns**: Each agent specializes in its domain
2. **Flexibility**: Easy to add new specialized agents
3. **Intelligent Routing**: LLM-based decision making (no hardcoded rules)
4. **Extensible**: Can add more tools/agents to the router
5. **Unified Interface**: Single entry point for all queries

### Alternative Approaches (Not Used):
- ❌ **Keyword matching** - Too rigid, misses nuances
- ❌ **Single unified agent** - Too complex, slower
- ❌ **Manual routing** - Requires user to choose agent

---

# 📝 Next Step: Create Sample Q&A Pairs

## Goal
Create a test dataset of questions paired with:
1. Expected SQL queries
2. Expected answers
3. Which agent should handle it

This will be used for:
- Testing router accuracy
- Validating SQL generation
- Benchmarking performance
- Creating automated tests

## Implementation Guide

### Step 1: Generate Database Data

**The database is currently empty!** First, populate it:

```bash
# Run the data generation script
python generate_data.py
```

This creates all tables and sample data for:
- Components (batteries, motors, etc.)
- Suppliers
- Warehouses
- Purchase orders
- Shipments
- Inventory

### Step 2: Explore Database Schema

```bash
# List all tables
python3 -c "
import sqlite3
conn = sqlite3.connect('data/ev_supply_chain.db')
cursor = conn.cursor()
tables = cursor.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()
for table in tables:
    print(f'\n=== {table[0]} ===')
    schema = cursor.execute(f\"PRAGMA table_info({table[0]})\").fetchall()
    for col in schema:
        print(f'  {col[1]} ({col[2]})')
conn.close()
"
```

### Step 3: Sample Data from Each Table

```bash
# Get sample rows from key tables
python3 << 'EOF'
import sqlite3
import json

conn = sqlite3.connect('data/ev_supply_chain.db')
conn.row_factory = sqlite3.Row

tables_to_sample = [
    'components', 'suppliers', 'warehouses', 
    'purchase_orders', 'po_line_items', 'shipments'
]

for table in tables_to_sample:
    print(f"\n{'='*60}")
    print(f"Table: {table}")
    print('='*60)
    
    cursor = conn.cursor()
    rows = cursor.execute(f"SELECT * FROM {table} LIMIT 3").fetchall()
    
    for row in rows:
        print(json.dumps(dict(row), indent=2, default=str))
        print()

conn.close()
EOF
```

### Step 4: Create Q&A Test File

Create `test_questions_answers.json`:

```json
{
  "test_cases": [
    {
      "id": 1,
      "question": "What is the total quantity of batteries in stock?",
      "agent": "sql",
      "category": "aggregation",
      "expected_sql": "SELECT SUM(quantity_in_stock) FROM components WHERE type = 'Battery'",
      "expected_answer_type": "number",
      "sample_answer": "15000",
      "tables_involved": ["components"],
      "difficulty": "easy"
    },
    {
      "id": 2,
      "question": "Which suppliers have the most delayed shipments?",
      "agent": "sql",
      "category": "ranking",
      "expected_sql": "SELECT s.name, COUNT(*) as delayed_count FROM suppliers s JOIN purchase_orders po ON s.supplierid = po.supplierid WHERE po.status = 'Delayed' GROUP BY s.name ORDER BY delayed_count DESC",
      "expected_answer_type": "table",
      "sample_answer": "['Supplier A: 15 delays', 'Supplier B: 12 delays']",
      "tables_involved": ["suppliers", "purchase_orders"],
      "difficulty": "medium"
    },
    {
      "id": 3,
      "question": "What is the schedule at Fremont CA?",
      "agent": "docking",
      "category": "real-time-schedule",
      "expected_api": "POST /qa with question",
      "expected_answer_type": "schedule_list",
      "sample_answer": "Door FRE-D01: Truck T-FRE-001 (10:00-11:30), Door FRE-D02: Load L-FRE-005 (11:00-12:00)",
      "tables_involved": ["dock_assignments", "dock_doors"],
      "difficulty": "easy"
    }
  ]
}
```

### Step 5: Use LLM to Generate More Examples

**Prompt for GPT-4/Claude/Gemini:**

```
I have an EV supply chain database with these tables:

TABLES:
- components (componentid, name, type, manufacturer, unit_cost, supplier_id, warehouse_location, quantity_in_stock, safety_stock_level)
- suppliers (supplierid, name, country, lead_time_days)
- warehouses (warehouse_id, location, capacity, manager)
- purchase_orders (po_id, supplier_id, order_date, delivery_date, status, total_cost)
- po_line_items (line_item_id, po_id, componentid, quantity_ordered, unit_price)
- shipments (shipment_id, po_id, ship_date, arrive_date, carrier, status)

SAMPLE DATA:
[Paste 3-5 rows from each table]

Generate 20 test questions in this JSON format:
{
  "question": "...",
  "agent": "sql" or "docking",
  "category": "aggregation|ranking|comparison|time-series|real-time-schedule|analysis",
  "expected_sql": "...",
  "expected_answer_type": "number|table|list|schedule",
  "difficulty": "easy|medium|hard"
}

Categories:
- Easy: Single table, simple aggregation
- Medium: 2-3 tables, joins, GROUP BY
- Hard: Complex multi-table joins, subqueries, window functions

Mix of:
- 70% SQL queries (analytical)
- 30% Docking queries (real-time operational)
```

### Step 6: Create Test Script

`test_orchestrator_accuracy.py`:

```python
import json
import time
from router_agent import runRouterAgent

# Load test cases
with open('test_questions_answers.json') as f:
    test_data = json.load(f)

results = {
    "total": 0,
    "correct_routing": 0,
    "correct_answers": 0,
    "failed": 0
}

for test_case in test_data['test_cases']:
    print(f"\n{'='*60}")
    print(f"Test #{test_case['id']}: {test_case['question']}")
    print(f"Expected Agent: {test_case['agent']}")
    
    try:
        start = time.time()
        result = runRouterAgent(test_case['question'])
        duration = time.time() - start
        
        # Check if correct agent was used
        if test_case['agent'] in result.lower():
            results['correct_routing'] += 1
            print(f"✓ Correct routing ({duration:.2f}s)")
        else:
            print(f"✗ Wrong routing")
        
        results['total'] += 1
        
    except Exception as e:
        print(f"✗ Failed: {e}")
        results['failed'] += 1

print(f"\n{'='*60}")
print(f"RESULTS:")
print(f"Total: {results['total']}")
print(f"Correct Routing: {results['correct_routing']} ({results['correct_routing']/results['total']*100:.1f}%)")
print(f"Failed: {results['failed']}")
```

## 📋 Example Test Questions to Generate

### SQL Agent Questions (Analytical)

**Easy:**
- "What is the total inventory value?"
- "How many components are below safety stock?"
- "List all suppliers from China"

**Medium:**
- "What's the average delivery time by supplier?"
- "Which warehouse has the highest inventory turnover?"
- "Compare battery costs across manufacturers"

**Hard:**
- "What's the cost impact of delayed shipments in Q4?"
- "Find components at risk of stockout within 30 days"
- "Calculate supplier reliability score based on on-time deliveries"

### Docking Agent Questions (Operational)

**Easy:**
- "Show me today's schedule at Austin"
- "Which doors are available at Fremont?"
- "When is the next truck arriving?"

**Medium:**
- "Why was door 5 reassigned this morning?"
- "What's the utilization rate for Berlin doors?"
- "How many trucks are scheduled for tomorrow?"

**Hard:**
- "Optimize the schedule for the next 4 hours at Fremont"
- "Analyze delay patterns across all locations"
- "What caused the bottleneck at Shanghai yesterday?"

## 🎯 Success Metrics

After creating test dataset, measure:

1. **Router Accuracy**: % of questions routed to correct agent
2. **SQL Correctness**: % of SQL queries that execute successfully
3. **Answer Quality**: % of answers matching expected format
4. **Performance**: Average response time per query type
5. **Error Rate**: % of queries that fail completely

Target: **>90% routing accuracy**, **>80% SQL correctness**

---

## Summary

**Orchestrator**: LLM-based router that intelligently selects between Docking Agent (operational) and SQL Agent (analytical)

**Next Step**: 
1. Generate database data
2. Extract schema + sample rows
3. Use LLM to generate 20+ test Q&A pairs
4. Create test script to validate routing accuracy
5. Iterate and improve based on results

