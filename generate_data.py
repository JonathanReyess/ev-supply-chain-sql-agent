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


    def generate_all(self):
        """Generate complete dataset and return as a dictionary of DataFrames."""
        print("🏭 Generating EV Supply Chain Data...\n")
        
        suppliers_df = self.generate_suppliers()
        components_df = self.generate_components(suppliers_df)
        pos_df = self.generate_purchase_orders(suppliers_df)
        po_line_items_df = self.generate_po_line_items(pos_df.copy(), components_df) # Pass copy to avoid modifying original in the function if needed later
        inventory_df = self.generate_inventory(components_df)
        lines_df = self.generate_production_lines()
        schedule_df = self.generate_production_schedule(lines_df)
        usage_df = self.generate_component_usage(schedule_df, components_df)
        quality_df = self.generate_quality_checks(pos_df, components_df)
        shipments_df = self.generate_shipments(pos_df)

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
            'shipments': shipments_df
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