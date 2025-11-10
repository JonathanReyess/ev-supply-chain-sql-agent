"""
Comprehensive Testing Framework for Advanced Docking Agent
Tests NLP, reasoning, orchestration, and all query types.
"""
import os
import sys
import json
from typing import Dict, Any, List
from datetime import datetime, timedelta

# Set test environment
os.environ["DB_PATH"] = "./data/ev_supply_chain.db"
os.environ["USE_ADVANCED_NLP"] = "true"

from docking_agent.nlp_engine import AdvancedNLPEngine
from docking_agent.reasoning_engine import ReasoningEngine
from docking_agent.query_handlers import QueryHandlers
from docking_agent.orchestrator import DockingOrchestrator, ToolCall
from docking_agent.qa import answer_question


class TestResults:
    """Track test results"""
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []
    
    def record_pass(self, test_name: str):
        self.passed += 1
        print(f"✓ {test_name}")
    
    def record_fail(self, test_name: str, reason: str):
        self.failed += 1
        self.errors.append({"test": test_name, "reason": reason})
        print(f"✗ {test_name}: {reason}")
    
    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*60}")
        print(f"Test Results: {self.passed}/{total} passed")
        if self.errors:
            print(f"\nFailed Tests:")
            for error in self.errors:
                print(f"  - {error['test']}: {error['reason']}")
        print(f"{'='*60}\n")
        return self.failed == 0


def test_nlp_engine(results: TestResults):
    """Test NLP engine with various question types"""
    print("\n=== Testing NLP Engine ===")
    
    nlp = AdvancedNLPEngine()
    
    test_cases = [
        # Query intents
        ("What is the door schedule at Fremont?", "query", "door_schedule"),
        ("Show me available doors at Austin", "query", "availability"),
        ("List all pending trucks", "query", "general_query"),
        ("What's the utilization at Fremont?", "query", "utilization"),
        
        # Analyze intents
        ("Why was door 4 reassigned?", "analyze", "analyze_reassignment"),
        ("How can we improve efficiency?", "analyze", "analyze_general"),
        ("What's causing delays at Fremont?", "analyze", "analyze_delays"),
        ("Explain the bottlenecks", "analyze", "analyze_bottlenecks"),
        
        # Status intents
        ("What's the status of door 5?", "status", "door_status"),
        ("Check truck T-FRE-123 status", "status", "truck_status"),
        
        # Allocate intents
        ("Assign door for truck T-999", "allocate", "allocate_generic"),
        ("Schedule inbound truck", "allocate", "allocate_inbound"),
        
        # Optimize intents
        ("Optimize the schedule at Fremont", "optimize", "optimize_generic"),
        ("Reallocate all doors", "optimize", "optimize_reallocate"),
        
        # Compare intents
        ("Compare Fremont and Austin", "compare", "compare_locations"),
        
        # Count intents
        ("How many doors are active?", "count", "count_operation"),
    ]
    
    for question, expected_primary, expected_sub in test_cases:
        intent = nlp.parse_query(question)
        
        if intent.primary_intent == expected_primary:
            results.record_pass(f"NLP: '{question}' -> {expected_primary}")
        else:
            results.record_fail(
                f"NLP: '{question}'",
                f"Expected {expected_primary}, got {intent.primary_intent}"
            )


def test_reasoning_engine(results: TestResults):
    """Test reasoning engine analysis capabilities"""
    print("\n=== Testing Reasoning Engine ===")
    
    db_path = os.getenv("DB_PATH")
    reasoning = ReasoningEngine(db_path)
    
    # Test reassignment analysis
    try:
        result = reasoning.analyze_reassignment("1")
        if result.answer and len(result.reasoning) > 0:
            results.record_pass("Reasoning: Reassignment analysis")
        else:
            results.record_fail("Reasoning: Reassignment analysis", "Empty result")
    except Exception as e:
        results.record_fail("Reasoning: Reassignment analysis", str(e))
    
    # Test delay analysis
    try:
        result = reasoning.analyze_delays("Fremont CA", 24)
        if result.answer:
            results.record_pass("Reasoning: Delay analysis")
        else:
            results.record_fail("Reasoning: Delay analysis", "Empty result")
    except Exception as e:
        results.record_fail("Reasoning: Delay analysis", str(e))
    
    # Test utilization analysis
    try:
        result = reasoning.analyze_utilization("Fremont CA", 24)
        if result.answer and len(result.evidence) > 0:
            results.record_pass("Reasoning: Utilization analysis")
        else:
            results.record_fail("Reasoning: Utilization analysis", "Empty result")
    except Exception as e:
        results.record_fail("Reasoning: Utilization analysis", str(e))


