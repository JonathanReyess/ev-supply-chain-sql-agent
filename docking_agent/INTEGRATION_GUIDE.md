# Integration Guide for Multi-Agent Orchestrators

This guide explains how to integrate the Docking Agent into a larger multi-agent system or orchestrator.

## Overview

The Docking Agent v2.0 is designed as a **specialized tool-providing agent** that can be called by a main orchestrator or other agents. It provides standardized interfaces for:

1. Natural language question answering
2. Dock allocation and scheduling
3. Batch optimization
4. Intelligent analysis and reasoning

## Integration Patterns

### Pattern 1: Direct Tool Calls (Recommended)

The orchestrator directly calls specific docking tools.

```python
from docking_agent.orchestrator import DockingOrchestrator, ToolCall

class MainOrchestrator:
    def __init__(self):
        self.docking_agent = DockingOrchestrator()
        # ... other agents
    
    def handle_user_request(self, request):
        # Determine which agent to use
        if "dock" in request.lower() or "door" in request.lower():
            return self.route_to_docking(request)
        # ... route to other agents
    
    def route_to_docking(self, request):
        # Call docking agent with natural language
        tool_call = ToolCall(
            tool_name="answer_docking_question",
            parameters={"question": request}
        )
        result = self.docking_agent.call_tool(tool_call)
        return result.result
```

### Pattern 2: REST API Integration

The orchestrator calls the docking agent via REST API.

```python
import requests

class MainOrchestrator:
    def __init__(self):
        self.docking_api = "http://localhost:8088"
    
    def query_docking(self, question):
        response = requests.post(
            f"{self.docking_api}/orchestrator/execute",
            json={
                "tool_name": "answer_docking_question",
                "parameters": {"question": question}
            }
        )
        return response.json()
    
    def allocate_dock(self, truck_info):
        response = requests.post(
            f"{self.docking_api}/orchestrator/execute",
            json={
                "tool_name": "allocate_inbound_truck",
                "parameters": {
                    "location": truck_info["location"],
                    "truck_id": truck_info["id"],
                    "eta_utc": truck_info["eta"],
                    "unload_min": truck_info["unload_time"],
                    "priority": truck_info["priority"]
                }
            }
        )
        return response.json()
```

### Pattern 3: Tool Discovery and Dynamic Calling

The orchestrator discovers available tools and calls them dynamically.

```python
import requests

class DynamicOrchestrator:
    def __init__(self):
        self.docking_api = "http://localhost:8088"
        self.tools = self.discover_tools()
    
    def discover_tools(self):
        """Discover available tools from docking agent"""
        response = requests.get(f"{self.docking_api}/orchestrator/tools")
        return response.json()["tools"]
    
    def find_tool(self, capability):
        """Find tool by capability"""
        for tool in self.tools:
            if capability in tool["description"].lower():
                return tool
        return None
    
    def execute_capability(self, capability, params):
        """Execute a capability"""
        tool = self.find_tool(capability)
        if not tool:
            return {"error": f"No tool found for {capability}"}
        
        response = requests.post(
            f"{self.docking_api}/orchestrator/execute",
            json={
                "tool_name": tool["name"],
                "parameters": params
            }
        )
        return response.json()

# Usage
orchestrator = DynamicOrchestrator()
result = orchestrator.execute_capability(
    "analyze utilization",
    {"location": "Fremont CA", "hours": 24}
)
```

## Complete Integration Example

Here's a complete example of a supply chain orchestrator that uses the docking agent:

