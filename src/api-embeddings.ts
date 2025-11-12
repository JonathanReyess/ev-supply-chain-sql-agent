/**
 * API Server for SQL-of-Thought Agent with Embedding-Based Context Retrieval
 * Uses HYBRID approach: Sliding Window (recency) + Semantic Search (relevance)
 * Runs on port 8001 for comparison with summary-based approach (port 8000)
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
import { getVectorStore, formatTurnForEmbedding, ConversationTurn } from './tools/embedding-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.API_PORT_EMBEDDINGS || 8001;

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
    question: question.substring(0, 100),
    ...tokenData
  };
  
  const logFile = join(LOGS_DIR, `token-usage-embeddings-${new Date().toISOString().split('T')[0]}.jsonl`);
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

// ===========================================================================
// HYBRID CONTEXT RETRIEVER
// ===========================================================================

interface ContextTurn {
  question: string;
  sql?: string;
  tables?: string[];
  provenance: 'recent' | 'retrieved';
  similarity?: number;
  turnNumber?: number;
}

/**
 * HYBRID Retriever: Combines sliding window (recency) + semantic search (relevance)
 * 
 * @param currentQuestion - The question being asked
 * @param conversationId - ID for vector store lookup
 * @returns Merged context with provenance markers
 */
async function hybridContextRetriever(
  currentQuestion: string,
  conversationId: string = 'default'
): Promise<{ context: ContextTurn[]; timings: any }> {
  const timings: any = {};
  const vectorStore = getVectorStore(conversationId);
  const totalTurns = vectorStore.size();

  console.log(`\n🔍 [Hybrid Retriever] Total turns in store: ${totalTurns}`);

  // a) Sliding Window: Last 2 turns for recency
  let stepStart = Date.now();
  const recentTurns = vectorStore.getRecentTurns(2);
  timings.sliding_window_ms = Date.now() - stepStart;

  console.log(`  ✓ Sliding window: ${recentTurns.length} recent turns`);

  const contextTurns: ContextTurn[] = recentTurns.map((turn, idx) => ({
    question: turn.question,
    sql: turn.sql,
    tables: turn.metadata.tables,
    provenance: 'recent' as const,
    turnNumber: totalTurns - recentTurns.length + idx + 1
  }));

  // b) Semantic Search: Top-k=3 from older turns
  if (totalTurns > 2) {
    stepStart = Date.now();
    
    // Exclude indices that are in the sliding window
    const excludeIndices = recentTurns.length > 0 
      ? Array.from({ length: recentTurns.length }, (_, i) => totalTurns - recentTurns.length + i)
      : [];

    console.log(`  🔎 Searching older turns (excluding indices: [${excludeIndices.join(', ')}])...`);

    const searchResults = await vectorStore.search(
      currentQuestion,
      3, // top-k
      excludeIndices
    );
    
    timings.semantic_search_ms = Date.now() - stepStart;
    timings.embedding_generation_ms = timings.semantic_search_ms; // Includes query embedding

    console.log(`  ✓ Found ${searchResults.length} semantically similar turns:`);
    searchResults.forEach(result => {
      console.log(`    - Turn ${result.index + 1}: "${result.turn.question}" (similarity: ${result.similarity.toFixed(3)})`);
    });

    // c) Merge retrieved turns with provenance
    searchResults.forEach(result => {
      contextTurns.push({
        question: result.turn.question,
        sql: result.turn.sql,
        tables: result.turn.metadata.tables,
        provenance: 'retrieved' as const,
        similarity: result.similarity,
        turnNumber: result.index + 1
      });
    });
  } else {
    timings.semantic_search_ms = 0;
    timings.embedding_generation_ms = 0;
    console.log(`  ℹ️  Not enough history for semantic search (need >2 turns)`);
  }

  return { context: contextTurns, timings };
}

/**
 * Format hybrid context for agent prompts with provenance markers
 */
