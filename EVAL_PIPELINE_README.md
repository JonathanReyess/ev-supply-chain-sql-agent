## LLM-as-a-Judge Evaluation Pipeline

**Inspired by:** "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" (Zheng et al., NeurIPS 2023)

### Overview

This evaluation pipeline automatically judges the quality of agent responses using a judge LLM. Instead of evaluating chatbot conversations (like MT-Bench), we evaluate individual agent calls: `question → routing → handler → SQL/API → answer`.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     AGENT CALL FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User Question                                                  │
│       ↓                                                         │
│  Router (Intent + Slots)                                        │
│       ↓                                                         │
│  Handler (SQL/API Query)                                        │
│       ↓                                                         │
│  Answer                                                         │
│       ↓                                                         │
│  📝 LOG to agent_call_logs                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│                  EVALUATION PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Fetch unevaluated calls from agent_call_logs               │
│       ↓                                                         │
│  2. Send to Judge LLM with rubric-based prompt                 │
│       ↓                                                         │
│  3. Parse JSON evaluation scores:                              │
│      • intent_correct (0/1)                                     │
│      • answer_on_topic (0/1)                                    │
│      • usefulness_score (1-5)                                   │
│      • hallucination_risk (low/medium/high)                     │
│      • severity (ok/minor_issue/major_issue)                    │
│      • feedback_summary (text)                                  │
│       ↓                                                         │
│  4. Save to agent_call_evals                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Database Schema

#### Table 1: `agent_call_logs`

Logs every agent call with full context:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `created_utc` | TEXT | Timestamp (auto) |
| `user_question` | TEXT | Original natural language question |
| `router_intent` | TEXT | Intent from router (e.g., "schedule_query") |
| `slots_json` | TEXT | JSON-serialized slots dict |
| `target_agent` | TEXT | Agent name ("docking" or "sql") |
| `handler_name` | TEXT | Handler function name |
| `sql_or_query` | TEXT | Raw SQL or query signature |
| `rows_returned` | INTEGER | Number of rows/items returned |
| `latency_ms` | INTEGER | Wall-clock latency in milliseconds |
| `error` | TEXT | Exception message if error occurred |
| `answer_summary` | TEXT | Short text form of answer |

#### Table 2: `agent_call_evals`

Stores judge LLM evaluations:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `call_id` | INTEGER | References agent_call_logs.id |
| `created_utc` | TEXT | Evaluation timestamp |
| `judge_model` | TEXT | Model name (e.g., "gpt-4o-mini") |
| `intent_correct` | INTEGER | 1 = yes, 0 = no |
| `answer_on_topic` | INTEGER | 1 = yes, 0 = no |
| `usefulness_score` | REAL | 1-5 scale for ops manager usefulness |
| `hallucination_risk` | TEXT | "low", "medium", or "high" |
| `severity` | TEXT | "ok", "minor_issue", or "major_issue" |
| `feedback_summary` | TEXT | Natural language feedback (1-3 sentences) |
| `raw_judge_json` | TEXT | Full JSON from judge (for debugging) |

### Setup

#### 1. Install Dependencies

```bash
cd docking_agent
pip install -r requirements.txt
pip install openai  # For judge LLM
```

#### 2. Configure Environment

Add to your `.env` file:

```bash
# OpenAI API key for judge LLM
OPENAI_API_KEY=your_api_key_here

# Database path
DB_PATH=./data/ev_supply_chain.db
```

#### 3. Run Migrations

```bash
python3 docking_agent/run_migrations.py
```

This creates the `agent_call_logs` and `agent_call_evals` tables.

### Usage

#### Automatic Logging

All calls to `/qa` endpoint are automatically logged. No code changes needed in your application!

#### Trigger Evaluation

**Via API:**

```bash
curl -X POST "http://localhost:8088/analysis/eval?limit=50&errors_only=false" \
  -H "Content-Type: application/json"
```

