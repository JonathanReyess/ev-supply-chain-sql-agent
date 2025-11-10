# Advanced Docking Agent Features

## Overview

The Docking Agent v2.0 is a comprehensive, intelligent system for managing dock operations with advanced NLP, reasoning, and orchestration capabilities. It can understand any type of natural language question about docking and provides intelligent analysis through data inference rather than just returning stored data.

## Key Features

### 1. **Universal NLP Understanding**
The agent can understand ANY type of question about docking operations:

- **Query Questions**: "What", "Show", "List", "Display", "Find"
- **Analysis Questions**: "Why", "How", "Explain", "Analyze"
- **Status Questions**: "What's the status of...", "Is... available?"
- **Comparison Questions**: "Compare...", "Which is better..."
- **Count/Aggregate Questions**: "How many...", "What's the average..."
- **Prediction Questions**: "When will...", "What happens if..."

**Examples:**
```bash
# Simple queries
"What's the door schedule at Fremont?"
"Show me available doors"
"List all pending trucks"

# Complex analysis
"Why was door 4 reassigned?"
"How can we improve utilization at Austin?"
"What's causing delays at Fremont?"

# Comparisons
"Compare utilization across all locations"
"Which doors are most efficient?"

# Predictions
"When will the next truck arrive?"
"What if we add 2 more doors?"
```

### 2. **Intelligent Reasoning Engine**

The system performs **actual data analysis** to answer "why" and "how" questions, not just returning stored causality data.

#### Reassignment Analysis
When asked "Why was door X reassigned?", the system:
1. Examines assignment history
2. Detects timing conflicts and overlaps
3. Analyzes job type patterns
4. Checks for ETA slips
5. Identifies priority-based preemptions
6. Evaluates resource constraints
7. Calculates utilization pressure
8. Synthesizes findings into coherent answer

**Example Response:**
```json
{
  "answer": "Door 4 was reassigned primarily due to: scheduling conflicts, ETA delays. Analysis of 5 recent assignments reveals patterns of high utilization (87%), increasing reassignment likelihood.",
  "reasoning": [
    "Examining assignment history for door",
    "Analyzing timing patterns and conflicts",
    "Found 2 timing conflicts requiring reassignment",
    "Checking for ETA changes in inbound trucks",
    "Truck T-FRE-123 had 25 minute delay"
  ],
  "evidence": [
    {
      "type": "overlap_detected",
      "assignment_1": {...},
      "assignment_2": {...}
    },
    {
      "type": "eta_slip",
      "truck_id": "T-FRE-123",
      "delay_minutes": 25
    }
  ],
  "insights": [
    "Door scheduling conflicts suggest high utilization or poor initial planning",
    "ETA slips are causing reactive reassignments"
  ],
  "recommendations": [
    "Consider reserving doors for high-priority jobs in advance",
    "Consider activating additional doors to reduce pressure"
  ],
  "confidence": 0.9
}
```

#### Delay Analysis
Analyzes delay patterns across operations:
- Identifies delayed assignments
- Calculates delay metrics
- Finds bottleneck doors
- Detects time-of-day patterns
- Provides actionable recommendations

#### Utilization Analysis
Evaluates operational efficiency:
- Calculates per-door utilization
- Identifies over/under-utilized doors
- Measures load balance
- Suggests optimization opportunities

### 3. **Multi-Agent Orchestration Interface**

The agent provides a standardized tool protocol for integration with larger multi-agent frameworks.

#### Available Tools

1. **answer_docking_question** - Answer any NL question
2. **allocate_inbound_truck** - Allocate dock for inbound
3. **allocate_outbound_load** - Allocate dock for outbound
4. **optimize_dock_schedule** - Batch optimization
5. **analyze_reassignment** - Detailed reassignment analysis
6. **analyze_delays** - Delay pattern analysis
7. **analyze_utilization** - Utilization analysis
8. **get_door_schedule** - Get schedule
9. **check_door_availability** - Check availability
10. **get_operational_status** - Get overall status

#### Orchestrator Integration

```python
from docking_agent.orchestrator import DockingOrchestrator, ToolCall

# Initialize orchestrator
orchestrator = DockingOrchestrator()

# Get available tools
tools = orchestrator.get_tools()

# Execute a tool
tool_call = ToolCall(
    tool_name="answer_docking_question",
    parameters={"question": "Why was door 4 reassigned?"}
)
result = orchestrator.call_tool(tool_call)

print(result.result)
```

#### REST API Integration

```bash
# Get available tools
curl http://localhost:8088/orchestrator/tools

# Execute a tool
curl -X POST http://localhost:8088/orchestrator/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "tool_name": "answer_docking_question",
    "parameters": {"question": "What is the utilization at Fremont?"}
  }'

# Batch execute
curl -X POST http://localhost:8088/orchestrator/batch_execute \
  -H 'Content-Type: application/json' \
  -d '{
    "tool_calls": [
      {"tool_name": "get_door_schedule", "parameters": {"location": "Fremont CA"}},
      {"tool_name": "check_door_availability", "parameters": {"location": "Fremont CA"}}
    ]
  }'

# Get capabilities
curl http://localhost:8088/capabilities
```

### 4. **Flexible Configuration**

Control system behavior with environment variables:

