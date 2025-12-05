# EV Supply Chain SQL Agent

**Natural language interface for supply chain operations with automated quality monitoring.**

Built for Tesla operations teams to query supply chain data using plain English, powered by Google Gemini with LLM-as-a-Judge evaluation.

---

## 🚀 Quick Start

Get started in 5 minutes - see **[QUICKSTART.md](QUICKSTART.md)**

```bash
# Automated setup
./setup_gemini.sh

# Manual setup
cp .env.example .env
# Add your Gemini API key to .env
export $(cat .env | xargs)
uvicorn docking_agent.api:app --reload --port 8088
```

---

## ✨ Key Features

### 1. Natural Language Queries
Ask questions in plain English about your supply chain:
- "What's the door schedule at Fremont?"
- "How many inbound trucks at Shanghai?"
- "Why was door 4 reassigned?"
- "What's the earliest ETA for batteries?"

### 2. LLM-as-a-Judge Evaluation
Automatic quality monitoring for every query:
- **Intent accuracy** - Did the system understand correctly?
- **Answer quality** - Scored 1-5 for usefulness
- **Hallucination detection** - Flags fabricated information
- **Production monitoring** - Track performance over time

### 3. Intelligent Routing
- Intent classification using Gemini LLM
- Entity extraction (locations, doors, dates, components)
- Context-aware query handling
- Optimized SQL execution

### 4. Event Tracking
- Complete audit trail of all operations
- Reassignment reasons and context
- ETA changes and priority shifts
- Provenance for every decision

---

## 🏗️ Architecture

```
User Question
    ↓
[LLM Router] ← Gemini classifies intent & extracts entities
    ↓
[Query Handler] ← Pre-written optimized SQL
    ↓
[Database] ← SQLite with supply chain data
    ↓
[Response Formatter] ← Structured JSON answer
    ↓
[Call Logger] ← Log everything for evaluation
    ↓
[LLM Judge] ← Gemini evaluates quality
    ↓
[Dashboard/Stats] ← Monitor performance
```

**Key Design Principle**: We use **intent routing**, not text-to-SQL. This provides:
- ✅ Predictable, optimized queries
- ✅ Better security (no SQL injection)
- ✅ Easier debugging and maintenance
- ✅ Lower latency and cost

---

## 📊 Database Schema

The system includes comprehensive supply chain data:

**Docking Operations:**
- `dock_doors` - Physical dock door locations
- `dock_assignments` - Truck/load assignments  
- `dock_events` - Event provenance with reasons

**Supply Chain:**
- `suppliers` - Supplier information
- `components` - Component catalog
- `inventory` - Stock levels by warehouse
- `purchase_orders` - Procurement orders
- `inbound_trucks` - Incoming shipments
- `outbound_loads` - Outgoing shipments

**Evaluation:**
- `agent_call_logs` - Every query logged
- `agent_call_evals` - LLM judge evaluations

---

## 🎯 Supported Query Types

### Door Schedule Queries
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the door schedule at Fremont?"}'
```

### Count Queries
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "How many inbound trucks at Shanghai?"}'
```

### Event Analysis
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Why was door FCX-D10 reassigned?"}'
```

### Component Queries
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Whats the earliest ETA for batteries?"}'
```

---

## 📈 Evaluation & Monitoring

### Trigger Evaluation
Evaluate recent agent calls using Gemini as judge:

```bash
# Via API
curl -X POST "http://localhost:8088/analysis/eval?limit=50"

# Via command line
python -m docking_agent.eval_agent_gemini 50
```

### View Statistics
```bash
curl http://localhost:8088/analysis/eval/stats
```

Returns:
```json
{
  "total_evaluations": 100,
  "avg_usefulness_score": 4.3,
  "severity_breakdown": {
    "ok": 85,
    "minor_issue": 12,
    "major_issue": 3
  },
  "avg_latency_ms": 420
}
```

### Evaluation Rubric

Every query is scored on:
1. **Intent Correctness** (0 or 1) - Router accuracy
2. **Answer On-Topic** (0 or 1) - Relevance  
3. **Usefulness** (1-5) - How helpful for ops managers
4. **Hallucination Risk** (low/medium/high) - Data accuracy
5. **Severity** (ok/minor_issue/major_issue) - Overall quality
6. **Feedback** - Natural language explanation

---

## 🔧 Configuration

### Environment Variables

Create `.env` from `.env.example`:

```bash
# Required
GOOGLE_API_KEY=your_gemini_api_key_here
LLM_PROVIDER=gemini
USE_LLM_ROUTER=true

# Optional
GEMINI_MODEL=gemini-2.0-flash-exp
DB_PATH=./data/ev_supply_chain.db
USE_ADVANCED_NLP=true
DEBUG_LLM_ROUTER=false
```

### Get Gemini API Key
1. Visit https://makersuite.google.com/app/apikey
2. Create new API key
3. Add to `.env` file

---

## 📁 Project Structure

```
ev-supply-chain-sql-agent/
├── docking_agent/           # Main application
│   ├── api.py              # FastAPI endpoints (/qa, /analysis/*)
│   ├── llm_router.py       # Intent classification with Gemini
│   ├── orchestrator.py     # Multi-agent coordination
│   ├── call_logger.py      # Automatic logging
│   ├── eval_agent_gemini.py # LLM-as-a-judge evaluator
│   ├── query_handlers.py   # Pre-written SQL handlers
│   ├── migrations/         # Database schema
│   └── requirements.txt
├── data/
│   └── ev_supply_chain.db  # SQLite database
├── frontend/
│   ├── index.html          # Web UI
│   └── app.js              # Frontend logic
├── .env.example            # Configuration template
├── setup_gemini.sh         # Automated setup script
├── generate_data.py        # Database generator
├── README.md               # This file
└── QUICKSTART.md           # 5-minute setup guide
```