function formatContextForPrompt(context: ContextTurn[]): string {
  if (context.length === 0) {
    return '';
  }

  let formatted = '\n## Conversation History (Hybrid: Recent + Retrieved)\n\n';

  context.forEach(turn => {
    const provenance = turn.provenance === 'recent'
      ? `[RECENT Turn ${turn.turnNumber}]`
      : `[RETRIEVED Turn ${turn.turnNumber}, similarity=${turn.similarity?.toFixed(2)}]`;

    formatted += `${provenance}\n`;
    formatted += `Q: "${turn.question}"\n`;
    if (turn.sql) {
      formatted += `SQL: ${turn.sql}\n`;
    }
    if (turn.tables && turn.tables.length > 0) {
      formatted += `Tables: ${turn.tables.join(', ')}\n`;
    }
    formatted += '\n';
  });

  formatted += `NOTE: If the current question uses "those", "them", "these", "it", look at the RECENT turns for context.\n`;

  return formatted;
}

// ===========================================================================
// AGENT FUNCTIONS (Modified to use hybrid context)
// ===========================================================================

async function schemaLinkingAgent(question: string, schema: any, contextTurns: ContextTurn[]): Promise<any> {
  const contextPrompt = formatContextForPrompt(contextTurns);

  const prompt = `${readFileSync(join(__dirname, 'prompts/schema-linking.md'), 'utf-8')}

## Database Schema

${formatSchemaForPrompt(schema)}
${contextPrompt}

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

async function queryPlanAgent(question: string, linkedSchema: any, subproblems: any, contextTurns: ContextTurn[]): Promise<any> {
  const contextPrompt = formatContextForPrompt(contextTurns);

  const prompt = `${readFileSync(join(__dirname, 'prompts/query-planning.md'), 'utf-8')}
${contextPrompt}

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

async function sqlGenerationAgent(question: string, queryPlan: any, linkedSchema: any, contextTurns: ContextTurn[]): Promise<any> {
  const contextPrompt = formatContextForPrompt(contextTurns);

  const prompt = `You are an expert SQL query generator. Given a query plan, generate the exact SQL query.

CRITICAL RULE: For ALL string comparisons in WHERE clauses, you MUST use LOWER() on BOTH sides.
Example: WHERE LOWER(type) = LOWER('battery')  NOT  WHERE type = 'battery'

${contextPrompt}

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

// ===========================================================================
// MAIN PIPELINE WITH HYBRID RETRIEVAL
// ===========================================================================

async function sqlOfThoughtWithEmbeddings(
  question: string,
  conversationId: string = 'default'
): Promise<any> {
  const pipelineStart = Date.now();
  const timings: any = {};
  const tokenUsagePerAgent: any[] = [];

  try {
    // HYBRID RETRIEVAL: Get context (sliding window + semantic search)
    let stepStart = Date.now();
    const { context: contextTurns, timings: retrievalTimings } = await hybridContextRetriever(
      question,
      conversationId
    );
    timings.context_retrieval_ms = Date.now() - stepStart;
    timings.retrieval_breakdown = retrievalTimings;

    console.log(`\n📚 [Context] Using ${contextTurns.length} turns:`, 
      `${contextTurns.filter(t => t.provenance === 'recent').length} recent,`,
      `${contextTurns.filter(t => t.provenance === 'retrieved').length} retrieved`);

    // Get database schema
    stepStart = Date.now();
    const schema = await getCompleteSchema(DB_PATH);
    timings.schema_loading_ms = Date.now() - stepStart;

    // Schema Linking
    stepStart = Date.now();
    const schemaLinkingResult = await schemaLinkingAgent(question, schema, contextTurns);
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
    const queryPlanResult = await queryPlanAgent(question, linkedSchema, subproblems, contextTurns);
    const queryPlan = queryPlanResult.result;
    timings.query_plan_ms = Date.now() - stepStart;
    tokenUsagePerAgent.push({
      agent: 'query_plan',
      ...queryPlanResult.tokenUsage
    });

    // SQL Generation
    stepStart = Date.now();
    const sqlGenResult = await sqlGenerationAgent(question, queryPlan, linkedSchema, contextTurns);
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

        // Extract key metric if present
        let keyMetric = '';
        if (resultsConverted && resultsConverted.length > 0) {
          const firstRow = resultsConverted[0];
          const keys = Object.keys(firstRow);
          const aggregateKey = keys.find(k =>
            k.match(/^(COUNT|AVG|SUM|MIN|MAX|TOTAL)/i) ||
            k.toLowerCase().includes('average') ||
            k.toLowerCase().includes('total')
          );
          if (aggregateKey) {
            keyMetric = `${aggregateKey}: ${firstRow[aggregateKey]}`;
          }
        }

        // RECORDER: Store turn in vector store
        stepStart = Date.now();
        const vectorStore = getVectorStore(conversationId);
        const turn: ConversationTurn = {
          id: `turn_${vectorStore.size() + 1}`,
          question,
          timestamp: new Date().toISOString(),
          metadata: {
            tables: linkedSchema.tables || [],
            rowCount: result.row_count,
            keyMetric: keyMetric
          },
          sql: generatedSQL
        };
        
        await vectorStore.add(turn);
        timings.embedding_storage_ms = Date.now() - stepStart;

        // Track embedding token usage (estimated)
        tokenUsagePerAgent.push({
          agent: 'embedding_generation',
          promptTokens: formatTurnForEmbedding(turn).split(' ').length, // Rough estimate
          completionTokens: 0,
          totalTokens: formatTurnForEmbedding(turn).split(' ').length
        });

        // Calculate aggregate token usage
        const aggregateTokens = {
          totalPromptTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.promptTokens, 0),
          totalCompletionTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.completionTokens, 0),
          totalTokens: tokenUsagePerAgent.reduce((sum, agent) => sum + agent.totalTokens, 0)
        };

        // Log token usage for each agent
        tokenUsagePerAgent.forEach(agentUsage => {
          logTokenUsage(agentUsage.agent, MODEL, agentUsage, question, conversationId);
        });

        return {
          success: true,
          sql: generatedSQL,
          results: resultsConverted || [],
          row_count: result.row_count,
          execution_time_ms: result.execution_time_ms,
          timings: timings,
          tokenUsage: {
            model: MODEL,
            method: 'hybrid_embeddings',
            perAgent: tokenUsagePerAgent,
            aggregate: aggregateTokens
          },
          context: {
            method: 'hybrid',
            recentTurns: contextTurns.filter(t => t.provenance === 'recent').length,
            retrievedTurns: contextTurns.filter(t => t.provenance === 'retrieved').length,
            totalTurns: contextTurns.length
          },
          metadata: {
            tables: linkedSchema.tables || [],
            rowCount: result.row_count,
            keyMetric: keyMetric
          }
        };
      } else {
        if (attempt < MAX_CORRECTION_ATTEMPTS) {
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
        method: 'hybrid_embeddings',
        perAgent: tokenUsagePerAgent,
        aggregate: aggregateTokens
      }
    };
  } catch (error: any) {
    timings.total_pipeline_ms = Date.now() - pipelineStart;

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
        method: 'hybrid_embeddings',
        perAgent: tokenUsagePerAgent,
        aggregate: aggregateTokens
      } : null
    };
  }
}

// ===========================================================================
// API ENDPOINTS
// ===========================================================================

app.post('/query', async (req, res) => {
  try {
    const { question, conversation_id } = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        error: 'Question is required'
      });
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚀 [Embeddings API] Processing query (conversation: ${conversation_id || 'default'})`);
    console.log(`${'='.repeat(80)}`);
    console.log(`📝 Question: ${question}`);

    const result = await sqlOfThoughtWithEmbeddings(question, conversation_id || 'default');

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    agent: 'sql-of-thought-embeddings',
    method: 'hybrid_retrieval',
    port: PORT
  });
});

// Clear conversation history endpoint (useful for testing)
app.post('/clear/:conversationId', async (req, res) => {
  try {
    const conversationId = req.params.conversationId || 'default';
    const vectorStore = getVectorStore(conversationId);
    vectorStore.clear();

    res.json({
      success: true,
      message: `Cleared conversation history for: ${conversationId}`
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Default clear endpoint (without conversationId)
app.post('/clear', async (req, res) => {
  try {
    const vectorStore = getVectorStore('default');
    vectorStore.clear();

    res.json({
      success: true,
      message: 'Cleared conversation history for: default'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 SQL-of-Thought with HYBRID Embeddings running on http://localhost:${PORT}`);
  console.log(`📊 Using database: ${DB_PATH}`);
  console.log(`🤖 Using model: ${MODEL}`);
  console.log(`🔍 Context method: Sliding Window (last 2) + Semantic Search (top 3)`);
  console.log(`${'='.repeat(80)}\n`);
});