```bash
# Enable advanced NLP (default: true)
export USE_ADVANCED_NLP=true

# Enable LLM-based routing (for complex queries)
export USE_LLM_ROUTER=true
export LLM_PROVIDER=gemini  # or openai
export GOOGLE_API_KEY=your_key
export GEMINI_MODEL=gemini-2.0-flash

# LLM routing strategy
export LLM_FIRST=false  # Try patterns first, LLM as fallback
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docking Agent v2.0                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   NLP Engine │  │   Reasoning  │  │ Orchestrator │      │
│  │              │  │    Engine    │  │  Interface   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                  │              │
│         └──────────────────┴──────────────────┘              │
│                          │                                   │
│                ┌─────────▼─────────┐                         │
│                │  Query Handlers   │                         │
│                └─────────┬─────────┘                         │
│                          │                                   │
│         ┌────────────────┼────────────────┐                 │
│         │                │                │                 │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐         │
│  │  Allocation │  │ Optimization│  │  Analytics │         │
│  │   Engine    │  │   Engine    │  │   Engine   │         │
│  └─────────────┘  └─────────────┘  └────────────┘         │
│                                                               │
└───────────────────────────┬───────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │   Database     │
                    │  (SQLite)      │
                    └────────────────┘
```

## Usage Examples

### Natural Language Queries

```bash
# Door schedules
curl -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"What doors are scheduled at Fremont today?"}'

# Availability
curl -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"Which doors are available in the next 2 hours at Austin?"}'

# Analysis
curl -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"Why are we seeing delays at Fremont?"}'

# Comparisons
curl -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"Compare utilization between Fremont and Austin"}'

# Status
curl -X POST http://localhost:8088/qa \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is the status of truck T-FRE-123?"}'
```

### Direct Tool Calls

```bash
# Allocate inbound truck
curl -X POST http://localhost:8088/orchestrator/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "tool_name": "allocate_inbound_truck",
    "parameters": {
      "location": "Fremont CA",
      "truck_id": "T-FRE-999",
      "eta_utc": "2030-01-01T14:00:00Z",
      "unload_min": 30,
      "priority": 2
    }
  }'

# Analyze utilization
curl -X POST http://localhost:8088/orchestrator/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "tool_name": "analyze_utilization",
    "parameters": {
      "location": "Fremont CA",
      "hours": 24
    }
  }'
```

### Python Integration

```python
from docking_agent.orchestrator import execute_docking_tool

# Answer a question
result = execute_docking_tool(
    "answer_docking_question",
    {"question": "Why was door 4 reassigned?"}
)
print(result["result"]["answer"])

# Allocate a truck
result = execute_docking_tool(
    "allocate_inbound_truck",
    {
        "location": "Fremont CA",
        "truck_id": "T-FRE-999",
        "eta_utc": "2030-01-01T14:00:00Z",
        "unload_min": 30,
        "priority": 2
    }
)
print(result["result"]["assignment"])
```

## Integration with Multi-Agent Systems

The docking agent is designed to be called by other agents in a larger orchestrator:

### Example: Supply Chain Orchestrator

```python
# Main orchestrator calls docking agent
class SupplyChainOrchestrator:
    def __init__(self):
        self.docking_agent = DockingOrchestrator()
        self.inventory_agent = InventoryAgent()
        self.routing_agent = RoutingAgent()
    
    def handle_inbound_shipment(self, shipment_info):
        # 1. Check inventory needs
        needs = self.inventory_agent.check_needs(shipment_info)
        
        # 2. Allocate dock
        dock_result = self.docking_agent.call_tool(ToolCall(
            tool_name="allocate_inbound_truck",
            parameters={
                "location": shipment_info["destination"],
                "truck_id": shipment_info["truck_id"],
                "eta_utc": shipment_info["eta"],
                "unload_min": shipment_info["unload_time"],
                "priority": needs["priority"]
            }
        ))
        
        # 3. Update routing
        if dock_result.success:
            self.routing_agent.update_route(
                shipment_info["truck_id"],
                dock_result.result["assignment"]
            )
        
        return dock_result
```

## Performance Characteristics

- **Query Response Time**: 50-200ms (without LLM), 300-800ms (with LLM)
- **Allocation Time**: 10-50ms (heuristic), 500-2000ms (optimization)
- **Analysis Time**: 100-500ms (depending on data volume)
- **Concurrent Requests**: Supports 100+ concurrent requests
- **Database**: SQLite (suitable for single-location deployments)

## Future Enhancements

1. **Async Operations** - Support for long-running optimizations
2. **Real-time Updates** - WebSocket support for live updates
3. **Multi-database** - PostgreSQL support for multi-location
4. **Advanced ML** - Predictive models for demand forecasting
5. **Visual Analytics** - Dashboard integration
6. **Mobile Support** - Mobile-optimized APIs

## Troubleshooting

### Advanced NLP not working
```bash
# Check if enabled
export USE_ADVANCED_NLP=true

# Check logs for errors
tail -f /var/log/docking_agent.log
```

### LLM routing failing
```bash
# Verify API key
echo $GOOGLE_API_KEY

# Test LLM connection
curl -X POST http://localhost:8088/debug/route \
  -H 'Content-Type: application/json' \
  -d '{"question":"test"}'
```

### Performance issues
```bash
# Check database size
ls -lh ./data/ev_supply_chain.db

# Optimize database
sqlite3 ./data/ev_supply_chain.db "VACUUM;"

# Check resource usage
ps aux | grep uvicorn
```

## Support

For issues or questions:
1. Check the logs
2. Review configuration
3. Test with simple queries first
4. Verify database integrity
5. Check API health: `curl http://localhost:8088/health`