```python
from typing import Dict, Any, List
from docking_agent.orchestrator import DockingOrchestrator, ToolCall

class SupplyChainOrchestrator:
    """
    Main orchestrator for supply chain operations.
    Coordinates multiple specialized agents.
    """
    
    def __init__(self):
        # Initialize specialized agents
        self.docking_agent = DockingOrchestrator()
        # self.inventory_agent = InventoryAgent()
        # self.routing_agent = RoutingAgent()
        # self.warehouse_agent = WarehouseAgent()
    
    def handle_inbound_shipment(self, shipment: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle incoming shipment - coordinates multiple agents
        """
        results = {}
        
        # Step 1: Check if we need this shipment (inventory agent)
        # needs = self.inventory_agent.check_needs(shipment["contents"])
        # results["inventory_check"] = needs
        
        # Step 2: Allocate dock (docking agent)
        dock_result = self.docking_agent.call_tool(ToolCall(
            tool_name="allocate_inbound_truck",
            parameters={
                "location": shipment["destination"],
                "truck_id": shipment["truck_id"],
                "eta_utc": shipment["eta"],
                "unload_min": shipment["estimated_unload_time"],
                "priority": shipment.get("priority", 1)
            }
        ))
        results["dock_allocation"] = dock_result.result
        
        # Step 3: If dock allocated, prepare warehouse (warehouse agent)
        if dock_result.success:
            assignment = dock_result.result["assignment"]
            # self.warehouse_agent.prepare_receiving(
            #     shipment["contents"],
            #     assignment["door_id"],
            #     assignment["start_utc"]
            # )
            results["warehouse_prepared"] = True
        
        return results
    
    def optimize_operations(self, location: str) -> Dict[str, Any]:
        """
        Optimize all operations at a location
        """
        results = {}
        
        # Analyze current state
        analysis = self.docking_agent.call_tool(ToolCall(
            tool_name="analyze_utilization",
            parameters={"location": location, "hours": 24}
        ))
        results["analysis"] = analysis.result
        
        # If utilization is high, optimize schedule
        if "high" in analysis.result.get("answer", "").lower():
            optimization = self.docking_agent.call_tool(ToolCall(
                tool_name="optimize_dock_schedule",
                parameters={
                    "location": location,
                    "horizon_min": 240,
                    "include_inbound": True,
                    "include_outbound": True
                }
            ))
            results["optimization"] = optimization.result
        
        return results
    
    def answer_user_question(self, question: str) -> Dict[str, Any]:
        """
        Route user questions to appropriate agent
        """
        question_lower = question.lower()
        
        # Route to docking agent
        if any(kw in question_lower for kw in ["dock", "door", "gate", "unload", "load"]):
            result = self.docking_agent.call_tool(ToolCall(
                tool_name="answer_docking_question",
                parameters={"question": question}
            ))
            return {
                "agent": "docking",
                "answer": result.result.get("answer"),
                "confidence": result.result.get("router", {}).get("confidence", 0)
            }
        
        # Route to other agents...
        # elif any(kw in question_lower for kw in ["inventory", "stock"]):
        #     return self.inventory_agent.answer(question)
        
        return {"error": "Could not route question to appropriate agent"}
    
    def handle_emergency(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle emergency events (e.g., truck breakdown, delay)
        """
        if event["type"] == "truck_delay":
            # Get current assignment
            status = self.docking_agent.call_tool(ToolCall(
                tool_name="answer_docking_question",
                parameters={
                    "question": f"What is the status of truck {event['truck_id']}?"
                }
            ))
            
            # Reallocate if needed
            if status.success:
                # Re-optimize schedule
                reallocation = self.docking_agent.call_tool(ToolCall(
                    tool_name="optimize_dock_schedule",
                    parameters={
                        "location": event["location"],
                        "horizon_min": 120
                    }
                ))
                return {"reallocated": True, "result": reallocation.result}
        
        return {"handled": False}


# Usage Example
if __name__ == "__main__":
    orchestrator = SupplyChainOrchestrator()
    
    # Handle inbound shipment
    shipment = {
        "truck_id": "T-FRE-999",
        "destination": "Fremont CA",
        "eta": "2030-01-01T14:00:00Z",
        "estimated_unload_time": 30,
        "priority": 2,
        "contents": ["batteries", "motors"]
    }
    result = orchestrator.handle_inbound_shipment(shipment)
    print("Shipment handled:", result)
    
    # Answer user question
    question = "Why was door 4 reassigned?"
    answer = orchestrator.answer_user_question(question)
    print("Answer:", answer)
    
    # Optimize operations
    optimization = orchestrator.optimize_operations("Fremont CA")
    print("Optimization:", optimization)
```

