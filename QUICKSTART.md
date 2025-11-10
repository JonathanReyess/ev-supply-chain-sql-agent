# Quick Start Guide

## Setup (< 5 minutes)

### 1. Install Dependencies

```bash
cd docking_agent
pip install -r requirements.txt
```

### 2. Generate Database

```bash
cd ..
python3 generate_data.py
```

This creates `data/ev_supply_chain.db` with synthetic EV supply chain data.

### 3. Seed Events

```bash
cd docking_agent
python3 seed_events.py
```

This populates 457 dock events with detailed provenance data.

### 4. Configure Environment

Create `docking_agent/.env`:

```bash
DB_PATH=/absolute/path/to/data/ev_supply_chain.db

USE_LLM_ROUTER=true
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.0-flash-exp
LLM_API_KEY=your_api_key_here
LLM_LATENCY_MS=400
```

### 5. Start Server

```bash
cd ..
python3 -m uvicorn docking_agent.api:app --reload --port 8088
```

Server will be available at: http://localhost:8088

### 6. Test Queries

```bash
# Count query
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "How many inbound at Shanghai?"}'

# Schedule query  
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me Fremont CA schedule"}'

# Why query
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Why was door 4 reassigned?"}'

# ETA query
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "When is the next truck arriving at Shanghai?"}'
```

## Run Test Suite

```bash
python3 test_systematic_approach.py
```

This runs 16 comprehensive tests covering all intent types.

## API Documentation

Once running, visit:
- **Interactive docs**: http://localhost:8088/docs
- **OpenAPI spec**: http://localhost:8088/openapi.json

## Architecture

The docking agent uses a systematic approach:

1. **Orchestrator Preprocessing**: Extracts context hints from question
2. **LLM Routing**: 5-step systematic analysis to classify intent
3. **Intent Handler**: Executes pre-written SQL query
4. **Response**: Returns structured JSON with rich context

See [SYSTEMATIC_APPROACH_IMPLEMENTATION.md](SYSTEMATIC_APPROACH_IMPLEMENTATION.md) for details.

## Troubleshooting

### "Unable to open database file"
- Use **absolute path** in `.env` for `DB_PATH`
- Ensure `generate_data.py` was run successfully

### "LLM router disabled"
- Set `USE_LLM_ROUTER=true` in `.env`
- Provide valid `LLM_API_KEY`

### "No events found"
- Run `python3 seed_events.py` from `docking_agent/` directory

## Next Steps

- Read [SYSTEMATIC_APPROACH_IMPLEMENTATION.md](SYSTEMATIC_APPROACH_IMPLEMENTATION.md) for architecture details
- Read [EVENT_INFERENCE_TEST_QUESTIONS.md](EVENT_INFERENCE_TEST_QUESTIONS.md) for 128 test questions
- Read [TECHNICAL_CHANGES_SUMMARY.md](TECHNICAL_CHANGES_SUMMARY.md) for implementation details

