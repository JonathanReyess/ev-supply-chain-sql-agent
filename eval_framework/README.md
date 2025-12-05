# Evaluation Framework - LLM-as-a-Judge

Automated quality monitoring for the EV Supply Chain SQL Agent using LLM-as-a-judge evaluation.

---

## 🎯 What This Does

Automatically evaluates every agent query using an LLM judge (Gemini) to:
- ✅ Verify intent classification accuracy
- ✅ Score answer quality (1-5)
- ✅ Detect hallucinations
- ✅ Identify issues before users notice
- ✅ Track performance over time

---

## 🚀 Quick Start

### From Root Directory
```bash
# Setup (if not done)
./setup_gemini.sh

# Make some queries to evaluate
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me Fremont doors"}'

# Trigger evaluation
curl -X POST "http://localhost:8088/analysis/eval?limit=50"

# View results
curl http://localhost:8088/analysis/eval/stats
```

### Using Python Directly
```bash
cd ev-supply-chain-sql-agent

# Evaluate recent calls
python -m docking_agent.eval_agent_gemini 50

# Evaluate only errors
python -m docking_agent.eval_agent_gemini 50 --errors-only
```

---

## 🏗️ How It Works

```
1. User makes query → API call logged
   ↓
2. call_logger.py saves to agent_call_logs
   - User question
   - Intent classification  
   - SQL executed
   - Results & latency
   ↓
3. eval_agent_gemini.py fetches unevaluated calls
   ↓
4. Gemini judge evaluates each call
   - Scores on rubric (see below)
   - Returns structured JSON
   ↓
5. Scores saved to agent_call_evals
   ↓
6. Available via API endpoints
```

---

## 📊 Evaluation Rubric

Each query is scored on 6 metrics:

### 1. Intent Correctness (Binary: 0 or 1)
Did the router correctly identify user intent?
- `1` = Correct classification
- `0` = Misclassified

### 2. Answer On-Topic (Binary: 0 or 1)
Does the answer address the question?
- `1` = Directly addresses question
- `0` = Off-topic or irrelevant

### 3. Usefulness Score (Scale: 1-5)
How useful for operations managers?
- `5` = Highly actionable, comprehensive
- `4` = Good, mostly complete
- `3` = Acceptable, some gaps
- `2` = Poor, missing key info
- `1` = Not useful, wrong

### 4. Hallucination Risk (Categorical)
Is the agent inventing information?
- `low` = Well-grounded in data
- `medium` = Some uncertainty
- `high` = Appears fabricated

### 5. Severity (Categorical)
Overall assessment:
- `ok` = No issues
- `minor_issue` = Acceptable but improvable
- `major_issue` = Significant problems

### 6. Feedback Summary (Text)
1-3 sentences explaining the scores.

---

## 🗄️ Database Schema

### agent_call_logs
Every query automatically logged:
```sql
CREATE TABLE agent_call_logs (
    id INTEGER PRIMARY KEY,
    created_utc TEXT NOT NULL,
    user_question TEXT NOT NULL,
    router_intent TEXT,
    slots_json TEXT,
    target_agent TEXT,
    handler_name TEXT,
    sql_or_query TEXT,
    rows_returned INTEGER,
    latency_ms INTEGER,
    error TEXT,
    answer_summary TEXT
);
```

### agent_call_evals
LLM judge evaluations:
```sql
CREATE TABLE agent_call_evals (
    id INTEGER PRIMARY KEY,
    call_id INTEGER NOT NULL,
    created_utc TEXT NOT NULL,
    judge_model TEXT NOT NULL,
    intent_correct INTEGER,
    answer_on_topic INTEGER,
    usefulness_score REAL,
    hallucination_risk TEXT,
    severity TEXT,
    feedback_summary TEXT,
    raw_judge_json TEXT,
    FOREIGN KEY (call_id) REFERENCES agent_call_logs(id)
);
```

---

## 📁 Key Files

### Core Files
| File | Purpose |
|------|---------|
| **core/eval_agent_gemini.py** | Main evaluator using Gemini |
| **core/call_logger.py** | Automatic query logging |
| **core/api_eval_endpoints.py** | API endpoints for evaluation |
| **core/run_migrations.py** | Database setup |

