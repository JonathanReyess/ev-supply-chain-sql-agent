from datetime import datetime, timedelta
import sqlite3

def load_free_windows(conn: sqlite3.Connection, location: str, horizon_min: int=240):
    c = conn.cursor()
    doors = [r[0] for r in c.execute(
        "SELECT door_id FROM dock_doors WHERE location=? AND is_active=1", (location,)
    ).fetchall()]
    now = datetime.utcnow().replace(second=0, microsecond=0)
    windows = {d: [(now, now+timedelta(minutes=horizon_min))] for d in doors}
    rows = c.execute("""SELECT door_id, start_utc, end_utc
                        FROM dock_assignments
                        WHERE location=? AND end_utc>=?""", (location, now)).fetchall()
    for door, s, e in rows:
        s = datetime.fromisoformat(s); e = datetime.fromisoformat(e)
        new=[]
        for (ws,we) in windows.get(door,[]):
            if e<=ws or s>=we:
                new.append((ws,we))
            else:
                if ws < s: new.append((ws, s))
                if e < we: new.append((e, we))
        windows[door]=new
    return windows

def greedy_assign(conn, job_type, ref_id, location, earliest, duration_min, deadline=None, priority=0, max_wait_min=30):
    c=conn.cursor()
    free = load_free_windows(conn, location)
    best=None
    for door, slots in free.items():
        for ws,we in slots:
            start = max(ws, earliest)
            end = start + timedelta(minutes=duration_min)
            if end > we: continue
            lateness = 0
            if deadline:
                from math import floor
                lateness = max(0, int((end - deadline).total_seconds()//60))
            wait = max(0, int((start - earliest).total_seconds()//60))
            if wait > max_wait_min: continue
            local_cost = wait + 2*lateness - 5*priority
            cand = dict(door_id=door, start=start, end=end, lateness=lateness, local_cost=local_cost)
            if (best is None) or (cand["local_cost"] < best["local_cost"]):
                best = cand
    return best
