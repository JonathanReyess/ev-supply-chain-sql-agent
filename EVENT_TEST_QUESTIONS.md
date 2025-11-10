# Event-Based QA Test Questions

Test questions specifically for dock events and provenance data from `dock_events` table.

## Reassignment Questions (Primary Event Test)

These query the `dock_events` table for `event_type='reassigned'` records.

### Regex-Matched Format (Exact Pattern)
1. `Why did dock 1 get reassigned?`
2. `Why did dock 2 get reassigned?`
3. `Why did dock 8 get reassigned?`
4. `Why did dock 9 get reassigned?`
5. `Why did dock 10 get reassigned?`
6. `Why did dock 11 get reassigned?`
7. `Why did dock 12 get reassigned?`
8. `Why did dock FCX-D01 get reassigned?`
9. `Why did dock FCX-D02 get reassigned?`
10. `Why did dock FCX-D08 get reassigned?`

### Natural Language (LLM Route)
1. `What caused dock 1 to be reassigned?`
2. `Why was door 2 reassigned?`
3. `Explain why dock 8 changed`
4. `What happened with door 9 that led to reassignment?`
5. `Tell me about the reassignment of dock 10`
6. `What's the reason dock 11 was reassigned?`
7. `Why did door FCX-D01 get moved?`
8. `What prompted the reassignment of dock FCX-D12?`
9. `Can you explain why door 8 was reassigned?`
10. `What's the story behind dock 1's reassignment?`

### Testing Different Reason Codes
Based on your events, you have these reason codes:
- `operational_conflict`
- `eta_slip`
- `priority_change`
- `heuristic_choice`
- `solver_choice`

Try questions about doors that likely have different reason codes:
```bash
# Test multiple doors to see different reason codes
curl -s -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"Why did dock 1 get reassigned?"}' | jq .

curl -s -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"Why did dock 10 get reassigned?"}' | jq .
```

## Edge Cases & Error Handling

### Doors with No Reassignment Events
1. `Why did dock 99 get reassigned?` (should fall back to inference)
2. `Why did dock XYZ-999 get reassigned?` (invalid door)

### Doors with Multiple Reassignments
The system should return the most recent (ORDER BY datetime(ts_utc) DESC LIMIT 1):
1. Query the same door multiple times to verify consistency
2. Check if it always returns the latest reassignment

### Numeric vs Door ID Formats
1. `Why did dock 1 get reassigned?` → matches "FCX-D01"
2. `Why did dock 01 get reassigned?` → matches "FCX-D01"
3. `Why did dock FCX-D01 get reassigned?` → exact match

## Expected Response Format

For successful reassignment queries:
```json
{
  "answer": "Dock 1 was reassigned due to operational conflict at 2025-10-30 22:05:00 UTC.",
  "context": {
    "reason_detail": {
      "previous": {
        "assignment_id": "...",
        "ref_id": "..."
      },
      "new": {
        "assignment_id": "...",
        "ref_id": "..."
      },
      "reason_detail": "Door FCX-D01 reassigned due to operational conflict"
    }
  },
  "explanation": "Derived from dock_events provenance.",
  "router": {
    "source": "regex" | "llm",
    "confidence": 0.95
  }
}
```

For doors with no explicit reassignment events (fallback):
```json
{
  "answer": "Most recent changes suggest operational conflict.",
  "context": {
    "previous": {...},
    "current": {...}
  },
  "explanation": "No explicit event found; inferred from timeline."
}
```

## Quick Test Script

```bash
#!/bin/bash
# Test reassignment questions

echo "=== Testing Reassignment Questions ==="

# Test numeric door formats
for door in 1 2 8 9 10 11 12; do
  echo "Testing door $door:"
  curl -s -X POST http://localhost:8088/qa \
    -H 'Content-Type: application/json' \
    -d "{\"question\":\"Why did dock $door get reassigned?\"}" \
    | jq -r '.answer // .explanation' | head -1
  echo ""
done

# Test door ID formats
for door in FCX-D01 FCX-D08 FCX-D10 FCX-D12; do
  echo "Testing door $door:"
  curl -s -X POST http://localhost:8088/qa \
    -H 'Content-Type: application/json' \
    -d "{\"question\":\"Why did dock $door get reassigned?\"}" \
    | jq -r '.answer // .explanation' | head -1
  echo ""
done

# Test natural language
echo "Testing natural language:"
curl -s -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"What caused dock 1 to be reassigned?"}' \
  | jq -r '.router.source, .answer' | head -2
```

## Verification Queries

Check what events exist in your DB:
```sql
-- Count events by type
SELECT event_type, COUNT(*) FROM dock_events GROUP BY event_type;

-- List reassignment events
SELECT door_id, reason_code, ts_utc 
FROM dock_events 
WHERE event_type='reassigned' 
ORDER BY datetime(ts_utc) DESC 
LIMIT 10;

-- Find doors with multiple reassignments
SELECT door_id, COUNT(*) as reassign_count
FROM dock_events 
WHERE event_type='reassigned'
GROUP BY door_id
HAVING COUNT(*) > 1
ORDER BY reassign_count DESC;
```

## Testing Event Timestamps

The system returns timestamps in UTC. Verify:
1. Timestamps are properly formatted
2. Most recent reassignment is returned (not oldest)
3. Timezone handling is correct

## Testing Reason Detail JSON Parsing

The `reason_detail` field contains JSON. Test that:
1. Valid JSON is parsed correctly
2. Malformed JSON falls back gracefully (already handled in code)
3. Empty/null reason_detail doesn't crash

