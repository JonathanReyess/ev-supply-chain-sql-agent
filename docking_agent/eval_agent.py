#!/usr/bin/env python3
"""
LLM-as-a-Judge Evaluation Module for Agent Calls

Inspired by "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" (Zheng et al., NeurIPS 2023).
This module evaluates individual agent calls (question → routing → handler → SQL/API → answer)
using a judge LLM with a rubric-based prompt.

Key Features:
- Fetches recent logs from agent_call_logs table
- Sends logs to judge LLM with structured rubric
- Parses strict JSON output with evaluation scores
- Writes per-call evaluations into agent_call_evals table
- Supports filtering by error status and time range
"""

import os
import json
import sqlite3
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
import time

# Try to import OpenAI, fallback gracefully
try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False
    OpenAI = None

# Judge LLM Rubric-Based Prompt (inspired by MT-Bench)
JUDGE_SYSTEM_PROMPT = """You are an expert evaluator for EV supply chain agent systems. Your role is to judge the quality of agent responses to user questions.

You will receive:
1. A user's natural language question
2. The agent's routing decision (intent + slots)
3. The handler that was called and any SQL/API queries executed
4. The final answer returned to the user
5. Metadata (latency, rows returned, errors)

Evaluate each agent call using the following rubric:

**Intent Correctness (intent_correct):**
- 1 = The router correctly identified the user's intent
- 0 = The router misclassified the intent

**Answer On-Topic (answer_on_topic):**
- 1 = The answer directly addresses the user's question
- 0 = The answer is off-topic or irrelevant

**Usefulness Score (usefulness_score):**
Rate on a 1-5 scale how useful this response would be to an ops manager:
- 5 = Highly actionable, comprehensive, directly answers the question
- 4 = Good response, mostly complete
- 3 = Acceptable, some gaps or unclear elements
- 2 = Poor, missing key information or partially wrong
- 1 = Not useful, wrong answer or system error

**Hallucination Risk (hallucination_risk):**
Assess the likelihood the agent invented information:
- "low" = Answer is well-grounded in data
- "medium" = Some uncertainty or potential extrapolation
- "high" = Answer appears to contain fabricated information

**Severity (severity):**
Overall assessment of this agent call:
- "ok" = No issues, good response
- "minor_issue" = Small problems but generally acceptable
- "major_issue" = Significant problems requiring attention

**Feedback Summary (feedback_summary):**
Provide 1-3 sentences of natural language feedback explaining your evaluation.

Return your evaluation as a JSON object with these exact keys:
{
  "intent_correct": 0 or 1,
  "answer_on_topic": 0 or 1,
  "usefulness_score": 1.0 to 5.0,
  "hallucination_risk": "low" | "medium" | "high",
  "severity": "ok" | "minor_issue" | "major_issue",
  "feedback_summary": "Your 1-3 sentence feedback here"
}

Be strict but fair. Focus on correctness, relevance, and usefulness to operations managers."""

JUDGE_USER_TEMPLATE = """Evaluate this agent call:

**User Question:**
{user_question}

**Agent Routing:**
- Intent: {router_intent}
- Slots: {slots_json}
- Target Agent: {target_agent}

**Execution:**
- Handler: {handler_name}
- SQL/Query: {sql_or_query}
- Rows Returned: {rows_returned}
- Latency: {latency_ms}ms
- Error: {error}

**Answer Summary:**
{answer_summary}

Provide your evaluation as JSON only, no other text."""


