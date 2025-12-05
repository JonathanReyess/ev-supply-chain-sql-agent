-- Migration 003: Agent Call Logging and Evaluation Tables
-- Implements LLM-as-a-judge evaluation pipeline inspired by MT-Bench (Zheng et al., NeurIPS 2023)

PRAGMA foreign_keys=ON;

-- Table 1: agent_call_logs
-- Logs every agent call (question → routing → handler → SQL/API → answer)
CREATE TABLE IF NOT EXISTS agent_call_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_utc      TEXT NOT NULL DEFAULT (datetime('now')),
  user_question    TEXT NOT NULL,           -- original natural language question
  router_intent    TEXT,                    -- intent label from router (e.g., "schedule_query")
  slots_json       TEXT,                    -- JSON-serialized slots dict
  target_agent     TEXT,                    -- e.g., "docking" or "sql"
  handler_name     TEXT,                    -- handler function name, like "handle_schedule"
  sql_or_query     TEXT,                    -- raw SQL string or handler-specific query signature
  rows_returned    INTEGER,                 -- number of rows or items returned by handler
  latency_ms       INTEGER,                 -- wall-clock latency in milliseconds for the call
  error            TEXT,                    -- repr(e) if an exception occurred, else NULL
  answer_summary   TEXT                     -- short text form of the answer (truncated for logging/judging)
);

-- Index for efficient querying by timestamp and error status
CREATE INDEX IF NOT EXISTS idx_agent_call_logs_created ON agent_call_logs(created_utc DESC);
CREATE INDEX IF NOT EXISTS idx_agent_call_logs_error ON agent_call_logs(error) WHERE error IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_call_logs_intent ON agent_call_logs(router_intent);

-- Table 2: agent_call_evals
-- Stores judgments from a judge LLM (scores + feedback)
CREATE TABLE IF NOT EXISTS agent_call_evals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id              INTEGER NOT NULL,    -- references agent_call_logs.id (semantic FK, not enforced)
  created_utc          TEXT NOT NULL DEFAULT (datetime('now')),
  judge_model          TEXT NOT NULL,       -- model name used for judging (e.g., "gpt-4o-mini")
  intent_correct       INTEGER,             -- 1 = yes, 0 = no
  answer_on_topic      INTEGER,             -- 1 = yes, 0 = no
  usefulness_score     REAL,                -- 1–5 scale representing usefulness to an ops manager
  hallucination_risk   TEXT,                -- 'low', 'medium', or 'high'
  severity             TEXT,                -- 'ok', 'minor_issue', or 'major_issue'
  feedback_summary     TEXT,                -- short natural-language feedback (1–3 sentences)
  raw_judge_json       TEXT                 -- full JSON from the judge, for debugging
);

-- Index for efficient joining with agent_call_logs
CREATE INDEX IF NOT EXISTS idx_agent_call_evals_call_id ON agent_call_evals(call_id);
CREATE INDEX IF NOT EXISTS idx_agent_call_evals_created ON agent_call_evals(created_utc DESC);
CREATE INDEX IF NOT EXISTS idx_agent_call_evals_severity ON agent_call_evals(severity);