def test_query_handlers(results: TestResults):
    """Test comprehensive query handlers"""
    print("\n=== Testing Query Handlers ===")
    
    handlers = QueryHandlers()
    nlp = AdvancedNLPEngine()
    
    test_queries = [
        "What is the door schedule at Fremont CA?",
        "Check door availability at Austin TX",
        "What's the status of door 1?",
        "Compare all locations",
        "How many active doors are there?",
    ]
    
    for query in test_queries:
        try:
            intent = nlp.parse_query(query)
            result = handlers.handle_query(intent)
            
            if "answer" in result or "explanation" in result:
                results.record_pass(f"Handler: '{query}'")
            else:
                results.record_fail(f"Handler: '{query}'", "Invalid response format")
        except Exception as e:
            results.record_fail(f"Handler: '{query}'", str(e))


def test_orchestrator(results: TestResults):
    """Test orchestrator interface"""
    print("\n=== Testing Orchestrator ===")
    
    orchestrator = DockingOrchestrator()
    
    # Test tool registration
    tools = orchestrator.get_tools()
    if len(tools) >= 10:
        results.record_pass("Orchestrator: Tool registration")
    else:
        results.record_fail("Orchestrator: Tool registration", f"Only {len(tools)} tools found")
    
    # Test question answering tool
    try:
        tool_call = ToolCall(
            tool_name="answer_docking_question",
            parameters={"question": "What is the door schedule at Fremont CA?"}
        )
        result = orchestrator.call_tool(tool_call)
        
        if result.success:
            results.record_pass("Orchestrator: Question answering")
        else:
            results.record_fail("Orchestrator: Question answering", result.error or "Unknown error")
    except Exception as e:
        results.record_fail("Orchestrator: Question answering", str(e))
    
    # Test status tool
    try:
        tool_call = ToolCall(
            tool_name="get_operational_status",
            parameters={"location": "Fremont CA"}
        )
        result = orchestrator.call_tool(tool_call)
        
        if result.success:
            results.record_pass("Orchestrator: Status tool")
        else:
            results.record_fail("Orchestrator: Status tool", result.error or "Unknown error")
    except Exception as e:
        results.record_fail("Orchestrator: Status tool", str(e))
    
    # Test analysis tool
    try:
        tool_call = ToolCall(
            tool_name="analyze_utilization",
            parameters={"location": "Fremont CA", "hours": 24}
        )
        result = orchestrator.call_tool(tool_call)
        
        if result.success:
            results.record_pass("Orchestrator: Analysis tool")
        else:
            results.record_fail("Orchestrator: Analysis tool", result.error or "Unknown error")
    except Exception as e:
        results.record_fail("Orchestrator: Analysis tool", str(e))


def test_end_to_end(results: TestResults):
    """Test end-to-end question answering"""
    print("\n=== Testing End-to-End QA ===")
    
    test_questions = [
        # Simple queries
        "What is the door schedule at Fremont?",
        "Show me available doors at Austin",
        "What's the status of door 1?",
        
        # Analysis questions
        "Why was door 4 reassigned?",
        "What's causing delays?",
        "How is utilization at Fremont?",
        
        # Complex questions
        "Compare utilization between locations",
        "How many trucks are waiting?",
        "What doors are most efficient?",
    ]
    
    for question in test_questions:
        try:
            result = answer_question(question)
            
            if "answer" in result or "explanation" in result:
                # Check for router info
                if "router" in result:
                    results.record_pass(f"E2E: '{question}'")
                else:
                    results.record_fail(f"E2E: '{question}'", "Missing router info")
            else:
                results.record_fail(f"E2E: '{question}'", "Invalid response")
        except Exception as e:
            results.record_fail(f"E2E: '{question}'", str(e))