## Tool Reference

### Available Tools

#### 1. answer_docking_question
**Purpose**: Answer any natural language question about docking

**Parameters**:
- `question` (string, required): Natural language question

**Returns**: Structured answer with reasoning and confidence

**Example**:
```python
ToolCall(
    tool_name="answer_docking_question",
    parameters={"question": "Why was door 4 reassigned?"}
)
```

#### 2. allocate_inbound_truck
**Purpose**: Allocate a dock door for an inbound truck

**Parameters**:
- `location` (string, required): Location name
- `truck_id` (string, required): Truck identifier
- `eta_utc` (string, required): ETA in ISO format
- `unload_min` (integer, required): Unload duration in minutes
- `priority` (integer, optional): Priority level (0-5)
- `window_min` (integer, optional): Max wait tolerance

**Returns**: Assignment details with door, time, and confidence

#### 3. allocate_outbound_load
**Purpose**: Allocate a dock door for an outbound load

**Parameters**:
- `location` (string, required): Location name
- `load_id` (string, required): Load identifier
- `cutoff_utc` (string, required): Cutoff time in ISO format
- `load_min` (integer, required): Loading duration in minutes
- `priority` (integer, optional): Priority level (0-5)
- `window_min` (integer, optional): Max wait tolerance

**Returns**: Assignment details with door, time, and confidence

#### 4. optimize_dock_schedule
**Purpose**: Optimize dock schedule using batch optimization

**Parameters**:
- `location` (string, required): Location to optimize
- `horizon_min` (integer, optional): Time horizon in minutes (default: 240)
- `include_inbound` (boolean, optional): Include inbound trucks (default: true)
- `include_outbound` (boolean, optional): Include outbound loads (default: true)

**Returns**: Optimized schedule with assignments and confidence

#### 5. analyze_reassignment
**Purpose**: Analyze why a door was reassigned with detailed reasoning

**Parameters**:
- `door_id` (string, required): Door identifier

**Returns**: Analysis with reasoning, evidence, insights, recommendations

#### 6. analyze_delays
**Purpose**: Analyze delay patterns and root causes

**Parameters**:
- `location` (string, optional): Location to analyze
- `hours` (integer, optional): Time window in hours (default: 24)

**Returns**: Delay analysis with patterns and recommendations

#### 7. analyze_utilization
**Purpose**: Analyze door utilization and efficiency

**Parameters**:
- `location` (string, required): Location to analyze
- `hours` (integer, optional): Time window in hours (default: 24)

**Returns**: Utilization analysis with metrics and recommendations

#### 8. get_door_schedule
**Purpose**: Get current and upcoming door schedule

**Parameters**:
- `location` (string, required): Location name
- `hours_ahead` (integer, optional): Hours to look ahead (default: 24)

**Returns**: List of scheduled assignments

#### 9. check_door_availability
**Purpose**: Check which doors are available

**Parameters**:
- `location` (string, required): Location name
- `hours_ahead` (integer, optional): Hours to check (default: 4)

**Returns**: List of doors with availability windows

#### 10. get_operational_status
**Purpose**: Get overall operational status and metrics

**Parameters**:
- `location` (string, optional): Location name

**Returns**: Status metrics (active doors, assignments, pending trucks/loads)

## Error Handling

All tool calls return a `ToolResult` with:
- `success` (boolean): Whether the call succeeded
- `result` (any): The result data
- `error` (string, optional): Error message if failed

```python
result = orchestrator.call_tool(tool_call)

if result.success:
    print("Success:", result.result)
else:
    print("Error:", result.error)
```

## Best Practices

### 1. Use Natural Language for Queries
Let the docking agent handle NLP - don't try to parse questions yourself:

```python
# Good
tool_call = ToolCall(
    tool_name="answer_docking_question",
    parameters={"question": user_input}  # Pass as-is
)

# Bad - don't pre-parse
if "why" in user_input and "reassign" in user_input:
    # Don't do this - let the agent handle it
    ...
```

### 2. Check Success Before Using Results
Always check the success flag:

