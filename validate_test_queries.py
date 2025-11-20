"""
Validate Test Queries Against Database
Tests all SQL queries from test_questions_answers.json
"""
import json
import sqlite3
from datetime import datetime

DB_PATH = 'data/ev_supply_chain.db'


def validate_sql_queries():
    """Test all SQL queries to ensure they work"""
    
    # Load test cases
    try:
        with open('test_questions_answers.json', 'r') as f:
            data = json.load(f)
        
        # Handle both formats
        if isinstance(data, dict) and 'test_cases' in data:
            test_cases = data['test_cases']
        elif isinstance(data, list):
            test_cases = data
        else:
            print("❌ Invalid JSON format")
            return
            
    except FileNotFoundError:
        print("❌ test_questions_answers.json not found")
        print("   Generate it using ChatGPT/Claude first")
        return
    
    print("="*80)
    print("  SQL Query Validation")
    print("="*80)
    print(f"\nLoaded {len(test_cases)} test cases\n")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    results = {
        'total_sql': 0,
        'valid_sql': 0,
        'invalid_sql': 0,
        'total_docking': 0,
        'errors': []
    }
    
    for test in test_cases:
        test_id = test.get('id', '?')
        question = test.get('question', 'N/A')
        agent = test.get('agent', 'unknown')
        sql = test.get('expected_sql', '')
        
        if agent == 'sql' and sql and sql != 'N/A':
            results['total_sql'] += 1
            
            print(f"\n[Test {test_id}] {question}")
            print(f"SQL: {sql[:80]}...")
            
            try:
                # Try to execute the query
                cursor.execute(sql)
                rows = cursor.fetchall()
                results['valid_sql'] += 1
                print(f"✅ Valid - Returns {len(rows)} row(s)")
                
                # Show sample result
                if rows:
                    print(f"   Sample: {rows[0]}")
                    
            except Exception as e:
                results['invalid_sql'] += 1
                error_msg = str(e)
                print(f"❌ Error: {error_msg}")
                results['errors'].append({
                    'id': test_id,
                    'question': question,
                    'sql': sql,
                    'error': error_msg
                })
        
        elif agent == 'docking':
            results['total_docking'] += 1
    
    conn.close()
    
    # Print summary
    print("\n" + "="*80)
    print("  VALIDATION SUMMARY")
    print("="*80)
    
    print(f"\n📊 SQL Queries:")
    print(f"   Total: {results['total_sql']}")
    print(f"   ✅ Valid: {results['valid_sql']}")
    print(f"   ❌ Invalid: {results['invalid_sql']}")
    
    if results['total_sql'] > 0:
        success_rate = (results['valid_sql'] / results['total_sql']) * 100
        print(f"   Success Rate: {success_rate:.1f}%")
        
        if success_rate >= 90:
            print(f"   ✅ EXCELLENT!")
        elif success_rate >= 75:
            print(f"   ✓ GOOD")
        else:
            print(f"   ⚠️  NEEDS WORK")
    
    print(f"\n🚪 Docking Queries: {results['total_docking']}")
    print(f"   (Will be tested when router runs)")
    
    # Show errors in detail
    if results['errors']:
        print(f"\n" + "="*80)
        print("  ERRORS TO FIX")
        print("="*80)
        for err in results['errors']:
            print(f"\n❌ Test {err['id']}: {err['question']}")
            print(f"   SQL: {err['sql']}")
            print(f"   Error: {err['error']}")
            print(f"   💡 Suggested fix:")
            
            # Common error fixes
            if 'no such table' in err['error'].lower():
                print(f"      - Check table name spelling")
                print(f"      - Verify table exists in database")
            elif 'no such column' in err['error'].lower():
                print(f"      - Check column name spelling")
                print(f"      - Use: python extract_schema.py to see exact column names")
            elif 'ambiguous column' in err['error'].lower():
                print(f"      - Add table prefix: table_name.column_name")
            elif 'syntax error' in err['error'].lower():
                print(f"      - Check SQL syntax")
                print(f"      - Missing quotes around strings?")
    
    print("\n" + "="*80)
    
    if results['invalid_sql'] == 0:
        print("✅ All SQL queries are valid!")
        print("   Ready to run: python test_orchestrator_metrics.py")
    else:
        print(f"⚠️  Fix {results['invalid_sql']} SQL errors in test_questions_answers.json")
        print("   Then run this script again")
    
    print("="*80 + "\n")
    
    return results


if __name__ == '__main__':
    validate_sql_queries()

