# Docking Agent - Natural Language Supply Chain Interface

The core Python application providing natural language query capabilities for EV supply chain operations.

---

## 🚀 Quick Start

### From Root Directory
```bash
cd ev-supply-chain-sql-agent
./setup_gemini.sh  # Automated setup

# Or manual:
export $(cat .env | xargs)
uvicorn docking_agent.api:app --reload --port 8088
```

### From This Directory
```bash
# Install dependencies
pip install -r requirements.txt

# Set environment
export GOOGLE_API_KEY=your_key_here
export DB_PATH=../data/ev_supply_chain.db
export LLM_PROVIDER=gemini
export USE_LLM_ROUTER=true

# Run migrations
python run_migrations.py

# Start server
uvicorn api:app --reload --port 8088
```

**API Running:** http://localhost:8088  
**Docs:** http://localhost:8088/docs

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| **api.py** | FastAPI endpoints (`/qa`, `/analysis/*`) |
| **llm_router.py** | Intent classification with Gemini |
| **orchestrator.py** | Multi-agent coordination |
| **query_handlers.py** | Pre-written SQL query handlers |
| **call_logger.py** | Automatic logging of all queries |
| **eval_agent_gemini.py** | LLM-as-a-judge evaluator |
| **nlp_engine.py** | Advanced NLP processing |
| **requirements.txt** | Python dependencies |

---

## 🎯 Main Endpoints

### Query Endpoint
```bash
POST /qa
{
  "question": "What is the door schedule at Fremont?"
}
```

### Evaluation Endpoints
```bash
POST /analysis/eval?limit=50           # Trigger evaluation
GET  /analysis/eval/stats              # Get statistics  
GET  /analysis/eval/recent?limit=10    # Recent evaluations
```

---

## 🏗️ How It Works

```
1. User Question
   ↓
2. LLM Router (llm_router.py)
   - Classifies intent using Gemini
   - Extracts entities (location, door, etc.)
   ↓
3. Query Handler (query_handlers.py)
   - Pre-written optimized SQL
   - Executes against database
   ↓
4. Response Formatter
   - Structured JSON response
   ↓
5. Call Logger (call_logger.py)
   - Logs everything for evaluation
   ↓
6. LLM Judge (eval_agent_gemini.py)
   - Evaluates quality (async)
```

---

## 🗄️ Database Schema

The database (`../data/ev_supply_chain.db`) includes:

**Docking Tables:**
- `dock_doors` - Physical locations
- `dock_assignments` - Scheduled assignments
- `dock_events` - Event provenance

**Supply Chain Tables:**
- `suppliers`, `components`, `inventory`
- `purchase_orders`, `inbound_trucks`, `outbound_loads`

**Evaluation Tables:**
- `agent_call_logs` - Every query logged
- `agent_call_evals` - LLM judge scores

Apply migrations: `python run_migrations.py`

---

## 🧪 Testing

```bash
# Run test suite
pytest test_advanced.py -v

# Test single query
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me Fremont doors"}'

# Run evaluation
python -m docking_agent.eval_agent_gemini 10

# Check stats
curl http://localhost:8088/analysis/eval/stats
```

---

## 🔧 Configuration

Required environment variables:

```bash
# LLM Configuration
LLM_PROVIDER=gemini              # Use Gemini
USE_LLM_ROUTER=true              # Enable LLM routing
GOOGLE_API_KEY=your_key_here     # Get from makersuite.google.com

# Models
GEMINI_MODEL=gemini-2.0-flash-exp
LLM_MODEL=gemini-2.0-flash-exp

# Database
DB_PATH=../data/ev_supply_chain.db

# Optional
USE_ADVANCED_NLP=true
DEBUG_LLM_ROUTER=false
```

---

## 📝 Adding New Query Types

### 1. Add Intent to Router
Edit `llm_router.py`:
```python
ALLOWED_INTENTS = [
    "door_schedule",
    "count_schedule",
    "your_new_intent"  # Add here
]
```

### 2. Update Prompt
Add to `USER_TMPL` in `llm_router.py`:
```
- your_new_intent: Description here (slots: param1, param2)
```