```python
result = orchestrator.call_tool(tool_call)
if result.success:
    process_result(result.result)
else:
    handle_error(result.error)
```

### 3. Use Batch Operations When Possible
For multiple operations, use batch execution:

```python
results = orchestrator.call_tool(ToolCall(
    tool_name="batch_execute",
    parameters={
        "tool_calls": [
            {"tool_name": "get_door_schedule", "parameters": {...}},
            {"tool_name": "check_door_availability", "parameters": {...}}
        ]
    }
))
```

### 4. Leverage Confidence Scores
Use confidence scores to decide whether to act:

```python
result = orchestrator.call_tool(tool_call)
if result.success:
    confidence = result.result.get("confidence", 0)
    if confidence > 0.8:
        # High confidence - proceed
        proceed_with_action()
    else:
        # Low confidence - ask for confirmation
        request_user_confirmation()
```

### 5. Handle Recommendations
Analysis tools provide recommendations - use them:

```python
analysis = orchestrator.call_tool(ToolCall(
    tool_name="analyze_utilization",
    parameters={"location": "Fremont CA"}
))

if analysis.success:
    recommendations = analysis.result.get("recommendations", [])
    for rec in recommendations:
        # Act on recommendations
        if "activate additional doors" in rec:
            activate_backup_doors()
```

## Testing Your Integration

```python
import unittest
from your_orchestrator import YourOrchestrator

class TestDockingIntegration(unittest.TestCase):
    def setUp(self):
        self.orchestrator = YourOrchestrator()
    
    def test_question_answering(self):
        result = self.orchestrator.answer_user_question(
            "What is the door schedule at Fremont?"
        )
        self.assertIn("answer", result)
    
    def test_allocation(self):
        result = self.orchestrator.allocate_dock({
            "truck_id": "TEST-001",
            "location": "Fremont CA",
            "eta": "2030-01-01T14:00:00Z",
            "unload_time": 30
        })
        self.assertTrue(result.get("success"))
    
    def test_analysis(self):
        result = self.orchestrator.analyze_operations("Fremont CA")
        self.assertIn("analysis", result)

if __name__ == "__main__":
    unittest.main()
```

## Deployment Considerations

### 1. Service Discovery
Register the docking agent with your service discovery:

```yaml
# docker-compose.yml
services:
  docking-agent:
    image: docking-agent:2.0
    ports:
      - "8088:8088"
    environment:
      - DB_PATH=/data/docking.db
      - USE_ADVANCED_NLP=true
    labels:
      - "agent.type=docking"
      - "agent.version=2.0"
```

### 2. Load Balancing
For high availability, run multiple instances:

```yaml
services:
  docking-agent:
    image: docking-agent:2.0
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
```

### 3. Monitoring
Monitor tool call metrics:

```python
from prometheus_client import Counter, Histogram

tool_calls = Counter('docking_tool_calls_total', 'Total tool calls', ['tool_name'])
tool_duration = Histogram('docking_tool_duration_seconds', 'Tool call duration', ['tool_name'])

# In your orchestrator
with tool_duration.labels(tool_name=tool_call.tool_name).time():
    result = self.docking_agent.call_tool(tool_call)
    tool_calls.labels(tool_name=tool_call.tool_name).inc()
```

## Troubleshooting

### Agent Not Responding
```bash
# Check health
curl http://localhost:8088/health

# Check capabilities
curl http://localhost:8088/capabilities
```

### Tool Calls Failing
```python
# Enable debug logging
import logging
logging.basicConfig(level=logging.DEBUG)

# Check tool list
tools = orchestrator.get_tools()
print(f"Available tools: {[t['name'] for t in tools]}")
```

### Low Confidence Results
```python
# Enable LLM routing for better understanding
os.environ["USE_LLM_ROUTER"] = "true"
os.environ["GOOGLE_API_KEY"] = "your_key"
```

## Support

For integration support:
1. Review this guide
2. Check [ADVANCED_FEATURES.md](./ADVANCED_FEATURES.md)
3. Run test suite: `python3 docking_agent/test_advanced.py`
4. Check API docs: http://localhost:8088/docs

