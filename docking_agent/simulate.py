import os, sqlite3, random
from datetime import datetime, timedelta

DB = os.getenv("DB_PATH","./data/ev_supply_chain.db")

def seed_doors_and_resources(location="Fremont CA", n_doors=6):
    conn=sqlite3.connect(DB); c=conn.cursor()
    for i in range(n_doors):
        c.execute("INSERT OR IGNORE INTO dock_doors(door_id, location, is_active) VALUES (?,?,1)",
                  (f"{location[:3].upper()}-D{i+1:02d}", location))
    start = datetime.utcnow().replace(second=0, microsecond=0)
    for k in range(0, 8*60, 15):
        s = start + timedelta(minutes=k)
        e = s + timedelta(minutes=15)
        c.execute("""INSERT INTO dock_resources(location, slot_start_utc, slot_end_utc, crews, forklifts)
                     VALUES (?,?,?,?,?)""", (location, s.isoformat(sep=' '), e.isoformat(sep=' '), 3, 3))
    conn.commit(); conn.close()

def seed_inbound_outbound(location="Fremont CA", n_in=8, n_out=6):
    conn=sqlite3.connect(DB); c=conn.cursor()
    now = datetime.utcnow().replace(second=0, microsecond=0)
    # inbound
    for i in range(n_in):
        eta = now + timedelta(minutes=random.randint(5, 180))
        unload = random.choice([20, 30, 45])
        c.execute("""INSERT OR REPLACE INTO inbound_trucks(truck_id, po_id, location, eta_utc, unload_min, priority, status)
                     VALUES (?,?,?,?,?,?,?)""",
                  (f"T-{i+1:03d}", None, location, eta.isoformat(sep=' '), unload, random.randint(0,2), "scheduled"))
    # outbound
    for j in range(n_out):
        cutoff = now + timedelta(minutes=random.randint(30, 240))
        loadm = random.choice([20, 30, 45])
        c.execute("""INSERT OR REPLACE INTO outbound_loads(load_id, location, cutoff_utc, load_min, carrier, priority, status)
                     VALUES (?,?,?,?,?,?,?)""",
                  (f"L-{j+1:03d}", location, cutoff.isoformat(sep=' '), loadm, "CarrierX", random.randint(0,2), "planned"))
    conn.commit(); conn.close()

if __name__ == "__main__":
    seed_doors_and_resources()
    seed_inbound_outbound()
    print("✔ Seeded doors/resources and inbound/outbound")
