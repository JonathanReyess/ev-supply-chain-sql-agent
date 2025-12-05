#!/usr/bin/env python3
"""
Test script for LLM-as-a-judge evaluation pipeline.

This script:
1. Runs migrations to create evaluation tables
2. Makes some test API calls to generate logs
3. Triggers evaluation on those logs
4. Displays evaluation results
"""

import os
import sys
import time
import requests
import json

# Configuration
API_BASE = "http://localhost:8088"
DB_PATH = os.getenv("DB_PATH", "./data/ev_supply_chain.db")


def run_migrations():
    """Run database migrations."""
    print("="*80)
    print("STEP 1: Running migrations...")
    print("="*80)
    
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "docking_agent"))
    from docking_agent import run_migrations
    
    applied = run_migrations.run_migrations(db_path=DB_PATH)
    print(f"\n✅ Migrations complete: {applied} applied\n")


def make_test_calls():
    """Make test API calls to generate logs."""
    print("="*80)
    print("STEP 2: Making test API calls...")
    print("="*80)
    
    test_questions = [
        "What's happening at Shanghai doors?",
        "How many inbound trucks at Fremont CA?",
        "When is the next truck arriving?",
        "Why was door 4 reassigned?",
        "Show me the schedule for Austin TX",
        "Count all assignments at Berlin",
        "What's the earliest ETA for part C00015?",
        "Optimize the schedule for Shanghai",
    ]
    
    for i, question in enumerate(test_questions, 1):
        print(f"\n[{i}/{len(test_questions)}] Question: {question}")
        
        try:
            response = requests.post(
                f"{API_BASE}/qa",
                json={"question": question},
                timeout=10
            )
            
            if response.status_code == 200:
                result = response.json()
                answer = result.get("answer")
                if isinstance(answer, list):
                    print(f"  ✅ Got {len(answer)} results")
                elif isinstance(answer, int):
                    print(f"  ✅ Count: {answer}")
                else:
                    print(f"  ✅ Answer: {str(answer)[:100]}")
            else:
                print(f"  ❌ Error: {response.status_code}")
                
        except Exception as e:
            print(f"  ❌ Exception: {e}")
        
        # Small delay between calls
        time.sleep(0.5)
    
    print(f"\n✅ Test calls complete\n")


def trigger_evaluation():
    """Trigger evaluation on recent calls."""
    print("="*80)
    print("STEP 3: Triggering LLM-as-a-judge evaluation...")
    print("="*80)
    
    try:
        response = requests.post(
            f"{API_BASE}/analysis/eval",
            params={
                "limit": 10,
                "errors_only": False,
                "judge_model": "gpt-4o-mini"
            },
            timeout=120  # Evaluation can take a while
        )
        
        if response.status_code == 200:
            result = response.json()
            print(json.dumps(result, indent=2))
            print(f"\n✅ Evaluation complete\n")
            return result
        else:
            print(f"❌ Error: {response.status_code}")
            print(response.text)
            return None
            
    except Exception as e:
        print(f"❌ Exception: {e}")
        return None


def show_stats():
    """Show evaluation statistics."""
    print("="*80)
    print("STEP 4: Evaluation Statistics")
    print("="*80)
    
    try:
        response = requests.get(f"{API_BASE}/analysis/eval/stats", timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            
            if result["status"] == "success":
                stats = result["stats"]
                
                print(f"\n📊 OVERALL STATS:")
                print(f"  Total Calls: {stats.get('total_calls', 0)}")
                print(f"  Calls with Errors: {stats.get('calls_with_errors', 0)}")
                print(f"  Total Evaluations: {stats.get('total_evaluations', 0)}")
                print(f"  Avg Usefulness Score: {stats.get('avg_usefulness_score', 'N/A')}/5.0")
                print(f"  Intent Correct: {stats.get('intent_correct_pct', 'N/A')}%")
                print(f"  Answer On-Topic: {stats.get('answer_on_topic_pct', 'N/A')}%")
                
                print(f"\n🎯 SEVERITY BREAKDOWN:")
                for severity, count in stats.get('severity_breakdown', {}).items():
                    print(f"  {severity}: {count}")
                
                print(f"\n🔍 HALLUCINATION RISK:")
                for risk, count in stats.get('hallucination_distribution', {}).items():
                    print(f"  {risk}: {count}")
            else:
                print(f"Error: {result.get('message')}")
        else:
            print(f"❌ Error: {response.status_code}")
            
    except Exception as e:
        print(f"❌ Exception: {e}")


def show_recent_evaluations():
    """Show recent evaluations with details."""
    print("\n" + "="*80)
    print("STEP 5: Recent Evaluations")
    print("="*80)
    
    try:
        response = requests.get(
            f"{API_BASE}/analysis/eval/recent",
            params={"limit": 5},
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            
            if result["status"] == "success":
                evaluations = result["evaluations"]
                
                for i, eval_data in enumerate(evaluations, 1):
                    print(f"\n{'─'*80}")
                    print(f"EVALUATION {i}/{len(evaluations)}")
                    print(f"{'─'*80}")
                    print(f"Question: {eval_data['question']}")
                    print(f"Intent: {eval_data['intent']}")
                    print(f"Handler: {eval_data['handler']}")
                    print(f"Latency: {eval_data['latency_ms']}ms")
                    print(f"Answer: {eval_data['answer_summary'][:100]}...")
                    
                    ev = eval_data['evaluation']
                    print(f"\n📊 SCORES:")
                    print(f"  Intent Correct: {'✅' if ev['intent_correct'] else '❌'}")
                    print(f"  Answer On-Topic: {'✅' if ev['answer_on_topic'] else '❌'}")
                    print(f"  Usefulness: {ev['usefulness_score']}/5.0")
                    print(f"  Hallucination Risk: {ev['hallucination_risk']}")
                    print(f"  Severity: {ev['severity']}")
                    print(f"\n💬 FEEDBACK: {ev['feedback']}")
            else:
                print(f"Error: {result.get('message')}")
        else:
            print(f"❌ Error: {response.status_code}")
            
    except Exception as e:
        print(f"❌ Exception: {e}")


def main():
    """Run the complete test pipeline."""
    print("\n" + "="*80)
    print("LLM-AS-A-JUDGE EVALUATION PIPELINE TEST")
    print("Inspired by MT-Bench (Zheng et al., NeurIPS 2023)")
    print("="*80)
    print()
    
    # Check if API is running
    try:
        response = requests.get(f"{API_BASE}/docs", timeout=5)
        if response.status_code != 200:
            print("❌ API not responding. Start the server first:")
            print("   cd docking_agent && uvicorn api:app --reload --port 8088")
            sys.exit(1)
    except Exception:
        print("❌ Cannot connect to API. Start the server first:")
        print("   cd docking_agent && uvicorn api:app --reload --port 8088")
        sys.exit(1)
    
    # Run pipeline
    try:
        run_migrations()
        make_test_calls()
        
        print("⏳ Waiting 2 seconds before evaluation...")
        time.sleep(2)
        
        trigger_evaluation()
        show_stats()
        show_recent_evaluations()
        
        print("\n" + "="*80)
        print("✅ PIPELINE TEST COMPLETE")
        print("="*80)
        print("\nNext steps:")
        print("  • View API docs: http://localhost:8088/docs")
        print("  • Trigger evaluation: POST /analysis/eval")
        print("  • View stats: GET /analysis/eval/stats")
        print("  • View recent evals: GET /analysis/eval/recent")
        print()
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

