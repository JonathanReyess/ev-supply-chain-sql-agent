#!/usr/bin/env python3
"""Seed dock_events table with realistic provenance events."""
import os, sqlite3, json, uuid, random
from datetime import datetime, timedelta

# Get DB path - check env var first, then try relative to script location, then relative to project root
DB_PATH = os.getenv("DB_PATH")
if not DB_PATH:
    # Try relative to this script (if running from docking_agent/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)  # Go up one level from docking_agent/
    db_in_project = os.path.join(project_root, "data", "ev_supply_chain.db")
    if os.path.exists(db_in_project):
        DB_PATH = db_in_project
    else:
        # Fallback to relative path (if running from project root)
        DB_PATH = "./data/ev_supply_chain.db"

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()

# Get existing assignments to create assigned events
assignments = c.execute("""
  SELECT assignment_id, location, door_id, job_type, ref_id, start_utc, created_utc
  FROM dock_assignments
  ORDER BY datetime(created_utc) DESC
  LIMIT 50
""").fetchall()

# Get doors that have multiple assignments (potential reassignments)
door_history = {}
for asg_id, loc, door, job, ref, start, created in assignments:
    if door not in door_history:
        door_history[door] = []
    door_history[door].append((asg_id, loc, job, ref, start, created))

# Create assigned events for recent assignments
for asg_id, loc, door, job, ref, start, created in assignments[:30]:
    c.execute("""
      INSERT OR IGNORE INTO dock_events(event_id, ts_utc, location, door_id, job_type, ref_id, event_type, reason_code, reason_detail)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
      f"evt-{uuid.uuid4().hex[:8]}",
      created or start,
      loc,
      door,
      job,
      ref,
      "assigned",
      random.choice(["heuristic_choice", "solver_choice"]),
      json.dumps({"assignment_id": asg_id, "source": "system"})
    ))

# Create reassigned events for doors with history
for door, history in door_history.items():
    if len(history) >= 2:
        # Find a gap where reassignment might have occurred
        for i in range(len(history) - 1):
            prev_asg, prev_loc, prev_job, prev_ref, prev_start, prev_created = history[i+1]
            curr_asg, curr_loc, curr_job, curr_ref, curr_start, curr_created = history[i]
            
            # Create a reassignment event between them
            try:
                curr_dt = datetime.fromisoformat(curr_created)
                reassign_ts = (curr_dt - timedelta(minutes=random.randint(5, 60))).isoformat(sep=' ')
            except:
                reassign_ts = prev_created
            
            # Get detailed context for previous and new assignments
            prev_truck = c.execute("SELECT truck_id, eta_utc, priority FROM inbound_trucks WHERE truck_id = ?", (prev_ref,)).fetchone()
            prev_load = c.execute("SELECT load_id, cutoff_utc, priority FROM outbound_loads WHERE load_id = ?", (prev_ref,)).fetchone()
            new_truck = c.execute("SELECT truck_id, eta_utc, priority FROM inbound_trucks WHERE truck_id = ?", (curr_ref,)).fetchone()
            new_load = c.execute("SELECT load_id, cutoff_utc, priority FROM outbound_loads WHERE load_id = ?", (curr_ref,)).fetchone()
            
            # Determine reason based on actual data
            reason = None
            reason_detail_extended = {
                "previous": {"assignment_id": prev_asg, "ref_id": prev_ref},
                "new": {"assignment_id": curr_asg, "ref_id": curr_ref}
            }
            
            # Check for priority change
            if prev_truck and new_truck:
                prev_prio = prev_truck[2] or 0
                new_prio = new_truck[2] or 0
                if new_prio > prev_prio:
                    reason = "priority_change"
                    reason_detail_extended["previous"]["priority"] = prev_prio
                    reason_detail_extended["previous"]["eta_utc"] = prev_truck[1]
                    reason_detail_extended["new"]["priority"] = new_prio
                    reason_detail_extended["new"]["eta_utc"] = new_truck[1]
                    reason_detail_extended["priority_delta"] = new_prio - prev_prio
            elif prev_load and new_load:
                prev_prio = prev_load[2] or 0
                new_prio = new_load[2] or 0
                if new_prio > prev_prio:
                    reason = "priority_change"
                    reason_detail_extended["previous"]["priority"] = prev_prio
                    reason_detail_extended["previous"]["cutoff_utc"] = prev_load[1]
                    reason_detail_extended["new"]["priority"] = new_prio
                    reason_detail_extended["new"]["cutoff_utc"] = new_load[1]
                    reason_detail_extended["priority_delta"] = new_prio - prev_prio
            
            # Check for ETA slip
            if not reason and prev_truck and new_truck:
                try:
                    prev_eta = datetime.fromisoformat(prev_truck[1])
                    new_eta = datetime.fromisoformat(new_truck[1])
                    # If new truck has earlier ETA, it's not an ETA slip - check if prev truck slipped
                    if new_eta < prev_eta:
                        # Check if there are competing assignments
                        competing = c.execute("""
                            SELECT COUNT(*) FROM dock_assignments
                            WHERE door_id = ? 
                              AND datetime(start_utc) BETWEEN datetime(?, '-30 minutes') AND datetime(?, '+30 minutes')
                              AND assignment_id != ? AND assignment_id != ?
                        """, (door, prev_start, curr_start, prev_asg, curr_asg)).fetchone()[0]
                        if competing > 0:
                            reason = "operational_conflict"
                            reason_detail_extended["competing_assignments"] = competing
                        else:
                            reason = random.choice(["eta_slip", "operational_conflict"])
                    else:
                        reason = "eta_slip"
                        reason_detail_extended["eta_delta_minutes"] = int((new_eta - prev_eta).total_seconds() / 60)
                        reason_detail_extended["previous"]["eta_utc"] = prev_truck[1]
                        reason_detail_extended["new"]["eta_utc"] = new_truck[1]
                except:
                    pass
            
            # Check for operational conflict (multiple assignments overlapping)
            if not reason:
                overlapping = c.execute("""
                    SELECT COUNT(*) FROM dock_assignments
                    WHERE door_id = ?
                      AND datetime(start_utc) BETWEEN datetime(?, '-1 hour') AND datetime(?, '+1 hour')
                      AND assignment_id NOT IN (?, ?)
                """, (door, prev_start, curr_start, prev_asg, curr_asg)).fetchone()[0]
                if overlapping > 0:
                    reason = "operational_conflict"
                    reason_detail_extended["overlapping_assignments"] = overlapping
                    reason_detail_extended["conflict_window"] = "1 hour"
                else:
                    reason = random.choice(["eta_slip", "priority_change", "operational_conflict"])
            
            reason_detail_extended["reason_detail"] = f"Door {door} reassigned due to {reason.replace('_', ' ')}"
            
            c.execute("""
              INSERT OR IGNORE INTO dock_events(event_id, ts_utc, location, door_id, job_type, ref_id, event_type, reason_code, reason_detail)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
              f"evt-{uuid.uuid4().hex[:8]}",
              reassign_ts,
              curr_loc,
              door,
              None,  # job_type is None for reassign events
              None,  # ref_id is None for reassign events
              "reassigned",
              reason,
              json.dumps(reason_detail_extended)
            ))

