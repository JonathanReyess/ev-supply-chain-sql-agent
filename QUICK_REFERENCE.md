# Quick Reference: Orchestrator & Test Generation

## 📖 How the Orchestrator Works

### Simple Explanation
**Router Agent** = Smart dispatcher that sends questions to the right expert:
- Questions about **real-time schedules/doors** → **Docking Agent** (Python API)
- Questions about **analytics/data** → **SQL Agent** (TypeScript)

### The Flow
```
User: "What's the average cost of batteries?"
  ↓
Router (uses Gemini LLM): "This needs data analysis..."
  ↓
Calls SQL Agent
  ↓
SQL Agent: Loads schema → Plans query → Generates SQL → Executes
  ↓
Returns: "$45.32"
```

### Key Files
- `router-agent.ts` - The smart router (150 lines)
- `src/agent.ts` - SQL orchestrator (800+ lines, multi-step pipeline)
- `docking_agent/api.py` - Docking API endpoint

---

## 🎯 Next Step: Generate Test Questions

### Why?
To test if the router makes correct decisions and agents return correct answers.

### Quick Start

**Step 1: Generate Database Data**
```bash
python generate_data.py
```
This creates ~10,000 rows of sample supply chain data.

**Step 2: Generate Test Questions**
```bash
python generate_test_questions.py
```
Uses Gemini AI to create 25 test questions based on your actual database schema.

**Step 3: Review Generated Questions**
```bash
cat test_questions_answers.json
```
Contains questions like:
- "What is the total inventory value?" (SQL)
- "Show me the schedule at Fremont" (Docking)
- "Which suppliers have most delays?" (SQL)

### What Gets Generated

**Each test question includes:**
```json
{
  "id": 1,
  "question": "What is the total quantity in stock?",
  "agent": "sql",
  "category": "aggregation",
  "expected_sql": "SELECT SUM(quantity_in_stock) FROM components",
  "expected_answer_type": "number",
  "tables_involved": ["components"],
  "difficulty": "easy",
  "explanation": "Simple aggregation on single table"
}
```

### Manual Method (If Script Doesn't Work)

**1. Get your schema:**
```bash
python3 << 'EOF'
import sqlite3
conn = sqlite3.connect('data/ev_supply_chain.db')
cursor = conn.cursor()

# List tables
tables = cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
for t in tables:
    print(f"\n=== {t[0]} ===")
    
    # Show columns
    cols = cursor.execute(f"PRAGMA table_info({t[0]})").fetchall()
    for c in cols:
        print(f"  {c[1]} ({c[2]})")
    
    # Show 2 sample rows
    rows = cursor.execute(f"SELECT * FROM {t[0]} LIMIT 2").fetchall()
    print(f"  Sample rows: {len(rows)}")

conn.close()
EOF
```

**2. Feed schema to ChatGPT/Claude/Gemini:**

> "I have these database tables: [paste schema above]
> 
> Generate 20 test questions for a supply chain system. 
> 60% should be SQL analytical queries (aggregations, joins, analysis)
> 40% should be real-time operational queries (schedules, door status)
> 
> Format each as JSON with: question, agent (sql/docking), expected_sql, difficulty"

**3. Save output to `test_questions_answers.json`**

---

## 🧪 Testing the System

### Test Individual Agents

**SQL Agent:**
```bash
npx ts-node src/agent.ts
# Tests with built-in demo queries
```

**Docking Agent:**
```bash
# Terminal 1: Start API
uvicorn docking_agent.api:app --port 8088

# Terminal 2: Test
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the schedule at Fremont?"}'
```

**Router:**
```bash
npx ts-node router-agent.ts 0
# Runs first demo query
```

### Test With Your Questions

Once you have `test_questions_answers.json`:

```python
# test_orchestrator.py
import json

with open('test_questions_answers.json') as f:
    data = json.load(f)

for test in data['test_cases'][:5]:  # Test first 5
    print(f"\nQ: {test['question']}")
    print(f"Expected agent: {test['agent']}")
    
    # TODO: Call router and check if correct agent used
    # result = runRouterAgent(test['question'])
```

---

## 📊 Success Criteria

After generating test questions, you should have:

✅ **25+ diverse questions** covering:
   - Easy (40%): Single table queries, simple schedules
   - Medium (40%): Multi-table joins, analysis
   - Hard (20%): Complex aggregations, optimization

✅ **Agent distribution:**
   - 60% SQL Agent (analytical)
   - 40% Docking Agent (operational)

✅ **Categories covered:**
   - Aggregation, Ranking, Comparison
   - Time series, Filtering, Joins
   - Real-time schedules, Analysis

---

## 🎯 Summary

**Orchestrator**: LLM-powered router using Gemini function calling
- Automatically decides: SQL Agent vs Docking Agent
- Based on question semantics, not keywords

**Next Step Implementation**:
1. ✅ Run `python generate_data.py` (populate DB)
2. ✅ Run `python generate_test_questions.py` (generate Q&A)
3. ✅ Review `test_questions_answers.json`
4. 📝 Create test script to validate router accuracy
5. 📈 Measure: routing accuracy, SQL correctness, answer quality

**Files Created**:
- `ORCHESTRATOR_SUMMARY.md` - Full technical explanation
- `generate_test_questions.py` - Auto-generates tests using Gemini
- `test_questions_answers.json` - Output file with all test cases

