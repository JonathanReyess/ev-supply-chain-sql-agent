#!/usr/bin/env python3
"""
Full Synthetic EV Supply Chain Data Generator (10 Tables)
Generates realistic data and saves it directly to the ./data folder as ev_supply_chain.db
"""

import random
import pandas as pd
import numpy as np
import os
import sqlite3
from datetime import datetime, timedelta
from faker import Faker
from datetime import datetime, timedelta, timezone


# --- Configuration & Seeding ---
fake = Faker()
Faker.seed(42)
random.seed(42)
np.random.seed(42)

# Project Constants
DB_NAME = 'ev_supply_chain.db'
OUTPUT_DIR = './data'

# EV Supply Chain Domain-Specific Configurations
VEHICLE_MODELS = ['Model E', 'Model G', 'Roadster', 'Cybertruck']
COUNTRIES = ['China', 'USA', 'Germany', 'Japan', 'South Korea', 'Taiwan']
COMPONENT_TYPES = {
    'Battery': ['Cell', 'Module', 'BMS', 'Pack Housing'],
    'Motor': ['Stator', 'Rotor', 'Inverter', 'Gearbox'],
    'Chassis': ['Frame', 'Suspension Arm', 'Brake Pad', 'Wheel Assembly'],
    'Electronics': ['MCU', 'Sensor Array', 'Wiring Harness', 'Control Chip'],
}
WAREHOUSE_LOCATIONS = ['Fremont CA', 'Austin TX', 'Shanghai', 'Berlin', 'Nevada Gigafactory']
PO_STATUSES = ['Pending', 'Shipped', 'Delivered', 'Delayed', 'Cancelled']
DEFECT_TYPES = ['Dimensional', 'Material Failure', 'Functional Issue', 'Cosmetic', 'None']

def loc_code(name: str) -> str:
    # "Fremont CA" -> "FRE", "Nevada Gigafactory" -> "NEV"
    parts = name.replace('Gigafactory','').strip().split()
    if not parts: return "LOC"
    raw = ''.join([p[0] for p in parts])  # initials
    return raw[:3].upper().ljust(3, 'X')