**Via Python:**

```python
from docking_agent import eval_agent

result = eval_agent.run_evaluation(
    limit=50,
    errors_only=False,
    since_hours=24,
    judge_model="gpt-4o-mini"
)

print(result)
```

**Via CLI:**

```bash
cd docking_agent
python3 eval_agent.py 50  # Evaluate last 50 calls
python3 eval_agent.py 50 --errors-only  # Only evaluate errors
```

#### View Statistics

```bash
curl "http://localhost:8088/analysis/eval/stats"
```

Returns:
- Total calls logged
- Calls with errors
- Total evaluations
- Average usefulness score
- Intent correctness rate
- Answer on-topic rate
- Severity breakdown
- Hallucination risk distribution

#### View Recent Evaluations

```bash
curl "http://localhost:8088/analysis/eval/recent?limit=10"
```

Returns detailed evaluations with:
- Original question
- Intent and handler
- Answer summary
- All evaluation scores
- Judge feedback

### API Endpoints

#### `POST /analysis/eval`

Trigger evaluation on recent unevaluated calls.

**Parameters:**
- `limit` (int, default: 50): Max number of calls to evaluate
- `errors_only` (bool, default: false): Only evaluate calls with errors
- `since_hours` (int, optional): Only evaluate calls from last N hours
- `judge_model` (str, default: "gpt-4o-mini"): LLM model for judging

**Response:**
```json
{
  "status": "success",
  "calls_evaluated": 45,
  "calls_failed": 0,
  "severity_breakdown": {
    "ok": 38,
    "minor_issue": 5,
    "major_issue": 2
  },
  "avg_usefulness_score": 4.2,
  "elapsed_seconds": 23.5,
  "judge_model": "gpt-4o-mini"
}
```

#### `GET /analysis/eval/stats`

Get aggregate evaluation statistics.

**Parameters:**
- `since_hours` (int, optional): Stats from last N hours

**Response:**
```json
{
  "status": "success",
  "stats": {
    "total_calls": 150,
    "calls_with_errors": 5,
    "total_evaluations": 145,
    "avg_usefulness_score": 4.3,
    "intent_correct_pct": 94.5,
    "answer_on_topic_pct": 97.2,
    "severity_breakdown": {
      "ok": 130,
      "minor_issue": 12,
      "major_issue": 3
    },
    "hallucination_distribution": {
      "low": 140,
      "medium": 4,
      "high": 1
    }
  },
  "time_range": "all time"
}
```

#### `GET /analysis/eval/recent`

Get recent evaluations with full details.

**Parameters:**
- `limit` (int, default: 10): Number of evaluations to return
- `severity` (str, optional): Filter by severity (ok|minor_issue|major_issue)

**Response:**
```json
{
  "status": "success",
  "count": 10,
  "evaluations": [
    {
      "call_id": 123,
      "question": "How many inbound at Shanghai?",
      "intent": "count_schedule",
      "handler": "handle_count_schedule",
      "latency_ms": 145,
      "had_error": false,
      "answer_summary": "Count: 5",
      "evaluation": {
        "intent_correct": true,
        "answer_on_topic": true,
        "usefulness_score": 5.0,
        "hallucination_risk": "low",
        "severity": "ok",
        "feedback": "Perfect response. Intent correctly identified, answer directly addresses the question with accurate count.",
        "evaluated_at": "2025-01-15 14:30:00",
        "judge_model": "gpt-4o-mini"
      }
    }
  ]
}
```

### Evaluation Rubric

The judge LLM evaluates each call using this rubric (from the prompt):

#### Intent Correctness
- **1** = Router correctly identified the user's intent
- **0** = Router misclassified the intent

#### Answer On-Topic
- **1** = Answer directly addresses the user's question
- **0** = Answer is off-topic or irrelevant

