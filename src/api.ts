/**
 * API Server for SQL-of-Thought Agent
 * Provides REST endpoints for the frontend
 */

import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { runOrchestrator, OrchestratorResult } from './agent.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.API_PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve plots as static files
app.use('/plots', express.static(join(process.cwd(), 'plots')));

// Configuration
const DB_PATH = join(process.cwd(), 'data', 'ev_supply_chain.db');
const ERROR_TAXONOMY_PATH = join(__dirname, '../data/error-taxonomy.json');
const MAX_CORRECTION_ATTEMPTS = 3;
const LOGS_DIR = join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// Logging function for token usage
function logTokenUsage(agentType: string, model: string, tokenData: any, question: string, conversationId: string = 'default') {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    conversationId,
    agentType,
    model,
    question: question.substring(0, 100), // Truncate long questions
    ...tokenData
  };
  
  const logFile = join(LOGS_DIR, `token-usage-sql-of-thought-${new Date().toISOString().split('T')[0]}.jsonl`);
  try {
    appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

// Initialize GoogleGenAI
const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TEMPERATURE = 1;

// Load error taxonomy
const errorTaxonomy = JSON.parse(readFileSync(ERROR_TAXONOMY_PATH, 'utf-8'));

// ============================================================================
// OPTION B: Intent Classifier + Query State Management
// ============================================================================

// Conversation State Interface
interface ConversationState {
  table: string | null;
  columns: string[];
  filters: Array<{ column: string; operator: string; value: string }>;
  joins: Array<{ table: string; condition: string }>;
  sorts: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  aggregations: string | null;
  limit: number | null;
  groupBy: string[];
  lastSQL: string | null;
}

// Conversation Summary Interface for sliding-window context management
interface ConversationSummary {
  summaryText: string;
  turnRange: { start: number; end: number };
  keyMetadata: {
    tablesUsed: string[];
    keyMetrics: Array<{ question: string; result: string }>;
  };
  tokenCount: number;
  createdAt: string;
}

// Simple fallback SQL parser for single-table queries
function parseSQLFallback(sql: string): Partial<ConversationState> {
  try {
    const cleaned = sql.replace(/\s+/g, ' ').trim();
    const lower = cleaned.toLowerCase();

    // Columns
    let columns: string[] = [];
    const selectMatch = lower.match(/select\s+(.+?)\s+from\s+/i);
    if (selectMatch && selectMatch[1]) {
      const colsRaw = cleaned.substring(
        cleaned.toLowerCase().indexOf('select') + 6,
        cleaned.toLowerCase().indexOf('from')
      ).trim();
      if (colsRaw !== '*') {
        columns = colsRaw.split(',').map(s => s.trim());
      }
    }

    // Table (first token after FROM)
    let table: string | null = null;
    const fromMatch = cleaned.match(/from\s+([A-Za-z_][\w\.]*)/i);
    if (fromMatch && fromMatch[1]) {
      table = fromMatch[1].replace(/"/g, '');
    }

    // WHERE clause -> basic AND-split conditions
    const whereMatch = cleaned.match(/where\s+(.+?)(?:\s+group\s+by|\s+order\s+by|\s+limit|$)/i);
    const filters: Array<{ column: string; operator: string; value: string }> = [];
    if (whereMatch && whereMatch[1]) {
      const whereRaw = whereMatch[1].trim();
      const parts = whereRaw.split(/\s+and\s+/i);
      for (const part of parts) {
        const m = part.match(/([A-Za-z_][\w\.]*)\s*(=|!=|<>|>=|<=|>|<|like|in|not in)\s*(.+)/i);
        if (m) {
          const col = m[1];
          const op = m[2].toUpperCase();
          const val = m[3].trim();
          filters.push({ column: col, operator: op, value: val });
        }
      }
    }

    return { table, columns, filters };
  } catch {
    return {};
  }
}

function formatFiltersForConstraint(filters: Array<{ column: string; operator: string; value: string }>): string {
  if (!filters || filters.length === 0) return '';
  const clause = filters.map(f => {
    const op = (f.operator || '').toUpperCase();
    const val = (f.value || '').trim();
    const isQuotedString = /^'.*'$/.test(val);
    const isStringComparisonOp = ['=', '!=', '<>', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN'].includes(op);
    
    if (isStringComparisonOp && isQuotedString) {
      return `LOWER(${f.column}) ${f.operator} LOWER(${f.value})`;
    }
    return `${f.column} ${f.operator} ${f.value}`;
  }).join(' AND ');
  return `Constraints:\n- Apply these WHERE filters from prior context: ${clause}`;
}

// Intent Classifier - Lightweight LLM call to classify user intent
async function intentClassifier(
  question: string, 
  conversationState: ConversationState | null
): Promise<{ intent: string; confidence: number; modifications: any }> {
  const stateContext = conversationState 
    ? `
Current Query State:
- Table: ${conversationState.table || 'none'}
- Filters: ${conversationState.filters.length > 0 ? JSON.stringify(conversationState.filters) : 'none'}
- Columns: ${conversationState.columns.join(', ') || 'all'}
- Aggregations: ${conversationState.aggregations || 'none'}
- Sorts: ${conversationState.sorts.length > 0 ? JSON.stringify(conversationState.sorts) : 'none'}
- Previous SQL: ${conversationState.lastSQL || 'none'}
`
    : 'No previous query state.';

  const prompt = `You are an intent classifier for SQL query modifications.

${stateContext}

User Question: "${question}"

Classify the user's intent into ONE of these categories:

1. "new_query" - User is asking a completely new question unrelated to previous query
2. "add_filter" - User wants to add a WHERE condition to existing query
3. "remove_filter" - User wants to remove a filter
4. "change_aggregation" - User wants different aggregation (AVG, SUM, COUNT, MIN, MAX)
5. "add_sort" - User wants to sort results
6. "add_limit" - User wants to limit number of rows (only if current state is NOT an aggregation)
7. "show_rows_with_limit" - User wants to see individual rows with LIMIT (removes aggregation, keeps filters)
8. "refine_columns" - User wants different columns/fields
9. "keep_filters_aggregate" - User wants to aggregate existing filtered data (e.g., "average of those")

Return ONLY a JSON object with this exact structure:
{
  "intent": "intent_name",
  "confidence": 0.95,
  "modifications": {
    "aggregation": "AVG(columnname)",
    "filter": {"column": "name", "operator": "=", "value": "'value'"},
    "sort": {"column": "name", "direction": "DESC"},
    "limit": 10,
    "columns": ["col1", "col2"],
    "keep_filters": true,
    "remove_aggregation": true
  }
}

Rules:
- If the question uses "those", "them", "these", "it" and refers to previous results, set "keep_filters": true
- For aggregations like "average", "sum", "count", use "change_aggregation" or "keep_filters_aggregate"
- If user says "show top X" or "show X" AFTER an aggregation, use "show_rows_with_limit" (not "add_limit")
- If completely different topic or table, use "new_query"
- Confidence should be 0-1 (higher = more certain)

Return ONLY valid JSON.`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return {
      intent: parsed.intent || 'new_query',
      confidence: parsed.confidence || 0,
      modifications: parsed.modifications || {}
    };
  } catch (error) {
    console.error('Intent classifier error:', error);
    return { intent: 'new_query', confidence: 0, modifications: {} };
  }
}

// State Updater - Programmatically update conversation state
function stateUpdater(
  currentState: ConversationState | null,
  intent: string,
  modifications: any
): ConversationState {
  // If no state or new query, return minimal state
  if (!currentState || intent === 'new_query') {
    return {
      table: null,
      columns: [],
      filters: [],
      joins: [],
      sorts: [],
      aggregations: null,
      limit: null,
      groupBy: [],
      lastSQL: null
    };
  }

  // Clone current state
  const newState: ConversationState = JSON.parse(JSON.stringify(currentState));

  // Update based on intent
  switch (intent) {
    case 'add_filter':
      if (modifications.filter) {
        newState.filters.push(modifications.filter);
      }
      break;

    case 'remove_filter':
      if (modifications.filter_index !== undefined) {
        newState.filters.splice(modifications.filter_index, 1);
      }
      break;

    case 'change_aggregation':
    case 'keep_filters_aggregate':
      if (modifications.aggregation) {
        newState.aggregations = modifications.aggregation;
      }
      // Keep existing filters when aggregating
      break;

    case 'add_sort':
      if (modifications.sort) {
        newState.sorts.push(modifications.sort);
      }
      break;

    case 'add_limit':
      if (modifications.limit) {
        newState.limit = modifications.limit;
      }
      break;

    case 'show_rows_with_limit':
      // Remove aggregation and show individual rows with limit
      newState.aggregations = null;
      newState.groupBy = [];
      if (modifications.limit) {
        newState.limit = modifications.limit;
      }
      // If columns were empty (because of aggregation), restore to show all
      if (newState.columns.length === 0) {
        newState.columns = ['*'];
      }
      break;

    case 'refine_columns':
      if (modifications.columns) {
        newState.columns = modifications.columns;
      }
      break;
  }

  return newState;
}

// Query Composer - Programmatically build SQL from state
function queryComposer(state: ConversationState): string {
  if (!state.table) {
    throw new Error('Cannot compose query without table');
  }

  let sql = '';

  // SELECT clause
  if (state.aggregations) {
    sql = `SELECT ${state.aggregations}`;
  } else if (state.columns.length > 0) {
    sql = `SELECT ${state.columns.join(', ')}`;
  } else {
    sql = `SELECT *`;
  }

  // FROM clause
  sql += ` FROM ${state.table}`;

  // JOIN clauses
  if (state.joins.length > 0) {
    state.joins.forEach(join => {
      sql += ` JOIN ${join.table} ON ${join.condition}`;
    });
  }

  // WHERE clause
  if (state.filters.length > 0) {
    const whereClause = state.filters
      .map(f => {
        const op = (f.operator || '').toUpperCase();
        const val = (f.value || '').trim();
        const isQuotedString = /^'.*'$/.test(val);
        const isStringComparisonOp = ['=', '!=', '<>', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN'].includes(op);
        
        // Use case-insensitive comparison for string values
        if (isStringComparisonOp && isQuotedString) {
          return `LOWER(${f.column}) ${f.operator} LOWER(${f.value})`;
        }
        return `${f.column} ${f.operator} ${f.value}`;
      })
      .join(' AND ');
    sql += ` WHERE ${whereClause}`;
  }

  // GROUP BY clause (needed for aggregations with filters)
  if (state.groupBy.length > 0) {
    sql += ` GROUP BY ${state.groupBy.join(', ')}`;
  }

  // ORDER BY clause
  if (state.sorts.length > 0) {
    sql += ` ORDER BY ${state.sorts.map(s => `${s.column} ${s.direction}`).join(', ')}`;
  }

  // LIMIT clause
  if (state.limit) {
    sql += ` LIMIT ${state.limit}`;
  }

  return sql;
}

// Check if we can handle this programmatically
function canHandleProgrammatically(
  intent: string,
  confidence: number,
  modifications: any,
  state: ConversationState | null
): boolean {
  // Must have confidence threshold
  if (confidence < 0.7) {
    return false;
  }

  // Must have existing state for modifications
  if (!state || !state.table) {
    return false;
  }

  // Don't handle multi-table queries programmatically (too complex)
  if (state.joins.length > 0) {
    return false;
  }

  // Only handle these simple intents
  const simpleIntents = [
    'add_filter',
    'add_sort',
    'add_limit',
    'show_rows_with_limit',
    'change_aggregation',
    'keep_filters_aggregate',
    'refine_columns'
  ];

  return simpleIntents.includes(intent);
}

// Parse SQL to extract conversation state
async function extractStateFromSQL(sql: string, question: string, schema: any): Promise<ConversationState> {
  // Use LLM to parse SQL and extract structured state
  const prompt = `Parse this SQL query and extract its components into a structured format.

SQL Query:
${sql}

Question it answers:
"${question}"

Available Schema:
${JSON.stringify(schema, null, 2)}

Return ONLY a JSON object with this structure:
{
  "table": "main_table_name",
  "columns": ["col1", "col2"],
  "filters": [{"column": "col", "operator": "=", "value": "'val'"}],
  "joins": [{"table": "join_table", "condition": "t1.id = t2.id"}],
  "sorts": [{"column": "col", "direction": "ASC"}],
  "aggregations": "AVG(column)" or null,
  "limit": 10 or null,
  "groupBy": ["col1"]
}

Extract all components accurately. Return ONLY valid JSON.`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    // Backfill missing pieces with fallback parser
    const fallback = parseSQLFallback(sql);
    return {
      table: parsed.table || fallback.table || null,
      columns: (parsed.columns && parsed.columns.length > 0) ? parsed.columns : (fallback.columns || []),
      filters: (parsed.filters && parsed.filters.length > 0) ? parsed.filters : (fallback.filters || []),
      joins: parsed.joins || [],
      sorts: parsed.sorts || [],
      aggregations: parsed.aggregations || null,
      limit: parsed.limit || null,
      groupBy: parsed.groupBy || [],
      lastSQL: sql
    };
  } catch (error) {
    console.error('State extraction error:', error);
    return {
      table: null,
      columns: [],
      filters: [],
      joins: [],
      sorts: [],
      aggregations: null,
      limit: null,
      groupBy: [],
      lastSQL: sql
    };
  }
}

// ============================================================================
// END OPTION B
// ============================================================================

// NOTE: Agent functions removed - now using orchestrator from agent.ts

/**
 * Generate or update a conversation summary for context management
 * Enforces 200-word maximum and includes key metadata
 */
async function generateConversationSummary(
  turns: any[],
  existingSummary?: ConversationSummary
): Promise<ConversationSummary> {
  console.log(`\n📝 [Summary Generation] Summarizing ${turns.length} turns...`);
  
  // Extract metadata from turns
  const allTables = new Set<string>();
  const keyMetrics: Array<{ question: string; result: string }> = [];
  
  turns.forEach(turn => {
    if (turn.tables && Array.isArray(turn.tables)) {
      turn.tables.forEach((t: string) => allTables.add(t));
    }
    if (turn.question && turn.rowCount !== undefined) {
      const metric = turn.keyMetric || `${turn.rowCount} rows`;
      keyMetrics.push({ question: turn.question, result: metric });
    }
  });

  // Build prompt for summary generation
  const previousSummary = existingSummary ? `\nPrevious Summary:\n${existingSummary.summaryText}\n` : '';
  const turnsContext = turns.map((t, idx) => 
    `Turn ${idx + 1}: Q: "${t.question}" | SQL: ${t.sql || 'N/A'} | Result: ${t.rowCount || 0} rows${t.keyMetric ? ' | ' + t.keyMetric : ''}`
  ).join('\n');

  const prompt = `You are a conversation summarizer for a SQL query system. Create a concise summary of the conversation history.

${previousSummary}

## Recent Conversation Turns
${turnsContext}

## Requirements
- **Maximum 200 words**
- Include: (a) user questions summarized, (b) key result numbers, (c) table names used
- Format: "User queried [tables]. Q1: X, result: Y rows. Q2: Z, metric: M."
- Be concise and factual

Return ONLY the summary text, no additional commentary.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.3, // Lower temperature for factual summarization
      maxOutputTokens: 300, // Enforce token limit (roughly 200 words)
    },
  });

  const summaryText = response.text?.trim() || '';
  const tokenCount = response.usageMetadata?.totalTokenCount || 0;

  return {
    summaryText,
    turnRange: { start: existingSummary ? existingSummary.turnRange.start : 1, end: turns.length },
    keyMetadata: {
      tablesUsed: Array.from(allTables),
      keyMetrics
    },
    tokenCount,
    createdAt: new Date().toISOString()
  };
}

// Global summaryStorage (in production, this should be per-session in database or Redis)
let conversationSummaryStorage: ConversationSummary | null = null;

// Main SQL-of-Thought function using orchestrator
async function sqlOfThought(question: string, conversationHistory: any[] = []): Promise<any> {
  const pipelineStart = Date.now();
  
  try {
    // Prepare context with sliding-window strategy + summary
    let contextString: string | undefined;
    
    if (conversationHistory.length > 3) {
      // Generate or update summary for turns 0 to -3
      const oldTurns = conversationHistory.slice(0, -3);
      conversationSummaryStorage = await generateConversationSummary(oldTurns, conversationSummaryStorage || undefined);
      
      // Format context: summary + last 3 turns
      const recentTurns = conversationHistory.slice(-3);
      const recentContext = recentTurns.map((t, idx) =>
        `Turn ${idx + 1}: Q: "${t.question}" | SQL: ${t.sql || 'N/A'} | Result: ${t.rowCount || 0} rows${t.keyMetric ? ' | ' + t.keyMetric : ''}`
      ).join('\n');
      
      contextString = `## Conversation Summary\n${conversationSummaryStorage.summaryText}\n\n## Recent Turns\n${recentContext}`;
      
      console.log(`\n📚 [Context Management] Using summary (${conversationSummaryStorage.tokenCount} tokens) + last 3 turns`);
    } else if (conversationHistory.length > 0) {
      // Just use all turns directly if few
      contextString = conversationHistory.map((t, idx) =>
        `Turn ${idx + 1}: Q: "${t.question}" | SQL: ${t.sql || 'N/A'} | Result: ${t.rowCount || 0} rows${t.keyMetric ? ' | ' + t.keyMetric : ''}`
      ).join('\n');
    }
    
    // Call orchestrator with context
    const orchestratorResult = await runOrchestrator(question, contextString);
    
    // Log token usage
    orchestratorResult.tokenUsage.perTool.forEach(toolUsage => {
      logTokenUsage(toolUsage.tool, orchestratorResult.tokenUsage.model, toolUsage, question);
    });
    
    // Format response to match expected API format
    return {
      success: orchestratorResult.success,
      sql: orchestratorResult.sql,
      results: orchestratorResult.results || [],
      row_count: orchestratorResult.row_count || 0,
      finalAnswer: orchestratorResult.finalAnswer,
      visualization: orchestratorResult.visualization,
      execution_time_ms: orchestratorResult.timings.total_ms,
      timings: orchestratorResult.timings,
      tokenUsage: {
        model: orchestratorResult.tokenUsage.model,
        method: 'orchestrator_with_summary',
        perAgent: orchestratorResult.tokenUsage.perTool,
        aggregate: orchestratorResult.tokenUsage.aggregate
      },
      metadata: orchestratorResult.metadata,
      iterations: orchestratorResult.iterations,
      // Include summary info if it was used
      summary: conversationSummaryStorage ? {
        summaryText: conversationSummaryStorage.summaryText,
        turnsCount: conversationSummaryStorage.turnRange.end,
        tokenCount: conversationSummaryStorage.tokenCount,
        tablesUsed: conversationSummaryStorage.keyMetadata.tablesUsed
      } : undefined
    };
  } catch (error: any) {
    const totalMs = Date.now() - pipelineStart;
    
    return {
      success: false,
      error: error.message || 'Pipeline error',
      timings: { total_ms: totalMs },
      tokenUsage: null
    };
  }
}

// API Endpoints
app.post('/query', async (req, res) => {
  try {
    const { question, conversation_history } = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        error: 'Question is required'
      });
    }

    // Simplified approach: Always use full SQL-of-Thought pipeline with conversation history
    console.log('[SQL-of-Thought] Processing query with', (conversation_history || []).length, 'previous turns');
    const result = await sqlOfThought(question, conversation_history || []);
    
    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'sql-of-thought' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SQL-of-Thought API running on http://localhost:${PORT}`);
  console.log(`📊 Using database: ${DB_PATH}`);
  console.log(`🤖 Using model: ${MODEL}`);
});

