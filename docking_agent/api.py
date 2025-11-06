import os
import json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Tuple, Dict, Any
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

# Load env from local .env before importing router (so it sees flags like USE_LLM_ROUTER)
try:
    from dotenv import load_dotenv
    here = os.path.dirname(__file__)
    load_dotenv(os.path.join(here, ".env"))
    load_dotenv()  # also load project/root .env if present
except Exception:
    # dotenv is optional; continue if not installed
    pass

from . import llm_router

app = FastAPI(title="Docking Agent API")

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure logs directory exists
LOGS_DIR = Path(__file__).parent.parent / "logs"
LOGS_DIR.mkdir(exist_ok=True)

def log_token_usage(intent: str, model: str, provider: str, token_data: dict, question: str, conversation_id: str = "default"):
    """Log token usage to JSONL file"""
    timestamp = datetime.utcnow().isoformat()
    log_entry = {
        "timestamp": timestamp,
        "conversationId": conversation_id,
        "intent": intent,
        "model": model,
        "provider": provider,
        "question": question[:100],  # Truncate long questions
        **token_data
    }
    
    log_file = LOGS_DIR / f"token-usage-docking-agent-{datetime.utcnow().date().isoformat()}.jsonl"
    try:
        with open(log_file, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception as e:
        print(f"Failed to write log: {e}")

class QARequest(BaseModel):
    question: str

def parse_question(question: str) -> Tuple[str, Dict[str, Any], float, str]:
    """Parse a natural-language question into an intent and metadata.

    Uses the LLM router when enabled; otherwise returns unknown intent.
    Returns: (intent, metadata_dict, confidence, source)
    where metadata_dict contains 'slots' and optionally 'tokenUsage'
    """
    try:
        intent, meta, conf = llm_router.llm_route(question)
        source = "llm" if intent not in ("disabled", "unknown") else "router"
        if intent == "disabled":
            return "unknown", {}, 0.0, "disabled"
        return intent, meta, float(conf or 0.0), source
    except Exception:
        return "unknown", {}, 0.0, "error"

def _conn():
    db_path = os.getenv("DB_PATH", "./data/ev_supply_chain.db")
    return sqlite3.connect(db_path)

def handle_earliest_eta_part(part: str, location: str) -> Dict[str, Any]:
    part = (part or "").strip()
    location = (location or "").strip()
    conn = _conn(); cur = conn.cursor()
    try:
        # Case 1: part and location provided
        if part and location:
            row = cur.execute(
                """
                WITH pos_for_part AS (
                  SELECT DISTINCT li.po_id
                  FROM po_line_items li
                  JOIN components c ON c.componentid = li.componentid
                  WHERE (
                    c.componentid = ? OR lower(c.name) LIKE '%' || lower(?) || '%'
                  )
                )
                SELECT t.truck_id, t.po_id, t.location, t.eta_utc, t.unload_min, t.priority
                FROM inbound_trucks t
                JOIN pos_for_part p ON p.po_id = t.po_id
                WHERE t.location = ?
                ORDER BY datetime(t.eta_utc) ASC
                LIMIT 1;
                """,
                (part, part, location)
            ).fetchone()
            if not row:
                return {"answer": None, "explanation": "No inbound trucks found for that part/location", "inputs": {"part": part, "location": location}}
            truck_id, po_id, loc, eta_utc, unload_min, priority = row
            return {"answer": eta_utc, "explanation": "Earliest inbound truck ETA for the part at the location", "inputs": {"part": part, "location": location, "truck_id": truck_id, "po_id": po_id, "unload_min": unload_min, "priority": priority}}
        # Case 2: part only → earliest across all locations
        if part and not location:
            row = cur.execute(
                """
                WITH pos_for_part AS (
                  SELECT DISTINCT li.po_id
                  FROM po_line_items li
                  JOIN components c ON c.componentid = li.componentid
                  WHERE c.componentid = ? OR lower(c.name) LIKE '%' || lower(?) || '%'
                )
                SELECT t.truck_id, t.po_id, t.location, t.eta_utc, t.unload_min, t.priority
                FROM inbound_trucks t
                JOIN pos_for_part p ON p.po_id = t.po_id
                ORDER BY datetime(t.eta_utc) ASC
                LIMIT 1
                """,
                (part, part)
            ).fetchone()
            if not row:
                return {"answer": None, "explanation": "No inbound trucks found for that part", "inputs": {"part": part}}
            truck_id, po_id, loc, eta_utc, unload_min, priority = row
            return {"answer": eta_utc, "explanation": "Earliest inbound ETA for the part (any location)", "inputs": {"part": part, "location": loc, "truck_id": truck_id, "po_id": po_id}}
        # Case 3: location only → earliest inbound at that location
        if location and not part:
            row = cur.execute(
                """
                SELECT truck_id, po_id, location, eta_utc, unload_min, priority
                FROM inbound_trucks
                WHERE location = ?
                ORDER BY datetime(eta_utc) ASC
                LIMIT 1
                """,
                (location,)
            ).fetchone()
            if not row:
                return {"answer": None, "explanation": "No inbound trucks found at location", "inputs": {"location": location}}
            truck_id, po_id, loc, eta_utc, unload_min, priority = row
            return {"answer": eta_utc, "explanation": "Earliest inbound ETA at the location", "inputs": {"location": loc, "truck_id": truck_id, "po_id": po_id}}
        # Case 4: neither → global earliest inbound
        row = cur.execute(
            """
            SELECT truck_id, po_id, location, eta_utc, unload_min, priority
            FROM inbound_trucks
            ORDER BY datetime(eta_utc) ASC
            LIMIT 1
            """
        ).fetchone()
        if not row:
            return {"answer": None, "explanation": "No inbound trucks available", "inputs": {}}
        truck_id, po_id, loc, eta_utc, unload_min, priority = row
        return {"answer": eta_utc, "explanation": "Global earliest inbound truck ETA", "inputs": {"location": loc, "truck_id": truck_id, "po_id": po_id}}
    finally:
        conn.close()

def handle_why_reassigned(door: str) -> Dict[str, Any]:
    door = (door or "").strip()
    if not door:
        return {"answer": None, "explanation": "Missing door id", "inputs": {"door": door}}
    conn=_conn(); cur=conn.cursor()
    try:
        # Look for the most recent reassignment/assigned events for this door
        rows = cur.execute(
            """
            SELECT ts_utc, job_type, ref_id, event_type, reason_code, reason_detail
            FROM dock_events
            WHERE door_id = ?
            ORDER BY datetime(ts_utc) DESC
            LIMIT 10
            """,
            (door,)
        ).fetchall()
        if not rows:
            return {"answer": None, "explanation": "No events found for door", "inputs": {"door": door}}
        events = [
            {
                "ts": r[0], "job_type": r[1], "ref_id": r[2], "event_type": r[3],
                "reason_code": r[4], "reason_detail": r[5]
            } for r in rows
        ]
        # Best-effort rationale from latest event
        latest = events[0]
        return {
            "answer": latest.get("reason_code") or latest.get("event_type"),
            "explanation": latest.get("reason_detail") or "Most recent door event",
            "inputs": {"door": door, "recent_events": events}
        }
    finally:
        conn.close()

def handle_door_schedule(location: str) -> Dict[str, Any]:
    location = (location or "").strip()
    if not location:
        return {"answer": None, "explanation": "Missing location", "inputs": {"location": location}}
    now = datetime.utcnow()
    horizon = now + timedelta(hours=8)
    conn=_conn(); cur=conn.cursor()
    try:
        rows = cur.execute(
            """
            SELECT door_id, job_type, ref_id, start_utc, end_utc, status
            FROM dock_assignments
            WHERE location = ?
              AND datetime(end_utc) >= ?
              AND datetime(start_utc) <= ?
            ORDER BY datetime(start_utc) ASC
            LIMIT 50
            """,
            (location, now.isoformat(sep=' '), horizon.isoformat(sep=' '))
        ).fetchall()
        schedule = [
            {
                "door_id": r[0], "job_type": r[1], "ref_id": r[2],
                "start_utc": r[3], "end_utc": r[4], "status": r[5]
            } for r in rows
        ]
        return {
            "answer": schedule,
            "explanation": f"Upcoming assignments for {location}",
            "inputs": {"location": location}
        }
    finally:
        conn.close()

def handle_assignment_info(assignment_id: str) -> Dict[str, Any]:
    assignment_id = (assignment_id or "").strip()
    if not assignment_id:
        return {"answer": None, "explanation": "Missing assignment id", "inputs": {"assignment_id": assignment_id}}
    conn=_conn(); cur=conn.cursor()
    try:
        r = cur.execute(
            """
            SELECT assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, status
            FROM dock_assignments
            WHERE assignment_id=?
            LIMIT 1
            """,
            (assignment_id,)
        ).fetchone()
        if not r:
            return {"answer": None, "explanation": "No assignment found", "inputs": {"assignment_id": assignment_id}}
        a = {
            "assignment_id": r[0], "location": r[1], "door_id": r[2], "job_type": r[3],
            "ref_id": r[4], "start_utc": r[5], "end_utc": r[6], "status": r[7]
        }
        return {"answer": a, "explanation": "Assignment details", "inputs": {"assignment_id": assignment_id}}
    finally:
        conn.close()

def handle_ref_schedule(ref_id: str) -> Dict[str, Any]:
    ref_id = (ref_id or "").strip()
    if not ref_id:
        return {"answer": None, "explanation": "Missing reference id", "inputs": {"ref_id": ref_id}}
    conn=_conn(); cur=conn.cursor()
    try:
        rows = cur.execute(
            """
            SELECT assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, status
            FROM dock_assignments
            WHERE ref_id=?
            ORDER BY datetime(start_utc) DESC
            LIMIT 10
            """,
            (ref_id,)
        ).fetchall()
        if not rows:
            return {"answer": None, "explanation": "No assignments found for reference", "inputs": {"ref_id": ref_id}}
        items=[{
            "assignment_id": r[0], "location": r[1], "door_id": r[2], "job_type": r[3],
            "ref_id": r[4], "start_utc": r[5], "end_utc": r[6], "status": r[7]
        } for r in rows]
        return {"answer": items, "explanation": "Assignments for reference id", "inputs": {"ref_id": ref_id}}
    finally:
        conn.close()

def handle_door_schedule_for_door(door_id: str) -> Dict[str, Any]:
    door_id = (door_id or "").strip()
    if not door_id:
        return {"answer": None, "explanation": "Missing door id", "inputs": {"door_id": door_id}}
    now = datetime.utcnow(); horizon = now + timedelta(hours=8)
    conn=_conn(); cur=conn.cursor()
    try:
        rows = cur.execute(
            """
            SELECT door_id, job_type, ref_id, start_utc, end_utc, status
            FROM dock_assignments
            WHERE door_id = ?
              AND datetime(end_utc) >= ?
              AND datetime(start_utc) <= ?
            ORDER BY datetime(start_utc) ASC
            LIMIT 50
            """,
            (door_id, now.isoformat(sep=' '), horizon.isoformat(sep=' '))
        ).fetchall()
        items=[{
            "door_id": r[0], "job_type": r[1], "ref_id": r[2],
            "start_utc": r[3], "end_utc": r[4], "status": r[5]
        } for r in rows]
        return {"answer": items, "explanation": f"Upcoming assignments for {door_id}", "inputs": {"door_id": door_id}}
    finally:
        conn.close()

def handle_global_schedule(limit_per_location: int = 5) -> Dict[str, Any]:
    now = datetime.utcnow(); horizon = now + timedelta(hours=8)
    conn=_conn(); cur=conn.cursor()
    try:
        rows = cur.execute(
            """
            SELECT location, door_id, job_type, ref_id, start_utc, end_utc, status
            FROM dock_assignments
            WHERE datetime(end_utc) >= ? AND datetime(start_utc) <= ?
            ORDER BY location, datetime(start_utc) ASC
            """,
            (now.isoformat(sep=' '), horizon.isoformat(sep=' '))
        ).fetchall()
        out=[]; seen={}
        for r in rows:
            loc=r[0]
            seen[loc]=seen.get(loc,0)
            if seen[loc] >= limit_per_location:
                continue
            seen[loc]+=1
            out.append({
                "location": loc, "door_id": r[1], "job_type": r[2], "ref_id": r[3],
                "start_utc": r[4], "end_utc": r[5], "status": r[6]
            })
        return {"answer": out, "explanation": "Upcoming assignments across locations (top per location)", "inputs": {}}
    finally:
        conn.close()

def handle_count_schedule(location: str|None, job_type: str|None, horizon_min: int|None) -> Dict[str, Any]:
    location = (location or "").strip()
    job_type = (job_type or "all").strip().lower()
    horizon_min = int(horizon_min) if horizon_min not in (None, "", []) else 480
    now = datetime.utcnow(); horizon = now + timedelta(minutes=horizon_min)
    conn=_conn(); cur=conn.cursor()
    try:
        sql = [
            "SELECT COUNT(*) FROM dock_assignments WHERE datetime(end_utc)>=? AND datetime(start_utc)<=?"
        ]
        params = [now.isoformat(sep=' '), horizon.isoformat(sep=' ')]
        if location:
            sql.append("AND location=?"); params.append(location)
        if job_type in ("inbound","outbound"):
            sql.append("AND job_type=?"); params.append(job_type)
        row = cur.execute(" ".join(sql), tuple(params)).fetchone()
        cnt = row[0] if row else 0
        return {"answer": int(cnt), "explanation": "Count of assignments in horizon", "inputs": {"location": location or None, "job_type": job_type, "horizon_min": horizon_min}}
    finally:
        conn.close()


@app.post("/qa")
def qa(req: QARequest):
    intent, meta, conf, source = parse_question(req.question)
    slots = meta.get("slots", {}) if isinstance(meta, dict) else {}
    token_usage = meta.get("tokenUsage") if isinstance(meta, dict) else None
    
    if intent == "earliest_eta_part":
        out = handle_earliest_eta_part(slots.get("part",""), slots.get("location",""))
    elif intent == "why_reassigned":
        out = handle_why_reassigned(slots.get("door",""))
    elif intent == "door_schedule":
        loc = slots.get("location","")
        out = handle_door_schedule(loc) if loc else handle_global_schedule()
    elif intent == "count_schedule":
        out = handle_count_schedule(slots.get("location"), slots.get("job_type"), slots.get("horizon_min"))
    else:
        # Re-ask LLM with a best-effort routing prompt, then call DB-backed handlers
        intent2, meta2, conf2 = llm_router.llm_route_best_effort(req.question)
        slots2 = meta2.get("slots", {}) if isinstance(meta2, dict) else {}
        token_usage = meta2.get("tokenUsage") if isinstance(meta2, dict) else None
        
        if intent2 == "earliest_eta_part":
            out = handle_earliest_eta_part(slots2.get("part",""), slots2.get("location",""))
        elif intent2 == "why_reassigned":
            out = handle_why_reassigned(slots2.get("door",""))
        elif intent2 == "count_schedule":
            out = handle_count_schedule(slots2.get("location"), slots2.get("job_type"), slots2.get("horizon_min"))
        else:  # door_schedule default, but tailor to question ids if present
            q = req.question or ""
            import re
            m = re.search(r"\bASG-[A-Z]{3}-\d{5}\b", q.upper())
            if m:
                out = handle_assignment_info(m.group(0))
            else:
                # ref ids
                m = re.search(r"\bT-[A-Z]{3}-\d{3}\b|\bL-[A-Z]{3}-\d{3}\b", q.upper())
                if m:
                    out = handle_ref_schedule(m.group(0))
                else:
                    # door id
                    m = re.search(r"\b[A-Z]{3}-D\d{2}\b", q.upper())
                    if m:
                        out = handle_door_schedule_for_door(m.group(0))
                    else:
                        loc = slots2.get("location")
                        out = handle_door_schedule(loc) if loc else handle_global_schedule()
        # prefer confidence from second pass when used
        conf = conf2
        source = "llm"
    
    out["router"] = {"source": source, "confidence": conf}
    
    # Add token usage to response if available
    if token_usage:
        import os
        model_name = os.getenv("LLM_MODEL", "gpt-4o-mini")
        provider_name = os.getenv("LLM_PROVIDER", "openai").lower()
        
        out["tokenUsage"] = {
            "model": model_name,
            "provider": provider_name,
            **token_usage
        }
        
        # Log token usage
        log_token_usage(intent, model_name, provider_name, token_usage, req.question)
    
    return out

