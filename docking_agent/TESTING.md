# Testing Guide

## Server Status

Check if the server is running:
```bash
lsof -i:8088
```

Start the server (if not running):
```bash
cd /Users/owenchen/Desktop/ev-supply-chain-sql-agent
uvicorn docking_agent.api:app --reload --port 8088
```

## Quick Test Commands

### Test 1: Earliest ETA Query
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "when is the earliest ETA for part C00015 at Fremont CA"}'
```

**Expected**: Should return `"source": "llm"`, intent `earliest_eta_part` with slots.

### Test 2: Door Schedule Query
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "what is the door schedule for Fremont CA"}'
```

**Expected**: Should return `"source": "llm"`, intent `door_schedule`.

### Test 3: Reassignment Query
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "why was dock FRE-D04 reassigned"}'
```

### Test 4: Pretty Print Output
```bash
curl -s -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "when is the earliest ETA for part C00015 at Fremont CA"}' \
  | python3 -m json.tool
```

## Test All At Once

```bash
cd /Users/owenchen/Desktop/ev-supply-chain-sql-agent

echo "--- Test 1: ETA Query ---"
curl -s -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "when is the earliest ETA for part C00015 at Fremont CA"}' \
  | python3 -m json.tool

echo -e "\n--- Test 2: Door Schedule ---"
curl -s -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "what is the door schedule for Fremont CA"}' \
  | python3 -m json.tool

echo -e "\n--- Test 3: General Question (should fail) ---"
curl -s -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "how many motors are there"}' \
  | python3 -m json.tool
```

## Expected Response Format

```json
{
  "answer": null,
  "explanation": "ETA lookup not yet implemented",
  "inputs": {
    "part": "C00015",
    "location": "Fremont CA"
  },
  "router": {
    "source": "llm",
    "confidence": 0.95
  }
}
```

## Verification Checklist

- ✅ **Server running**: Check `lsof -i:8088`
- ✅ **LLM enabled**: Response should show `"source": "llm"` (not `"disabled"` or `"router"`)
- ✅ **Intent routing**: Correct intent extracted (`earliest_eta_part`, `door_schedule`, etc.)
- ✅ **Slots extracted**: `inputs` field contains extracted values
- ✅ **Confidence > 0**: Router confidence should be > 0 for recognized queries

