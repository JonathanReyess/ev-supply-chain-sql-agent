#!/usr/bin/env python3
"""Make API calls and manually log them for evaluation testing."""

import requests
import json
import sys
import time

sys.path.insert(0, "docking_agent")
import call_logger

API_URL = "http://localhost:8088/qa"

QUESTIONS = [
    "What's happening at Shanghai doors?",
    "How many inbound trucks at Fremont CA?",
    "When is the next truck arriving at Austin TX?",
    "Why was door 4 reassigned?",
    "Show me the schedule for Berlin",
    "Count all outbound at Shanghai",
    "What's the earliest ETA for part C00015?",
    "Optimize the schedule for Fremont CA",
    "Tell me about door FCX-D10",
    "How many assignments in the next 2 hours at Shanghai?"
]

print("="*80)
print("Making API calls with manual logging...")
print("="*80)

for i, question in enumerate(QUESTIONS, 1):
    print(f"\n[{i}/{len(QUESTIONS)}] {question}")
    
    start_time = time.time()
    
    try:
        response = requests.post(API_URL, json={"question": question}, timeout=10)
        latency_ms = int((time.time() - start_time) * 1000)
        
        if response.status_code == 200:
            result = response.json()
            answer = result.get("answer")
            explanation = result.get("explanation", "")
            router_info = result.get("router", {})
            intent = router_info.get("source", "unknown")
            
            # Format answer summary
            if isinstance(answer, list):
                rows_returned = len(answer)
                answer_summary = f"{len(answer)} results: {explanation}"
                print(f"  ✅ Got {len(answer)} results")
            elif isinstance(answer, int):
                rows_returned = answer
                answer_summary = f"Count: {answer} - {explanation}"
                print(f"  ✅ Count: {answer}")
            elif answer is None:
                rows_returned = 0
                answer_summary = f"No result: {explanation}"
                print(f"  ⚠️  No result")
            else:
                rows_returned = 1
                answer_summary = str(answer)[:200] + " - " + explanation
                print(f"  ✅ Answer: {str(answer)[:60]}")
            
            # Log the call
            log_id = call_logger.log_agent_call(
                user_question=question,
                router_intent=intent,
                slots=result.get("inputs", {}),
                target_agent="docking",
                handler_name=f"handler_for_{intent}",
                sql_or_query=f"Query for {intent}",
                rows_returned=rows_returned,
                latency_ms=latency_ms,
                error=None,
                answer_summary=answer_summary
            )
            print(f"  📝 Logged as call_id: {log_id}")
            
        else:
            print(f"  ❌ Error: {response.status_code}")
            # Log error
            call_logger.log_agent_call(
                user_question=question,
                router_intent="unknown",
                slots={},
                target_agent="docking",
                handler_name="unknown",
                sql_or_query="N/A",
                rows_returned=0,
                latency_ms=latency_ms,
                error=f"HTTP {response.status_code}",
                answer_summary=f"API error: {response.status_code}"
            )
            
    except Exception as e:
        print(f"  ❌ Exception: {e}")
        latency_ms = int((time.time() - start_time) * 1000)
        call_logger.log_agent_call(
            user_question=question,
            router_intent="unknown",
            slots={},
            target_agent="docking",
            handler_name="unknown",
            sql_or_query="N/A",
            rows_returned=0,
            latency_ms=latency_ms,
            error=repr(e),
            answer_summary=f"Exception: {str(e)[:200]}"
        )
    
    time.sleep(0.3)

print("\n" + "="*80)
print("✅ All calls made and logged!")
print("="*80)
