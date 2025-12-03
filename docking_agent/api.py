import os
from fastapi import FastAPI, Query
from pydantic import BaseModel
from typing import Tuple, Dict, Any, Optional
import sqlite3
from datetime import datetime, timedelta
import time
import json

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
    from . import call_logger
except ImportError:
    import llm_router
    import call_logger

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

def handle_optimize_schedule(location: str, horizon_min: int = 240) -> Dict[str, Any]:
    """Optimize dock schedule using solver for pending trucks/loads at a location"""
    from .agent import optimize_batch_and_commit
    
    location = (location or "").strip()
    if not location:
        return {"answer": None, "explanation": "Location required for optimization", "inputs": {"location": location}}
    
    # Get pending inbound trucks and outbound loads within horizon
    now = datetime.utcnow(); horizon = now + timedelta(minutes=horizon_min)
    conn=_conn(); cur=conn.cursor()
    try:
        # Get inbound trucks
        inbound_rows = cur.execute("""
            SELECT truck_id, eta_utc, unload_min, priority
            FROM inbound_trucks
            WHERE location = ? 
              AND status IN ('scheduled', 'pending')
              AND datetime(eta_utc) <= ?
            ORDER BY datetime(eta_utc) ASC
            LIMIT 50
        """, (location, horizon.isoformat(sep=' '))).fetchall()
        
        # Get outbound loads
        outbound_rows = cur.execute("""
            SELECT load_id, cutoff_utc, load_min, priority
            FROM outbound_loads
            WHERE location = ?
              AND status IN ('planned', 'pending')
              AND datetime(cutoff_utc) >= ?
            ORDER BY datetime(cutoff_utc) ASC
            LIMIT 50
        """, (location, now.isoformat(sep=' '))).fetchall()
        
        conn.close()
        
        # Build request list for solver
        requests = []
        for truck_id, eta_utc_str, unload_min, priority in inbound_rows:
            eta_utc = datetime.fromisoformat(eta_utc_str.replace(' ', 'T'))
            requests.append({
                "id": truck_id,
                "job_type": "inbound",
                "location": location,
                "earliest": eta_utc,
                "deadline": eta_utc + timedelta(hours=2),  # 2 hour window
                "duration_min": unload_min,
                "priority": priority or 0
            })
        
        for load_id, cutoff_utc_str, load_min, priority in outbound_rows:
            cutoff_utc = datetime.fromisoformat(cutoff_utc_str.replace(' ', 'T'))
            requests.append({
                "id": load_id,
                "job_type": "outbound",
                "location": location,
                "earliest": cutoff_utc - timedelta(minutes=load_min),
                "deadline": cutoff_utc,
                "duration_min": load_min,
                "priority": priority or 0
            })
        
        if not requests:
            return {
                "answer": None,
                "explanation": f"No pending trucks/loads found at {location} within {horizon_min} minute horizon",
                "inputs": {"location": location, "horizon_min": horizon_min}
            }
        
        # Run solver optimization
        decision = optimize_batch_and_commit(requests, location)
        
        # Format response
        assignments = []
        for prop in decision.accepted_proposals:
            assignments.append({
                "ref_id": prop.ref_id,
                "job_type": prop.job_type,
                "door_id": prop.door_id,
                "start_utc": prop.start_utc.isoformat(),
                "end_utc": prop.end_utc.isoformat(),
                "local_cost": prop.local_cost,
                "lateness_min": prop.lateness_min
            })
        
        return {
            "answer": {
                "decision_id": decision.decision_id,
                "assignments": assignments,
                "confidence": decision.confidence,
                "total_assigned": len(assignments),
                "total_requested": len(requests)
            },
            "explanation": f"Optimized {len(assignments)}/{len(requests)} pending jobs using constraint solver",
            "inputs": {"location": location, "horizon_min": horizon_min}
        }
    except Exception as e:
        if 'conn' in locals():
            conn.close()
        return {
            "answer": None,
            "explanation": f"Optimization failed: {str(e)}",
            "inputs": {"location": location, "horizon_min": horizon_min}
        }


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
    """
    Main QA endpoint with integrated call logging for LLM-as-a-judge evaluation.
    
    Logs every call to agent_call_logs table with:
    - User question
    - Router intent and slots
    - Handler execution details
    - SQL queries
    - Performance metrics
    - Errors (if any)
    - Answer summary
    """
    start_time = time.time()
    handler_name = None
    sql_or_query = None
    rows_returned = None
    error = None
    answer_summary = None
    
    try:
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
            handler_name = "handle_earliest_eta_part"
            sql_or_query = f"Query for part={slots.get('part')}, location={slots.get('location')}"
        out = handle_earliest_eta_part(slots.get("part",""), slots.get("location",""))
    elif intent == "why_reassigned":
            handler_name = "handle_why_reassigned"
            sql_or_query = f"Query for door={slots.get('door')}"
        out = handle_why_reassigned(slots.get("door",""))
    elif intent == "door_schedule":
            handler_name = "handle_door_schedule"
            loc = slots.get("location","")
            if not loc:
                loc = _extract_location_from_text(req.question)
            sql_or_query = f"Query for location={loc or 'global'}"
            out = handle_door_schedule(loc) if loc else handle_global_schedule()
        elif intent == "count_schedule":
            handler_name = "handle_count_schedule"
            loc = slots.get("location") or ""
            if not loc:
                loc = _extract_location_from_text(req.question)
            job_type = slots.get("job_type") or ""
            horizon_min = slots.get("horizon_min")
            sql_or_query = f"COUNT query: location={loc or 'all'}, job_type={job_type or 'all'}, horizon={horizon_min}"
            out = handle_count_schedule(loc if loc else None, job_type if job_type else None, horizon_min)
        elif intent == "optimize_schedule":
            handler_name = "handle_optimize_schedule"
            loc = slots.get("location","")
            if not loc:
                loc = _extract_location_from_text(req.question)
            horizon_min = slots.get("horizon_min") or 240
            sql_or_query = f"Optimization query: location={loc}, horizon={horizon_min}min"
            if loc:
                out = handle_optimize_schedule(loc, horizon_min)
            else:
                out = {"answer": None, "explanation": "Location required for optimization", "inputs": {}}
        else:
            # Re-ask LLM with a best-effort routing prompt, then call DB-backed handlers
            intent2, meta2, conf2 = llm_router.llm_route_best_effort(req.question)
            slots2 = meta2.get("slots", {}) if isinstance(meta2, dict) else {}
            if intent2 == "earliest_eta_part":
                handler_name = "handle_earliest_eta_part"
                sql_or_query = f"Query for part={slots2.get('part')}, location={slots2.get('location')}"
                out = handle_earliest_eta_part(slots2.get("part",""), slots2.get("location",""))
            elif intent2 == "why_reassigned":
                handler_name = "handle_why_reassigned"
                sql_or_query = f"Query for door={slots2.get('door')}"
                out = handle_why_reassigned(slots2.get("door",""))
            elif intent2 == "count_schedule":
                handler_name = "handle_count_schedule"
                loc = slots2.get("location") or ""
                if not loc:
                    loc = _extract_location_from_text(req.question)
                job_type = slots2.get("job_type") or ""
                horizon_min = slots2.get("horizon_min")
                sql_or_query = f"COUNT query: location={loc or 'all'}, job_type={job_type or 'all'}, horizon={horizon_min}"
                out = handle_count_schedule(loc if loc else None, job_type if job_type else None, horizon_min)
        else:  # door_schedule default, but tailor to question ids if present
            q = req.question or ""
            import re
            
            # Extract location from question text if not in slots
            loc_from_text = _extract_location_from_text(q)
            if loc_from_text and not slots2.get("location"):
                slots2["location"] = loc_from_text
            
            # Check for optimization queries first (before other patterns)
            if re.search(r'\b(optimize|optimise|reoptimize|re-optimize|batch.*assign|improve.*schedule)\b', q.lower()):
                horizon_min = 300  # 5 hours default
                time_match = re.search(r'(\d+)\s*(hour|hr)', q.lower())
                if time_match:
                    horizon_min = int(time_match.group(1)) * 60
                if loc_from_text:
                    out = handle_optimize_schedule(loc_from_text, horizon_min)
                else:
                    out = {"answer": None, "explanation": "Location required for optimization", "inputs": {}}
            # Check for count queries
            elif re.search(r'\b(how many|count|number of|total|how much)\b', q.lower()):
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
            intent = intent2
            slots = slots2
        
        # Extract answer summary and row count
        if isinstance(out, dict) and "answer" in out:
            answer_summary = call_logger.format_answer_summary(out, max_len=500)
            answer_value = out["answer"]
            if isinstance(answer_value, list):
                rows_returned = len(answer_value)
            elif isinstance(answer_value, int):
                rows_returned = answer_value
            else:
                rows_returned = 1 if answer_value is not None else 0
        else:
            answer_summary = str(out)[:500]
            rows_returned = 0
        
    out["router"] = {"source": source, "confidence": conf}
        
        # Calculate latency
        latency_ms = int((time.time() - start_time) * 1000)
        
        # Log the successful call
        try:
            call_logger.log_agent_call(
                user_question=req.question,
                router_intent=intent,
                slots=slots,
                target_agent="docking",
                handler_name=handler_name,
                sql_or_query=sql_or_query,
                rows_returned=rows_returned,
                latency_ms=latency_ms,
                error=None,
                answer_summary=answer_summary
            )
        except Exception as log_error:
            # Don't fail the request if logging fails
            print(f"Warning: Failed to log agent call: {log_error}")
        
    return out
        
    except Exception as e:
        # Log the failed call
        latency_ms = int((time.time() - start_time) * 1000)
        error = repr(e)
        
        try:
            call_logger.log_agent_call(
                user_question=req.question,
                router_intent=intent if 'intent' in locals() else None,
                slots=slots if 'slots' in locals() else None,
                target_agent="docking",
                handler_name=handler_name,
                sql_or_query=sql_or_query,
                rows_returned=0,
                latency_ms=latency_ms,
                error=error,
                answer_summary="ERROR: " + str(e)[:200]
            )
        except Exception as log_error:
            print(f"Warning: Failed to log error: {log_error}")
        
        # Re-raise the original exception
        raise


