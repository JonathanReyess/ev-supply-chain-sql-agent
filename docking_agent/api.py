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

try:
    from . import llm_router
except ImportError:
    import llm_router

app = FastAPI(title="Docking Agent API")

class QARequest(BaseModel):
    question: str

def parse_question(question: str, context: Dict[str, Any] = None) -> Tuple[str, Dict[str, Any], float, str]:
    """Parse a natural-language question into an intent and slots.

    Uses the LLM router when enabled; otherwise returns unknown intent.
    Args:
        question: Natural language question
        context: Optional context dict to pass to LLM router
    Returns: (intent, slots, confidence, source)
    """
    try:
        intent, meta, conf = llm_router.llm_route(question, context=context)
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
    
    # Handle numeric door references (e.g., "4" or "door 4")
    import re
    door_num_match = re.search(r'\b(\d{1,2})\b', door)
    if door_num_match and not re.search(r'[A-Z]{3}-D', door.upper()):
        # Just a number - search for door_id ending in -D## across all locations
        door_num = door_num_match.group(1).zfill(2)  # pad to 2 digits
        door_pattern = f"%-D{door_num}"
        conn=_conn(); cur=conn.cursor()
        try:
            # First try to find a door with this number
            door_rows = cur.execute(
                "SELECT door_id, location FROM dock_doors WHERE door_id LIKE ? LIMIT 1",
                (door_pattern,)
            ).fetchall()
            if door_rows:
                door_id = door_rows[0][0]
            else:
                # If no door found, try to find recent events with door numbers
                rows = cur.execute(
                    """
                    SELECT door_id, ts_utc, job_type, ref_id, event_type, reason_code, reason_detail
                    FROM dock_events
                    WHERE door_id LIKE ?
                    ORDER BY datetime(ts_utc) DESC
                    LIMIT 10
                    """,
                    (door_pattern,)
                ).fetchall()
                if rows:
                    door_id = rows[0][0]
                else:
                    return {"answer": None, "explanation": f"No door found matching '{door}'", "inputs": {"door": door}}
        finally:
            conn.close()
    else:
        # Already a proper door ID format
        door_id = door.upper()
    
    conn=_conn(); cur=conn.cursor()
    try:
        # First, specifically look for reassignment events for this door
        reassign_rows = cur.execute(
            """
            SELECT ts_utc, job_type, ref_id, event_type, reason_code, reason_detail
            FROM dock_events
            WHERE door_id = ? AND event_type = 'reassigned'
            ORDER BY datetime(ts_utc) DESC
            LIMIT 5
            """,
            (door_id,)
        ).fetchall()
        
        # Also get recent events for context
        all_rows = cur.execute(
            """
            SELECT ts_utc, job_type, ref_id, event_type, reason_code, reason_detail
            FROM dock_events
            WHERE door_id = ?
            ORDER BY datetime(ts_utc) DESC
            LIMIT 10
            """,
            (door_id,)
        ).fetchall()
        
        if not all_rows:
            return {"answer": None, "explanation": f"No events found for door {door_id}", "inputs": {"door": door_id}}
        
        # Use reassignment events if found, otherwise use all events
        rows = reassign_rows if reassign_rows else all_rows
        
        events = []
        for r in rows:
            event_dict = {
                "ts": r[0], "job_type": r[1], "ref_id": r[2], "event_type": r[3],
                "reason_code": r[4], "reason_detail": r[5]
            }
            # Parse reason_detail JSON if available
            if r[5]:
                try:
                    import json
                    event_dict["reason_detail_parsed"] = json.loads(r[5])
                except:
                    pass
            events.append(event_dict)
        
        # Find the most recent reassignment event
        reassign_event = next((e for e in events if e.get("event_type") == "reassigned"), None)
        
        if reassign_event:
            # Enhanced context for reassignment
            context = {
                "door_id": door_id,
                "reassignment_time": reassign_event["ts"],
                "reason_code": reassign_event["reason_code"],
                "reason_detail": reassign_event.get("reason_detail_parsed") or reassign_event.get("reason_detail")
            }
            
            # Get assignment context if available
            if reassign_event.get("reason_detail_parsed"):
                prev_ref = reassign_event["reason_detail_parsed"].get("previous", {}).get("ref_id")
                new_ref = reassign_event["reason_detail_parsed"].get("new", {}).get("ref_id")
                
                if prev_ref:
                    # Get previous assignment/truck details
                    prev_truck = cur.execute(
                        "SELECT truck_id, eta_utc, priority FROM inbound_trucks WHERE truck_id = ?",
                        (prev_ref,)
                    ).fetchone()
                    if prev_truck:
                        context["previous_truck"] = {
                            "truck_id": prev_truck[0],
                            "eta_utc": prev_truck[1],
                            "priority": prev_truck[2]
                        }
                    
                    prev_load = cur.execute(
                        "SELECT load_id, cutoff_utc, priority FROM outbound_loads WHERE load_id = ?",
                        (prev_ref,)
                    ).fetchone()
                    if prev_load:
                        context["previous_load"] = {
                            "load_id": prev_load[0],
                            "cutoff_utc": prev_load[1],
                            "priority": prev_load[2]
                        }
                
                if new_ref:
                    # Get new assignment/truck details
                    new_truck = cur.execute(
                        "SELECT truck_id, eta_utc, priority FROM inbound_trucks WHERE truck_id = ?",
                        (new_ref,)
                    ).fetchone()
                    if new_truck:
                        context["new_truck"] = {
                            "truck_id": new_truck[0],
                            "eta_utc": new_truck[1],
                            "priority": new_truck[2]
                        }
                    
                    new_load = cur.execute(
                        "SELECT load_id, cutoff_utc, priority FROM outbound_loads WHERE load_id = ?",
                        (new_ref,)
                    ).fetchone()
                    if new_load:
                        context["new_load"] = {
                            "load_id": new_load[0],
                            "cutoff_utc": new_load[1],
                            "priority": new_load[2]
                        }
            
            # Get assignments around the time of reassignment
            assignments_around = cur.execute(
                """
                SELECT assignment_id, ref_id, start_utc, end_utc, status, created_utc
                FROM dock_assignments
                WHERE door_id = ? 
                  AND datetime(start_utc) BETWEEN datetime(?, '-2 hours') AND datetime(?, '+2 hours')
                ORDER BY datetime(start_utc)
                """,
                (door_id, reassign_event["ts"], reassign_event["ts"])
            ).fetchall()
            if assignments_around:
                context["assignments_around_time"] = [
                    {
                        "assignment_id": a[0], "ref_id": a[1], "start_utc": a[2],
                        "end_utc": a[3], "status": a[4], "created_utc": a[5]
                    } for a in assignments_around
                ]
            
            # Build explanation with context from reason_detail
            explanation_parts = [f"Door {door_id} was reassigned at {reassign_event['ts']}"]
            if reassign_event["reason_code"]:
                explanation_parts.append(f"Reason: {reassign_event['reason_code'].replace('_', ' ')}")
            
            # Extract detailed context from reason_detail_parsed
            reason_detail = context.get("reason_detail")
            # If it's a string, try to parse it
            if isinstance(reason_detail, str):
                try:
                    import json
                    reason_detail = json.loads(reason_detail)
                except:
                    reason_detail = None
            
            if isinstance(reason_detail, dict):
                # Priority change details
                if reason_detail.get("priority_delta"):
                    delta = reason_detail["priority_delta"]
                    explanation_parts.append(f"Priority increased by {delta} (from {reason_detail.get('previous', {}).get('priority', 'unknown')} to {reason_detail.get('new', {}).get('priority', 'unknown')})")
                
                # ETA slip details
                if reason_detail.get("eta_delta_minutes"):
                    delay = reason_detail["eta_delta_minutes"]
                    explanation_parts.append(f"ETA slipped by {delay} minutes")
                
                # Operational conflict details
                if reason_detail.get("competing_assignments"):
                    competing = reason_detail["competing_assignments"]
                    explanation_parts.append(f"{competing} competing assignments detected")
                elif reason_detail.get("overlapping_assignments"):
                    overlapping = reason_detail["overlapping_assignments"]
                    explanation_parts.append(f"{overlapping} overlapping assignments in conflict window")
            
            # Fallback to truck/load priority comparison if available
            if context.get("previous_truck") and context.get("new_truck"):
                prev_prio = context["previous_truck"]["priority"]
                new_prio = context["new_truck"]["priority"]
                if new_prio > prev_prio and not any("priority" in p.lower() for p in explanation_parts):
                    explanation_parts.append(f"Higher priority truck (priority {new_prio} vs {prev_prio})")
            
            if context.get("previous_load") and context.get("new_load"):
                prev_prio = context["previous_load"]["priority"]
                new_prio = context["new_load"]["priority"]
                if new_prio > prev_prio and not any("priority" in p.lower() for p in explanation_parts):
                    explanation_parts.append(f"Higher priority load (priority {new_prio} vs {prev_prio})")
            
            return {
                "answer": reassign_event["reason_code"] or "reassigned",
                "explanation": ". ".join(explanation_parts),
                "context": context,
                "inputs": {"door": door_id, "original_query": door, "recent_events": events[:5]}
            }
        else:
            # No reassignment found, return most recent event
            latest = events[0]
            return {
                "answer": latest.get("reason_code") or latest.get("event_type"),
                "explanation": latest.get("reason_detail") or "Most recent door event",
                "inputs": {"door": door_id, "original_query": door, "recent_events": events[:5]}
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
            SELECT location, door_id, job_type, ref_id, start_utc, end_utc, status
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
                "location": r[0], "door_id": r[1], "job_type": r[2], "ref_id": r[3],
                "start_utc": r[4], "end_utc": r[5], "status": r[6]
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


def _extract_location_from_text(text: str) -> str:
    """Extract location from question text using pattern matching and DB lookup."""
    if not text:
        return ""
    text_lower = text.lower()
    import re
    
    # Known locations from schema
    known_locations = [
        "Fremont CA", "Austin TX", "Shanghai", "Berlin", 
        "Nevada Gigafactory", "Raleigh Service Center"
    ]
    
    # Try exact matches first
    for loc in known_locations:
        if loc.lower() in text_lower:
            return loc
    
    # Try partial matches (e.g., "Fremont" -> "Fremont CA")
    location_keywords = {
        "fremont": "Fremont CA",
        "austin": "Austin TX",
        "shanghai": "Shanghai",
        "berlin": "Berlin",
        "nevada": "Nevada Gigafactory",
        "gigafactory": "Nevada Gigafactory",
        "raleigh": "Raleigh Service Center"
    }
    for keyword, full_loc in location_keywords.items():
        if keyword in text_lower:
            return full_loc
    
    return ""

def _extract_structured_context(question: str) -> Dict[str, Any]:
    """Extract structured context from question before LLM routing.
    
    This implements the orchestrator's pre-processing step to provide
    the LLM with structured hints for systematic analysis.
    """
    import re
    context = {}
    q_lower = question.lower()
    
    # Extract location hints
    location = _extract_location_from_text(question)
    if location:
        context["location_hint"] = location
    
    # Extract priority hints
    if re.search(r'\b(urgent|critical|high priority|asap|emergency)\b', q_lower):
        context["priority_hint"] = "high"
    elif re.search(r'\b(low priority|whenever|not urgent|optional)\b', q_lower):
        context["priority_hint"] = "low"
    else:
        context["priority_hint"] = "normal"
    
    # Extract time horizon hints
    time_match = re.search(r'(\d+)\s*(hour|hr|minute|min|day)', q_lower)
    if time_match:
        value = int(time_match.group(1))
        unit = time_match.group(2)
        if 'hour' in unit or 'hr' in unit:
            context["horizon_minutes"] = value * 60
        elif 'day' in unit:
            context["horizon_minutes"] = value * 24 * 60
        else:
            context["horizon_minutes"] = value
    
    # Extract job type hints
    if re.search(r'\b(inbound|receiving|unload|arrival|incoming)\b', q_lower):
        context["job_type_hint"] = "inbound"
    elif re.search(r'\b(outbound|shipping|load|departure|outgoing)\b', q_lower):
        context["job_type_hint"] = "outbound"
    
    # Extract door ID hints
    door_match = re.search(r'\b([A-Z]{3}-D\d{2})\b', question.upper())
    if door_match:
        context["door_id_hint"] = door_match.group(1)
    else:
        door_num_match = re.search(r'\bdoor\s*(\d{1,2})\b', q_lower)
        if door_num_match:
            context["door_number_hint"] = door_num_match.group(1)
    
    # Extract part/component hints
    part_match = re.search(r'\b(C\d{5})\b', question.upper())
    if part_match:
        context["part_hint"] = part_match.group(1)
    
    # Extract truck/load ID hints
    truck_match = re.search(r'\b(T-[A-Z]{3}-\d{3})\b', question.upper())
    if truck_match:
        context["truck_id_hint"] = truck_match.group(1)
    
    load_match = re.search(r'\b(L-[A-Z]{3}-\d{3})\b', question.upper())
    if load_match:
        context["load_id_hint"] = load_match.group(1)
    
    # Extract assignment ID hints
    assignment_match = re.search(r'\b(ASG-[A-Z]{3}-\d{5})\b', question.upper())
    if assignment_match:
        context["assignment_id_hint"] = assignment_match.group(1)
    
    # Detect question intent hints
    if re.search(r'\b(why|reason|cause|because|explain)\b', q_lower):
        context["intent_hint"] = "causal_analysis"
    elif re.search(r'\b(how many|count|number of|total|sum)\b', q_lower):
        context["intent_hint"] = "count_query"
    elif re.search(r'\b(when|earliest|eta|arrival|next)\b', q_lower):
        context["intent_hint"] = "time_query"
    elif re.search(r'\b(schedule|assignments|what.*happening|status)\b', q_lower):
        context["intent_hint"] = "schedule_query"
    
    return context

@app.post("/qa")
def qa(req: QARequest):
    # Pre-process question to extract structured context (orchestrator-style)
    context = _extract_structured_context(req.question)
    
    # Route through LLM with systematic approach
    intent, slots, conf, source = parse_question(req.question, context=context)
    
    # If location is missing but might be in the question, extract it
    if not slots.get("location") and req.question:
        extracted_loc = _extract_location_from_text(req.question)
        if extracted_loc:
            slots["location"] = extracted_loc
    
    if intent == "earliest_eta_part":
        out = handle_earliest_eta_part(slots.get("part",""), slots.get("location",""))
    elif intent == "why_reassigned":
        out = handle_why_reassigned(slots.get("door",""))
    elif intent == "door_schedule":
        loc = slots.get("location","")
        if not loc:
            loc = _extract_location_from_text(req.question)
        out = handle_door_schedule(loc) if loc else handle_global_schedule()
    elif intent == "count_schedule":
        loc = slots.get("location") or ""
        if not loc:
            loc = _extract_location_from_text(req.question)
        job_type = slots.get("job_type") or ""
        horizon_min = slots.get("horizon_min")
        out = handle_count_schedule(loc if loc else None, job_type if job_type else None, horizon_min)
    else:
        # Re-ask LLM with a best-effort routing prompt, then call DB-backed handlers
        intent2, meta2, conf2 = llm_router.llm_route_best_effort(req.question)
        slots2 = meta2.get("slots", {}) if isinstance(meta2, dict) else {}
        if intent2 == "earliest_eta_part":
            out = handle_earliest_eta_part(slots2.get("part",""), slots2.get("location",""))
        elif intent2 == "why_reassigned":
            out = handle_why_reassigned(slots2.get("door",""))
        elif intent2 == "count_schedule":
            loc = slots2.get("location") or ""
            if not loc:
                loc = _extract_location_from_text(q)
            job_type = slots2.get("job_type") or ""
            horizon_min = slots2.get("horizon_min")
            out = handle_count_schedule(loc if loc else None, job_type if job_type else None, horizon_min)
        else:  # door_schedule default, but tailor to question ids if present
            q = req.question or ""
            import re
            
            # Extract location from question text if not in slots
            loc_from_text = _extract_location_from_text(q)
            if loc_from_text and not slots2.get("location"):
                slots2["location"] = loc_from_text
            
            # Check for count queries first (before other patterns)
            if re.search(r'\b(how many|count|number of|total|how much)\b', q.lower()):
                job_type_match = re.search(r'\b(inbound|outbound)\b', q.lower())
                job_type = job_type_match.group(1) if job_type_match else None
                out = handle_count_schedule(loc_from_text if loc_from_text else None, job_type, None)
            # Check for "why reassigned" patterns even if intent wasn't detected
            elif re.search(r'\bwhy\b.*\b(reassigned|re-assigned|changed|moved)\b', q.lower()) or \
               re.search(r'\breassigned\b.*\bwhy\b', q.lower()) or \
               re.search(r'\b(reassigned|re-assigned).*\bdoor\b', q.lower()):
                door_match = re.search(r'\bdoor\s*(\d{1,2})\b|\b(\d{1,2})\b.*\bdoor\b', q.lower())
                if door_match:
                    door_num = door_match.group(1) or door_match.group(2)
                    out = handle_why_reassigned(door_num)
                else:
                    m = re.search(r"\b[A-Z]{3}-D\d{2}\b", q.upper())
                    if m:
                        out = handle_why_reassigned(m.group(0))
                    else:
                        loc = slots2.get("location") or loc_from_text
                        out = handle_door_schedule(loc) if loc else handle_global_schedule()
            else:
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
                            # Check for "doors" or "schedule" with location
                            if ("door" in q.lower() or "schedule" in q.lower()) and loc_from_text:
                                out = handle_door_schedule(loc_from_text)
                            else:
                                loc = slots2.get("location") or loc_from_text
                                out = handle_door_schedule(loc) if loc else handle_global_schedule()
        # prefer confidence from second pass when used
        conf = conf2
        source = "llm"
    out["router"] = {"source": source, "confidence": conf}
    return out