class EVSupplyChainGenerator:
    """Generates interconnected dataframes for the EV supply chain."""
    def __init__(self, n_suppliers=50, n_components=200, n_pos=1000, n_inventory=10000):
        self.n_suppliers = n_suppliers
        self.n_components = n_components
        self.n_pos = n_pos
        self.n_inventory = n_inventory
        self.start_date = datetime(2024, 1, 1)
        self.end_date = datetime(2025, 12, 31)

    # --- 1. Suppliers Table ---
    def generate_suppliers(self):
        suppliers = []
        for i in range(self.n_suppliers):
            country = random.choice(COUNTRIES)
            suppliers.append({
                'SupplierID': f'S{i+1:04d}',
                'Name': fake.company(),
                'LocationCountry': country,
                'LocationCity': fake.city(),
                'ReliabilityScore': random.randint(70, 100),
                'LeadTimeDays': random.randint(7, 60),
            })
        return pd.DataFrame(suppliers)

    # --- 2. Components Table ---
    def generate_components(self, suppliers_df):
        components = []
        supplier_ids = suppliers_df['SupplierID'].tolist()
        i = 0
        for comp_type, sub_types in COMPONENT_TYPES.items():
            for sub_type in sub_types:
                for _ in range(self.n_components // (len(COMPONENT_TYPES) * len(sub_types)) + 1):
                    i += 1
                    components.append({
                        'ComponentID': f'C{i:05d}',
                        'Name': f'{sub_type} - {fake.unique.word()[:5]}',
                        'Type': comp_type,
                        'UnitCost': round(random.uniform(5.50, 8500.00), 2),
                        'TargetStock': random.randint(1000, 50000),
                        'SupplierID': random.choice(supplier_ids),
                    })
        return pd.DataFrame(components).head(self.n_components)

    # --- 3. Purchase Orders (Header) Table ---
    def generate_purchase_orders(self, suppliers_df):
        pos = []
        supplier_ids = suppliers_df['SupplierID'].tolist()
        for i in range(self.n_pos):
            order_date = fake.date_time_between(start_date=self.start_date, end_date=self.end_date)
            status = random.choice(PO_STATUSES)
            delivery_date = order_date + timedelta(days=random.randint(5, 70))
            pos.append({
                'PO_ID': f'PO{i+1:06d}',
                'SupplierID': random.choice(supplier_ids),
                'OrderDate': order_date.strftime('%Y-%m-%d %H:%M:%S'),
                'DeliveryDateEstimate': delivery_date.strftime('%Y-%m-%d'),
                'Status': status,
                'TotalCost': 0.0, # Will be updated by line items
            })
        return pd.DataFrame(pos)

    # --- 4. PO Line Items Table ---
    def generate_po_line_items(self, pos_df, components_df):
        line_items = []
        component_ids = components_df['ComponentID'].tolist()
        po_ids = pos_df['PO_ID'].tolist()
        
        # Keep track of PO costs to update the header later
        po_costs = {po_id: 0.0 for po_id in po_ids}
        
        line_num = 1
        for po_id in po_ids:
            num_items = random.randint(1, 5)
            for i in range(num_items):
                component_id = random.choice(component_ids)
                component_info = components_df[components_df['ComponentID'] == component_id].iloc[0]
                
                quantity = random.randint(50, 500)
                unit_cost = component_info['UnitCost']
                line_total = quantity * unit_cost

                line_items.append({
                    'LineItemID': f'L{line_num:08d}',
                    'PO_ID': po_id,
                    'ComponentID': component_id,
                    'QuantityOrdered': quantity,
                    'UnitCostAtOrder': unit_cost,
                    'LineTotal': line_total
                })
                po_costs[po_id] += line_total
                line_num += 1

        # Update PO TotalCost in the header dataframe
        for po_id, total in po_costs.items():
            pos_df.loc[pos_df['PO_ID'] == po_id, 'TotalCost'] = round(total, 2)

        return pd.DataFrame(line_items)

    # --- 5. Inventory Table ---
    def generate_inventory(self, components_df):
        inventory = []
        component_ids = components_df['ComponentID'].tolist()
        
        for i in range(self.n_inventory):
            component_id = random.choice(component_ids)
            warehouse_id = random.choice(WAREHOUSE_LOCATIONS)
            quantity = random.randint(0, 5000)
            days_ago = random.randint(1, 365)
            last_updated = (datetime.now() - timedelta(days=days_ago)).strftime('%Y-%m-%d %H:%M:%S')
            
            inventory.append({
                'InventoryID': f'I{i+1:08d}',
                'ComponentID': component_id,
                'WarehouseLocation': warehouse_id,
                'QuantityInStock': quantity,
                'LastUpdated': last_updated,
            })
        return pd.DataFrame(inventory)

    # --- 6. Production Lines Table ---
    def generate_production_lines(self):
        lines = []
        for i, loc in enumerate(WAREHOUSE_LOCATIONS):
            lines.append({
                'LineID': f'PL{i+1:03d}',
                'Location': loc,
                'VehicleModel': random.choice(VEHICLE_MODELS),
                'CapacityPerDay': random.randint(50, 150),
            })
        return pd.DataFrame(lines)

# --- 7. Production Schedule Table ---
    def generate_production_schedule(self, lines_df):
        schedule = []
        line_ids = lines_df['LineID'].tolist()
        i = 0
        current_date = self.start_date
        
        while current_date <= self.end_date:
            for line_id in line_ids:
                i += 1
                line_info = lines_df[lines_df['LineID'] == line_id].iloc[0]
                
                # 1. Calculate planned vehicles (always >= 1)
                planned_vehicles = random.randint(max(1, line_info['CapacityPerDay'] - 20), line_info['CapacityPerDay'])
                
                # 2. Calculate actual vehicles (allow small dips due to realistic issues)
                # Ensure ActualVehicles is not less than zero.
                baseline_actual = planned_vehicles - random.randint(0, 15)
                actual_vehicles = max(0, baseline_actual) # Ensure it's not negative
                
                schedule.append({
                    'ScheduleID': f'SCH{i:08d}',
                    'LineID': line_id,
                    'Date': current_date.strftime('%Y-%m-%d'),
                    'PlannedVehicles': planned_vehicles,
                    'ActualVehicles': actual_vehicles,
                    'ModelProduced': line_info['VehicleModel'],
                })
            current_date += timedelta(days=1)
        return pd.DataFrame(schedule)
    # --- 8. Component Usage Table (Bill of Materials tracking) ---
    def generate_component_usage(self, schedule_df, components_df):
        usage = []
        schedule_ids = schedule_df['ScheduleID'].tolist()
        component_ids = components_df['ComponentID'].tolist()
        
        for schedule_id in random.sample(schedule_ids, 2000): # Sample 2000 days
            num_components_used = random.randint(5, 15)
            for comp_id in random.sample(component_ids, num_components_used):
                quantity_per_vehicle = random.randint(1, 4)
                
                schedule_info = schedule_df[schedule_df['ScheduleID'] == schedule_id].iloc[0]
                actual_vehicles = schedule_info['ActualVehicles']
                
                usage.append({
                    'UsageID': f'U{fake.unique.random_number(digits=8):08d}',
                    'ScheduleID': schedule_id,
                    'ComponentID': comp_id,
                    'QuantityPerVehicle': quantity_per_vehicle,
                    'TotalQuantityUsed': quantity_per_vehicle * actual_vehicles,
                })
        return pd.DataFrame(usage)

    # --- 9. Quality Checks Table ---
    def generate_quality_checks(self, pos_df, components_df):
        quality = []
        po_ids = pos_df[pos_df['Status'] == 'Delivered']['PO_ID'].tolist()
        component_ids = components_df['ComponentID'].tolist()
        
        for po_id in random.sample(po_ids, min(500, len(po_ids))): # Check 500 delivered POs
            check_date = fake.date_time_between(start_date=self.start_date, end_date=self.end_date)
            component_id = random.choice(component_ids)
            
            is_pass = random.choices([True, False], weights=[0.85, 0.15], k=1)[0]
            defect_type = random.choice(DEFECT_TYPES) if not is_pass else 'None'
            
            quality.append({
                'CheckID': f'Q{fake.unique.random_number(digits=8):08d}',
                'PO_ID': po_id,
                'ComponentID': component_id,
                'CheckDate': check_date.strftime('%Y-%m-%d %H:%M:%S'),
                'IsPass': is_pass,
                'DefectType': defect_type,
            })
        return pd.DataFrame(quality)

    # --- 10. Shipments Table ---
    def generate_shipments(self, pos_df):
        shipments = []
        po_ids = pos_df['PO_ID'].tolist()
        
        for i in range(len(po_ids)):
            po_info = pos_df[pos_df['PO_ID'] == po_ids[i]].iloc[0]
            
            shipment_date = fake.date_time_between(start_date=pd.to_datetime(po_info['OrderDate']), 
                                                   end_date=pd.to_datetime(po_info['DeliveryDateEstimate']) + timedelta(days=10))
            
            shipments.append({
                'ShipmentID': f'SH{i+1:08d}',
                'PO_ID': po_ids[i],
                'TrackingNumber': fake.bothify(text='TN-##########-??'),
                'ShipmentDate': shipment_date.strftime('%Y-%m-%d %H:%M:%S'),
                'CurrentStatus': po_info['Status'], # Inherit status for simplicity
                'ShippingCost': round(po_info['TotalCost'] * random.uniform(0.01, 0.05), 2),
            })
        return pd.DataFrame(shipments)
        # --- A. Dock doors (per warehouse/DC) ---
    def generate_dock_doors(self):
        rows = []
        for loc in WAREHOUSE_LOCATIONS:
            n_doors = np.random.randint(6, 16)  # typical mid-size DC: 6–15 doors
            code = loc_code(loc)
            for i in range(1, n_doors+1):
                rows.append({
                    'door_id': f'{code}-D{i:02d}',
                    'location': loc,
                    'is_active': 1
                })
        return pd.DataFrame(rows)

    # --- B. Dock resources (3 shifts, 15-min granularity for next 24h) ---
    def generate_dock_resources(self, horizon_hours=24, slot_min=15):
        rows = []
        now = datetime.utcnow().replace(second=0, microsecond=0, tzinfo=None)
        slots = int((horizon_hours*60)//slot_min)
        for loc in WAREHOUSE_LOCATIONS:
            for s in range(slots):
                start = now + timedelta(minutes=s*slot_min)
                end   = start + timedelta(minutes=slot_min)
                hour = start.hour
                # staffing by shift (roughly realistic)
                if 6 <= hour < 14:   # Day
                    crews = np.random.randint(3, 6)      # 3–5 crews
                    forklifts = np.random.randint(3, 7)  # 3–6 FLs
                elif 14 <= hour < 22: # Swing
                    crews = np.random.randint(2, 5)
                    forklifts = np.random.randint(2, 6)
                else:                 # Night
                    crews = np.random.randint(1, 4)
                    forklifts = np.random.randint(1, 4)
                rows.append({
                    'location': loc,
                    'slot_start_utc': start.strftime('%Y-%m-%d %H:%M:%S'),
                    'slot_end_utc':   end.strftime('%Y-%m-%d %H:%M:%S'),
                    'crews': int(crews),
                    'forklifts': int(forklifts),
                })
        return pd.DataFrame(rows)

    # --- C. Inbound trucks (derived from POs; ETAs cluster around DeliveryDateEstimate ± jitter) ---
    def generate_inbound_trucks(self, pos_df, po_line_items_df, components_df, per_loc=40):
        rows = []
        # Join to infer priority by component type (battery/electronics higher)
        li = po_line_items_df.merge(components_df[['ComponentID','Type']], on='ComponentID', how='left')
        po_types = li.groupby('PO_ID')['Type'].apply(lambda s: s.mode().iloc[0] if len(s)>0 else 'Other').to_dict()

        for loc in WAREHOUSE_LOCATIONS:
            for i in range(per_loc):
                po = pos_df.sample(1).iloc[0]
                eta_base = pd.to_datetime(po['DeliveryDateEstimate']) if not pd.isna(po['DeliveryDateEstimate']) else \
                           fake.date_time_between(start_date=self.start_date, end_date=self.end_date)
                # realistic jitter: -2d to +3d, but clamp to next 48h for demo utility
                jitter_min = int(np.random.randint(-24*2, 24*3))
                eta = (pd.to_datetime(eta_base) + pd.to_timedelta(jitter_min, unit='m')).to_pydatetime()
                if eta < datetime.utcnow():  # keep near-future for demos
                    eta = datetime.utcnow() + timedelta(minutes=int(np.random.randint(10, 8*60)))

                comp_type = po_types.get(po['PO_ID'], 'Other')
                # unload time: pallets vs modules etc.
                if comp_type == 'Battery':
                    unload = np.random.choice([30, 45, 60], p=[0.3, 0.5, 0.2])
                    priority = np.random.choice([1,2,3], p=[0.2, 0.5, 0.3])
                elif comp_type == 'Electronics':
                    unload = np.random.choice([20, 30, 45], p=[0.2, 0.6, 0.2])
                    priority = np.random.choice([0,1,2], p=[0.3,0.5,0.2])
                else:
                    unload = np.random.choice([20, 30, 45])
                    priority = np.random.choice([0,1])

                rows.append({
                    'truck_id': f'T-{loc_code(loc)}-{fake.random_int(min=100, max=999)}',
                    'po_id': po['PO_ID'],
                    'location': loc,
                    'eta_utc': eta.strftime('%Y-%m-%d %H:%M:%S'),
                    'unload_min': int(unload),
                    'priority': int(priority),
                    'status': 'scheduled'
                })
        # dedupe truck_ids if collisions (rare)
        df = pd.DataFrame(rows).drop_duplicates(subset=['truck_id'])
        return df

    # --- D. Outbound loads (carrier cutoffs within next ~12h) ---
    def generate_outbound_loads(self, per_loc=25):
        carriers = ['UPS', 'FedEx', 'DHL', 'XPO', 'R+L', 'Old Dominion']
        rows = []
        now = datetime.utcnow().replace(second=0, microsecond=0)
        for loc in WAREHOUSE_LOCATIONS:
            for _ in range(per_loc):
                cutoff = now + timedelta(minutes=int(np.random.randint(45, 12*60)))
                loadm  = int(np.random.choice([20, 30, 45]))
                priority = int(np.random.choice([0,1,2,3], p=[0.4,0.3,0.2,0.1]))
                rows.append({
                    'load_id': f'L-{loc_code(loc)}-{fake.random_int(min=100, max=999)}',
                    'location': loc,
                    'cutoff_utc': cutoff.strftime('%Y-%m-%d %H:%M:%S'),
                    'load_min': loadm,
                    'carrier': random.choice(carriers),
                    'priority': priority,
                    'status': 'planned'
                })
        return pd.DataFrame(rows).drop_duplicates(subset=['load_id'])

    # --- E. Build a simple, conflict-free schedule for next 8h (greedy by earliest ETA / nearest cutoff) ---
    def generate_dock_assignments(self, doors_df, resources_df, inbound_df, outbound_df, horizon_hours=8):
        rows = []
        now = datetime.utcnow().replace(second=0, microsecond=0)
        horizon_end = now + timedelta(hours=horizon_hours)

        # Pre-index resources (availability map by location -> time slots) for a simple check
        resources_df['slot_start_utc'] = pd.to_datetime(resources_df['slot_start_utc'])
        resources_df['slot_end_utc']   = pd.to_datetime(resources_df['slot_end_utc'])

        def next_free_window(existing, start, dur_min):
            """Greedy search for earliest non-overlapping [start, start+dur] across existing list."""
            cand_start = start
            cand_end = cand_start + timedelta(minutes=dur_min)
            # Keep pushing by 5 min if overlaps
            while True:
                overlap = any(not (cand_end <= s or e <= cand_start) for (s,e) in existing)
                if not overlap: return cand_start, cand_end
                cand_start += timedelta(minutes=5)
                if cand_start > horizon_end: return None, None
                cand_end = cand_start + timedelta(minutes=dur_min)

        for loc in WAREHOUSE_LOCATIONS:
            code = loc_code(loc)
            door_ids = doors_df[doors_df['location']==loc]['door_id'].tolist()
            # schedule state per door
            scheduled = {d: [] for d in door_ids}

            # inbound first (by ETA)
            inbound_loc = inbound_df[(inbound_df['location']==loc)]
            inbound_loc['eta_utc'] = pd.to_datetime(inbound_loc['eta_utc'])
            inbound_loc = inbound_loc[(inbound_loc['eta_utc'] <= horizon_end)].sort_values(['eta_utc','priority'], ascending=[True, False])

            for _, t in inbound_loc.iterrows():
                # pick door with earliest feasible slot
                best = None
                for d in door_ids:
                    s, e = next_free_window(scheduled[d], t['eta_utc'], int(t['unload_min']))
                    if s is None: continue
                    # basic resource check: require crews>=1 and forklifts>=1 throughout interval
                    res = resources_df[(resources_df['location']==loc) & (resources_df['slot_start_utc']>=s) & (resources_df['slot_end_utc']<=e)]
                    if len(res)==0 or res['crews'].min()<1 or res['forklifts'].min()<1:
                        continue
                    if (best is None) or (s < best[1]):  # earliest finish
                        best = (d, e, s)
                if best:
                    d, e, s = best
                    scheduled[d].append((s,e))
                    rows.append({
                        'assignment_id': f'ASG-{code}-{fake.random_int(min=10000, max=99999)}',
                        'location': loc,
                        'door_id': d,
                        'job_type': 'inbound',
                        'ref_id': t['truck_id'],
                        'start_utc': s.strftime('%Y-%m-%d %H:%M:%S'),
                        'end_utc':   e.strftime('%Y-%m-%d %H:%M:%S'),
                        'crew': f'Crew-{np.random.randint(1,6)}',
                        'created_utc': now.strftime('%Y-%m-%d %H:%M:%S'),
                        'status': 'scheduled'
                    })

            # outbound next (by nearest cutoff)
            outbound_loc = outbound_df[(outbound_df['location']==loc)]
            outbound_loc['cutoff_utc'] = pd.to_datetime(outbound_loc['cutoff_utc'])
            outbound_loc = outbound_loc[(outbound_loc['cutoff_utc'] <= horizon_end)].sort_values(['cutoff_utc','priority'], ascending=[True, False])

            for _, l in outbound_loc.iterrows():
                # try to finish at/before cutoff; back-schedule
                desired_end = l['cutoff_utc'] - timedelta(minutes=int(np.random.choice([0,5,10,15])))
                desired_start = desired_end - timedelta(minutes=int(l['load_min']))
                # door search
                best=None
                for d in door_ids:
                    s, e = next_free_window(scheduled[d], desired_start, int(l['load_min']))
                    if s is None: continue
                    # resource sanity
                    res = resources_df[(resources_df['location']==loc) & (resources_df['slot_start_utc']>=s) & (resources_df['slot_end_utc']<=e)]
                    if len(res)==0 or res['crews'].min()<1 or res['forklifts'].min()<1:
                        continue
                    lateness = max(0, int((e - l['cutoff_utc']).total_seconds()//60))
                    score = lateness*5 + int((e - desired_end).total_seconds()//60)
                    if (best is None) or (score < best[0]):
                        best = (score, d, s, e)
                if best:
                    _, d, s, e = best
                    scheduled[d].append((s,e))
                    rows.append({
                        'assignment_id': f'ASG-{code}-{fake.random_int(min=10000, max=99999)}',
                        'location': loc,
                        'door_id': d,
                        'job_type': 'outbound',
                        'ref_id': l['load_id'],
                        'start_utc': s.strftime('%Y-%m-%d %H:%M:%S'),
                        'end_utc':   e.strftime('%Y-%m-%d %H:%M:%S'),
                        'crew': f'Crew-{np.random.randint(1,6)}',
                        'created_utc': now.strftime('%Y-%m-%d %H:%M:%S'),
                        'status': 'scheduled'
                    })

        return pd.DataFrame(rows)

    # --- F. Yard queue (trucks arriving within next 90 min but not yet scheduled) ---
    def generate_yard_queue(self, inbound_df, assignments_df):
        rows=[]
        now = datetime.utcnow().replace(second=0, microsecond=0)
        assigned_trucks = set(assignments_df[assignments_df['job_type']=='inbound']['ref_id'].tolist())
        inbound_df['eta_utc'] = pd.to_datetime(inbound_df['eta_utc'])
        soon = inbound_df[(inbound_df['eta_utc'] >= now) & (inbound_df['eta_utc'] <= now + timedelta(minutes=90))]
        # rank per location by ETA
        for loc, g in soon.groupby('location'):
            g = g.sort_values('eta_utc')
            for pos, (_, r) in enumerate(g.iterrows(), start=1):
                if r['truck_id'] in assigned_trucks: 
                    continue
                rows.append({
                    'location': loc,
                    'truck_id': r['truck_id'],
                    'position': pos,
                    'created_utc': now.strftime('%Y-%m-%d %H:%M:%S')
                })
        return pd.DataFrame(rows)


    def generate_all(self):
        """Generate complete dataset and return as a dictionary of DataFrames."""
        print("🏭 Generating EV Supply Chain Data...\n")
        
        suppliers_df = self.generate_suppliers()
        components_df = self.generate_components(suppliers_df)
        pos_df = self.generate_purchase_orders(suppliers_df)
        po_line_items_df = self.generate_po_line_items(pos_df.copy(), components_df)
        inventory_df = self.generate_inventory(components_df)
        lines_df = self.generate_production_lines()
        schedule_df = self.generate_production_schedule(lines_df)
        usage_df = self.generate_component_usage(schedule_df, components_df)
        quality_df = self.generate_quality_checks(pos_df, components_df)
        shipments_df = self.generate_shipments(pos_df)

        # NEW: operational docking data
        dock_doors_df      = self.generate_dock_doors()
        dock_resources_df  = self.generate_dock_resources(horizon_hours=24, slot_min=15)
        inbound_trucks_df  = self.generate_inbound_trucks(pos_df, po_line_items_df, components_df, per_loc=40)
        outbound_loads_df  = self.generate_outbound_loads(per_loc=25)
        dock_assignments_df= self.generate_dock_assignments(dock_doors_df, dock_resources_df, inbound_trucks_df, outbound_loads_df, horizon_hours=8)
        yard_queue_df      = self.generate_yard_queue(inbound_trucks_df, dock_assignments_df)

        return {
            'suppliers': suppliers_df,
            'components': components_df,
            'inventory': inventory_df,
            'purchase_orders': pos_df,
            'po_line_items': po_line_items_df,
            'production_lines': lines_df,
            'production_schedule': schedule_df,
            'component_usage': usage_df,
            'quality_checks': quality_df,
            'shipments': shipments_df,

            # 🔽 NEW tables required by the Docking Agent
            'dock_doors': dock_doors_df,
            'dock_resources': dock_resources_df,
            'inbound_trucks': inbound_trucks_df,
            'outbound_loads': outbound_loads_df,
            'dock_assignments': dock_assignments_df,
            'yard_queue': yard_queue_df
        }

# --- Database Saving Function ---
def save_to_sqlite(data_dict, db_name=DB_NAME, output_dir=OUTPUT_DIR):
    """Save all dataframes to a single SQLite database file in the specified directory."""
    os.makedirs(output_dir, exist_ok=True)
    
    db_path = os.path.join(output_dir, db_name)
    print(f"\n💾 Generating SQLite Database: {db_path}...")
    
    # Connect to the SQLite database
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Tables must be dropped in dependency order (reverse order of creation)
    table_names = list(data_dict.keys())
    for name in reversed(table_names): 
        # Convert DataFrame name to SQL-friendly format (e.g., po_line_items to "po_line_items")
        sql_name = name.lower() 
        cursor.execute(f"DROP TABLE IF EXISTS {sql_name}")
        
    for table_name, df in data_dict.items():
        # Ensure column names are SQL-friendly (lowercase and use underscores if needed)
        df.columns = [col.lower() for col in df.columns] 
        
        # Use pandas to write the DataFrame directly to a new table
        df.to_sql(table_name.lower(), conn, if_exists='replace', index=False)
        print(f"  ✓ Created table {table_name.upper()} ({len(df):,} rows)")
        
    conn.close()
    print(f"\n✅ SQLite database '{db_name}' generation complete!")

def main():
    """Main execution function."""
    print("=" * 80)
    print("  EV Supply Chain Data Generator (SQL-of-Thought Ready)")
    print("=" * 80)
    
    # Set generation parameters
    generator = EVSupplyChainGenerator(
        n_suppliers=60,
        n_components=300,
        n_pos=1500,
        n_inventory=12000 # Increased to ensure good data volume
    )
    
    data = generator.generate_all()
    
    # Save directly to the ./data folder
    save_to_sqlite(data)
    
    print("\nQuick Stats:")
    for table_name, df in data.items():
        print(f"  {table_name.upper()}: {len(df):,} rows")
    
    print(f"\n🚀 Database file created at: {os.path.join(OUTPUT_DIR, DB_NAME)}")
    print("This file is ready to be used by the SQL-of-Thought agent.")
    print("=" * 80)

if __name__ == '__main__':
    try:
        main()
    except ImportError as e:
        print("\n" + "=" * 80)
        print(f"ERROR: Missing required Python libraries. Please run:")
        print("  pip install pandas numpy Faker")
        print("=" * 80)
    except Exception as e:
        print(f"\nFATAL ERROR during data generation: {e}")