### 3. Create Handler
Add to `query_handlers.py`:
```python
def handle_your_new_intent(param1, param2):
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT ... FROM ... WHERE ...",
        (param1, param2)
    ).fetchall()
    return {
        "answer": "...",
        "results": rows
    }
```

### 4. Route in API
Add to `api.py` in the `qa()` endpoint:
```python
elif intent == "your_new_intent":
    result = handle_your_new_intent(
        slots.get("param1"),
        slots.get("param2")
    )
```

---

## 🔍 Debugging

### Enable Debug Mode
```bash
export DEBUG_LLM_ROUTER=true
# Restart server
```

### Check Logs
```bash
# View recent queries
sqlite3 ../data/ev_supply_chain.db \
  "SELECT user_question, router_intent, created_utc 
   FROM agent_call_logs 
   ORDER BY created_utc DESC LIMIT 10"

# Check for errors
sqlite3 ../data/ev_supply_chain.db \
  "SELECT * FROM agent_call_logs WHERE error IS NOT NULL"
```

### Common Issues

**"LLM Router disabled"**
```bash
export USE_LLM_ROUTER=true
export LLM_PROVIDER=gemini
```

**"No Gemini API key"**
```bash
export GOOGLE_API_KEY=your_key_here
```

**"Database not found"**
```bash
python run_migrations.py
cd .. && python generate_data.py
```

---

## 📊 Evaluation System

### Automatic Logging
Every query is automatically logged to `agent_call_logs` with:
- User question
- Intent classification
- SQL executed
- Rows returned
- Latency
- Errors (if any)

### LLM-as-a-Judge
Run evaluations using Gemini:

```bash
# Evaluate recent calls
python eval_agent_gemini.py 50

# Or via API
curl -X POST "http://localhost:8088/analysis/eval?limit=50"
```

### Evaluation Metrics
- **Intent Correctness** (0/1)
- **Answer On-Topic** (0/1)
- **Usefulness** (1-5)
- **Hallucination Risk** (low/medium/high)
- **Severity** (ok/minor_issue/major_issue)

See `eval_agent_gemini.py` for details.

---

## 🚀 Production Deployment

### Run with Gunicorn
```bash
pip install gunicorn
gunicorn -w 4 -k uvicorn.workers.UvicornWorker docking_agent.api:app --bind 0.0.0.0:8088
```

### Scheduled Evaluation
Add to crontab for hourly evaluation:
```bash
0 * * * * cd /path/to/repo && python -m docking_agent.eval_agent_gemini 100
```

### Monitor Performance
```bash
# Check recent quality
curl http://localhost:8088/analysis/eval/stats

# Find issues
sqlite3 ../data/ev_supply_chain.db \
  "SELECT * FROM agent_call_evals WHERE severity='major_issue'"
```

---

## 📚 Related Documentation

- **Main README:** `../README.md` - Complete system overview
- **Quick Start:** `../QUICKSTART.md` - 5-minute setup
- **Eval Framework:** `../eval_framework/README.md` - Evaluation details

---

## 🎓 Architecture Notes

### Why Intent Routing (Not Text-to-SQL)?

We use **intent classification + pre-written SQL** instead of generating SQL:

**Benefits:**
- ✅ Predictable, tested queries
- ✅ Better performance (optimized SQL)
- ✅ No SQL injection risk
- ✅ Easier to debug
- ✅ Lower latency

**How It Works:**
1. LLM classifies intent (e.g., "door_schedule")
2. LLM extracts parameters (e.g., location="Fremont")
3. We call pre-written handler with parameters
4. Handler executes optimized SQL
5. Return formatted results

This approach is more reliable for production systems.

---

## 💡 Tips

1. **Use Debug Mode:** Set `DEBUG_LLM_ROUTER=true` to see routing decisions
2. **Monitor Evaluations:** Check stats regularly for quality issues
3. **Optimize Queries:** Pre-written SQL can be tuned for performance
4. **Add Context:** Pass context to orchestrator for multi-turn conversations
5. **Test Thoroughly:** Use `test_advanced.py` before deploying changes

---

## 📞 Need Help?

- **Main docs:** `../README.md`
- **Setup issues:** `../QUICKSTART.md`
- **API docs:** http://localhost:8088/docs
- **Gemini docs:** https://ai.google.dev/docs

---

**Built for Tesla Supply Chain Operations** 🚗⚡