### Test Files
| File | Purpose |
|------|---------|
| **tests/test_eval_pipeline.py** | End-to-end test |
| **tests/test_eval_simple.py** | Simple smoke test |
| **tests/make_logged_calls.py** | Generate test data |
| **tests/show_orchestrator_responses.py** | Debug tool |

### Scripts
| File | Purpose |
|------|---------|
| **scripts/quick_demo.sh** | Demo the system |
| **scripts/make_test_calls.sh** | Generate test queries |
| **scripts/show_eval_results.sh** | View results |
| **scripts/view_eval_data.sql** | SQL queries |

---

## 🧪 Testing the Framework

### Run Complete Test
```bash
cd ev-supply-chain-sql-agent
python eval_framework/tests/test_eval_pipeline.py
```

This will:
1. ✅ Make test API calls
2. ✅ Log them automatically
3. ✅ Trigger evaluation
4. ✅ Display statistics
5. ✅ Show sample results

### Make Test Calls
```bash
# Generate test queries
cd eval_framework/tests
python make_logged_calls.py

# Or use script
cd eval_framework/scripts
./make_test_calls.sh
```

### View Results
```bash
# Via API
curl http://localhost:8088/analysis/eval/stats
curl http://localhost:8088/analysis/eval/recent?limit=10

# Via database
sqlite3 data/ev_supply_chain.db < eval_framework/scripts/view_eval_data.sql

# Via script
./eval_framework/scripts/show_eval_results.sh
```

---

## 📈 API Endpoints

All evaluation endpoints are under `/analysis/eval`:

### POST /analysis/eval
Trigger evaluation of recent unevaluated calls.

**Parameters:**
- `limit` (int): Max calls to evaluate (default: 50)
- `errors_only` (bool): Only evaluate errors (default: false)

**Example:**
```bash
curl -X POST "http://localhost:8088/analysis/eval?limit=50&errors_only=false"
```

**Response:**
```json
{
  "status": "success",
  "calls_evaluated": 50,
  "avg_usefulness_score": 4.3,
  "severity_breakdown": {
    "ok": 45,
    "minor_issue": 4,
    "major_issue": 1
  },
  "elapsed_seconds": 75.5,
  "judge_model": "gemini-2.0-flash-exp"
}
```

### GET /analysis/eval/stats
Get aggregate statistics.

**Example:**
```bash
curl http://localhost:8088/analysis/eval/stats
```

**Response:**
```json
{
  "total_evaluations": 100,
  "avg_usefulness_score": 4.3,
  "avg_latency_ms": 420,
  "intent_accuracy": 0.95,
  "severity_breakdown": {
    "ok": 85,
    "minor_issue": 12,
    "major_issue": 3
  }
}
```

### GET /analysis/eval/recent
Get recent evaluations with details.

**Parameters:**
- `limit` (int): Number of results (default: 10)

**Example:**
```bash
curl "http://localhost:8088/analysis/eval/recent?limit=5"
```

---

## 📊 SQL Queries

### View Recent Logs
```sql
SELECT 
    user_question,
    router_intent,
    latency_ms,
    error
FROM agent_call_logs 
ORDER BY created_utc DESC 
LIMIT 10;
```

### View Evaluations with Feedback
```sql
SELECT 
    l.user_question,
    e.usefulness_score,
    e.severity,
    e.feedback_summary
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
ORDER BY e.created_utc DESC 
LIMIT 10;
```

### Find Problem Calls
```sql
SELECT 
    l.user_question,
    l.router_intent,
    e.severity,
    e.feedback_summary
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
WHERE e.severity = 'major_issue'
ORDER BY e.created_utc DESC;
```

### Average Score by Intent
```sql
SELECT 
    l.router_intent,
    COUNT(*) as count,
    AVG(e.usefulness_score) as avg_usefulness,
    AVG(e.intent_correct) as intent_accuracy
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
GROUP BY l.router_intent
ORDER BY avg_usefulness ASC;
```

### Calls Awaiting Evaluation
```sql
SELECT COUNT(*)
FROM agent_call_logs l
LEFT JOIN agent_call_evals e ON e.call_id = l.id
WHERE e.id IS NULL;
```

---

## 🔧 Configuration

The evaluator uses these environment variables:

