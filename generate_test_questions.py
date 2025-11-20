"""
Generate Sample Questions and Expected Answers for Testing
Uses Gemini AI to create comprehensive test dataset based on database schema
"""
import sqlite3
import json
import os
from datetime import datetime
from google import generativeai as genai
from dotenv import load_dotenv

load_dotenv()

# Configure Gemini
genai.configure(api_key=os.getenv('GOOGLE_API_KEY'))
model = genai.GenerativeModel('gemini-2.0-flash-exp')

DB_PATH = 'data/ev_supply_chain.db'
OUTPUT_FILE = 'test_questions_answers.json'


def get_database_schema():
    """Extract complete database schema with sample data"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    schema_info = {}
    
    # Get all tables
    tables = cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    
    for table_row in tables:
        table_name = table_row[0]
        
        # Get schema
        columns = cursor.execute(f"PRAGMA table_info({table_name})").fetchall()
        column_info = [
            {
                'name': col[1],
                'type': col[2],
                'notnull': bool(col[3]),
                'pk': bool(col[5])
            }
            for col in columns
        ]
        
        # Get sample data (3 rows)
        try:
            sample_rows = cursor.execute(f"SELECT * FROM {table_name} LIMIT 3").fetchall()
            samples = [dict(row) for row in sample_rows]
        except:
            samples = []
        
        # Get row count
        try:
            count = cursor.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        except:
            count = 0
        
        schema_info[table_name] = {
            'columns': column_info,
            'sample_data': samples,
            'row_count': count
        }
    
    conn.close()
    return schema_info


def format_schema_for_prompt(schema_info):
    """Format schema info for LLM prompt"""
    output = []
    
    for table_name, info in schema_info.items():
        output.append(f"\n## Table: {table_name} ({info['row_count']} rows)")
        
        # Columns
        output.append("\nColumns:")
        for col in info['columns']:
            pk = " (PRIMARY KEY)" if col['pk'] else ""
            notnull = " NOT NULL" if col['notnull'] else ""
            output.append(f"  - {col['name']}: {col['type']}{pk}{notnull}")
        
        # Sample data
        if info['sample_data']:
            output.append("\nSample Data:")
            for i, row in enumerate(info['sample_data'][:2], 1):
                output.append(f"  Row {i}: {json.dumps(row, default=str)}")
    
    return '\n'.join(output)


def generate_test_questions(schema_prompt, num_questions=25):
    """Use Gemini to generate test questions"""
    
    prompt = f"""You are a test data generator for a supply chain database system with two agents:

1. **SQL Agent**: Handles analytical queries (aggregations, comparisons, historical analysis, KPIs)
2. **Docking Agent**: Handles real-time operational queries (door schedules, assignments, status)

DATABASE SCHEMA:
{schema_prompt}

Generate {num_questions} diverse test questions in JSON format. Each question should include:
- question: Natural language question
- agent: "sql" or "docking" 
- category: One of [aggregation, ranking, comparison, time_series, real_time_schedule, analysis, join, filtering]
- expected_sql: SQL query (for SQL agent) or "N/A" (for docking)
- expected_answer_type: One of [number, table, list, schedule, boolean, text]
- tables_involved: List of table names
- difficulty: "easy", "medium", or "hard"
- explanation: Brief explanation of what the query does

DISTRIBUTION GUIDELINES:
- 60% SQL Agent questions (analytical)
- 40% Docking Agent questions (operational)
- Difficulty: 40% easy, 40% medium, 20% hard
- Mix of all categories

SQL AGENT EXAMPLES:
- "What is the total quantity of batteries in stock?" (easy aggregation)
- "Which suppliers have the most delayed orders?" (medium ranking + join)
- "Calculate the average cost per component type by manufacturer" (hard multi-table aggregation)

DOCKING AGENT EXAMPLES:
- "What is the schedule at Fremont CA today?" (easy real-time schedule)
- "Why was door FRE-D04 reassigned?" (medium analysis)
- "Which doors have the highest utilization rate?" (hard operational analysis)

Return ONLY valid JSON array format:
[
  {{
    "id": 1,
    "question": "...",
    "agent": "sql",
    "category": "aggregation",
    "expected_sql": "SELECT ...",
    "expected_answer_type": "number",
    "tables_involved": ["components"],
    "difficulty": "easy",
    "explanation": "..."
  }},
  ...
]

Generate exactly {num_questions} questions now:"""

    print("🤖 Asking Gemini to generate test questions...")
    print("⏳ This may take 10-20 seconds...\n")
    
    response = model.generate_content(prompt)
    
    # Clean response (remove markdown if present)
    text = response.text.strip()
    if text.startswith('```json'):
        text = text[7:]
    if text.startswith('```'):
        text = text[3:]
    if text.endswith('```'):
        text = text[:-3]
    text = text.strip()
    
    try:
        questions = json.loads(text)
        return questions
    except json.JSONDecodeError as e:
        print(f"❌ Error parsing JSON: {e}")
        print(f"Response text: {text[:500]}...")
        return []


def main():
    print("="*70)
    print("  Test Question Generator for Supply Chain Orchestrator")
    print("="*70)
    print()
    
    # Check if database exists and has data
    if not os.path.exists(DB_PATH):
        print(f"❌ Database not found: {DB_PATH}")
        print("   Run 'python generate_data.py' first to create the database")
        return
    
    # Get schema
    print("📊 Extracting database schema...")
    schema_info = get_database_schema()
    
    if not schema_info:
        print("❌ No tables found in database")
        print("   Run 'python generate_data.py' to populate the database")
        return
    
    print(f"✓ Found {len(schema_info)} tables")
    for table, info in schema_info.items():
        print(f"   - {table}: {info['row_count']} rows")
    print()
    
    # Format schema for prompt
    schema_prompt = format_schema_for_prompt(schema_info)
    
    # Generate questions
    questions = generate_test_questions(schema_prompt, num_questions=25)
    
    if not questions:
        print("❌ Failed to generate questions")
        return
    
    print(f"✓ Generated {len(questions)} test questions\n")
    
    # Categorize questions
    sql_questions = [q for q in questions if q.get('agent') == 'sql']
    docking_questions = [q for q in questions if q.get('agent') == 'docking']
    
    print(f"📊 Distribution:")
    print(f"   SQL Agent: {len(sql_questions)} questions")
    print(f"   Docking Agent: {len(docking_questions)} questions")
    print()
    
    # Show sample questions
    print("📝 Sample Questions:")
    for q in questions[:5]:
        print(f"\n   Q{q.get('id', '?')}: {q.get('question', 'N/A')}")
        print(f"       Agent: {q.get('agent', 'N/A')} | Difficulty: {q.get('difficulty', 'N/A')}")
    print()
    
    # Save to file
    output_data = {
        "generated_at": datetime.utcnow().isoformat(),
        "database": DB_PATH,
        "total_questions": len(questions),
        "sql_agent_count": len(sql_questions),
        "docking_agent_count": len(docking_questions),
        "test_cases": questions
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output_data, f, indent=2)
    
    print(f"✅ Saved to {OUTPUT_FILE}")
    print(f"   Total: {len(questions)} questions")
    print()
    print("="*70)
    print("Next steps:")
    print("  1. Review test_questions_answers.json")
    print("  2. Run: python test_orchestrator_accuracy.py")
    print("  3. Evaluate routing and answer quality")
    print("="*70)


if __name__ == '__main__':
    main()

