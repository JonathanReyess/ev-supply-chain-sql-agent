# Quick Test Generation Workflow (No Token Waste!)

## 🎯 Overview

Instead of burning API tokens on generation, we:
1. Extract schema once locally
2. Paste into ChatGPT/Claude manually (uses their tokens, not yours)
3. Validate generated queries against database

**Cost**: $0 (uses ChatGPT's free tier)

---

## 📋 Step-by-Step Workflow

### Step 1: Extract Database Schema (Done!)

```bash
python3 extract_schema.py
```

**Output**: `schema_for_llm.txt` (complete database schema with sample data)

✅ **Already completed!** You now have the schema file.

---

### Step 2: Generate Questions with ChatGPT/Claude

**Open ChatGPT or Claude and paste this:**

```
I have an EV supply chain database with the schema below. Generate 25 diverse 
test questions in JSON format for testing a multi-agent orchestrator system.

SYSTEM OVERVIEW:
- SQL Agent: Handles analytical queries (aggregations, joins, KPIs, trends)
- Docking Agent: Handles operational queries (schedules, door assignments, status)

REQUIREMENTS:
1. 60% SQL Agent questions (15 questions)
2. 40% Docking Agent questions (10 questions)
3. Mix of difficulties: 40% easy, 40% medium, 20% hard
4. Each question must include expected SQL (for SQL agent) or API endpoint (for docking)

JSON FORMAT (return ONLY valid JSON array):
[
  {
    "id": 1,
    "question": "What is the total quantity of batteries in stock?",
    "agent": "sql",
    "category": "aggregation",
    "difficulty": "easy",
    "expected_sql": "SELECT SUM(quantity_in_stock) FROM components WHERE type = 'Battery'",
    "expected_answer_type": "number",
    "tables_involved": ["components"]
  },
  {
    "id": 2,
    "question": "What is the schedule at Fremont CA?",
    "agent": "docking",
    "category": "real_time_schedule",
    "difficulty": "easy",
    "expected_api": "POST /qa with question",
    "expected_answer_type": "schedule",
    "tables_involved": ["dock_assignments", "dock_doors"]
  }
]

CATEGORIES:
- SQL: aggregation, ranking, comparison, join, filtering, time_series, kpi
- Docking: real_time_schedule, door_status, analysis, optimization

DATABASE SCHEMA:
[NOW PASTE CONTENTS OF schema_for_llm.txt HERE]

Generate exactly 25 questions following the format above.
```

**Then**:
1. Copy ALL contents of `schema_for_llm.txt`
2. Paste where it says `[NOW PASTE CONTENTS...]`
3. Hit Enter
4. Copy the JSON output
5. Save as `test_questions_answers.json`

---

### Step 3: Validate Generated Queries

```bash
python3 validate_test_queries.py
```

**What it does**:
- Runs every SQL query against the database
- Checks for syntax errors
- Verifies tables/columns exist
- Shows which queries work and which don't
- Suggests fixes for broken queries

**Example output**:
```
[Test 1] What is the total quantity of batteries in stock?
SQL: SELECT SUM(quantity_in_stock) FROM components WHERE...
✅ Valid - Returns 1 row(s)
   Sample: (15000,)

[Test 5] Show average delivery time
SQL: SELECT AVG(JULIANDAY(delivery_date) - JULIANDAY...
❌ Error: no such column: delivery_date
   💡 Suggested fix: Check column name spelling
```

---

### Step 4: Fix Any Errors

If some queries fail:
1. Check the error messages from `validate_test_queries.py`
2. Fix the SQL in `test_questions_answers.json`
3. Run `python3 validate_test_queries.py` again
4. Repeat until all queries pass

**Common fixes**:
- Table names: Use exact case from schema
- Column names: Check spelling in `schema_for_llm.txt`
- String comparisons: Use `LOWER()` for case-insensitive matching
- Dates: Use `datetime()` function in SQLite

---

### Step 5: Run Full Test Suite

Once all queries validate:

```bash
# Test the orchestrator with your questions
python3 test_orchestrator_metrics.py
```

This will measure all 5 metrics using your generated test questions.

---

## 📁 Files Created

| File | Purpose | Size |
|------|---------|------|
| `extract_schema.py` | Extract DB schema to file | ~100 lines |
| `schema_for_llm.txt` | **Schema for ChatGPT** | ~600 lines |
| `validate_test_queries.py` | Test SQL queries work | ~150 lines |
| `test_questions_answers.json` | **Your test dataset** (create this) | ~500 lines |

---

## 🎨 Example Questions to Generate

### SQL Agent (60% of questions)

**Easy (6 questions):**
- "What is the total inventory value?"
- "How many suppliers are from China?"
- "List all components below safety stock"

**Medium (6 questions):**
- "What's the average delivery time by supplier?"
- "Which warehouses have the highest battery inventory?"
- "Compare component costs across manufacturers"

**Hard (3 questions):**
- "Calculate on-time delivery rate by supplier in last 90 days"
- "Find components with highest stockout risk (demand vs inventory)"
- "Show production schedule bottlenecks by line and component"

### Docking Agent (40% of questions)

**Easy (4 questions):**
- "What is the schedule at Fremont CA?"
- "Which doors are available now?"
- "When is the next truck arriving?"

**Medium (4 questions):**
- "Why was door 5 reassigned today?"
- "Show utilization rate for Austin doors"
- "How many trucks scheduled tomorrow?"

**Hard (2 questions):**
- "Analyze delay patterns across all locations last week"
- "What caused the bottleneck at Shanghai yesterday?"

---

## 💡 Tips for Better Questions

### For SQL Questions:
✅ **Do**:
- Use exact table/column names from schema
- Include WHERE clauses for filtering
- Use JOINs for multi-table queries
- Add GROUP BY for aggregations

❌ **Don't**:
- Use ambiguous column names without table prefix
- Assume column names (check schema!)
- Forget single quotes around strings
- Use invalid SQLite functions

### For Docking Questions:
✅ **Do**:
- Reference specific locations (Fremont CA, Austin TX, etc.)
- Ask about schedules, doors, assignments
- Use operational language (assign, optimize, status)

❌ **Don't**:
- Ask analytical questions (those are SQL agent)
- Request historical data (use SQL agent)
- Calculate aggregations (use SQL agent)

---

## 🚀 Quick Commands

```bash
# 1. Extract schema (one time)
python3 extract_schema.py

# 2. View schema
cat schema_for_llm.txt

# 3. After ChatGPT generates questions, validate
python3 validate_test_queries.py

# 4. Run full test suite
python3 test_orchestrator_metrics.py
```

---

## ✅ Success Checklist

- [ ] Run `python3 extract_schema.py`
- [ ] Copy `schema_for_llm.txt` contents
- [ ] Paste into ChatGPT/Claude with prompt
- [ ] Save generated JSON as `test_questions_answers.json`
- [ ] Run `python3 validate_test_queries.py`
- [ ] Fix any SQL errors
- [ ] All queries validate successfully
- [ ] Run `python3 test_orchestrator_metrics.py`

---

## 🎯 Why This Approach?

**Before** (using Gemini API directly):
- ❌ Burns your API tokens
- ❌ Hits rate limits
- ❌ Costs money if you exceed free tier
- ❌ Need to wait between retries

**After** (manual with ChatGPT):
- ✅ Uses ChatGPT's free tier (no cost)
- ✅ No rate limit issues
- ✅ Can iterate and refine easily
- ✅ More control over question quality
- ✅ Validate locally before testing

**Result**: Generate high-quality test questions for $0 and no rate limit headaches! 🎉

