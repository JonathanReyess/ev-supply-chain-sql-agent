-- View call logs with evaluations
.mode box
.headers on
.width 5 40 15 5 6 12 10

SELECT 
    l.id,
    substr(l.user_question, 1, 40) as question,
    l.router_intent,
    l.rows_returned as rows,
    l.latency_ms as latency,
    e.severity,
    substr(e.feedback_summary, 1, 30) as feedback
FROM agent_call_logs l
LEFT JOIN agent_call_evals e ON e.call_id = l.id
WHERE l.id >= 3
ORDER BY l.id;
