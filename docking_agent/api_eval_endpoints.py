"""
Evaluation endpoints for LLM-as-a-judge pipeline.
This file contains the evaluation endpoints that can be added to the main API.
"""

from fastapi import Query
from typing import Optional, Dict, Any


def add_eval_endpoints(app, _conn):
    """Add evaluation endpoints to the FastAPI app."""
    
    @app.post("/analysis/eval")
    def trigger_evaluation(
        limit: int = Query(50, description="Maximum number of calls to evaluate"),
        errors_only: bool = Query(False, description="Only evaluate calls with errors"),
        since_hours: Optional[int] = Query(None, description="Only evaluate calls from last N hours"),
        judge_model: str = Query("gpt-4o-mini", description="LLM model to use for judging")
    ):
        """Trigger LLM-as-a-judge evaluation on recent agent calls."""
        try:
            try:
                from . import eval_agent
            except ImportError:
                import eval_agent
            
            result = eval_agent.run_evaluation(
                limit=limit,
                errors_only=errors_only,
                since_hours=since_hours,
                judge_model=judge_model
            )
            
            return result
            
        except ImportError as e:
            return {
                "status": "error",
                "message": f"eval_agent module not available: {str(e)}",
                "hint": "Install OpenAI package: pip install openai"
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e)
            }
    
    @app.get("/analysis/eval/stats")
    def evaluation_stats(
        since_hours: Optional[int] = Query(None, description="Stats from last N hours")
    ):
        """Get evaluation statistics."""
        try:
            conn = _conn()
            cur = conn.cursor()
            
            time_filter = ""
            params = []
            if since_hours:
                time_filter = "WHERE datetime(l.created_utc) > datetime('now', ?)"
                params.append(f"-{since_hours} hours")
            
            stats = {}
            
            # Total calls
            query = f"SELECT COUNT(*) FROM agent_call_logs l {time_filter}"
            stats["total_calls"] = cur.execute(query, params).fetchone()[0]
            
            # Calls with errors
            error_filter = f"AND l.error IS NOT NULL" if time_filter else "WHERE l.error IS NOT NULL"
            query = f"SELECT COUNT(*) FROM agent_call_logs l {time_filter} {error_filter if time_filter else 'WHERE l.error IS NOT NULL'}"
            stats["calls_with_errors"] = cur.execute(query, params).fetchone()[0]
            
            # Total evaluations
            eval_time_filter = ""
            if since_hours:
                eval_time_filter = "WHERE datetime(e.created_utc) > datetime('now', ?)"
            query = f"SELECT COUNT(*) FROM agent_call_evals e {eval_time_filter}"
            stats["total_evaluations"] = cur.execute(query, params if since_hours else []).fetchone()[0]
            
            # Average usefulness score
            query = f"""
                SELECT AVG(e.usefulness_score)
                FROM agent_call_evals e
                {eval_time_filter}
            """
            avg_score = cur.execute(query, params if since_hours else []).fetchone()[0]
            stats["avg_usefulness_score"] = round(float(avg_score), 2) if avg_score else None
            
            # Severity breakdown
            query = f"""
                SELECT e.severity, COUNT(*) as count
                FROM agent_call_evals e
                {eval_time_filter}
                GROUP BY e.severity
            """
            severity_rows = cur.execute(query, params if since_hours else []).fetchall()
            stats["severity_breakdown"] = {row[0]: row[1] for row in severity_rows}
            
            # Intent correctness rate
            query = f"""
                SELECT AVG(CAST(e.intent_correct AS FLOAT)) * 100 as pct
                FROM agent_call_evals e
                {eval_time_filter}
            """
            intent_pct = cur.execute(query, params if since_hours else []).fetchone()[0]
            stats["intent_correct_pct"] = round(float(intent_pct), 1) if intent_pct else None
            
            # Answer on-topic rate
            query = f"""
                SELECT AVG(CAST(e.answer_on_topic AS FLOAT)) * 100 as pct
                FROM agent_call_evals e
                {eval_time_filter}
            """
            on_topic_pct = cur.execute(query, params if since_hours else []).fetchone()[0]
            stats["answer_on_topic_pct"] = round(float(on_topic_pct), 1) if on_topic_pct else None
            
            # Hallucination risk distribution
            query = f"""
                SELECT e.hallucination_risk, COUNT(*) as count
                FROM agent_call_evals e
                {eval_time_filter}
                GROUP BY e.hallucination_risk
            """
            halluc_rows = cur.execute(query, params if since_hours else []).fetchall()
            stats["hallucination_distribution"] = {row[0]: row[1] for row in halluc_rows}
            
            conn.close()
            
            return {
                "status": "success",
                "stats": stats,
                "time_range": f"last {since_hours} hours" if since_hours else "all time"
            }
            
        except Exception as e:
            return {
                "status": "error",
                "message": str(e)
            }
    
    @app.get("/analysis/eval/recent")
    def recent_evaluations(
        limit: int = Query(10, description="Number of recent evaluations to return"),
        severity: Optional[str] = Query(None, description="Filter by severity")
    ):
        """Get recent evaluations with full details."""
        try:
            conn = _conn()
            cur = conn.cursor()
            
            severity_filter = ""
            params = []
            if severity:
                severity_filter = "WHERE e.severity = ?"
                params.append(severity)
            
            query = f"""
                SELECT 
                    l.id as call_id,
                    l.user_question,
                    l.router_intent,
                    l.handler_name,
                    l.latency_ms,
                    l.error,
                    l.answer_summary,
                    e.intent_correct,
                    e.answer_on_topic,
                    e.usefulness_score,
                    e.hallucination_risk,
                    e.severity,
                    e.feedback_summary,
                    e.created_utc as eval_time,
                    e.judge_model
                FROM agent_call_evals e
                JOIN agent_call_logs l ON l.id = e.call_id
                {severity_filter}
                ORDER BY e.created_utc DESC
                LIMIT ?
            """
            params.append(limit)
            
            rows = cur.execute(query, params).fetchall()
            conn.close()
            
            evaluations = []
            for row in rows:
                evaluations.append({
                    "call_id": row[0],
                    "question": row[1],
                    "intent": row[2],
                    "handler": row[3],
                    "latency_ms": row[4],
                    "had_error": row[5] is not None,
                    "answer_summary": row[6],
                    "evaluation": {
                        "intent_correct": bool(row[7]),
                        "answer_on_topic": bool(row[8]),
                        "usefulness_score": row[9],
                        "hallucination_risk": row[10],
                        "severity": row[11],
                        "feedback": row[12],
                        "evaluated_at": row[13],
                        "judge_model": row[14]
                    }
                })
            
            return {
                "status": "success",
                "count": len(evaluations),
                "evaluations": evaluations
            }
            
        except Exception as e:
            return {
                "status": "error",
                "message": str(e)
            }

