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
import { runOrchestrator, OrchestratorResult } from './agent.js';
import { getVectorStore, formatTurnForEmbedding, ConversationTurn } from './tools/embedding-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.API_PORT_EMBEDDINGS || 8001;

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
// NOTE: Agent functions removed - now using orchestrator from agent.ts
// ===========================================================================

// ===========================================================================
// MAIN PIPELINE WITH HYBRID RETRIEVAL
// ===========================================================================

async function sqlOfThoughtWithEmbeddings(
  question: string,
  conversationId: string = 'default'
): Promise<any> {
  const pipelineStart = Date.now();

  try {
    // HYBRID RETRIEVAL: Get context (sliding window + semantic search)
    let stepStart = Date.now();
    const { context: contextTurns, timings: retrievalTimings } = await hybridContextRetriever(
      question,
      conversationId
    );
    const retrievalMs = Date.now() - stepStart;

    console.log(`\n📚 [Context] Using ${contextTurns.length} turns:`, 
      `${contextTurns.filter(t => t.provenance === 'recent').length} recent,`,
      `${contextTurns.filter(t => t.provenance === 'retrieved').length} retrieved`);

    // Format context for orchestrator
    const contextString = formatContextForPrompt(contextTurns);

    // Call orchestrator with embeddings context
    const orchestratorResult = await runOrchestrator(question, contextString);

    // Store turn in vector store if successful
    if (orchestratorResult.success && orchestratorResult.sql) {
      stepStart = Date.now();
      const vectorStore = getVectorStore(conversationId);
      const turn: ConversationTurn = {
        id: `turn_${vectorStore.size() + 1}`,
        question,
        timestamp: new Date().toISOString(),
        metadata: {
          tables: orchestratorResult.metadata?.tables || [],
          rowCount: orchestratorResult.metadata?.rowCount || 0,
          keyMetric: orchestratorResult.metadata?.keyMetric || ''
        },
        sql: orchestratorResult.sql
      };
      
      await vectorStore.add(turn);
      const embeddingMs = Date.now() - stepStart;

      console.log(`✅ Stored turn in vector store (${embeddingMs}ms)`);
    }

    // Log token usage
    orchestratorResult.tokenUsage.perTool.forEach(toolUsage => {
      logTokenUsage(toolUsage.tool, orchestratorResult.tokenUsage.model, toolUsage, question, conversationId);
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
      timings: {
        ...orchestratorResult.timings,
        context_retrieval_ms: retrievalMs,
        retrieval_breakdown: retrievalTimings
      },
      tokenUsage: {
        model: orchestratorResult.tokenUsage.model,
        method: 'orchestrator_with_embeddings',
        perAgent: orchestratorResult.tokenUsage.perTool,
        aggregate: orchestratorResult.tokenUsage.aggregate
      },
      context: {
        method: 'hybrid',
        recentTurns: contextTurns.filter(t => t.provenance === 'recent').length,
        retrievedTurns: contextTurns.filter(t => t.provenance === 'retrieved').length,
        totalTurns: contextTurns.length
      },
      metadata: orchestratorResult.metadata,
      iterations: orchestratorResult.iterations
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

