# Docking Agent: Feature Summary & Testing Guide

## Overview

The Docking Agent is an LLM-powered subagent designed for Tesla's EV supply chain operations. It provides intelligent routing and querying of dock-related data through natural language questions. The agent can be called by a master orchestrator when dock-specific queries are needed.

**Branch**: `feature/count-schedule-and-broadened-eta`  
**Status**: Ready for testing

---

## Key Features

### 1. **LLM-Powered Intent Routing**
- Uses Gemini/OpenAI/Anthropic to understand natural language questions
- Extracts structured data (parts, locations, doors, job types) from queries
- Routes to appropriate database handlers based on intent

### 2. **Four Supported Intents**

#### `earliest_eta_part`
- **Purpose**: Find earliest inbound truck ETA for a specific part and/or location
- **Flexibility**: Works with:
  - Part + Location: "earliest ETA for part C00015 at Fremont CA"
  - Part only: "earliest ETA for part C00015"
  - Location only: "earliest inbound at Fremont CA"
  - Neither: "earliest inbound" (global earliest)

#### `door_schedule`
- **Purpose**: Retrieve dock door schedules
- **Flexibility**: 
  - Location-specific: "door schedule for Fremont CA"
  - Global: "show me current docking schedule" (top 5 per location)
  - Door-specific: "schedule for door FCX-D12"
  - Assignment ID: "info on ASG-FCX-22128"
  - Reference ID: "status of truck T-FCX-958"

#### `why_reassigned`
- **Purpose**: Explain door reassignment reasons
- **Usage**: "why was dock FRE-D04 reassigned"

#### `count_schedule` ⭐ NEW
- **Purpose**: Count dock assignments matching criteria
- **Parameters**:
  - `location?`: Filter by location (optional)
  - `job_type?`: Filter by inbound/outbound (optional)
  - `horizon_min?`: Time window in minutes (default: 480 = 8 hours)
- **Examples**:
  - "how many inbound at Fremont CA in next 120 minutes"
  - "count of outbound assignments at Austin TX"
  - "how many assignments today"

