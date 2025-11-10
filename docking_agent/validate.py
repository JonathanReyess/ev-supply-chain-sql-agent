import sqlite3
from datetime import datetime

def overlaps(a_start, a_end, b_start, b_end):
    return not (a_end <= b_start or b_end <= a_start)

def hard_checks(conn: sqlite3.Connection, proposal) -> tuple[bool,str]:
    c = conn.cursor()
    # door exists & active
    r = c.execute("SELECT is_active FROM dock_doors WHERE door_id=?", (proposal.door_id,)).fetchone()
    if not r or r[0] != 1:
        return False, "inactive_or_missing_door"
    # overlap on door/time
    q = """SELECT 1 FROM dock_assignments
           WHERE door_id=?
             AND status IN ('scheduled','in_progress')
             AND NOT( end_utc<=? OR start_utc>=? ) LIMIT 1"""
    row = c.execute(q, (proposal.door_id, proposal.start_utc, proposal.end_utc)).fetchone()
    if row:
        return False, "double_booking"
    # resource calendar sanity
    q2 = """SELECT MIN(crews), MIN(forklifts) FROM dock_resources
            WHERE location=? AND slot_start_utc>=? AND slot_end_utc<=?"""
    m = c.execute(q2, (proposal.location, proposal.start_utc, proposal.end_utc)).fetchone()
    if not m or m[0] is None:
        return False, "no_resource_calendar"
    if m[0] < 1 or m[1] < 1:
        return False, "insufficient_resources"
    return True, "ok"

def score_confidence(hard_ok: bool, lateness_min: int, heuristic_cost: float, penalties: float=0.0) -> float:
    base = 1.0 if hard_ok else 0.0
    late_pen = min(max(lateness_min,0)/60.0, 1.0)*0.3
    cost_pen = min(max(heuristic_cost,0)/60.0, 1.0)*0.3
    conf = max(0.0, min(1.0, base - late_pen - cost_pen - penalties))
    return conf
