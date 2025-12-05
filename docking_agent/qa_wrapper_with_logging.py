#!/usr/bin/env python3
"""
Wrapper for /qa endpoint that adds logging without modifying the original code.
"""

import time
import json
from typing import Dict, Any
from fastapi import APIRouter
from pydantic import BaseModel

# Import the original QA handler
try:
    from . import call_logger
    from . import api
except ImportError:
    import call_logger
    import api

router = APIRouter()

class QARequest(BaseModel):
    question: str


@router.post("/qa_logged")
def qa_with_logging(req: QARequest):
    """
    QA endpoint with automatic logging for evaluation pipeline.
    This wraps the original /qa endpoint.
    """
    start_time = time.time()
    handler_name = None
    sql_or_query = None
    rows_returned = None
    error = None
    answer_summary = None
    intent = None
    slots = {}
    
    try:
        # Call the original qa function
        result = api.qa(req)
        
        # Extract routing info
        router_info = result.get("router", {})
        intent = router_info.get("intent", "unknown")
        
        # Extract answer info
        answer = result.get("answer")
        explanation = result.get("explanation", "")
        
        # Format answer summary
        if isinstance(answer, list):
            rows_returned = len(answer)
            answer_summary = f"{len(answer)} results: {explanation}"
        elif isinstance(answer, int):
            rows_returned = answer
            answer_summary = f"Count: {answer} - {explanation}"
        elif answer is None:
            rows_returned = 0
            answer_summary = f"No result: {explanation}"
        else:
            rows_returned = 1
            answer_summary = f"{str(answer)[:200]} - {explanation}"
        
        # Calculate latency
        latency_ms = int((time.time() - start_time) * 1000)
        
        # Log the call
        try:
            call_logger.log_agent_call(
                user_question=req.question,
                router_intent=intent,
                slots=result.get("inputs", {}),
                target_agent="docking",
                handler_name=handler_name or f"handler_for_{intent}",
                sql_or_query=sql_or_query or f"Query for {intent}",
                rows_returned=rows_returned,
                latency_ms=latency_ms,
                error=None,
                answer_summary=answer_summary
            )
        except Exception as log_error:
            print(f"Warning: Failed to log: {log_error}")
        
        return result
        
    except Exception as e:
        # Log error
        latency_ms = int((time.time() - start_time) * 1000)
        
        try:
            call_logger.log_agent_call(
                user_question=req.question,
                router_intent=intent,
                slots=slots,
                target_agent="docking",
                handler_name=handler_name,
                sql_or_query=sql_or_query,
                rows_returned=0,
                latency_ms=latency_ms,
                error=repr(e),
                answer_summary=f"ERROR: {str(e)[:200]}"
            )
        except Exception as log_error:
            print(f"Warning: Failed to log error: {log_error}")
        
        raise


