import os
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Tuple, Dict, Any
import sqlite3
from datetime import datetime, timedelta

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

class QARequest(BaseModel):
    question: str

def parse_question(question: str) -> Tuple[str, Dict[str, Any], float, str]:
    """Parse a natural-language question into an intent and slots.

    Uses the LLM router when enabled; otherwise returns unknown intent.
    Returns: (intent, slots, confidence, source)
    """
    try:
        intent, meta, conf = llm_router.llm_route(question)
        slots = meta.get("slots", {}) if isinstance(meta, dict) else {}
        source = "llm" if intent not in ("disabled", "unknown") else "router"
        if intent == "disabled":
            return "unknown", {}, 0.0, "disabled"
        return intent, slots, float(conf or 0.0), source
    except Exception:
        return "unknown", {}, 0.0, "error"

def _conn():
    db_path = os.getenv("DB_PATH", "./data/ev_supply_chain.db")
    return sqlite3.connect(db_path)

def handle_earliest_eta_part(part: str, location: str) -> Dict[str, Any]:
    part = (part or "").strip()
    location = (location or "").strip()
    if not part or not location:
        return {"answer": None, "explanation": "Missing part or location", "inputs": {"part": part, "location": location}}
    # If the user passed a component ID like C00015, match directly. Otherwise try token match on component name
    q = {
        "sql": """
            WITH pos_for_part AS (
              SELECT DISTINCT li.po_id
              FROM po_line_items li
              JOIN components c ON c.componentid = li.componentid
              WHERE (
                c.componentid = ?
                OR lower(c.name) LIKE '%' || lower(?) || '%'
              )
            )
            SELECT t.truck_id, t.po_id, t.location, t.eta_utc, t.unload_min, t.priority
            FROM inbound_trucks t
            JOIN pos_for_part p ON p.po_id = t.po_id
            WHERE t.location = ?
            ORDER BY datetime(t.eta_utc) ASC
            LIMIT 1;
        """,
        "params": (part, part, location)
    }
    conn = _conn(); cur = conn.cursor()
    try:
        row = cur.execute(q["sql"], q["params"]).fetchone()
        if not row:
            return {"answer": None, "explanation": "No inbound trucks found for that part/location", "inputs": {"part": part, "location": location}}
        truck_id, po_id, loc, eta_utc, unload_min, priority = row
        return {
            "answer": eta_utc,
            "explanation": "Earliest inbound truck ETA for the part at the location",
            "inputs": {"part": part, "location": location, "truck_id": truck_id, "po_id": po_id, "unload_min": unload_min, "priority": priority}
        }
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


@app.post("/qa")
def qa(req: QARequest):
    intent, slots, conf, source = parse_question(req.question)
    if intent == "earliest_eta_part":
        out = handle_earliest_eta_part(slots.get("part",""), slots.get("location",""))
    elif intent == "why_reassigned":
        out = handle_why_reassigned(slots.get("door",""))
    elif intent == "door_schedule":
        out = handle_door_schedule(slots.get("location",""))
    else:
        # Re-ask LLM with a best-effort routing prompt, then call DB-backed handlers
        intent2, meta2, conf2 = llm_router.llm_route_best_effort(req.question)
        slots2 = meta2.get("slots", {}) if isinstance(meta2, dict) else {}
        if intent2 == "earliest_eta_part":
            out = handle_earliest_eta_part(slots2.get("part",""), slots2.get("location",""))
        elif intent2 == "why_reassigned":
            out = handle_why_reassigned(slots2.get("door",""))
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
                        loc = slots2.get("location", "Fremont CA")
                        out = handle_door_schedule(loc)
        # prefer confidence from second pass when used
        conf = conf2
        source = "llm"
    out["router"] = {"source": source, "confidence": conf}
    return out

