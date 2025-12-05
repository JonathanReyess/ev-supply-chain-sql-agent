#!/bin/bash
# Display actual evaluation framework test results

echo "════════════════════════════════════════════════════════════════"
echo "           REAL DATABASE STATE (as of Dec 3, 2025)"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "📊 AGENT CALL LOGS (Sample):"
echo "─────────────────────────────────────────────────────────────────"
sqlite3 data/ev_supply_chain.db << 'SQL'
.mode box
.width 5 45 12 6 8
SELECT 
    id,
    substr(user_question, 1, 45) as question,
    router_intent,
    rows_returned,
    latency_ms
FROM agent_call_logs
WHERE id >= 3
ORDER BY id
LIMIT 5;
SQL
echo ""

echo "📊 AGENT CALL EVALUATIONS (Sample):"
echo "─────────────────────────────────────────────────────────────────"
sqlite3 data/ev_supply_chain.db << 'SQL'
.mode box
.width 5 8 15 18 20
SELECT 
    id,
    call_id,
    severity,
    usefulness_score,
    substr(feedback_summary, 1, 20) as feedback
FROM agent_call_evals
ORDER BY id DESC
LIMIT 5;
SQL
echo ""

echo "📊 SUMMARY STATISTICS:"
echo "─────────────────────────────────────────────────────────────────"
sqlite3 data/ev_supply_chain.db << 'SQL'
.mode line
SELECT 
    (SELECT COUNT(*) FROM agent_call_logs) as total_calls_logged,
    (SELECT COUNT(*) FROM agent_call_evals) as total_evaluations,
    (SELECT AVG(latency_ms) FROM agent_call_logs WHERE id >= 3) as avg_latency_ms,
    (SELECT AVG(usefulness_score) FROM agent_call_evals) as avg_usefulness,
    (SELECT COUNT(*) FROM agent_call_logs WHERE error IS NOT NULL) as calls_with_errors;
SQL
echo ""

echo "📊 SEVERITY BREAKDOWN:"
echo "─────────────────────────────────────────────────────────────────"
sqlite3 data/ev_supply_chain.db << 'SQL'
.mode box
SELECT 
    severity,
    COUNT(*) as count,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM agent_call_evals), 1) || '%' as percentage
FROM agent_call_evals
GROUP BY severity;
SQL
echo ""

echo "════════════════════════════════════════════════════════════════"
echo ""
echo "✅ All data successfully stored in SQLite database!"
echo "📁 Database location: data/ev_supply_chain.db"
echo ""
echo "To explore further:"
echo "  sqlite3 data/ev_supply_chain.db"
echo "  > SELECT * FROM agent_call_logs;"
echo "  > SELECT * FROM agent_call_evals;"
echo ""
echo "════════════════════════════════════════════════════════════════"
