# Judge AI Evaluation System

Automated evaluation of SQL-of-Thought and Docking agents using two LLM judges.

## Quick Start

### Run Evaluation

```bash
# Test with first 3 questions
npm run evaluate:quick

# Full evaluation (all 25 questions)
npm run evaluate

# Custom limit
npx tsx src/evaluation/run-evaluation.ts 5
```

### Prerequisites

1. **Docking Agent Running** (for questions 16-25):
   ```bash
   cd docking_agent
   uvicorn api:app --reload --port 8088
   ```

2. **Environment**: Set `GOOGLE_API_KEY` in `.env` file

## The Two Judges

### Judge #1: Output Evaluator
- **SQL Correctness** (50%): Compares generated vs expected SQL semantically
- **Results Accuracy** (50%): Validates result structure matches expected type

### Judge #2: Process Evaluator
- **Tool Efficiency** (100%): Analyzes if optimal tools were called
- Checks for unnecessary/missing tools
- Expected: 5 tools for easy, 5-6 for medium, 6-8 for hard

## Output

Results saved to `reports/evaluation-runs/run-{timestamp}/`:

- **`test-results.jsonl`** - Raw agent outputs
- **`evaluation-results.jsonl`** - Combined judge scores

Each line in `evaluation-results.jsonl`:
```json
{
  "test_id": 1,
  "question": "...",
  "agent_used": "sql",
  "difficulty": "easy",
  "expected_sql": "...",
  "generated_sql": "...",
  "judge_output": {
    "sql_correctness_score": 9,
    "results_accuracy_score": 10,
    "overall_score": 9.5,
    "passed": true
  },
  "judge_process": {
    "tool_efficiency_score": 10,
    "tools_called": ["load_schema", "schema_linking", ...],
    "passed": true
  }
}
```

## Scoring

- **Pass**: >= 7/10 on BOTH judges
- **Fail**: < 7/10 on either judge

## Test Questions

25 questions from `test_questions_answers.json`:
- Questions 1-15: SQL agent (easy/medium/hard)
- Questions 16-25: Docking agent (easy/medium/hard)

## Analyzing Results

```bash
# View all results
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | jq .

# Find failed tests
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | \
  jq 'select(.judge_output.passed == false or .judge_process.passed == false)'

# Calculate pass rate
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | \
  jq '[.judge_output.passed and .judge_process.passed] | add / length'
```

## Files

- `evaluation-types.ts` - TypeScript interfaces
- `judge-output-evaluator.ts` - Judge #1 (SQL + results)
- `judge-process-evaluator.ts` - Judge #2 (tool efficiency)
- `run-evaluation.ts` - Main orchestrator
