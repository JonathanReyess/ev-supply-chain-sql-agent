import os, sqlite3, random, uuid
from datetime import datetime, timedelta, timezone

DB = os.getenv("DB_PATH","./data/ev_supply_chain.db")

def seed_doors_and_resources(location="Fremont CA", n_doors=6):
    conn=sqlite3.connect(DB); c=conn.cursor()
    for i in range(n_doors):
        c.execute("INSERT OR IGNORE INTO dock_doors(door_id, location, is_active) VALUES (?,?,1)",
                  (f"{location[:3].upper()}-D{i+1:02d}", location))
    start = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    for k in range(0, 8*60, 15):
        s = start + timedelta(minutes=k)
        e = s + timedelta(minutes=15)
        c.execute("""INSERT INTO dock_resources(location, slot_start_utc, slot_end_utc, crews, forklifts)
                     VALUES (?,?,?,?,?)""", (location, s.isoformat(sep=' '), e.isoformat(sep=' '), 3, 3))
    conn.commit(); conn.close()

def seed_inbound_outbound(location="Fremont CA", n_in=8, n_out=6):
    conn=sqlite3.connect(DB); c=conn.cursor()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    
    # Get some actual PO IDs from the database
    pos = c.execute("SELECT DISTINCT po_id FROM purchase_orders LIMIT 20").fetchall()
    po_list = [row[0] for row in pos] if pos else [None] * n_in
    
    # Get some actual door IDs
    doors = c.execute(f"SELECT door_id FROM dock_doors WHERE location=? AND is_active=1", (location,)).fetchall()
    door_list = [row[0] for row in doors] if doors else []
    
    # inbound - Link to real POs
    for i in range(n_in):
        eta = now + timedelta(minutes=random.randint(5, 180))
        unload = random.choice([20, 30, 45])
        po_id = random.choice(po_list) if po_list else None
        c.execute("""INSERT OR REPLACE INTO inbound_trucks(truck_id, po_id, location, eta_utc, unload_min, priority, status)
                     VALUES (?,?,?,?,?,?,?)""",
                  (f"T-FRE-{i+1:03d}", po_id, location, eta.isoformat(sep=' '), unload, random.randint(0,2), "scheduled"))
        
        # Create some dock assignments for inbound trucks
        if door_list and i < 4:  # Assign first 4 trucks
            door = random.choice(door_list)
            start_time = eta
            end_time = start_time + timedelta(minutes=unload)
            c.execute("""INSERT OR REPLACE INTO dock_assignments
                (assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, crew, status)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (f"ASG-FRE-{i+1:05d}", location, door, "inbound", f"T-FRE-{i+1:03d}",
                 start_time.isoformat(sep=' '), end_time.isoformat(sep=' '), "auto", "scheduled"))
    
    # outbound
    for j in range(n_out):
        cutoff = now + timedelta(minutes=random.randint(30, 240))
        loadm = random.choice([20, 30, 45])
        c.execute("""INSERT OR REPLACE INTO outbound_loads(load_id, location, cutoff_utc, load_min, carrier, priority, status)
                     VALUES (?,?,?,?,?,?,?)""",
                  (f"L-FRE-{j+1:03d}", location, cutoff.isoformat(sep=' '), loadm, "CarrierX", random.randint(0,2), "planned"))
        
        # Create some dock assignments for outbound
        if door_list and j < 3:  # Assign first 3 loads
            door = random.choice(door_list)
            start_time = cutoff - timedelta(minutes=loadm)
            end_time = cutoff
            c.execute("""INSERT OR REPLACE INTO dock_assignments
                (assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, crew, status)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (f"ASG-FRE-{n_in+j+1:05d}", location, door, "outbound", f"L-FRE-{j+1:03d}",
                 start_time.isoformat(sep=' '), end_time.isoformat(sep=' '), "auto", "scheduled"))
    
    conn.commit(); conn.close()

if __name__ == "__main__":
    seed_doors_and_resources()
    seed_inbound_outbound()
    print("✔ Seeded doors/resources and inbound/outbound")