#### Usefulness Score (1-5)
- **5** = Highly actionable, comprehensive, directly answers the question
- **4** = Good response, mostly complete
- **3** = Acceptable, some gaps or unclear elements
- **2** = Poor, missing key information or partially wrong
- **1** = Not useful, wrong answer or system error

#### Hallucination Risk
- **low** = Answer is well-grounded in data
- **medium** = Some uncertainty or potential extrapolation
- **high** = Answer appears to contain fabricated information

#### Severity
- **ok** = No issues, good response
- **minor_issue** = Small problems but generally acceptable
- **major_issue** = Significant problems requiring attention

### Testing

Run the complete test pipeline:

```bash
# Start the API server
cd docking_agent
uvicorn api:app --reload --port 8088

# In another terminal, run the test
python3 test_eval_pipeline.py
```

This will:
1. Run migrations
2. Make 8 test API calls
3. Trigger evaluation
4. Display statistics and recent evaluations

### Monitoring & Dashboards

The evaluation data can be used for:

1. **Quality Monitoring**: Track usefulness scores over time
2. **Error Analysis**: Focus on calls with `severity="major_issue"`
3. **Intent Accuracy**: Monitor `intent_correct_pct`
4. **Hallucination Detection**: Flag high-risk responses
5. **Performance Metrics**: Correlate latency with quality

Example queries:

```sql
-- Find worst-performing intents
SELECT 
  l.router_intent,
  AVG(e.usefulness_score) as avg_score,
  COUNT(*) as count
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
GROUP BY l.router_intent
ORDER BY avg_score ASC;

-- Find high hallucination risk calls
SELECT 
  l.user_question,
  l.answer_summary,
  e.hallucination_risk,
  e.feedback_summary
FROM agent_call_evals e
JOIN agent_call_logs l ON l.id = e.call_id
WHERE e.hallucination_risk = 'high';

-- Track quality over time
SELECT 
  DATE(e.created_utc) as date,
  AVG(e.usefulness_score) as avg_score,
  COUNT(*) as evaluations
FROM agent_call_evals e
GROUP BY DATE(e.created_utc)
ORDER BY date DESC;
```

### Future Enhancements

Inspired by the MT-Bench paper, potential improvements:

1. **Bias Mitigation**:
   - Randomize response order in multi-response scenarios
   - Normalize for verbosity bias
   - Use different judge models for cross-validation

2. **Reflexion-Style Improvements**:
   - Feed low-scoring evaluations back to improve prompts
   - Automatically retry failed calls with adjusted parameters
   - Learn from high-scoring patterns

3. **Multi-Turn Evaluation**:
   - Evaluate conversation sequences
   - Track context retention across turns

4. **Human-in-the-Loop**:
   - Flag uncertain evaluations for human review
   - Compare human vs. LLM judge agreement
   - Fine-tune rubric based on human feedback

5. **A/B Testing**:
   - Compare different router strategies
   - Test prompt variations
   - Measure impact of code changes on quality

### References

- **Paper**: Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023
- **MT-Bench**: https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge
- **Chatbot Arena**: https://chat.lmsys.org/

### Troubleshooting

**"OpenAI package not installed"**
```bash
pip install openai
```

**"Tables don't exist"**
```bash
python3 docking_agent/run_migrations.py
```

**"No unevaluated calls found"**
- Make some API calls first: `curl -X POST http://localhost:8088/qa -d '{"question":"test"}'`
- Check logs table: `sqlite3 data/ev_supply_chain.db "SELECT COUNT(*) FROM agent_call_logs"`

**"Evaluation taking too long"**
- Reduce `limit` parameter
- Use faster judge model (e.g., "gpt-3.5-turbo")
- Increase `delay_between_calls` to avoid rate limits

**"High API costs"**
- Use `gpt-4o-mini` instead of `gpt-4` (much cheaper)
- Evaluate only errors: `errors_only=true`
- Reduce evaluation frequency
- Sample calls instead of evaluating all

### License

This implementation follows the MIT license of the parent repository.