---

## 🧪 Testing

### Run Test Suite
```bash
cd docking_agent
pytest test_advanced.py -v
```

### Test Gemini Setup
```bash
python test_gemini_setup.py
```

### Manual Testing
```bash
# Start server
uvicorn docking_agent.api:app --reload --port 8088

# In another terminal
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me Fremont doors"}'
```

---

## 🌐 Frontend

Open `frontend/index.html` in a browser for a web interface:
- Visual query builder
- Real-time results
- Chart generation
- Export to CSV

Make sure the API is running on port 8088.

---

## 📊 Performance

| Metric | Value |
|--------|-------|
| Query Latency | <100ms (SQL only) |
| LLM Latency | 200-400ms |
| Intent Accuracy | 94%+ |
| Gemini Cost | ~$0.075 per 1M tokens |
| Rate Limit | 1500 RPM (free tier) |

---

## 🔐 Security Best Practices

1. **Never commit `.env`** - Already in `.gitignore`
2. **Rotate API keys** regularly
3. **Use separate keys** for dev/staging/prod
4. **Monitor usage** at Google Cloud Console
5. **Set rate limits** if exposed publicly

---

## 🐛 Troubleshooting

### "No Gemini API key found"
```bash
export GOOGLE_API_KEY=your_key_here
# Or add to .env and: export $(cat .env | xargs)
```

### "Module not found: google.generativeai"
```bash
pip install google-generativeai
```

### "Database not found"
```bash
python -m docking_agent.run_migrations
python generate_data.py
```

### "LLM Router returns 'unknown'"
```bash
export USE_LLM_ROUTER=true
export LLM_PROVIDER=gemini
```

### Poor Intent Classification
- Check model: Should be `gemini-2.0-flash-exp` or newer
- Enable debug: `export DEBUG_LLM_ROUTER=true`
- Review logs in terminal

---

## 🚀 Production Deployment

### Automated Evaluation
Set up cron job for continuous monitoring:

```bash
# Evaluate hourly
0 * * * * cd /path/to/repo && python -m docking_agent.eval_agent_gemini 100
```

### API Rate Limiting
Add middleware in `api.py`:

```python
from slowapi import Limiter
limiter = Limiter(key_func=lambda: "global")
app.state.limiter = limiter
```

### Database Backup
```bash
# Backup SQLite
sqlite3 data/ev_supply_chain.db ".backup data/backup.db"
```

### Monitoring
```bash
# Check recent errors
curl http://localhost:8088/analysis/eval/recent?limit=10 | \
  jq '.[] | select(.severity=="major_issue")'
```

---

## 📚 API Reference

### Core Endpoints

**POST /qa** - Ask a question
```json
{
  "question": "What's happening at Shanghai?"
}
```

**POST /analysis/eval** - Trigger evaluation
```
?limit=50&errors_only=false
```

**GET /analysis/eval/stats** - Get statistics
```json
{
  "total_evaluations": 100,
  "avg_usefulness_score": 4.3,
  "severity_breakdown": {...}
}
```

**GET /analysis/eval/recent** - Recent evaluations
```
?limit=10
```

**GET /docs** - Interactive API documentation (Swagger UI)

---

## 🎓 How It Works

### 1. Intent Classification
User asks: *"How many trucks at Shanghai?"*

Gemini extracts:
```json
{
  "intent": "count_schedule",
  "slots": {
    "location": "Shanghai",
    "direction": "inbound"
  }
}
```

### 2. Query Handler
Routes to `handle_count_schedule()` which executes:
```sql
SELECT COUNT(*) 
FROM dock_assignments 
WHERE location LIKE '%Shanghai%'
  AND direction = 'inbound'
  AND status = 'active'
```

### 3. Response
```json
{
  "answer": "There are 12 inbound trucks at Shanghai",
  "count": 12,
  "metadata": {
    "latency_ms": 85,
    "rows_returned": 1
  }
}
```

### 4. Logging
Automatically logged to `agent_call_logs` table.

### 5. Evaluation (Async)
LLM judge reviews and scores:
```json
{
  "intent_correct": 1,
  "answer_on_topic": 1,
  "usefulness_score": 4.5,
  "hallucination_risk": "low",
  "severity": "ok",
  "feedback": "Excellent response with accurate count."
}
```

---

## 🤝 Contributing

This is an internal Tesla project. For changes:

1. Create feature branch
2. Make changes with tests
3. Run test suite
4. Submit PR with description
5. Wait for review

---

## 📞 Support

### Resources
- **Quick Start**: See QUICKSTART.md
- **Gemini API**: https://ai.google.dev/docs
- **API Keys**: https://makersuite.google.com/app/apikey
- **Swagger UI**: http://localhost:8088/docs

### Common Issues
See Troubleshooting section above or check logs:
```bash
# API logs
tail -f logs/api.log

# Debug mode
export DEBUG_LLM_ROUTER=true
```

---

## 📝 License

Internal Tesla project - All rights reserved.

---

**Built with ⚡ for Tesla Supply Chain Operations**