```bash
# Required
GOOGLE_API_KEY=your_key_here        # Gemini API key
DB_PATH=../data/ev_supply_chain.db  # Database path

# Optional
JUDGE_MODEL=gemini-2.0-flash-exp    # Judge model to use
```

---

## 🚀 Production Usage

### Automated Evaluation
Set up cron job for continuous monitoring:

```bash
# Evaluate hourly
0 * * * * cd /path/to/repo && python -m docking_agent.eval_agent_gemini 100

# Evaluate every 15 minutes (more frequent)
*/15 * * * * cd /path/to/repo && python -m docking_agent.eval_agent_gemini 50
```

### Alerting on Issues
```bash
#!/bin/bash
# Check for major issues and alert

MAJOR_ISSUES=$(sqlite3 data/ev_supply_chain.db \
  "SELECT COUNT(*) FROM agent_call_evals 
   WHERE severity='major_issue' 
   AND datetime(created_utc) > datetime('now', '-1 hour')")

if [ "$MAJOR_ISSUES" -gt 5 ]; then
    # Send alert (Slack, email, etc.)
    echo "⚠️ High error rate: $MAJOR_ISSUES major issues in last hour"
fi
```

### Monitor Quality Trends
```sql
-- Daily quality scores
SELECT 
    DATE(created_utc) as date,
    COUNT(*) as evaluations,
    AVG(usefulness_score) as avg_quality,
    SUM(CASE WHEN severity='major_issue' THEN 1 ELSE 0 END) as major_issues
FROM agent_call_evals
WHERE created_utc > datetime('now', '-30 days')
GROUP BY DATE(created_utc)
ORDER BY date DESC;
```

---

## 🎓 Understanding the Architecture

### Why LLM-as-a-Judge?

**Traditional Approach:**
- Manual review by engineers
- Slow (5 min/query)
- Expensive ($100+/hour)
- Not scalable

**LLM-as-a-Judge:**
- Automated evaluation
- Fast (1-2 sec/query)
- Cheap (~$0.001/query)
- Scales to millions

### Design Principles

1. **Separation of Concerns**
   - Logging is fast and never fails
   - Evaluation is slow but graceful
   - Database is single source of truth

2. **Async Evaluation**
   - Don't slow down user queries
   - Evaluate in batch later
   - Results available for analysis

3. **Graceful Degradation**
   - If judge fails, system continues
   - Failed evaluations get default scores
   - Never breaks user experience

4. **Comprehensive Context**
   - Judge sees everything: question, intent, SQL, results, errors
   - Can make informed decisions
   - Provides actionable feedback

---

## 🐛 Troubleshooting

### "No unevaluated calls found"
Make some API calls first:
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me doors"}'
```

### "No Gemini API key"
```bash
export GOOGLE_API_KEY=your_key_here
# Or add to .env
```

### "Tables don't exist"
```bash
python -m docking_agent.run_migrations
```

### "Judge returns error"
Check:
1. API key is valid
2. Rate limits not exceeded (1500 RPM free tier)
3. Network connectivity

Enable debug:
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

---

## 💰 Cost Analysis

### Gemini Pricing
- Free tier: 60 requests/minute
- Paid: ~$0.075 per 1M tokens

### Cost Estimate
- ~500 tokens per evaluation
- $0.0000375 per evaluation
- 1000 calls/day = $0.0375/day = **$1.12/month**

Compare to manual review:
- $100/hour engineer
- 5 min per call = $8.33 per review
- 1000 calls = **$8,330**

**Savings: 99.99%**

---

## 📚 Related Documentation

- **Main README:** `../README.md` - System overview
- **Quick Start:** `../QUICKSTART.md` - Setup guide
- **Docking Agent:** `../docking_agent/README.md` - Agent details

---

## 🎯 Next Steps

1. **Run a test:** `python eval_framework/tests/test_eval_pipeline.py`
2. **Make queries:** Use the API to generate real data
3. **Trigger eval:** `curl -X POST http://localhost:8088/analysis/eval?limit=50`
4. **View results:** `curl http://localhost:8088/analysis/eval/stats`
5. **Set up cron:** Automate evaluation for continuous monitoring

---

**Built for production-grade quality monitoring** 📊✨

