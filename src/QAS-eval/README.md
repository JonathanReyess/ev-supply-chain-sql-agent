# QAS Evaluation System

Automated evaluation of SQL-of-Thought and Docking agents using QAS (Query Affinity Score) methodology.

Article: https://www.nature.com/articles/s41598-025-04890-9

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

## QAS Methodology

The QAS (Query Affinity Score) evaluation combines three weighted components:

### Three Evaluation Components

#### 1. Semantic Similarity (40%)
- **LLM-based comparison** of generated vs expected SQL
- Evaluates logical equivalence, not syntax
- Tolerates different approaches (join order, aliases, etc.)
- For docking agent: Based on API call success

#### 2. Execution Similarity (40%)
- **Data-level correctness validation**
- Compares actual results with expected ground-truth data
- Provides partial credit for close matches
- For numbers: Checks value equality with tolerance
- For tables: Compares row count, columns, and sample data

#### 3. Data Type Validity (20%)
- **Flexible type checking with normalization**
- Handles edge cases (e.g., 1x1 DataFrame → number)
- Validates result structure matches expected type
- Compatible types are accepted (parseable strings, etc.)

### Weighted Scoring Formula

```
Final Score = (0.40 × Semantic) + (0.40 × Execution) + (0.20 × Datatype)
```

- All scores are 0.0-1.0
- **Pass threshold**: ≥ 0.70
- **Partial credit**: Scores between 0.0-1.0 based on quality

## Output

Results saved to `reports/evaluation-runs/run-{timestamp}/`:

- **`test-results.jsonl`** - Raw agent outputs
- **`evaluation-results.jsonl`** - QAS scores for each test

Each line in `evaluation-results.jsonl`:
```json
{
  "test_id": 1,
  "question": "...",
  "agent_used": "sql",
  "difficulty": "easy",
  "expected_sql": "...",
  "generated_sql": "...",
  "expected_results": 42,
  "actual_results": 42,
  "qas_evaluation": {
    "semantic_score": 0.95,
    "execution_score": 1.0,
    "datatype_score": 1.0,
    "final_score": 0.97,
    "passed": true,
    "breakdown": {
      "semantic_explanation": "Semantically identical SQL",
      "execution_explanation": "Numeric match: 42 ≈ 42",
      "datatype_explanation": "Valid numeric value"
    }
  }
}
```

## Scoring Examples

### Perfect Score (1.0)
- Semantic: SQL is logically identical
- Execution: Data matches exactly
- Datatype: Correct format
- **Final**: 1.0 ✅ PASS

### Partial Credit (0.75)
- Semantic: Different approach but correct (0.8)
- Execution: Close data match (0.8)
- Datatype: Valid format (1.0)
- **Final**: (0.8×0.4) + (0.8×0.4) + (1.0×0.2) = 0.84 ✅ PASS

### Failed Test (0.45)
- Semantic: Wrong SQL logic (0.3)
- Execution: Incorrect data (0.2)
- Datatype: Valid format (1.0)
- **Final**: (0.3×0.4) + (0.2×0.4) + (1.0×0.2) = 0.40 ❌ FAIL

## Test Questions

25 questions from `test_workflow/test_questions_answers.json`:
- Questions 1-15: SQL agent (easy/medium/hard)
- Questions 16-25: Docking agent (easy/medium/hard)

Each question includes:
- `expected_sql`: For semantic comparison
- `expected_results`: Ground-truth data (when available)
- `expected_answer_type`: For type validation

## Analyzing Results

```bash
# View all results
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | jq .

# Find failed tests
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | \
  jq 'select(.qas_evaluation.passed == false)'

# Calculate pass rate
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | \
  jq '[.qas_evaluation.passed] | add / length'

# Show score breakdown
cat reports/evaluation-runs/run-*/evaluation-results.jsonl | \
  jq '{id: .test_id, final: .qas_evaluation.final_score, semantic: .qas_evaluation.semantic_score, execution: .qas_evaluation.execution_score, type: .qas_evaluation.datatype_score}'
```

## Key Features

### Flexible Type Normalization
Solves the "1x1 DataFrame vs number" issue:
```javascript
// These are all valid for expected_answer_type: "number"
42                          // Raw number ✅
[{count: 42}]              // 1x1 DataFrame ✅
"42"                        // Parseable string ✅
```

### Partial Credit System
Unlike binary pass/fail, QAS gives proportional scores:
- SQL logic perfect but missing ORDER BY → 0.85 (PASS)
- Correct approach but data type mismatch → 0.60 (FAIL, but helpful debugging)
- Wrong SQL entirely → 0.20 (FAIL)

### Data-Level Verification
Validates actual correctness, not just structure:
- Detects when SQL runs but returns wrong values
- Compares table data for multi-row results
- Provides detailed explanations in breakdown

## Files

- `evaluation-types.ts` - TypeScript interfaces
- `semantic-evaluator.ts` - LLM-based SQL comparison
- `execution-evaluator.ts` - Data-level validation
- `datatype-validator.ts` - Flexible type checking
- `qas-evaluator.ts` - Main orchestrator
- `run-evaluation.ts` - Evaluation runner
