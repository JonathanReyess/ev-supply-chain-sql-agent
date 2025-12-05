#!/usr/bin/env python3
"""
Agent Call Logging Helper Module

Provides utilities to log agent calls to the agent_call_logs table
for LLM-as-a-judge evaluation pipeline.
"""

import os
import json
import sqlite3
from typing import Optional, Dict, Any


def log_agent_call(
    *,
    user_question: str,
    router_intent: Optional[str] = None,
    slots: Optional[dict] = None,
    target_agent: str = "docking",
    handler_name: Optional[str] = None,
    sql_or_query: Optional[str] = None,
    rows_returned: Optional[int] = None,
    latency_ms: Optional[int] = None,
    error: Optional[str] = None,
    answer_summary: Optional[str] = None,
    db_path: Optional[str] = None
) -> int:
    """
    Log an agent call to the agent_call_logs table.
    
    Args:
        user_question: Original natural language question
        router_intent: Intent label from router (e.g., "schedule_query")
        slots: Dictionary of extracted slots
        target_agent: Agent name (e.g., "docking" or "sql")
        handler_name: Handler function name (e.g., "handle_schedule")
        sql_or_query: Raw SQL string or query signature
        rows_returned: Number of rows/items returned
        latency_ms: Wall-clock latency in milliseconds
        error: Exception message if error occurred
        answer_summary: Short text form of answer (truncated)
        db_path: Database path (defaults to env var or ./data/ev_supply_chain.db)
        
    Returns:
        ID of the inserted log record
    """
    db_path = db_path or os.getenv("DB_PATH", "./data/ev_supply_chain.db")
    
    # Serialize slots to JSON
    slots_json = json.dumps(slots) if slots else None
    
    # Truncate answer summary if too long
    if answer_summary and len(answer_summary) > 2000:
        answer_summary = answer_summary[:1997] + "..."
    
    # Truncate SQL/query if too long
    if sql_or_query and len(sql_or_query) > 5000:
        sql_or_query = sql_or_query[:4997] + "..."
    
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    
    try:
        cur.execute("""
            INSERT INTO agent_call_logs (
                user_question, router_intent, slots_json, target_agent,
                handler_name, sql_or_query, rows_returned, latency_ms,
                error, answer_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_question,
            router_intent,
            slots_json,
            target_agent,
            handler_name,
            sql_or_query,
            rows_returned,
            latency_ms,
            error,
            answer_summary
        ))
        
        log_id = cur.lastrowid
        conn.commit()
        return log_id
        
    finally:
        conn.close()


def format_answer_summary(answer: Any, max_len: int = 500) -> str:
    """
    Format an answer object into a summary string for logging.
    
    Args:
        answer: Answer object (dict, list, string, etc.)
        max_len: Maximum length of summary
        
    Returns:
        Formatted summary string
    """
    try:
        if isinstance(answer, dict):
            # Extract key information from dict
            if "answer" in answer:
                ans_value = answer["answer"]
                explanation = answer.get("explanation", "")
                
                if isinstance(ans_value, list):
                    summary = f"{len(ans_value)} items"
                    if explanation:
                        summary += f": {explanation}"
                elif isinstance(ans_value, (int, float)):
                    summary = f"Value: {ans_value}"
                    if explanation:
                        summary += f" ({explanation})"
                elif ans_value is None:
                    summary = f"No result. {explanation}"
                else:
                    summary = str(ans_value)
                    if explanation:
                        summary += f" - {explanation}"
            else:
                # Generic dict formatting
                summary = json.dumps(answer, default=str)
        elif isinstance(answer, list):
            summary = f"{len(answer)} items: {json.dumps(answer[:3], default=str)}..."
        else:
            summary = str(answer)
        
        # Truncate if too long
        if len(summary) > max_len:
            summary = summary[:max_len - 3] + "..."
        
        return summary
        
    except Exception as e:
        return f"Error formatting answer: {str(e)}"


def ensure_tables_exist(db_path: Optional[str] = None) -> bool:
    """
    Ensure agent_call_logs and agent_call_evals tables exist.
    
    This is useful for testing or if migrations haven't been run yet.
    
    Args:
        db_path: Database path (defaults to env var or ./data/ev_supply_chain.db)
        
    Returns:
        True if tables exist or were created successfully
    """
    db_path = db_path or os.getenv("DB_PATH", "./data/ev_supply_chain.db")
    
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    
    try:
        # Check if tables exist
        cur.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='agent_call_logs'
        """)
        
        if cur.fetchone() is None:
            # Tables don't exist, create them
            print("Creating agent_call_logs and agent_call_evals tables...")
            
            # Read and execute migration
            migration_path = os.path.join(
                os.path.dirname(__file__),
                "migrations",
                "003_agent_call_logging.sql"
            )
            
            if os.path.exists(migration_path):
                with open(migration_path, 'r') as f:
                    migration_sql = f.read()
                cur.executescript(migration_sql)
                conn.commit()
                print("Tables created successfully")
            else:
                print(f"Warning: Migration file not found at {migration_path}")
                return False
        
        return True
        
    except Exception as e:
        print(f"Error ensuring tables exist: {e}")
        return False
        
    finally:
        conn.close()


if __name__ == "__main__":
    # Test logging
    print("Testing agent call logging...")
    
    # Ensure tables exist
    if not ensure_tables_exist():
        print("Failed to ensure tables exist")
        exit(1)
    
    # Log a test call
    log_id = log_agent_call(
        user_question="What's happening at Shanghai doors?",
        router_intent="door_schedule",
        slots={"location": "Shanghai"},
        target_agent="docking",
        handler_name="handle_door_schedule",
        sql_or_query="SELECT * FROM dock_assignments WHERE location = 'Shanghai'",
        rows_returned=5,
        latency_ms=123,
        error=None,
        answer_summary="5 scheduled assignments at Shanghai"
    )
    
    print(f"✅ Test log created with ID: {log_id}")