class AgentCallEvaluator:
    """Evaluates agent calls using an LLM judge."""
    
    def __init__(
        self,
        db_path: Optional[str] = None,
        judge_model: str = "gpt-4o-mini",
        api_key: Optional[str] = None
    ):
        """
        Initialize the evaluator.
        
        Args:
            db_path: Path to SQLite database (defaults to env var or ./data/ev_supply_chain.db)
            judge_model: LLM model to use for judging (default: gpt-4o-mini)
            api_key: OpenAI API key (defaults to OPENAI_API_KEY env var)
        """
        self.db_path = db_path or os.getenv("DB_PATH", "./data/ev_supply_chain.db")
        self.judge_model = judge_model
        
        if not HAS_OPENAI:
            raise ImportError(
                "OpenAI package not installed. Install with: pip install openai"
            )
        
        self.client = OpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))
    
    def _conn(self) -> sqlite3.Connection:
        """Get database connection."""
        return sqlite3.connect(self.db_path)
    
    def fetch_recent_calls(
        self,
        limit: int = 50,
        errors_only: bool = False,
        since_hours: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch recent agent calls that haven't been evaluated yet.
        
        Args:
            limit: Maximum number of calls to fetch
            errors_only: If True, only fetch calls with errors
            since_hours: Only fetch calls from the last N hours
            
        Returns:
            List of agent call records as dictionaries
        """
        conn = self._conn()
        cur = conn.cursor()
        
        # Build query
        query = """
            SELECT 
                l.id, l.created_utc, l.user_question, l.router_intent,
                l.slots_json, l.target_agent, l.handler_name, l.sql_or_query,
                l.rows_returned, l.latency_ms, l.error, l.answer_summary
            FROM agent_call_logs l
            LEFT JOIN agent_call_evals e ON e.call_id = l.id
            WHERE e.id IS NULL
        """
        
        params = []
        
        if errors_only:
            query += " AND l.error IS NOT NULL"
        
        if since_hours:
            query += " AND datetime(l.created_utc) > datetime('now', ?)"
            params.append(f"-{since_hours} hours")
        
        query += " ORDER BY l.created_utc DESC LIMIT ?"
        params.append(limit)
        
        rows = cur.execute(query, params).fetchall()
        conn.close()
        
        # Convert to dicts
        columns = [
            "id", "created_utc", "user_question", "router_intent",
            "slots_json", "target_agent", "handler_name", "sql_or_query",
            "rows_returned", "latency_ms", "error", "answer_summary"
        ]
        
        return [dict(zip(columns, row)) for row in rows]
    
    def judge_call(self, call: Dict[str, Any]) -> Dict[str, Any]:
        """
        Evaluate a single agent call using the judge LLM.
        
        Args:
            call: Agent call record from agent_call_logs
            
        Returns:
            Evaluation dictionary with scores and feedback
        """
        # Format the prompt
        user_prompt = JUDGE_USER_TEMPLATE.format(
            user_question=call["user_question"],
            router_intent=call["router_intent"] or "None",
            slots_json=call["slots_json"] or "{}",
            target_agent=call["target_agent"] or "unknown",
            handler_name=call["handler_name"] or "N/A",
            sql_or_query=self._truncate(call["sql_or_query"], 500) or "N/A",
            rows_returned=call["rows_returned"] if call["rows_returned"] is not None else "N/A",
            latency_ms=call["latency_ms"] if call["latency_ms"] is not None else "N/A",
            error=call["error"] or "None",
            answer_summary=self._truncate(call["answer_summary"], 1000) or "N/A"
        )
        
        try:
            # Call judge LLM
            response = self.client.chat.completions.create(
                model=self.judge_model,
                messages=[
                    {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.0,  # Deterministic evaluation
                response_format={"type": "json_object"}  # Force JSON output
            )
            
            # Parse JSON response
            raw_json = response.choices[0].message.content
            evaluation = json.loads(raw_json)
            
            # Validate required fields
            required_fields = [
                "intent_correct", "answer_on_topic", "usefulness_score",
                "hallucination_risk", "severity", "feedback_summary"
            ]
            
            for field in required_fields:
                if field not in evaluation:
                    raise ValueError(f"Judge response missing required field: {field}")
            
            # Store raw JSON for debugging
            evaluation["raw_judge_json"] = raw_json
            
            return evaluation
            
        except Exception as e:
            # Return a default "failed to evaluate" response
            return {
                "intent_correct": 0,
                "answer_on_topic": 0,
                "usefulness_score": 1.0,
                "hallucination_risk": "high",
                "severity": "major_issue",
                "feedback_summary": f"Failed to evaluate: {str(e)}",
                "raw_judge_json": json.dumps({"error": str(e)})
            }
    
    def save_evaluation(self, call_id: int, evaluation: Dict[str, Any]) -> int:
        """
        Save an evaluation to the database.
        
        Args:
            call_id: ID from agent_call_logs
            evaluation: Evaluation dictionary from judge_call()
            
        Returns:
            ID of the inserted evaluation record
        """
        conn = self._conn()
        cur = conn.cursor()
        
        cur.execute("""
            INSERT INTO agent_call_evals (
                call_id, judge_model, intent_correct, answer_on_topic,
                usefulness_score, hallucination_risk, severity,
                feedback_summary, raw_judge_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            call_id,
            self.judge_model,
            evaluation["intent_correct"],
            evaluation["answer_on_topic"],
            evaluation["usefulness_score"],
            evaluation["hallucination_risk"],
            evaluation["severity"],
            evaluation["feedback_summary"],
            evaluation["raw_judge_json"]
        ))
        
        eval_id = cur.lastrowid
        conn.commit()
        conn.close()
        
        return eval_id
    
    def evaluate_recent_calls(
        self,
        limit: int = 50,
        errors_only: bool = False,
        since_hours: Optional[int] = None,
        delay_between_calls: float = 0.5
    ) -> Dict[str, Any]:
        """
        Evaluate recent unevaluated agent calls.
        
        Args:
            limit: Maximum number of calls to evaluate
            errors_only: Only evaluate calls with errors
            since_hours: Only evaluate calls from last N hours
            delay_between_calls: Sleep duration between API calls (rate limiting)
            
        Returns:
            Summary dictionary with evaluation statistics
        """
        start_time = time.time()
        
        # Fetch calls to evaluate
        calls = self.fetch_recent_calls(
            limit=limit,
            errors_only=errors_only,
            since_hours=since_hours
        )
        
        if not calls:
            return {
                "status": "success",
                "calls_evaluated": 0,
                "message": "No unevaluated calls found",
                "elapsed_seconds": time.time() - start_time
            }
        
        # Evaluate each call
        results = []
        for call in calls:
            try:
                evaluation = self.judge_call(call)
                eval_id = self.save_evaluation(call["id"], evaluation)
                
                results.append({
                    "call_id": call["id"],
                    "eval_id": eval_id,
                    "severity": evaluation["severity"],
                    "usefulness": evaluation["usefulness_score"]
                })
                
                # Rate limiting
                if delay_between_calls > 0:
                    time.sleep(delay_between_calls)
                    
            except Exception as e:
                results.append({
                    "call_id": call["id"],
                    "error": str(e)
                })
        
        # Compute summary statistics
        evaluated = [r for r in results if "eval_id" in r]
        failed = [r for r in results if "error" in r]
        
        severity_counts = {}
        for r in evaluated:
            sev = r["severity"]
            severity_counts[sev] = severity_counts.get(sev, 0) + 1
        
        avg_usefulness = (
            sum(r["usefulness"] for r in evaluated) / len(evaluated)
            if evaluated else 0.0
        )
        
        return {
            "status": "success",
            "calls_evaluated": len(evaluated),
            "calls_failed": len(failed),
            "severity_breakdown": severity_counts,
            "avg_usefulness_score": round(avg_usefulness, 2),
            "elapsed_seconds": round(time.time() - start_time, 2),
            "judge_model": self.judge_model
        }
    
    def _truncate(self, text: Optional[str], max_len: int) -> Optional[str]:
        """Truncate text to max length with ellipsis."""
        if not text:
            return text
        if len(text) <= max_len:
            return text
        return text[:max_len - 3] + "..."


def run_evaluation(
    limit: int = 50,
    errors_only: bool = False,
    since_hours: Optional[int] = None,
    db_path: Optional[str] = None,
    judge_model: str = "gpt-4o-mini"
) -> Dict[str, Any]:
    """
    Convenience function to run evaluation pipeline.
    
    Args:
        limit: Maximum number of calls to evaluate
        errors_only: Only evaluate calls with errors
        since_hours: Only evaluate calls from last N hours
        db_path: Path to database (defaults to env var)
        judge_model: LLM model to use for judging
        
    Returns:
        Evaluation summary dictionary
    """
    evaluator = AgentCallEvaluator(db_path=db_path, judge_model=judge_model)
    return evaluator.evaluate_recent_calls(
        limit=limit,
        errors_only=errors_only,
        since_hours=since_hours
    )


if __name__ == "__main__":
    # CLI interface for testing
    import sys
    
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    errors_only = "--errors-only" in sys.argv
    
    print(f"Running evaluation on up to {limit} recent calls...")
    if errors_only:
        print("(errors only)")
    
    try:
        result = run_evaluation(limit=limit, errors_only=errors_only)
        print("\n" + "="*80)
        print("EVALUATION RESULTS")
        print("="*80)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

