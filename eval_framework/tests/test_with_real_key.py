#!/usr/bin/env python3
"""Test evaluation with real Gemini API key"""

import os
os.environ['GOOGLE_API_KEY'] = os.getenv('GOOGLE_API_KEY', 'your-api-key-here')

import requests
import time
import sys
sys.path.insert(0, 'docking_agent')

from call_logger import log_agent_call
from eval_agent_gemini import AgentCallEvaluator

API_URL = "http://localhost:8088/qa"

TEST_QUESTIONS = [
    "What's happening at Shanghai?",
    "How many inbound trucks at Fremont CA?",
    "Why was door 4 reassigned?",
    "Show me the schedule for the next 2 hours",
    "Count all assignments at Shanghai"
]

print("="*80)
print("MAKING API CALLS AND LOGGING...")
print("="*80)

call_ids = []
for i, question in enumerate(TEST_QUESTIONS, 1):
    print(f"\n[{i}/{len(TEST_QUESTIONS)}] {question}")
    
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
            
            if isinstance(answer, list):
                rows = len(answer)
                summary = f"{len(answer)} results: {explanation}"
                print(f"  ✅ Got {len(answer)} results")
            elif isinstance(answer, int):
                rows = answer
                summary = f"Count: {answer} - {explanation}"
                print(f"  ✅ Count: {answer}")
            else:
                rows = 1
                summary = str(answer)[:200]
                print(f"  ✅ Answer: {str(answer)[:60]}")
            
            # Log the call
            call_id = log_agent_call(
                user_question=question,
                router_intent=intent,
                slots=result.get("inputs", {}),
                target_agent="docking",
                handler_name=f"handler_{intent}",
                sql_or_query=f"Query for {intent}",
                rows_returned=rows,
                latency_ms=latency_ms,
                error=None,
                answer_summary=summary
            )
            call_ids.append(call_id)
            print(f"  📝 Logged as call_id: {call_id}")
    except Exception as e:
        print(f"  ❌ Error: {e}")
    
    time.sleep(0.5)

print("\n" + "="*80)
print("RUNNING EVALUATION WITH GEMINI...")
print("="*80)

evaluator = AgentCallEvaluator(judge_model="gemini-2.0-flash-exp")
result = evaluator.evaluate_recent_calls(limit=5, delay_between_calls=1.0)

print("\n" + "="*80)
print("EVALUATION RESULTS")
print("="*80)
print(f"Calls Evaluated: {result['calls_evaluated']}")
print(f"Calls Failed: {result['calls_failed']}")
print(f"Average Usefulness: {result['avg_usefulness_score']}/5.0")
print(f"\nSeverity Breakdown:")
for severity, count in result['severity_breakdown'].items():
    emoji = {"ok": "✅", "minor_issue": "⚠️", "major_issue": "❌"}.get(severity, "")
    print(f"  {emoji} {severity}: {count}")

print(f"\nTop Results:")
for i, r in enumerate(result['results'][:5], 1):
    print(f"\n{i}. Call #{r['call_id']}")
    print(f"   Severity: {r['severity']}")
    print(f"   Usefulness: {r['usefulness']}/5.0")
    print(f"   Feedback: {r['feedback'][:80]}")

print("\n" + "="*80)
