import sqlite3, os, uuid, json
from datetime import datetime
from .schemas import RequestInboundSlot, RequestOutboundSlot, Proposal, Decision
from .heuristic import greedy_assign
from .solver import solve_batch
from .validate import hard_checks, score_confidence

DB = os.getenv("DB_PATH","./data/ev_supply_chain.db")
MAX_WAIT_MIN = int(os.getenv("MAX_WAIT_MIN", "30"))

def _conn(): return sqlite3.connect(DB, detect_types=sqlite3.PARSE_DECLTYPES)

def _log_event(conn, location, door_id, job_type, ref_id, event_type, reason_code, detail_dict):
    c = conn.cursor()
    c.execute("""INSERT INTO dock_events(event_id, location, door_id, job_type, ref_id, event_type, reason_code, reason_detail)
                 VALUES(?,?,?,?,?,?,?,?)""",
              (f"evt-{uuid.uuid4().hex[:8]}", location, door_id, job_type, ref_id,
               event_type, reason_code, json.dumps(detail_dict or {})))
    conn.commit()

def propose_inbound(req: RequestInboundSlot) -> Proposal|None:
    conn=_conn()
    best = greedy_assign(conn, "inbound", req.truck_id, req.location, req.eta_utc, req.unload_min,
                         deadline=None, priority=req.priority, max_wait_min=req.window_min)
    if not best:
        conn.close(); return None
    prop = Proposal(
        task_id=req.task_id,
        proposal_id=f"prop-{uuid.uuid4().hex[:8]}",
        job_type="inbound",
        ref_id=req.truck_id,
        location=req.location,
        door_id=best["door_id"],
        start_utc=best["start"],
        end_utc=best["end"],
        local_cost=float(best["local_cost"]),
        lateness_min=int(best["lateness"]),
        feasibility={"crew":"auto","mhe_ok":True}
    )
    conn.close()
    return prop

def propose_outbound(req: RequestOutboundSlot) -> Proposal|None:
    conn=_conn()
    earliest = datetime.utcnow().replace(second=0, microsecond=0)
    best = greedy_assign(conn, "outbound", req.load_id, req.location, earliest, req.load_min,
                         deadline=req.cutoff_utc, priority=req.priority, max_wait_min=req.window_min)
    if not best:
        conn.close(); return None
    prop = Proposal(
        task_id=req.task_id,
        proposal_id=f"prop-{uuid.uuid4().hex[:8]}",
        job_type="outbound",
        ref_id=req.load_id,
        location=req.location,
        door_id=best["door_id"],
        start_utc=best["start"],
        end_utc=best["end"],
        local_cost=float(best["local_cost"]),
        lateness_min=int(best["lateness"]),
        feasibility={"crew":"auto","mhe_ok":True}
    )
    conn.close()
    return prop

def decide_and_commit(proposals: list[Proposal]) -> Decision:
    conn=_conn(); c=conn.cursor()
    accepted=[]; penalties=0.0
    for p in proposals:
        ok, why = hard_checks(conn, p)
        conf = score_confidence(ok, p.lateness_min, p.local_cost, penalties=0.0)
        if ok and conf >= 0.6:
            detail = {"local_cost": p.local_cost, "lateness_min": p.lateness_min}
            c.execute("""INSERT OR REPLACE INTO dock_assignments
                (assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, crew, status, why_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
              (f"asg-{uuid.uuid4().hex[:8]}", p.location, p.door_id, p.job_type, p.ref_id,
               p.start_utc.isoformat(sep=' '), p.end_utc.isoformat(sep=' '),
               p.feasibility.get("crew","auto"), "scheduled", json.dumps(detail)))
            _log_event(conn, p.location, p.door_id, p.job_type, p.ref_id,
                       "assigned", "heuristic_choice", detail)
            accepted.append(p)
        else:
            penalties += 0.1
    conn.commit(); conn.close()
    avg_conf = (sum(score_confidence(True, p.lateness_min, p.local_cost) for p in accepted)/len(accepted)) if accepted else 0.0
    return Decision(decision_id=f"dec-{uuid.uuid4().hex[:8]}", accepted_proposals=accepted, confidence=avg_conf, why=["heuristic_commit"])

def optimize_batch_and_commit(requests: list[dict], location: str) -> Decision:
    conn=_conn(); c=conn.cursor()
    doors=[r[0] for r in c.execute("SELECT door_id FROM dock_doors WHERE location=? AND is_active=1",(location,)).fetchall()]
    if not doors:
        conn.close();  return Decision(decision_id="dec-none", accepted_proposals=[], confidence=0.0, why=["no_doors"])
    time_ref = datetime.utcnow().replace(second=0, microsecond=0)
    sol = solve_batch(requests, doors, time_ref)
    accepted=[]
    for req in requests:
        s = sol.get(req["id"])
        if not s: continue
        p = Proposal(
            task_id=f"task-{req['id']}",
            proposal_id=f"prop-{uuid.uuid4().hex[:8]}",
            job_type=req["job_type"],
            ref_id=req["id"],
            location=location,
            door_id=s["door_id"],
            start_utc=s["start"],
            end_utc=s["end"],
            local_cost=float(s["local_cost"]),
            lateness_min=int(s["lateness"]),
            feasibility={"crew":"auto","mhe_ok":True}
        )
        ok, _ = hard_checks(conn, p)
        if ok:
            detail = {"local_cost": p.local_cost, "lateness_min": p.lateness_min}
            c.execute("""INSERT OR REPLACE INTO dock_assignments
                (assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, crew, status, why_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
              (f"asg-{uuid.uuid4().hex[:8]}", p.location, p.door_id, p.job_type, p.ref_id,
               p.start_utc.isoformat(sep=' '), p.end_utc.isoformat(sep=' '),
               p.feasibility.get("crew","auto"), "scheduled", json.dumps(detail)))
            _log_event(conn, p.location, p.door_id, p.job_type, p.ref_id, "assigned", "solver_choice", detail)
            accepted.append(p)
    conn.commit(); conn.close()
    conf = 0.0 if not accepted else sum(1.0 - min(max(p.lateness_min,0)/60.0,1.0)*0.3 for p in accepted)/len(accepted)
    return Decision(decision_id=f"dec-{uuid.uuid4().hex[:8]}", accepted_proposals=accepted, confidence=conf, why=["solver_commit"])
