"""
Multi-Agent Orchestrator Interface for Docking Agent
Provides standardized tool protocol for integration with larger multi-agent frameworks.
"""
import json
import uuid
from typing import Dict, Any, List, Optional, Literal
from datetime import datetime
from pydantic import BaseModel, Field
from .nlp_engine import AdvancedNLPEngine
from .query_handlers import QueryHandlers
from .agent import propose_inbound, propose_outbound, decide_and_commit, optimize_batch_and_commit
from .schemas import RequestInboundSlot, RequestOutboundSlot


class ToolCall(BaseModel):
    """Standardized tool call format for orchestrators"""
    tool_name: str
    parameters: Dict[str, Any]
    call_id: Optional[str] = Field(default_factory=lambda: f"call-{uuid.uuid4().hex[:8]}")


class ToolResult(BaseModel):
    """Standardized tool result format"""
    call_id: str
    tool_name: str
    success: bool
    result: Any
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class DockingAgentTool(BaseModel):
    """Tool definition for orchestrators"""
    name: str
    description: str
    parameters: Dict[str, Any]
    category: Literal["query", "allocate", "optimize", "analyze"]


class DockingOrchestrator:
    """
    Orchestrator interface for docking agent.
    Provides standardized tools that can be called by other agents or orchestrators.
    """
    
    def __init__(self):
        self.nlp_engine = AdvancedNLPEngine()
        self.query_handlers = QueryHandlers()
        
        # Register available tools
        self.tools = self._register_tools()
    
    def _register_tools(self) -> List[DockingAgentTool]:
        """Register all available tools with their schemas"""
        return [
            # Query tools
            DockingAgentTool(
                name="answer_docking_question",
                description="Answer any natural language question about docking operations, schedules, status, or analysis",
                parameters={
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "Natural language question about docking operations"
                        }
                    },
                    "required": ["question"]
                },
                category="query"
            ),
            
            # Allocation tools
            DockingAgentTool(
                name="allocate_inbound_truck",
                description="Allocate a dock door for an inbound truck",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location (e.g., 'Fremont CA')"},
                        "truck_id": {"type": "string", "description": "Truck identifier"},
                        "eta_utc": {"type": "string", "description": "ETA in ISO format"},
                        "unload_min": {"type": "integer", "description": "Unload duration in minutes"},
                        "priority": {"type": "integer", "description": "Priority level (0-5)", "default": 0},
                        "window_min": {"type": "integer", "description": "Max wait tolerance in minutes", "default": 60}
                    },
                    "required": ["location", "truck_id", "eta_utc", "unload_min"]
                },
                category="allocate"
            ),
            
            DockingAgentTool(
                name="allocate_outbound_load",
                description="Allocate a dock door for an outbound load",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location (e.g., 'Fremont CA')"},
                        "load_id": {"type": "string", "description": "Load identifier"},
                        "cutoff_utc": {"type": "string", "description": "Cutoff time in ISO format"},
                        "load_min": {"type": "integer", "description": "Loading duration in minutes"},
                        "priority": {"type": "integer", "description": "Priority level (0-5)", "default": 0},
                        "window_min": {"type": "integer", "description": "Max wait tolerance in minutes", "default": 60}
                    },
                    "required": ["location", "load_id", "cutoff_utc", "load_min"]
                },
                category="allocate"
            ),
            
            # Optimization tools
            DockingAgentTool(
                name="optimize_dock_schedule",
                description="Optimize dock schedule for a location using batch optimization",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location to optimize"},
                        "horizon_min": {"type": "integer", "description": "Time horizon in minutes", "default": 240},
                        "include_inbound": {"type": "boolean", "description": "Include inbound trucks", "default": True},
                        "include_outbound": {"type": "boolean", "description": "Include outbound loads", "default": True}
                    },
                    "required": ["location"]
                },
                category="optimize"
            ),
            
            # Analysis tools
            DockingAgentTool(
                name="analyze_reassignment",
                description="Analyze why a door was reassigned with detailed reasoning",
                parameters={
                    "type": "object",
                    "properties": {
                        "door_id": {"type": "string", "description": "Door identifier to analyze"}
                    },
                    "required": ["door_id"]
                },
                category="analyze"
            ),
            
            DockingAgentTool(
                name="analyze_delays",
                description="Analyze delay patterns and root causes",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location to analyze (optional)"},
                        "hours": {"type": "integer", "description": "Time window in hours", "default": 24}
                    },
                    "required": []
                },
                category="analyze"
            ),
            
            DockingAgentTool(
                name="analyze_utilization",
                description="Analyze door utilization and efficiency",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location to analyze"},
                        "hours": {"type": "integer", "description": "Time window in hours", "default": 24}
                    },
                    "required": ["location"]
                },
                category="analyze"
            ),
            
            DockingAgentTool(
                name="get_door_schedule",
                description="Get current and upcoming door schedule for a location",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location name"},
                        "hours_ahead": {"type": "integer", "description": "Hours to look ahead", "default": 24}
                    },
                    "required": ["location"]
                },
                category="query"
            ),
            
            DockingAgentTool(
                name="check_door_availability",
                description="Check which doors are available at a location",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location name"},
                        "hours_ahead": {"type": "integer", "description": "Hours to check", "default": 4}
                    },
                    "required": ["location"]
                },
                category="query"
            ),
            
            DockingAgentTool(
                name="get_operational_status",
                description="Get overall operational status and metrics",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "Location name (optional)"}
                    },
                    "required": []
                },
                category="query"
            )
        ]
    
    def get_tools(self) -> List[Dict[str, Any]]:
        """Get list of available tools in standard format"""
        return [tool.model_dump() for tool in self.tools]
    
    def call_tool(self, tool_call: ToolCall) -> ToolResult:
        """Execute a tool call and return standardized result"""
        try:
            if tool_call.tool_name == "answer_docking_question":
                result = self._answer_question(tool_call.parameters)
            elif tool_call.tool_name == "allocate_inbound_truck":
                result = self._allocate_inbound(tool_call.parameters)
            elif tool_call.tool_name == "allocate_outbound_load":
                result = self._allocate_outbound(tool_call.parameters)
            elif tool_call.tool_name == "optimize_dock_schedule":
                result = self._optimize_schedule(tool_call.parameters)
            elif tool_call.tool_name == "analyze_reassignment":
                result = self._analyze_reassignment(tool_call.parameters)
            elif tool_call.tool_name == "analyze_delays":
                result = self._analyze_delays(tool_call.parameters)
            elif tool_call.tool_name == "analyze_utilization":
                result = self._analyze_utilization(tool_call.parameters)
            elif tool_call.tool_name == "get_door_schedule":
                result = self._get_schedule(tool_call.parameters)
            elif tool_call.tool_name == "check_door_availability":
                result = self._check_availability(tool_call.parameters)
            elif tool_call.tool_name == "get_operational_status":
                result = self._get_status(tool_call.parameters)
            else:
                return ToolResult(
                    call_id=tool_call.call_id,
                    tool_name=tool_call.tool_name,
                    success=False,
                    result=None,
                    error=f"Unknown tool: {tool_call.tool_name}"
                )
            
            return ToolResult(
                call_id=tool_call.call_id,
                tool_name=tool_call.tool_name,
                success=True,
                result=result,
                metadata={"execution_time_ms": 0}  # Could add timing
            )
        
        except Exception as e:
            return ToolResult(
                call_id=tool_call.call_id,
                tool_name=tool_call.tool_name,
                success=False,
                result=None,
                error=str(e)
            )
    
    def _answer_question(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Answer natural language question"""
        question = params["question"]
        
        # Parse intent
        intent = self.nlp_engine.parse_query(question)
        
        # Handle query
        result = self.query_handlers.handle_query(intent)
        
        return result
    
    def _allocate_inbound(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Allocate inbound truck"""
        req = RequestInboundSlot(
            task_id=f"task-{uuid.uuid4().hex[:8]}",
            location=params["location"],
            truck_id=params["truck_id"],
            eta_utc=datetime.fromisoformat(params["eta_utc"]),
            unload_min=params["unload_min"],
            priority=params.get("priority", 0),
            window_min=params.get("window_min", 60)
        )
        
        proposal = propose_inbound(req)
        
        if not proposal:
            return {
                "success": False,
                "message": "No feasible dock assignment found",
                "reason": "All doors are occupied or constraints cannot be met"
            }
        
        # Commit the proposal
        decision = decide_and_commit([proposal])
        
        return {
            "success": True,
            "assignment": {
                "door_id": proposal.door_id,
                "start_utc": proposal.start_utc.isoformat(),
                "end_utc": proposal.end_utc.isoformat(),
                "local_cost": proposal.local_cost,
                "lateness_min": proposal.lateness_min
            },
            "decision_id": decision.decision_id,
            "confidence": decision.confidence
        }
    
    def _allocate_outbound(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Allocate outbound load"""
        req = RequestOutboundSlot(
            task_id=f"task-{uuid.uuid4().hex[:8]}",
            location=params["location"],
            load_id=params["load_id"],
            cutoff_utc=datetime.fromisoformat(params["cutoff_utc"]),
            load_min=params["load_min"],
            priority=params.get("priority", 0),
            window_min=params.get("window_min", 60)
        )
        
        proposal = propose_outbound(req)
        
        if not proposal:
            return {
                "success": False,
                "message": "No feasible dock assignment found",
                "reason": "All doors are occupied or constraints cannot be met"
            }
        
        # Commit the proposal
        decision = decide_and_commit([proposal])
        
        return {
            "success": True,
            "assignment": {
                "door_id": proposal.door_id,
                "start_utc": proposal.start_utc.isoformat(),
                "end_utc": proposal.end_utc.isoformat(),
                "local_cost": proposal.local_cost,
                "lateness_min": proposal.lateness_min
            },
            "decision_id": decision.decision_id,
            "confidence": decision.confidence
        }
    
    def _optimize_schedule(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Optimize dock schedule"""
        from .qa import handle_optimize_reallocate
        
        result = handle_optimize_reallocate(
            params["location"],
            params.get("horizon_min", 240)
        )
        
        return result
    
    def _analyze_reassignment(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze reassignment"""
        result = self.query_handlers.reasoning_engine.analyze_reassignment(
            params["door_id"]
        )
        
        return {
            "answer": result.answer,
            "reasoning": result.reasoning,
            "evidence": result.evidence,
            "insights": result.insights,
            "recommendations": result.recommendations,
            "confidence": result.confidence
        }
    
    def _analyze_delays(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze delays"""
        result = self.query_handlers.reasoning_engine.analyze_delays(
            params.get("location"),
            params.get("hours", 24)
        )
        
        return {
            "answer": result.answer,
            "reasoning": result.reasoning,
            "evidence": result.evidence,
            "insights": result.insights,
            "recommendations": result.recommendations,
            "confidence": result.confidence
        }
    
    def _analyze_utilization(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze utilization"""
        result = self.query_handlers.reasoning_engine.analyze_utilization(
            params["location"],
            params.get("hours", 24)
        )
        
        return {
            "answer": result.answer,
            "reasoning": result.reasoning,
            "evidence": result.evidence,
            "insights": result.insights,
            "recommendations": result.recommendations,
            "confidence": result.confidence
        }
    
    def _get_schedule(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get door schedule"""
        from .nlp_engine import QueryIntent
        
        intent = QueryIntent(
            primary_intent="query",
            sub_intent="door_schedule",
            entities={"location": params["location"]},
            confidence=1.0,
            reasoning="Direct tool call"
        )
        
        return self.query_handlers.handle_door_schedule(intent)
    
    def _check_availability(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check availability"""
        from .nlp_engine import QueryIntent
        
        intent = QueryIntent(
            primary_intent="query",
            sub_intent="availability",
            entities={"location": params["location"]},
            confidence=1.0,
            reasoning="Direct tool call"
        )
        
        return self.query_handlers.handle_availability(intent)
    
    def _get_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get operational status"""
        from .nlp_engine import QueryIntent
        
        intent = QueryIntent(
            primary_intent="status",
            sub_intent="general_status",
            entities={"location": params.get("location", "")},
            confidence=1.0,
            reasoning="Direct tool call"
        )
        
        return self.query_handlers.handle_general_status(intent)


# Convenience function for external orchestrators
def get_docking_agent_tools() -> List[Dict[str, Any]]:
    """Get list of available docking agent tools for orchestrator registration"""
    orchestrator = DockingOrchestrator()
    return orchestrator.get_tools()


def execute_docking_tool(tool_name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a docking tool and return result"""
    orchestrator = DockingOrchestrator()
    tool_call = ToolCall(tool_name=tool_name, parameters=parameters)
    result = orchestrator.call_tool(tool_call)
    return result.model_dump()