### 3. **Smart Fallback Behavior**
- When LLM returns "unknown" intent, re-asks with best-effort prompt
- Automatically detects IDs in questions (ASG-*, T-*, L-*, XXX-D##)
- Always returns dock-related answers (never "Unrecognized")

### 4. **Provider-Agnostic API Key Support**
- Single `LLM_API_KEY` environment variable works with any provider
- Supports OpenAI, Anthropic, Gemini, Cohere, Groq
- Falls back to provider-specific keys if generic key not set

---

## Technical Implementation

### Architecture
```
User Question → LLM Router → Intent + Slots → Database Handler → Response
```

### Database Integration
- SQLite database with 16 tables including:
  - `dock_assignments`: Scheduled dock jobs
  - `inbound_trucks`: Incoming shipments
  - `outbound_loads`: Outgoing shipments
  - `dock_doors`: Door configurations
  - `dock_events`: Event history
  - `po_line_items` + `components`: Part tracking

### Key Code Changes (2 files, +142/-38 lines)

**`docking_agent/llm_router.py`**:
- Added `count_schedule` to allowed intents
- Updated prompts to support optional slots (part?, location?)
- Enhanced best-effort routing system

**`docking_agent/api.py`**:
- Broadened `handle_earliest_eta_part()` to handle 4 cases (part+loc, part only, loc only, neither)
- Added `handle_count_schedule()` for counting queries
- Added `handle_global_schedule()` for location-agnostic queries
- Added targeted handlers: `handle_assignment_info()`, `handle_ref_schedule()`, `handle_door_schedule_for_door()`
- Improved fallback logic with ID detection

---

## Testing Guide

### Prerequisites
1. **Database**: Ensure `./data/ev_supply_chain.db` exists (run `python3 generate_data.py`)
2. **Environment**: Set `docking_agent/.env`:
   ```bash
   USE_LLM_ROUTER=true
   LLM_PROVIDER=gemini
   LLM_API_KEY=your_api_key_here
   LLM_MODEL=gemini-2.5-flash
   DB_PATH=./data/ev_supply_chain.db
   ```
3. **Server**: Start the API server:
   ```bash
   uvicorn docking_agent.api:app --reload --port 8088
   ```

### Test Cases

#### 1. Earliest ETA Queries (All Variations)

```bash
# Full specification
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "when is the earliest ETA for part C00015 at Fremont CA"}'

# Part only
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "earliest ETA for part C00015"}'

# Location only
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "earliest inbound at Fremont CA"}'

# Neither (global)
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "earliest inbound"}'
```

**Expected**: Returns ETA timestamp with truck details

---

#### 2. Door Schedule Queries

```bash
# Location-specific
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "what is the door schedule for Fremont CA"}'

# Global (no location)
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "show me current docking schedule"}'

# Door-specific
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "schedule for door FCX-D12"}'

# Assignment ID
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "info on ASG-FCX-22128"}'

# Reference ID (truck)
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "status of truck T-FCX-958"}'
```

**Expected**: Returns array of assignments with door_id, job_type, ref_id, times

---

#### 3. Count Schedule Queries ⭐ NEW

```bash
# Count with all filters
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "how many inbound at Fremont CA in next 120 minutes"}'

# Count by location
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "count of assignments at Austin TX"}'

# Count by job type
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "how many outbound today"}'

# Simple count
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "how many assignments"}'
```

**Expected**: Returns integer count with explanation

---

#### 4. Reassignment Queries

```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "why was dock FRE-D04 reassigned"}'
```

**Expected**: Returns reason code and event details

---

#### 5. Vague/Ambiguous Queries (Tests Fallback)

```bash
# Vague question that should still get dock-related answer
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "earliest docking time"}'

# Should default to global schedule
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "show me dock schedule"}'
```

**Expected**: Returns relevant dock information, not "Unrecognized"

---

### Response Format

All responses follow this structure:

```json
{
  "answer": <result_data>,
  "explanation": "Human-readable explanation",
  "inputs": {
    "extracted_slots": "values"
  },
  "router": {
    "source": "llm" | "llm-fallback" | "disabled",
    "confidence": 0.0-1.0
  }
}
```

**Key Fields**:
- `answer`: The actual data (string, number, array, or object)
- `explanation`: What the answer represents
- `inputs`: Extracted slots from the question
- `router.source`: Indicates LLM was used (`"llm"`) or fallback (`"llm-fallback"`)
- `router.confidence`: LLM's confidence in intent classification

---

## Performance Characteristics

- **Latency**: 200-3000ms depending on LLM provider and query complexity
- **Accuracy**: High confidence (>0.8) for well-formed questions with clear intent
- **Fallback**: Always returns dock-related answer, never "unrecognized"
- **Scalability**: Stateless API, can handle concurrent requests

---

## Integration Points for Master Orchestrator

### API Endpoint
```
POST http://localhost:8088/qa
Content-Type: application/json

{
  "question": "natural language question"
}
```

### When to Call This Agent
- Questions about dock schedules, assignments, or door operations
- ETA queries for incoming shipments
- Counting queries about dock activity
- Reassignment explanations

### Response Handling
- Check `router.source == "llm"` to confirm LLM routing worked
- Use `router.confidence` to determine answer reliability
- `answer` field contains the actual data to return to user

---

## Next Steps

1. **Review**: Test all query types with real Tesla dock scenarios
2. **Tune**: Adjust LLM prompts if intent classification needs improvement
3. **Extend**: Add more intents as needed (e.g., capacity queries, optimization suggestions)
4. **Monitor**: Track LLM latency and accuracy in production

---

## Questions?

For technical details, see:
- `docking_agent/api.py` - API handlers
- `docking_agent/llm_router.py` - LLM routing logic
- `docking_agent/TESTING.md` - Additional test examples