# Add some completed and cancelled events with detailed context
for asg_id, loc, door, job, ref, start, created in assignments[30:40]:
    try:
        start_dt = datetime.fromisoformat(start)
        end_time = (start_dt + timedelta(minutes=random.randint(20, 60))).isoformat(sep=' ')
        duration_min = int((datetime.fromisoformat(end_time) - start_dt).total_seconds() / 60)
    except:
        end_time = created
        duration_min = None
    
    # Get truck/load details for context
    truck_info = c.execute("SELECT truck_id, eta_utc, priority, unload_min FROM inbound_trucks WHERE truck_id = ?", (ref,)).fetchone()
    load_info = c.execute("SELECT load_id, cutoff_utc, priority, load_min FROM outbound_loads WHERE load_id = ?", (ref,)).fetchone()
    
    completion_detail = {
        "assignment_id": asg_id,
        "duration_minutes": duration_min,
        "status": "normal_completion"
    }
    
    if truck_info:
        completion_detail["truck"] = {
            "truck_id": truck_info[0],
            "eta_utc": truck_info[1],
            "priority": truck_info[2],
            "unload_min": truck_info[3]
        }
    if load_info:
        completion_detail["load"] = {
            "load_id": load_info[0],
            "cutoff_utc": load_info[1],
            "priority": load_info[2],
            "load_min": load_info[3]
        }
    
    c.execute("""
      INSERT OR IGNORE INTO dock_events(event_id, ts_utc, location, door_id, job_type, ref_id, event_type, reason_code, reason_detail)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
      f"evt-{uuid.uuid4().hex[:8]}",
      end_time,
      loc,
      door,
      job,
      ref,
      "completed",
      "normal_completion",
      json.dumps(completion_detail)
    ))

# Add ETA update events for trucks (to track ETA changes)
print("  Adding ETA update events...")
trucks_with_events = c.execute("""
    SELECT DISTINCT t.truck_id, t.eta_utc, t.location
    FROM inbound_trucks t
    JOIN dock_events e ON e.ref_id = t.truck_id
    WHERE e.event_type = 'assigned'
    LIMIT 20
""").fetchall()

for truck_id, current_eta, location in trucks_with_events:
    # Create a fictional ETA change event (earlier ETA that was updated)
    try:
        eta_dt = datetime.fromisoformat(current_eta)
        earlier_eta = (eta_dt - timedelta(minutes=random.randint(30, 120))).isoformat(sep=' ')
        update_time = (eta_dt - timedelta(minutes=random.randint(60, 180))).isoformat(sep=' ')
        
        # Find a door assignment for context
        door_asg = c.execute("""
            SELECT door_id FROM dock_assignments 
            WHERE ref_id = ? 
            ORDER BY datetime(start_utc) DESC 
            LIMIT 1
        """, (truck_id,)).fetchone()
        
        door_id = door_asg[0] if door_asg else None
        
        c.execute("""
          INSERT OR IGNORE INTO dock_events(event_id, ts_utc, location, door_id, job_type, ref_id, event_type, reason_code, reason_detail)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
          f"evt-{uuid.uuid4().hex[:8]}",
          update_time,
          location,
          door_id,
          "inbound",
          truck_id,
          "eta_updated",
          "eta_slip",
          json.dumps({
            "truck_id": truck_id,
            "previous_eta": earlier_eta,
            "new_eta": current_eta,
            "delay_minutes": int((eta_dt - datetime.fromisoformat(earlier_eta)).total_seconds() / 60)
          })
        ))
    except Exception as e:
        pass  # Skip if datetime parsing fails

conn.commit()
count = c.execute("SELECT COUNT(*) FROM dock_events").fetchone()[0]
conn.close()
print(f"✔ Populated {count} dock events (assigned, reassigned, completed)")

