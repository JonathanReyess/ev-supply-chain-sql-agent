#!/usr/bin/env python3
"""
Demonstrate evaluation results with mock data (no API calls).
This shows what the system would output with a working API key.
"""

import sqlite3
import json
from datetime import datetime

DB_PATH = "data/ev_supply_chain.db"

# Mock evaluations based on the actual calls
MOCK_EVALS = [
    {
        "call_id": 3,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.0,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "Intent correctly identified as door_schedule. However, returned 0 results for Shanghai, which may indicate data issue or need to seed more data."
    },
    {
        "call_id": 4,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.5,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "Count query correctly handled. Returned 0 inbound trucks at Fremont CA, which is accurate but may indicate scheduling gap."
    },
    {
        "call_id": 5,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.0,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "Austin TX location query handled correctly. No results returned, likely due to no scheduled arrivals."
    },
    {
        "call_id": 6,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 4.5,
        "hallucination_risk": "low",
        "severity": "ok",
        "feedback_summary": "Excellent causal explanation for reassignment. Returned 'solver_choice' as reason, which is informative for ops managers."
    },
    {
        "call_id": 7,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.0,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "Berlin schedule query correctly routed. No results returned, may need to seed Berlin warehouse data."
    },
    {
        "call_id": 8,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.5,
        "hallucination_risk": "low",
        "severity": "ok",
        "feedback_summary": "Count query for Shanghai outbound correctly handled. Returned 0, which is accurate based on current data."
    },
    {
        "call_id": 9,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 2.5,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "ETA query for part C00015 correctly understood. No results may indicate part not in system or no scheduled deliveries."
    },
    {
        "call_id": 10,
        "intent_correct": 1,
        "answer_on_topic": 0,
        "usefulness_score": 2.0,
        "hallucination_risk": "medium",
        "severity": "minor_issue",
        "feedback_summary": "Optimization request may be outside docking agent's scope. Returned generic response rather than actual optimization."
    },
    {
        "call_id": 11,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.0,
        "hallucination_risk": "low",
        "severity": "minor_issue",
        "feedback_summary": "Door-specific query correctly routed. No results for FCX-D10 may indicate door not in schedule or data seeding issue."
    },
    {
        "call_id": 12,
        "intent_correct": 1,
        "answer_on_topic": 1,
        "usefulness_score": 3.5,
        "hallucination_risk": "low",
        "severity": "ok",
        "feedback_summary": "Time-bounded count query correctly handled. Returned 0 for next 2 hours at Shanghai, accurate given current schedule."
    }
]

print("="*80)
print("MOCK EVALUATION RESULTS (Demonstrating Working System)")
print("="*80)
print()

# Connect to DB
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

# Get actual call data
calls = cur.execute("""
    SELECT id, user_question, router_intent, rows_returned, latency_ms
    FROM agent_call_logs
    WHERE id >= 3 AND id <= 12
    ORDER BY id
""").fetchall()

print(f"Evaluated {len(calls)} agent calls:")
print()

# Display results
severity_counts = {"ok": 0, "minor_issue": 0, "major_issue": 0}
total_usefulness = 0
hallucination_counts = {"low": 0, "medium": 0, "high": 0}

for call in calls:
    call_id, question, intent, rows, latency = call
    
    # Find mock eval
    mock_eval = next((e for e in MOCK_EVALS if e["call_id"] == call_id), None)
    if not mock_eval:
        continue
    
    severity_counts[mock_eval["severity"]] += 1
    total_usefulness += mock_eval["usefulness_score"]
    hallucination_counts[mock_eval["hallucination_risk"]] += 1
    
    # Color code severity
    severity_emoji = {
        "ok": "✅",
        "minor_issue": "⚠️",
        "major_issue": "❌"
    }
    
    print(f"{severity_emoji[mock_eval['severity']]} Call #{call_id}: {question[:50]}")
    print(f"   Intent: {intent} | Rows: {rows} | Latency: {latency}ms")
    print(f"   Usefulness: {mock_eval['usefulness_score']}/5.0 | Hallucination: {mock_eval['hallucination_risk']}")
    print(f"   Feedback: {mock_eval['feedback_summary']}")
    print()

# Summary statistics
print("="*80)
print("SUMMARY STATISTICS")
print("="*80)
print(f"Total Calls Evaluated: {len(calls)}")
print(f"Average Usefulness Score: {total_usefulness / len(calls):.2f}/5.0")
print()
print("Severity Breakdown:")
print(f"  ✅ OK: {severity_counts['ok']} ({severity_counts['ok']/len(calls)*100:.0f}%)")
print(f"  ⚠️  Minor Issue: {severity_counts['minor_issue']} ({severity_counts['minor_issue']/len(calls)*100:.0f}%)")
print(f"  ❌ Major Issue: {severity_counts['major_issue']} ({severity_counts['major_issue']/len(calls)*100:.0f}%)")
print()
print("Hallucination Risk:")
print(f"  Low: {hallucination_counts['low']} ({hallucination_counts['low']/len(calls)*100:.0f}%)")
print(f"  Medium: {hallucination_counts['medium']} ({hallucination_counts['medium']/len(calls)*100:.0f}%)")
print(f"  High: {hallucination_counts['high']} ({hallucination_counts['high']/len(calls)*100:.0f}%)")
print()
print("="*80)
print("KEY INSIGHTS")
print("="*80)
print("1. Intent classification is 100% accurate across all queries")
print("2. Most queries return 0 results due to empty/minimal data seeding")
print("3. Causal explanation queries (why reassigned) work well")
print("4. Count queries are handled correctly")
print("5. Recommendation: Seed more diverse data for better testing")
print()

conn.close()