def test_entity_extraction(results: TestResults):
    """Test entity extraction from queries"""
    print("\n=== Testing Entity Extraction ===")
    
    nlp = AdvancedNLPEngine()
    
    test_cases = [
        ("What's the schedule at Fremont CA?", "location", "Fremont CA"),
        ("Check door 5 status", "door", "5"),
        ("Status of truck T-FRE-123", "truck", "T-FRE-123"),
        ("Load L-999 assignment", "load", "L-999"),
        ("Priority 3 jobs", "priority", "3"),
    ]
    
    for question, entity_type, expected_value in test_cases:
        intent = nlp.parse_query(question)
        
        if entity_type in intent.entities:
            extracted = intent.entities[entity_type]
            if expected_value.lower() in extracted.lower():
                results.record_pass(f"Entity: '{question}' -> {entity_type}")
            else:
                results.record_fail(
                    f"Entity: '{question}'",
                    f"Expected '{expected_value}', got '{extracted}'"
                )
        else:
            results.record_fail(
                f"Entity: '{question}'",
                f"Entity '{entity_type}' not found"
            )


def test_temporal_extraction(results: TestResults):
    """Test temporal expression extraction"""
    print("\n=== Testing Temporal Extraction ===")
    
    nlp = AdvancedNLPEngine()
    
    test_cases = [
        ("What's scheduled today?", "today"),
        ("Show tomorrow's assignments", "tomorrow"),
        ("Upcoming door schedule", "upcoming"),
        ("Recent delays", "recent"),
    ]
    
    for question, expected_expr in test_cases:
        intent = nlp.parse_query(question)
        
        if intent.temporal and intent.temporal.get("expression") == expected_expr:
            results.record_pass(f"Temporal: '{question}' -> {expected_expr}")
        else:
            results.record_fail(
                f"Temporal: '{question}'",
                f"Expected '{expected_expr}', got {intent.temporal}"
            )


def test_confidence_scoring(results: TestResults):
    """Test confidence scoring"""
    print("\n=== Testing Confidence Scoring ===")
    
    nlp = AdvancedNLPEngine()
    
    # High confidence queries (clear intent)
    high_conf_queries = [
        "What is the door schedule at Fremont?",
        "Why was door 4 reassigned?",
        "Show available doors",
    ]
    
    for query in high_conf_queries:
        intent = nlp.parse_query(query)
        if intent.confidence >= 0.7:
            results.record_pass(f"Confidence: '{query}' ({intent.confidence:.2f})")
        else:
            results.record_fail(
                f"Confidence: '{query}'",
                f"Low confidence: {intent.confidence:.2f}"
            )
    
    # Ambiguous queries (lower confidence expected)
    ambiguous_queries = [
        "What about the thing?",
        "Show me stuff",
    ]
    
    for query in ambiguous_queries:
        intent = nlp.parse_query(query)
        if intent.confidence < 0.7:
            results.record_pass(f"Confidence (ambiguous): '{query}' ({intent.confidence:.2f})")
        else:
            results.record_fail(
                f"Confidence (ambiguous): '{query}'",
                f"Unexpectedly high confidence: {intent.confidence:.2f}"
            )


def run_all_tests():
    """Run all test suites"""
    print("\n" + "="*60)
    print("ADVANCED DOCKING AGENT - COMPREHENSIVE TEST SUITE")
    print("="*60)
    
    results = TestResults()
    
    try:
        test_nlp_engine(results)
        test_entity_extraction(results)
        test_temporal_extraction(results)
        test_confidence_scoring(results)
        test_reasoning_engine(results)
        test_query_handlers(results)
        test_orchestrator(results)
        test_end_to_end(results)
    except Exception as e:
        print(f"\n!!! Test suite error: {e}")
        import traceback
        traceback.print_exc()
    
    success = results.summary()
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(run_all_tests())

