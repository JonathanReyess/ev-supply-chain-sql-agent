# EV Supply Chain Docking Agent

A natural language interface for dock scheduling and event analysis in EV supply chain operations.

## Overview

The Docking Agent provides a question-answering API for dock operations, enabling natural language queries about schedules, assignments, ETAs, and event causality. It uses LLM-based intent classification to route questions to optimized database queries.

## Features

- **Natural Language Queries**: Ask questions about dock schedules, assignments, and events
- **Event Inference**: Understand why reassignments happened with detailed context
- **Location-Aware**: Handles queries across multiple locations (Fremont CA, Shanghai, Austin TX, etc.)
- **Pattern Matching Fallbacks**: Always returns relevant answers, even for vague questions
- **Event Provenance**: Track assignment changes, ETA updates, and operational decisions

## Architecture

The system uses **intent routing** (not text-to-SQL):
1. LLM classifies user questions into predefined intents
2. Extracts relevant entities (location, door, truck, etc.)
3. Routes to handler functions with pre-written SQL queries
4. Returns structured JSON responses with context

See [TECHNICAL_CHANGES_SUMMARY.md](TECHNICAL_CHANGES_SUMMARY.md) for detailed architecture.

## Quick Start

### 1. Install Dependencies

```bash
cd docking_agent
pip install -r requirements.txt
```

### 2. Generate Database

```bash
cd ..
python generate_data.py
```

This creates `data/ev_supply_chain.db` with synthetic EV supply chain data.

### 3. Seed Events

```bash
cd docking_agent
python seed_events.py
```

This populates the database with event provenance data (356 events).

### 4. Configure Environment

Create `docking_agent/.env`:

```bash
# LLM Configuration
LLM_PROVIDER=gemini
LLM_API_KEY=your_api_key_here
LLM_MODEL=gemini-2.0-flash-exp
USE_LLM_ROUTER=true

# Database
DB_PATH=../data/ev_supply_chain.db
```

### 5. Start API Server

```bash
cd docking_agent
uvicorn api:app --reload --port 8088
```

### 6. Test Queries

```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the schedule for Shanghai doors?"}'

curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Why was door FCX-D10 reassigned?"}'

curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "How many inbound at Fremont CA?"}'
```

## API Documentation

Once running, visit:
- Interactive docs: http://localhost:8088/docs
- OpenAPI spec: http://localhost:8088/openapi.json

## Supported Query Types

### 1. Schedule Queries
- "What is the door schedule at Fremont?"
- "Show me Shanghai doors"
- "What's happening at dock 4?"

### 2. Reassignment Queries
- "Why was door FCX-D10 reassigned?"
- "What caused the reassignment at door 4?"
- "Tell me about the door change at Berlin"

### 3. ETA Queries
- "What's the earliest ETA for part C00015?"
- "When will the next inbound truck arrive at Shanghai?"

### 4. Count Queries
- "How many inbound at Shanghai?"
- "Count outbound assignments at Fremont"

See [EVENT_INFERENCE_TEST_QUESTIONS.md](EVENT_INFERENCE_TEST_QUESTIONS.md) for 128 test questions.

## Project Structure

```
docking-agent-clean/
├── docking_agent/          # Main application
│   ├── api.py             # FastAPI endpoints
│   ├── llm_router.py      # Intent classification
│   ├── agent.py           # Assignment logic
│   ├── heuristic.py       # Scheduling heuristics
│   ├── solver.py          # Optimization solver
│   ├── seed_events.py     # Event data generator
│   ├── migrations/        # Database schema
│   └── requirements.txt   # Python dependencies
├── data/
│   └── ev_supply_chain.db # SQLite database
├── generate_data.py       # Database generator
└── *.md                   # Documentation
```

## Documentation

- [DOCKING_AGENT_FEATURES.md](DOCKING_AGENT_FEATURES.md) - Feature overview
- [TECHNICAL_CHANGES_SUMMARY.md](TECHNICAL_CHANGES_SUMMARY.md) - Architecture details
- [EVENT_INFERENCE_TEST_QUESTIONS.md](EVENT_INFERENCE_TEST_QUESTIONS.md) - Test questions
- [docking_agent/INTEGRATION_GUIDE.md](docking_agent/INTEGRATION_GUIDE.md) - Integration guide
- [docking_agent/ADVANCED_FEATURES.md](docking_agent/ADVANCED_FEATURES.md) - Advanced features

## Key Technologies

- **FastAPI**: REST API framework
- **SQLite**: Database for supply chain data
- **Google Gemini / OpenAI**: LLM for intent classification
- **Python 3.12+**: Runtime

## Database Schema

The database includes:
- `dock_doors`: Physical dock door locations
- `dock_assignments`: Scheduled truck/load assignments
- `dock_events`: Event provenance (assignments, reassignments, completions)
- `inbound_trucks`: Inbound truck schedules
- `outbound_loads`: Outbound load schedules
- Supply chain tables: `suppliers`, `components`, `inventory`, `purchase_orders`, etc.

See `docking_agent/migrations/` for full schema.

## Event Types

The system tracks:
- **assigned**: Initial door assignments
- **reassigned**: Door changes (with reasons: priority_change, eta_slip, operational_conflict)
- **completed**: Finished operations
- **eta_updated**: Truck ETA changes

Each event includes:
- Timestamp
- Location and door
- Reason code
- Detailed context (JSON)

## Development

### Run Tests

```bash
cd docking_agent
pytest test_advanced.py
```

### Add New Query Type

1. Add intent to `llm_router.py`:
```python
ALLOWED_INTENTS = [..., "new_intent"]
```

2. Update prompt in `llm_router.py`:
```python
USER_TMPL = """...
- new_intent: description (slots: ...)
..."""
```

3. Add handler in `api.py`:
```python
def handle_new_intent(param1, param2):
    conn = _conn()
    cur = conn.cursor()
    rows = cur.execute("SELECT ... FROM ... WHERE ...", (param1, param2)).fetchall()
    return {"answer": ..., "explanation": ...}
```

4. Route in `qa()` endpoint:
```python
elif intent == "new_intent":
    out = handle_new_intent(slots.get("param1"), slots.get("param2"))
```

## Performance

- **Location extraction**: ~95% success rate
- **Query latency**: <100ms (excluding LLM)
- **LLM latency**: 200-400ms
- **Events**: 356 total (10 with priority_delta)

## Troubleshooting

### "No events found for door"
- Run `python seed_events.py` to populate events

### "LLM router disabled"
- Set `USE_LLM_ROUTER=true` in `.env`
- Provide valid `LLM_API_KEY`

### "Unable to open database file"
- Run `python generate_data.py` from project root
- Check `DB_PATH` in `.env`

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Run tests
5. Submit a pull request

## Contact

For questions or issues, please open a GitHub issue.

---

**Built for Tesla supply chain operations** 🚗⚡