@app.post("/analysis/eval")
def trigger_evaluation(
    limit: int = Query(50, description="Maximum number of calls to evaluate"),
    errors_only: bool = Query(False, description="Only evaluate calls with errors"),
    since_hours: Optional[int] = Query(None, description="Only evaluate calls from last N hours"),
    judge_model: str = Query("gpt-4o-mini", description="LLM model to use for judging")
):
    """
    Trigger LLM-as-a-judge evaluation on recent agent calls.
    
    This endpoint:
    1. Fetches recent unevaluated calls from agent_call_logs
    2. Sends them to a judge LLM with a rubric-based prompt
    3. Parses the JSON evaluation scores
    4. Writes evaluations to agent_call_evals
    
    Inspired by "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" (Zheng et al., NeurIPS 2023).
    
    Parameters:
    - limit: Max number of calls to evaluate (default: 50)
    - errors_only: Only evaluate calls with errors (default: False)
    - since_hours: Only evaluate calls from last N hours (default: all)
    - judge_model: LLM model to use for judging (default: gpt-4o-mini)
    
    Returns:
    - Summary of evaluation results with statistics
    """
    try:
        # Import eval_agent module
        try:
            from . import eval_agent
        except ImportError:
            import eval_agent
        
        # Run evaluation
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
    """
    Get evaluation statistics.
    
    Returns aggregate statistics on agent call evaluations:
    - Total calls logged
    - Total calls evaluated
    - Average usefulness score
    - Severity breakdown
    - Error rate
    
    Parameters:
    - since_hours: Only include calls from last N hours (default: all)
    """
    try:
        conn = _conn()
        cur = conn.cursor()
        
        # Build time filter
        time_filter = ""
        params = []
        if since_hours:
            time_filter = "WHERE datetime(l.created_utc) > datetime('now', ?)"
            params.append(f"-{since_hours} hours")
        
        # Get stats
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
    severity: Optional[str] = Query(None, description="Filter by severity (ok|minor_issue|major_issue)")
):
    """
    Get recent evaluations with full details.
    
    Returns a list of recent evaluations including:
    - Original question and answer
    - Evaluation scores
    - Judge feedback
    
    Parameters:
    - limit: Number of evaluations to return (default: 10)
    - severity: Filter by severity level (optional)
    """
    try:
        conn = _conn()
        cur = conn.cursor()
        
        # Build query
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
        
        # Format results
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

