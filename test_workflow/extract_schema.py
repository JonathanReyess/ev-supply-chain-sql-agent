"""
Extract Database Schema for Manual Test Generation
Run this once, copy output to ChatGPT/Claude to generate test questions
"""
import sqlite3
import json

DB_PATH = 'data/ev_supply_chain.db'


def extract_full_schema():
    """Extract complete schema with sample data"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    schema_output = []
    schema_output.append("="*80)
    schema_output.append("EV SUPPLY CHAIN DATABASE SCHEMA")
    schema_output.append("="*80)
    
    # Get all tables
    tables = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    
    for table_row in tables:
        table_name = table_row[0]
        
        schema_output.append(f"\n{'='*80}")
        schema_output.append(f"TABLE: {table_name}")
        schema_output.append('='*80)
        
        # Get column info
        columns = cursor.execute(f"PRAGMA table_info({table_name})").fetchall()
        
        schema_output.append("\nColumns:")
        for col in columns:
            col_name = col[1]
            col_type = col[2]
            notnull = " NOT NULL" if col[3] else ""
            pk = " PRIMARY KEY" if col[5] else ""
            schema_output.append(f"  - {col_name}: {col_type}{notnull}{pk}")
        
        # Get row count
        count = cursor.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        schema_output.append(f"\nTotal Rows: {count}")
        
        # Get 2 sample rows
        if count > 0:
            schema_output.append("\nSample Data (first 2 rows):")
            rows = cursor.execute(f"SELECT * FROM {table_name} LIMIT 2").fetchall()
            for i, row in enumerate(rows, 1):
                schema_output.append(f"\n  Row {i}:")
                row_dict = dict(row)
                for key, value in row_dict.items():
                    # Truncate long values
                    val_str = str(value)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + "..."
                    schema_output.append(f"    {key}: {val_str}")
    
    conn.close()
    
    return "\n".join(schema_output)


def save_schema_for_llm():
    """Save schema in format ready for ChatGPT/Claude"""
    schema = extract_full_schema()
    
    # Save to file
    with open('schema_for_llm.txt', 'w') as f:
        f.write(schema)
    
    print("="*80)
    print("Schema Extraction Complete!")
    print("="*80)
    print(f"\n✅ Saved to: schema_for_llm.txt")
    print(f"\n📋 Copy this file and paste into ChatGPT/Claude with the prompt below:\n")
    
    # Print the prompt
    prompt = """
================================================================================
PROMPT FOR CHATGPT/CLAUDE
================================================================================

I have an EV supply chain database with the schema below. Generate 25 diverse 
test questions in JSON format for testing a multi-agent orchestrator system.

SYSTEM OVERVIEW:
- SQL Agent: Handles analytical queries (aggregations, joins, KPIs, trends)
- Docking Agent: Handles operational queries (schedules, door assignments, status)

REQUIREMENTS:
1. 60% SQL Agent questions (15 questions)
2. 40% Docking Agent questions (10 questions)
3. Mix of difficulties: 40% easy, 40% medium, 20% hard
4. Each question must include expected SQL (for SQL agent) or API endpoint (for docking)

JSON FORMAT (return ONLY valid JSON array):
[
  {
    "id": 1,
    "question": "What is the total quantity of batteries in stock?",
    "agent": "sql",
    "category": "aggregation",
    "difficulty": "easy",
    "expected_sql": "SELECT SUM(quantity_in_stock) FROM components WHERE type = 'Battery'",
    "expected_answer_type": "number",
    "tables_involved": ["components"]
  },
  {
    "id": 2,
    "question": "What is the schedule at Fremont CA?",
    "agent": "docking",
    "category": "real_time_schedule",
    "difficulty": "easy",
    "expected_api": "POST /qa with question",
    "expected_answer_type": "schedule",
    "tables_involved": ["dock_assignments", "dock_doors"]
  }
]

CATEGORIES:
- SQL: aggregation, ranking, comparison, join, filtering, time_series, kpi
- Docking: real_time_schedule, door_status, analysis, optimization

DATABASE SCHEMA:
[PASTE schema_for_llm.txt CONTENTS HERE]

Generate exactly 25 questions following the format above.
================================================================================
"""
    
    print(prompt)
    print("\n" + "="*80)
    print("NEXT STEPS:")
    print("="*80)
    print("1. Copy schema_for_llm.txt contents")
    print("2. Paste into ChatGPT/Claude with the prompt above")
    print("3. Save generated JSON as: test_questions_answers.json")
    print("4. Run: python validate_test_queries.py")
    print("="*80)


if __name__ == '__main__':
    save_schema_for_llm()

