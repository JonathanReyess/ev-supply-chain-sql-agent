# LLM-as-a-Judge Evaluation Pipeline - Quick Start

## 5-Minute Setup

### 1. Install Dependencies

```bash
pip install openai  # Required for judge LLM
```

### 2. Configure API Key

Add to your `.env` file:

```bash
OPENAI_API_KEY=your_api_key_here
```

### 3. Run Migrations

```bash
python3 docking_agent/run_migrations.py
```

### 4. Start API Server

```bash
cd docking_agent
uvicorn api:app --reload --port 8088
```

## Usage

### Make API Calls (Auto-Logged)

```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "How many inbound at Shanghai?"}'
```

Every call is automatically logged to `agent_call_logs` table.

### Trigger Evaluation

```bash
curl -X POST "http://localhost:8088/analysis/eval?limit=50"
```

This sends recent unevaluated calls to the judge LLM and stores scores in `agent_call_evals`.

### View Statistics

```bash
curl http://localhost:8088/analysis/eval/stats | python3 -m json.tool
```

### View Recent Evaluations

```bash
curl "http://localhost:8088/analysis/eval/recent?limit=5" | python3 -m json.tool
```

## Run Complete Test

```bash
python3 test_eval_pipeline.py
```

This will:
1. Run migrations
2. Make 8 test API calls
3. Trigger evaluation
4. Display statistics
5. Show recent evaluations

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/qa` | POST | Make agent call (auto-logged) |
| `/analysis/eval` | POST | Trigger evaluation |
| `/analysis/eval/stats` | GET | View statistics |
| `/analysis/eval/recent` | GET | View recent evaluations |

## Evaluation Rubric

Each call is evaluated on:

1. **Intent Correctness** (0/1) - Did router get it right?
2. **Answer On-Topic** (0/1) - Does answer address question?
3. **Usefulness Score** (1-5) - How useful for ops manager?
4. **Hallucination Risk** (low/medium/high) - Is data fabricated?
5. **Severity** (ok/minor_issue/major_issue) - Overall assessment
6. **Feedback** (text) - Natural language explanation

## Python Integration

```python
from docking_agent import eval_agent

# Run evaluation
result = eval_agent.run_evaluation(
    limit=50,
    errors_only=False,
    judge_model="gpt-4o-mini"
)

print(f"Evaluated: {result['calls_evaluated']}")
print(f"Avg usefulness: {result['avg_usefulness_score']}/5.0")
print(f"Severity: {result['severity_breakdown']}")
```

## SQL Queries

```sql
-- View recent logs
SELECT * FROM agent_call_logs 
ORDER BY created_utc DESC LIMIT 10;

-- View evaluations
SELECT 
  l.user_question,
  e.usefulness_score,
  e.severity,
  e.feedback_summary
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
ORDER BY e.created_utc DESC LIMIT 10;

-- Find problematic calls
SELECT * FROM agent_call_evals
WHERE severity = 'major_issue'
ORDER BY created_utc DESC;

-- Average scores by intent
SELECT 
  l.router_intent,
  AVG(e.usefulness_score) as avg_score,
  COUNT(*) as count
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
GROUP BY l.router_intent
ORDER BY avg_score ASC;
```

## Troubleshooting

**"OpenAI package not installed"**
```bash
pip install openai
```

**"Tables don't exist"**
```bash
python3 docking_agent/run_migrations.py
```

**"No unevaluated calls"**
- Make some API calls first
- Check: `sqlite3 data/ev_supply_chain.db "SELECT COUNT(*) FROM agent_call_logs"`

**"API not responding"**
```bash
cd docking_agent && uvicorn api:app --reload --port 8088
```

## Cost Optimization

- Default model: `gpt-4o-mini` (very cheap)
- Evaluate errors only: `errors_only=true`
- Reduce frequency: evaluate daily instead of real-time
- Sample calls: `limit=10` instead of all

## Next Steps

1. ✅ Read [EVAL_PIPELINE_README.md](EVAL_PIPELINE_README.md) for full documentation
2. ✅ Read [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for technical details
3. ✅ Run `test_eval_pipeline.py` for end-to-end test
4. ✅ View API docs: http://localhost:8088/docs
5. ✅ Build dashboards using evaluation data

## References

- **Paper**: Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023
- **GitHub**: https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge

