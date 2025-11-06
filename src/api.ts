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
import { getCompleteSchema, formatSchemaForPrompt } from './tools/schema-tool.js';
import { executeSQL } from './tools/sql-executor-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.API_PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());

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

// Agent functions (same as in agent.ts)
async function schemaLinkingAgent(question: string, schema: any, conversationHistory: any[] = []): Promise<any> {
  // Optional prompt-based history context (last 3 turns)
  let conversationContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    conversationContext = '\n## Conversation History (for context)\n\n';
    const recentHistory = conversationHistory.slice(-3);
    recentHistory.forEach((turn, idx) => {
      conversationContext += `Turn ${idx + 1}:\n`;
      conversationContext += `Q: "${turn.question}"\n`;
      if (turn.sql) {
        conversationContext += `SQL Generated: ${turn.sql}\n`;
      }
      conversationContext += '\n';
    });
    conversationContext += `IMPORTANT: If the current question references previous results ("those", "them", "these", "it"), carry forward the same WHERE filters used in the most recent query.\n`;
  }

  const prompt = `${readFileSync(join(__dirname, 'prompts/schema-linking.md'), 'utf-8')}

## Database Schema

${formatSchemaForPrompt(schema)}
${conversationContext}

## Question

"${question}"

Analyze the question and identify the relevant tables, columns, and relationships needed. Return ONLY a valid JSON object as specified in the output format.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{}');
  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { result, tokenUsage };
}

async function subproblemAgent(question: string, linkedSchema: any): Promise<any> {
  const prompt = `You are a SQL query decomposition expert. Given a natural language question, break it down into SQL clause-level subproblems.

Question: "${question}"

Relevant tables: ${linkedSchema.tables.join(', ')}
Relevant columns: ${JSON.stringify(linkedSchema.columns)}

Identify which SQL clauses are needed and what each should accomplish. Return a JSON object with:

Only include clauses that are needed. Return ONLY valid JSON.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{}');
  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { result, tokenUsage };
}

async function queryPlanAgent(question: string, linkedSchema: any, subproblems: any, conversationHistory: any[] = []): Promise<any> {
  let historyContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const lastQuery = conversationHistory[conversationHistory.length - 1];
    if (lastQuery.sql) {
      historyContext = `\n## Previous Query Context\nLast SQL: ${lastQuery.sql}\nIf the current question uses references like "those"/"them"/"it", these refer to the filtered subset from the last query.\n\n`;
    }
  }

  const prompt = `${readFileSync(join(__dirname, 'prompts/query-planning.md'), 'utf-8')}
${historyContext}

## Question
"${question}"

## Schema Information
Tables: ${linkedSchema.tables.join(', ')}
Columns: ${JSON.stringify(linkedSchema.columns, null, 2)}
Foreign Keys: ${JSON.stringify(linkedSchema.foreign_keys, null, 2)}

## Identified Clauses
${JSON.stringify(subproblems.clauses, null, 2)}

Create a detailed step-by-step query plan using Chain-of-Thought reasoning. Return ONLY valid JSON as specified.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{}');
  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { result, tokenUsage };
}

async function sqlGenerationAgent(question: string, queryPlan: any, linkedSchema: any, conversationHistory: any[] = []): Promise<any> {
  let historyContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const lastQuery = conversationHistory[conversationHistory.length - 1];
    if (lastQuery.sql) {
      historyContext = `\nPrevious SQL Query:\n${lastQuery.sql}\n\nIf the current question references previous results ("those", "them", "it", "these"), carry forward the WHERE filters from the previous query.\n\n`;
    }
  }

  const prompt = `You are an expert SQL query generator. Given a query plan, generate the exact SQL query.

CRITICAL RULE: For ALL string comparisons in WHERE clauses, you MUST use LOWER() on BOTH sides.
Example: WHERE LOWER(type) = LOWER('battery')  NOT  WHERE type = 'battery'

${historyContext}

## Guidelines

- Use exact names: Column and table names must match the schema exactly (case-sensitive)
- ALWAYS wrap string values in WHERE clauses with LOWER() for case-insensitive matching

Question: "${question}"

Query Plan:
${JSON.stringify(queryPlan, null, 2)}

Schema:
${JSON.stringify(linkedSchema, null, 2)}

Generate the SQL query that implements this plan. Return ONLY the SQL query, no explanations or markdown. The query should be executable and syntactically correct.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
    },
  });

  const sql = response.text?.trim() || '';
  const cleanedSQL = sql
    .replace(/```sql\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { sql: cleanedSQL, tokenUsage };
}

async function correctionPlanAgent(
  question: string,
  incorrectSQL: string,
  error: string,
  linkedSchema: any
): Promise<any> {
  const prompt = `${readFileSync(join(__dirname, 'prompts/error-correction.md'), 'utf-8')}

## Error Taxonomy
${JSON.stringify(errorTaxonomy, null, 2)}

## Question
"${question}"

## Failed SQL Query
\`\`\`sql
${incorrectSQL}
\`\`\`

## Error Message
${error}

## Schema
${JSON.stringify(linkedSchema, null, 2)}

Analyze this error using the taxonomy and provide a structured correction plan. Return ONLY valid JSON as specified.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{}');
  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { result, tokenUsage };
}

async function correctionSQLAgent(
  question: string,
  incorrectSQL: string,
  correctionPlan: any,
  linkedSchema: any
): Promise<any> {
  const prompt = `You are an expert SQL query corrector. Fix the SQL query based on the correction plan.

Question: "${question}"

Incorrect SQL:
\`\`\`sql
${incorrectSQL}
\`\`\`

Correction Plan:
${JSON.stringify(correctionPlan, null, 2)}

Schema:
${JSON.stringify(linkedSchema, null, 2)}

Generate the corrected SQL query that addresses all issues identified in the correction plan. Return ONLY the corrected SQL query, no explanations.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
    },
  });

  const sql = response.text?.trim() || '';
  const cleanedSQL = sql
    .replace(/```sql\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  const tokenUsage = {
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  };

  return { sql: cleanedSQL, tokenUsage };
}

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
  
  console.log(`  [DEBUG] Processing ${turns.length} turns for summary`);
  
  turns.forEach((turn, idx) => {
    console.log(`  [DEBUG] Turn ${idx + 1}: tables=${turn.tables}, keyMetric=${turn.keyMetric}, rowCount=${turn.rowCount}`);
    
    if (turn.tables && Array.isArray(turn.tables)) {
      turn.tables.forEach((t: string) => allTables.add(t));
    }
    if (turn.question) {
      const metric = turn.keyMetric || `${turn.rowCount || 0} rows`;
      keyMetrics.push({ question: turn.question, result: metric });
    }
  });
  
  console.log(`  [DEBUG] Extracted tables: [${Array.from(allTables).join(', ')}]`);

  // Build prompt for summary generation
  const previousSummary = existingSummary ? `\nPrevious Summary:\n${existingSummary.summaryText}\n` : '';
  const turnsContext = turns.map((t, idx) => {
    const resultInfo = t.keyMetric ? t.keyMetric : `${t.rowCount || 0} rows returned`;
    return `Turn ${idx + 1}:
  - Question: "${t.question}"
  - Tables: ${t.tables?.join(', ') || 'unknown'}
  - Key Result: ${resultInfo}`;
  }).join('\n\n');

  const prompt = `You are a conversation summarizer for a SQL query system. Create a concise summary of the conversation history.

${previousSummary}

## Conversation Turns to Summarize
${turnsContext}

## Requirements
- **Maximum 200 words**
- CRITICAL: Include the actual KEY RESULT numbers (like "60 suppliers", "average: 84.5"), NOT just "X rows returned"
- Include: (a) what user asked, (b) the actual numeric answers/metrics, (c) table names queried
- Format example: "User queried suppliers table, finding 60 suppliers with average reliability 84.5. Then queried components table, finding 150 items in stock."
- Be concise, factual, and include the ACTUAL result numbers

Return ONLY the summary text, no additional commentary or formatting.`;

  let summaryText = '';
  let tokenCount = 0;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 300,
      },
    });

    tokenCount = response.usageMetadata?.totalTokenCount || 0;
    
    console.log(`  [DEBUG] Response.text exists:`, !!response.text);
    console.log(`  [DEBUG] Response.candidates exists:`, !!response.candidates);
    
    // Try to extract text - handle different response formats
    if (response.text) {
      summaryText = response.text.trim();
      console.log(`  [DEBUG] Got text from response.text`);
    } else if (response.candidates && response.candidates[0]?.content?.parts) {
      summaryText = response.candidates[0].content.parts
        .map((p: any) => p.text || '')
        .join('')
        .trim();
      console.log(`  [DEBUG] Got text from candidates.parts`);
    }

    // Fallback if LLM returns empty text
    if (!summaryText) {
      console.error('  ⚠️  WARNING: Summary text is empty!');
      console.error('  [DEBUG] Response keys:', Object.keys(response));
      console.error('  [DEBUG] Finish reason:', response.candidates?.[0]?.finishReason);
      
      // Create a simple fallback summary from the metadata
      const tablesList = Array.from(allTables).join(', ') || 'unknown';
      const metricsText = keyMetrics.map(m => `${m.question} (${m.result})`).join('; ');
      summaryText = `Previous queries on ${tablesList}: ${metricsText}`;
      console.log(`  [DEBUG] Using fallback summary: "${summaryText}"`);
    }
    
    console.log(`  ✓ Generated summary (${summaryText.length} chars): "${summaryText.substring(0, 100)}${summaryText.length > 100 ? '...' : ''}"`);
    console.log(`  ✓ Summary tokens: ${tokenCount}, Word count: ${summaryText.split(' ').length}`);
  } catch (error: any) {
    console.error('  ❌ Summary generation failed:', error.message);
    // Create fallback summary
    const tablesList = Array.from(allTables).join(', ') || 'unknown tables';
    const metricsText = keyMetrics.map(m => `"${m.question}" → ${m.result}`).join(', ');
    summaryText = `Queried ${tablesList}. ${metricsText}`;
    console.log(`  ℹ️  Using fallback summary: "${summaryText}"`);
  }


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

// Main SQL-of-Thought function
async function sqlOfThought(question: string, conversationHistory: any[] = []): Promise<any> {
  const pipelineStart = Date.now();
  const timings: any = {};
  const tokenUsagePerAgent: any[] = [];
  
  try {
    // Prepare context with sliding-window strategy (window size = 3)
    // Summary triggers on Q4 (when history has 3 items: Q1, Q2, Q3)
    let contextForAgents = conversationHistory;
    console.log(`\n[DEBUG] History length: ${conversationHistory.length}`);
    
    if (conversationHistory.length >= 3) {
      // Summarize old turns, keep last 2 in full window
      // When history = 3 (asking Q4): summarize Q1, keep Q2,Q3 + current
      // When history = 4 (asking Q5): summarize Q1-Q2, keep Q3,Q4 + current
      const oldTurns = conversationHistory.slice(0, -2);
      
      console.log(`[DEBUG] oldTurns.length: ${oldTurns.length}`);
      
      if (oldTurns.length > 0) {
        console.log(`\n📝 Generating summary for ${oldTurns.length} turn(s), keeping last 2 in full context`);
        
        conversationSummaryStorage = await generateConversationSummary(oldTurns, conversationSummaryStorage || undefined);
        
        console.log(`[DEBUG] Summary storage after generation:`, conversationSummaryStorage ? 'EXISTS' : 'NULL');
        
        // Use summary + last 2 turns (will become 3 with current question)
        contextForAgents = [
          { 
            isSummary: true, 
            summaryText: conversationSummaryStorage.summaryText,
            tables: conversationSummaryStorage.keyMetadata.tablesUsed
          },
          ...conversationHistory.slice(-2)
        ];
        
        console.log(`\n📚 [Context Management] Using summary (${conversationSummaryStorage.tokenCount} tokens) + last 2 turns`);
      }
    }
    
    // Get database schema
    let stepStart = Date.now();
    const schema = await getCompleteSchema(DB_PATH);
    timings.schema_loading_ms = Date.now() - stepStart;

    // Schema Linking
    stepStart = Date.now();
    const schemaLinkingResult = await schemaLinkingAgent(question, schema, contextForAgents);
    const linkedSchema = schemaLinkingResult.result;
    timings.schema_linking_ms = Date.now() - stepStart;
    tokenUsagePerAgent.push({
      agent: 'schema_linking',
      ...schemaLinkingResult.tokenUsage
    });

    // Subproblem Identification
    stepStart = Date.now();
    const subproblemResult = await subproblemAgent(question, linkedSchema);
    const subproblems = subproblemResult.result;
    timings.subproblem_ms = Date.now() - stepStart;
    tokenUsagePerAgent.push({
      agent: 'subproblem',
      ...subproblemResult.tokenUsage
    });

    // Query Plan Generation
    stepStart = Date.now();
    const queryPlanResult = await queryPlanAgent(question, linkedSchema, subproblems, contextForAgents);
    const queryPlan = queryPlanResult.result;
    timings.query_plan_ms = Date.now() - stepStart;
    tokenUsagePerAgent.push({
      agent: 'query_plan',
      ...queryPlanResult.tokenUsage
    });

    // SQL Generation
    stepStart = Date.now();
    const sqlGenResult = await sqlGenerationAgent(question, queryPlan, linkedSchema, contextForAgents);
    let generatedSQL = sqlGenResult.sql;
    timings.sql_generation_ms = Date.now() - stepStart;
    tokenUsagePerAgent.push({
      agent: 'sql_generation',
      ...sqlGenResult.tokenUsage
    });

    // Execute and potentially correct
    let attempt = 0;
    let success = false;
    let result: any;
    const correctionTimings: number[] = [];

    while (attempt <= MAX_CORRECTION_ATTEMPTS && !success) {
      stepStart = Date.now();
      result = await executeSQL(generatedSQL, DB_PATH);
      const executionTime = Date.now() - stepStart;

      if (result.success) {
        success = true;
        timings.sql_execution_ms = result.execution_time_ms;
        timings.total_pipeline_ms = Date.now() - pipelineStart;
        
        // Convert BigInt to string for JSON serialization
        const resultsConverted = result.result?.map((row: any) => {
          const converted: any = {};
          for (const [key, value] of Object.entries(row)) {
            converted[key] = typeof value === 'bigint' ? value.toString() : value;
          }
          return converted;
        });

        // Calculate aggregate token usage
        const aggregateTokens = {
          totalPromptTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.promptTokens, 0),
          totalCompletionTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.completionTokens, 0),
          totalTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.totalTokens, 0)
        };

        // Log token usage for each agent
        tokenUsagePerAgent.forEach(agentUsage => {
          logTokenUsage(agentUsage.agent, MODEL, agentUsage, question);
        });

        // Extract key metric if present (e.g., aggregation result)
        let keyMetric = '';
        if (resultsConverted && resultsConverted.length > 0) {
          const firstRow = resultsConverted[0];
          const keys = Object.keys(firstRow);
          // Check if there's an aggregation (COUNT, AVG, SUM, etc.)
          const aggregateKey = keys.find(k => 
            k.match(/^(COUNT|AVG|SUM|MIN|MAX|TOTAL)/i) || 
            k.toLowerCase().includes('average') ||
            k.toLowerCase().includes('total')
          );
          if (aggregateKey) {
            keyMetric = `${aggregateKey}: ${firstRow[aggregateKey]}`;
          }
        }

        // Include summary info if it was used
        let summaryInfo = null;
        if (conversationHistory.length >= 3 && conversationSummaryStorage) {
          summaryInfo = {
            summaryText: conversationSummaryStorage.summaryText,
            tokenCount: conversationSummaryStorage.tokenCount,
            turnsCount: conversationSummaryStorage.turnRange.end,
            tablesUsed: conversationSummaryStorage.keyMetadata.tablesUsed
          };
        }

        return {
          success: true,
          sql: generatedSQL,
          results: resultsConverted || [],
          row_count: result.row_count,
          execution_time_ms: result.execution_time_ms,
          timings: timings,
          tokenUsage: {
            model: MODEL,
            perAgent: tokenUsagePerAgent,
            aggregate: aggregateTokens
          },
          // Enhanced metadata for conversation history
          metadata: {
            tables: linkedSchema.tables || [],
            rowCount: result.row_count,
            keyMetric: keyMetric
          },
          // Summary information (if active)
          summary: summaryInfo
        };
      } else {
        if (attempt < MAX_CORRECTION_ATTEMPTS) {
          // Enter correction loop
          const correctionStart = Date.now();
          const correctionPlanResult = await correctionPlanAgent(question, generatedSQL, result.error || '', linkedSchema);
          const correctionPlan = correctionPlanResult.result;
          tokenUsagePerAgent.push({
            agent: 'correction_plan',
            ...correctionPlanResult.tokenUsage
          });
          
          const correctionSQLResult = await correctionSQLAgent(question, generatedSQL, correctionPlan, linkedSchema);
          generatedSQL = correctionSQLResult.sql;
          tokenUsagePerAgent.push({
            agent: 'correction_sql',
            ...correctionSQLResult.tokenUsage
          });
          
          correctionTimings.push(Date.now() - correctionStart);
        }
        attempt++;
      }
    }

    if (correctionTimings.length > 0) {
      timings.correction_attempts_ms = correctionTimings;
    }
    timings.total_pipeline_ms = Date.now() - pipelineStart;

    // Calculate aggregate token usage even on failure
    const aggregateTokens = {
      totalPromptTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.promptTokens, 0),
      totalCompletionTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.completionTokens, 0),
      totalTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.totalTokens, 0)
    };

    return {
      success: false,
      error: result.error || 'Unknown error',
      sql: generatedSQL,
      attempts: attempt,
      timings: timings,
      tokenUsage: {
        model: MODEL,
        perAgent: tokenUsagePerAgent,
        aggregate: aggregateTokens
      }
    };
  } catch (error: any) {
    timings.total_pipeline_ms = Date.now() - pipelineStart;
    
    // Calculate aggregate token usage for partial execution
    const aggregateTokens = tokenUsagePerAgent.length > 0 ? {
      totalPromptTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.promptTokens, 0),
      totalCompletionTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.completionTokens, 0),
      totalTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.totalTokens, 0)
    } : null;

    return {
      success: false,
      error: error.message || 'Pipeline error',
      timings: timings,
      tokenUsage: aggregateTokens ? {
        model: MODEL,
        perAgent: tokenUsagePerAgent,
        aggregate: aggregateTokens
      } : null
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

