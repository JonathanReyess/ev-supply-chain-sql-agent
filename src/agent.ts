/**
 * SQL-of-Thought: Multi-agent Text-to-SQL with Looping Orchestrator
 * Using GEMINI 2.5 Flash with agentic tool-calling loop
 */

// FIX 1: Import Type along with GoogleGenAI
import { GoogleGenAI, Schema, Type } from '@google/genai';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { getCompleteSchema, formatSchemaForPrompt } from './tools/schema-tool.js';
import { executeSQL } from './tools/sql-executor-tool.js';
import { generatePlot, PlottingInput, PlottingInputJSONSchema } from './tools/plotting-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DB_PATH = join(process.cwd(), 'data', 'ev_supply_chain.db');
const ERROR_TAXONOMY_PATH = join(__dirname, '../data/error-taxonomy.json');
const MAX_AGENT_ITERATIONS = 15; // Maximum loops to prevent infinite execution
const MAX_CORRECTION_ATTEMPTS = 3;

// --- NEW CONSTANTS FOR RATE LIMITING ---
const BASE_RETRY_DELAY_MS = 1000; // 1 second base delay
const MAX_RETRY_DELAY_MS = 60000; // Maximum delay (1 minute)

/**
 * Helper function to introduce a delay.
 * @param ms The number of milliseconds to wait.
 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
// ----------------------------------------

// Initialize GoogleGenAI
const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '0.7');

// Load resources
const errorTaxonomy = JSON.parse(readFileSync(ERROR_TAXONOMY_PATH, 'utf-8'));

/**
 * Helper function to convert BigInts to strings for JSON serialization
 */
function convertBigIntsToStrings(data: any[]): any[] {
  return data.map(row => {
    const converted: any = {};
    for (const [key, value] of Object.entries(row)) {
      converted[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return converted;
  });
}

/**
 * Helper function to sanitize the LLM response text, ensuring it is clean JSON.
 * Removes common markdown code fences (```json, ```) if they exist.
 */
function cleanJsonString(text: string): string {
    let cleanedText = text.trim();
    
    // Check for and remove markdown code block wrapping
    if (cleanedText.startsWith('```')) {
        // Strip the opening fence (e.g., ```json\n or ```\n)
        cleanedText = cleanedText.replace(/^```(json\s*|yaml\s*|)\n/i, '').trim();
        
        // Strip the closing fence (e.g., \n```)
        if (cleanedText.endsWith('```')) {
            cleanedText = cleanedText.substring(0, cleanedText.length - 3).trim();
        }
    }
    
    // If the text is empty after cleaning, return a default empty JSON object string
    return cleanedText.length > 0 ? cleanedText : '{}';
}


// ----------------------------------------------------------------------
// AGENT STATE MANAGEMENT
// ----------------------------------------------------------------------

interface AgentState {
  question: string;
  schema?: any;
  linkedSchema?: any;
  kpiDecomposition?: any;
  subproblems?: any;
  queryPlan?: any;
  currentSQL?: string;
  executionResult?: any;
  correctionAttempts: number;
  visualizationResult?: any;
  finalAnswer?: string;
  completed: boolean;
  conversationHistory: Array<{role: string, content: string}>;
}

// Token usage tracking interface
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Orchestrator result interface
export interface OrchestratorResult {
  success: boolean;
  question: string;
  sql?: string;
  results?: any[];
  row_count?: number;
  finalAnswer?: string;
  visualization?: any;
  timings: {
    total_ms: number;
    [key: string]: number;
  };
  tokenUsage: {
    model: string;
    perTool: Array<{
      tool: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>;
    aggregate: {
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalTokens: number;
    };
  };
  iterations: number;
  metadata?: {
    tables?: string[];
    rowCount?: number;
    keyMetric?: string;
  };
}

function createInitialState(question: string): AgentState {
  return {
    question,
    correctionAttempts: 0,
    completed: false,
    conversationHistory: [],
  };
}

// ----------------------------------------------------------------------
// TOOLKIT: Individual Agent Functions (Tools)
// ----------------------------------------------------------------------

/**
 * Tool 1: Load Database Schema
 */
async function toolLoadSchema(state: AgentState): Promise<string> {
  console.log('\n📥 [Tool: Load Schema] Loading database schema...');
  try {
    const schema = await getCompleteSchema(DB_PATH);
    state.schema = schema;
    const tableCount = Object.keys(schema.tables).length;
    console.log(`  ✓ Schema loaded: ${tableCount} tables`);
    return `Successfully loaded database schema with ${tableCount} tables: ${Object.keys(schema.tables).join(', ')}`;
  } catch (error) {
    return `Error loading schema: ${error}`;
  }
}

/**
 * Tool 2: Schema Linking 
 */
async function toolSchemaLinking(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n🔗 [Tool: Schema Linking] Analyzing question for relevant schema elements...');
  
  if (!state.schema) {
    return 'Error: Schema not loaded. Please load schema first.';
  }
  const prompt = `${readFileSync(join(__dirname, 'prompts/schema-linking.md'), 'utf-8')}

## Database Schema

${formatSchemaForPrompt(state.schema)}

## Question

"${state.question}"

Analyze the question and identify the relevant tables, columns, and relationships needed. Return ONLY a valid JSON object as specified in the output format.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  // Track token usage
  tokenTracker.push({
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  });

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  const result = JSON.parse(jsonText);
  state.linkedSchema = result;
  console.log('  ✓ Identified tables:', result.tables);
  return `Schema linking complete. Identified ${result.tables.length} relevant tables: ${result.tables.join(', ')}. Reasoning: ${result.reasoning}`;
}

/**
 * Tool 3: KPI Decomposition 
 */
async function toolKPIDecomposition(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n📊 [Tool: KPI Decomposition] Breaking down KPI metrics...');
  
  if (!state.linkedSchema) {
    return 'Error: Schema linking not performed. Please link schema first.';
  }

  const KPI_METRIC_PROMPT_PATH = join(__dirname, 'prompts/kpi-metric-agent.md');
  const prompt = `${readFileSync(KPI_METRIC_PROMPT_PATH, 'utf-8')}

## Question
"${state.question}"

## Schema Information
Tables: ${state.linkedSchema.tables.join(', ')}
Columns: ${JSON.stringify(state.linkedSchema.columns, null, 2)}
Foreign Keys: ${JSON.stringify(state.linkedSchema.foreign_keys, null, 2)}

Analyze the question and break down the KPI into its core components. Return ONLY valid JSON as specified.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  // Track token usage
  tokenTracker.push({
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  });

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  const result = JSON.parse(jsonText);
  state.kpiDecomposition = result;
  console.log('  ✓ Decomposed KPI:', result.kpi_name);
  return `KPI decomposed: ${result.kpi_name}. Primary calculation: ${result.primary_calculation?.operation} on ${result.primary_calculation?.target}`;
}

/**
 * Tool 4: Generate Query Plan (Combination of Subproblem Identification & Query Planning)
 */
async function toolGenerateQueryPlan(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n🤔 [Tool: Generate Query Plan] Decomposing query and generating plan...');
  
  if (!state.linkedSchema) {
    return 'Error: Schema linking not performed. Please link schema first.';
  }

  // Use the KPI Decomposition if it exists, otherwise rely purely on the question and schema
  const decompositionContext = state.kpiDecomposition 
    ? `## KPI Decomposition\n${JSON.stringify(state.kpiDecomposition, null, 2)}`
    : ``;
    
  // NOTE: The prompt now needs to instruct the LLM to perform BOTH decomposition and planning.
  const prompt = `You are a specialized SQL query planning expert. Your task is to analyze the user's question, decompose it into SQL components, and then generate a step-by-step query execution plan.

${readFileSync(join(__dirname, 'prompts/query-planning.md'), 'utf-8')}

## Question
"${state.question}"

## Schema Information
Tables: ${state.linkedSchema.tables.join(', ')}
Columns: ${JSON.stringify(state.linkedSchema.columns, null, 2)}
Foreign Keys: ${JSON.stringify(state.linkedSchema.foreign_keys, null, 2)}

${decompositionContext}

Create a detailed step-by-step query plan using Chain-of-Thought reasoning. Ensure the plan addresses the goal, data sources, joins, filters, and aggregations using the provided Schema Information. Return ONLY valid JSON as specified in the 'Output Format' section of the Query Plan Agent instructions.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  // Track token usage
  tokenTracker.push({
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  });

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  
  try {
    const result = JSON.parse(jsonText);
    state.queryPlan = result;
    // NOTE: state.subproblems is no longer needed/set
    console.log('  ✓ Generated plan with', result.steps?.length || 0, 'steps');
    return `Query plan created with ${result.steps?.length || 0} steps. Strategy: ${result.final_strategy}`;
  } catch (e) {
      console.error(`Failed to parse JSON for query plan. Error: ${e}`);
      console.error('Original (uncleaned) text:', response.text);
      console.error('Cleaned text that failed:', jsonText);
      return `Tool Error: Failed to parse LLM response into JSON. Error: ${e}`;
  }
}

// REMOVED: toolSubproblemIdentification (Tool 4)
// REMOVED: toolQueryPlanning (Tool 5) -> replaced by toolGenerateQueryPlan (New Tool 4)

/**
 * Tool 5: SQL Generation (Tool number shifts down)
 */
async function toolSQLGeneration(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n📝 [Tool: SQL Generation] Generating SQL query...');
  
  if (!state.queryPlan || !state.linkedSchema) {
    return 'Error: Query plan or schema not available.';
  }

  const prompt = `You are an expert SQL query generator. Given a query plan, generate the exact SQL query.

Question: "${state.question}"

Query Plan:
${JSON.stringify(state.queryPlan, null, 2)}

Schema:
${JSON.stringify(state.linkedSchema, null, 2)}

IMPORTANT: For WHERE clause string comparisons, always use case-insensitive matching with LOWER():
- Example: WHERE LOWER(type) = LOWER('Battery')
- Example: WHERE LOWER(status) = LOWER('delayed')

Generate the SQL query that implements this plan. Return ONLY the SQL query, no explanations or markdown. The query should be executable and syntactically correct.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
    },
  });

  // Track token usage
  tokenTracker.push({
    promptTokens: response.usageMetadata?.promptTokenCount || 0,
    completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: response.usageMetadata?.totalTokenCount || 0,
  });

  const sql = response.text?.trim() || '';
  const cleanedSQL = sql
    .replace(/```sql\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  state.currentSQL = cleanedSQL;
  console.log('  ✓ Generated SQL');
  return `SQL query generated: ${cleanedSQL.substring(0, 100)}...`;
}

/**
 * Tool 6: Execute SQL
 */
async function toolExecuteSQL(state: AgentState): Promise<string> {
  console.log('\n▶️ [Tool: Execute SQL] Running query...');
  
  if (!state.currentSQL) {
    return 'Error: No SQL query to execute. Generate SQL first.';
  }

  // NOTE: Assuming your executeSQL function works correctly
  const result = await executeSQL(state.currentSQL, DB_PATH);
  state.executionResult = result;

  if (result.success) {
    console.log(` Query executed successfully! ${result.row_count} rows in ${result.execution_time_ms}ms`);
    
    const resultsToShow = result.result?.slice(0, 3).map(row => {
      const converted: any = {};
      for (const [key, value] of Object.entries(row)) {
        converted[key] = typeof value === 'bigint' ? value.toString() : value;
      }
      return converted;
    });

    return `Query executed successfully. Returned ${result.row_count} rows. Sample: ${JSON.stringify(resultsToShow)}`;
  } else {
    console.log(' Query failed:', result.error);
    return `Query execution failed: ${result.error}`;
  }
}

/**
 * Tool 7: Error Correction 
 */
async function toolErrorCorrection(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n🔧 [Tool: Error Correction] Analyzing and fixing error...');
  
  if (!state.executionResult || state.executionResult.success) {
    return 'Error: No failed query to correct.';
  }

  if (state.correctionAttempts >= MAX_CORRECTION_ATTEMPTS) {
    return `Maximum correction attempts (${MAX_CORRECTION_ATTEMPTS}) reached. Cannot fix query.`;
  }

  // Generate correction plan
  // NOTE: Assuming your prompts/error-correction.md path is correct
  const correctionPrompt = `${readFileSync(join(__dirname, 'prompts/error-correction.md'), 'utf-8')}

## Error Taxonomy
${JSON.stringify(errorTaxonomy, null, 2)}

## Question
"${state.question}"

## Failed SQL Query
\`\`\`sql
${state.currentSQL}
\`\`\`

## Error Message
${state.executionResult.error}

## Schema
${JSON.stringify(state.linkedSchema, null, 2)}

Analyze this error using the taxonomy and provide a structured correction plan. Return ONLY valid JSON as specified.`;

  const correctionPlanResponse = await ai.models.generateContent({
    model: MODEL,
    contents: correctionPrompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  // Track token usage for correction plan
  tokenTracker.push({
    promptTokens: correctionPlanResponse.usageMetadata?.promptTokenCount || 0,
    completionTokens: correctionPlanResponse.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: correctionPlanResponse.usageMetadata?.totalTokenCount || 0,
  });

  const correctionPlanJsonText = cleanJsonString(correctionPlanResponse.text || '{}'); // Apply fix
  const correctionPlan = JSON.parse(correctionPlanJsonText);
  console.log('  ✓ Error categories:', correctionPlan.error_categories);

  // Generate corrected SQL
  const correctionSQLPrompt = `You are an expert SQL query corrector. Fix the SQL query based on the correction plan.

Question: "${state.question}"

Incorrect SQL:
\`\`\`sql
${state.currentSQL}
\`\`\`

Correction Plan:
${JSON.stringify(correctionPlan, null, 2)}

Schema:
${JSON.stringify(state.linkedSchema, null, 2)}

Generate the corrected SQL query that addresses all issues identified in the correction plan. Return ONLY the corrected SQL query, no explanations.`;

  const correctedSQLResponse = await ai.models.generateContent({
    model: MODEL,
    contents: correctionSQLPrompt,
    config: {
      temperature: TEMPERATURE,
    },
  });

  // Track token usage for corrected SQL
  tokenTracker.push({
    promptTokens: correctedSQLResponse.usageMetadata?.promptTokenCount || 0,
    completionTokens: correctedSQLResponse.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: correctedSQLResponse.usageMetadata?.totalTokenCount || 0,
  });

  const sql = correctedSQLResponse.text?.trim() || '';
  const cleanedSQL = sql
    .replace(/```sql\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  state.currentSQL = cleanedSQL;
  state.correctionAttempts++;
  console.log('  ✓ Generated corrected SQL');
  return `SQL corrected (attempt ${state.correctionAttempts}/${MAX_CORRECTION_ATTEMPTS}). Error categories: ${correctionPlan.error_categories.join(', ')}`;
}

/**
 * Tool 8: Visualize Results
 */
async function toolVisualizeResults(state: AgentState, tokenTracker: TokenUsage[]): Promise<string> {
  console.log('\n📈 [Tool: Visualize Results] Generating visualization...');
  
  if (!state.executionResult || !state.executionResult.success) {
    return 'Error: No successful query results to visualize.';
  }

  const results = state.executionResult.result || [];
  if (results.length === 0) {
    return 'No data to visualize (empty result set).';
  }

  // Prepare schema context
  const schemaContext = convertBigIntsToStrings(results.slice(0, 1));

  const prompt = `You are a Visualization Planner. Given the user question and the structure of the successful SQL results, determine the best parameters for the 'generate_plot' tool.

Question: "${state.question}"

SQL Result Schema (Keys and one example row):
${JSON.stringify(schemaContext, null, 2)}

Identify the column for the X-axis (dimension), the column for the Y-axis (metric), and the best plot type. Return ONLY the JSON object that conforms to the 'generate_plot' tool input schema.
NOTE: Ensure your response is a valid JSON object matching the 'generate_plot' input schema, omitting the 'query_results' key.`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0.0,
        responseMimeType: 'application/json',
        responseSchema: PlottingInputJSONSchema,
      },
    });

    // Track token usage
    tokenTracker.push({
      promptTokens: response.usageMetadata?.promptTokenCount || 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
      totalTokens: response.usageMetadata?.totalTokenCount || 0,
    });

    const plotParamsJsonText = cleanJsonString(response.text || '{}'); // Apply fix
    const plotParams: PlottingInput = JSON.parse(plotParamsJsonText);
    // NOTE: query_results is added here, outside the LLM call
    plotParams.query_results = results;

    // NOTE: Assuming your generatePlot function works correctly
    const plotOutput = await generatePlot(plotParams);
    state.visualizationResult = plotOutput;

    console.log(`  ✓ Generated plot: ${plotOutput.plot_description}`);
    return `Visualization created: ${plotOutput.plot_description}. File saved to: ${plotOutput.plot_file_path}`;
  } catch (e) {
    console.error('   Failed to generate visualization:', e);
    return `Visualization failed: ${e}`;
  }
}

// ----------------------------------------------------------------------
// TOOL REGISTRY
// ----------------------------------------------------------------------

const TOOL_DESCRIPTIONS = {
  load_schema: "Load the database schema to understand available tables and columns",
  schema_linking: "Identify relevant tables, columns, and relationships for the question",
  kpi_decomposition: "Break down a KPI metric into its component calculations (use for complex metrics)",
  // COMBINED: subproblem_identification is now part of generate_query_plan
  generate_query_plan: "Decompose the query into SQL clauses and create a step-by-step execution plan",
  sql_generation: "Generate the actual SQL query from the execution plan",
  execute_sql: "Execute the SQL query against the database",
  error_correction: "Analyze and fix SQL execution errors",
  visualize_results: "Create a visualization from successful query results",
};

// ----------------------------------------------------------------------
// LOOPING ORCHESTRATOR AGENT
// ----------------------------------------------------------------------

/**
 * The main Orchestrator Agent that runs in a loop - EXPORTED for use by API servers
 * @param question - The user's question
 * @param contextHistory - Optional conversation context (from summaries or embeddings)
 * @returns Structured results including SQL, results, tokens, and timings
 */
export async function runOrchestrator(
  question: string,
  contextHistory?: string
): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const tokenTracker: TokenUsage[] = [];
  console.log('\n' + '='.repeat(80));
  console.log(' SQL-of-Thought: Looping Orchestrator Agent');
  console.log('='.repeat(80));
  console.log('\n📝 Question:', question);
  if (contextHistory) {
    console.log('📚 Using conversation context');
  }

  const state = createInitialState(question);
  let iteration = 0;
  let consecutiveApiFailures = 0;

  // Inject context history into system prompt if provided
  const contextSection = contextHistory ? `\n\n## Conversation Context\n${contextHistory}\n` : '';

  // System prompt for the orchestrator (defines the agent's identity and rules)
  const baseSystemPrompt = `You are an intelligent data analyst orchestrator agent. Your goal is to answer the user's question about data in a database.
${contextSection}
You have access to these tools:
${Object.entries(TOOL_DESCRIPTIONS).map(([name, desc]) => `- ${name}: ${desc}`).join('\n')}

At each step, you should:
1. Analyze the current state and what's been accomplished
2. Decide which tool to call next (if any) to get closer to answering the question
3. Or, if you have all the information needed, provide a final answer to the user

Guidelines:
- Always start by loading the schema
- For KPI questions (metrics like "average time", "total count"), use kpi_decomposition, then generate_query_plan.
- For standard queries, skip kpi_decomposition and go straight to generate_query_plan.
- After generating SQL, always execute it
- If execution fails, use error_correction (up to ${MAX_CORRECTION_ATTEMPTS} times)
- Consider visualization for numerical results
- When you have the answer, respond with "FINAL_ANSWER: [your answer]"`;

  while (iteration < MAX_AGENT_ITERATIONS && !state.completed) {
    iteration++;
    
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`🔄 Iteration ${iteration}/${MAX_AGENT_ITERATIONS}`);
    console.log(`${'─'.repeat(80)}`);

    // --- NEW: Implement Exponential Backoff Delay Logic ---
    if (consecutiveApiFailures > 0) {
      // Calculate delay: Base * 2^R, clamped by max delay
      let delay = Math.min(
        BASE_RETRY_DELAY_MS * Math.pow(2, consecutiveApiFailures - 1),
        MAX_RETRY_DELAY_MS
      );
      
      // Add "Jitter" (up to 20% of delay)
      const jitter = Math.random() * delay * 0.2;
      delay += jitter;

      console.log(`\n⏸️ API Error detected. Waiting for ${Math.round(delay / 1000)}s before retrying...`);
      await sleep(delay);
    }
    // --------------------------------------------------------

    // Build conversation history (short-term memory)
    const conversationContext = state.conversationHistory.length > 0
      ? `\n\nPrevious actions:\n${state.conversationHistory.map(h => `${h.role}: ${h.content}`).join('\n')}`
      : '';

    // Build current state summary for this iteration
    const currentStateSummary = `\n\nCurrent state summary:
- Schema loaded: ${!!state.schema}
- Schema linked: ${!!state.linkedSchema}
- Query plan created: ${!!state.queryPlan}
- SQL generated: ${!!state.currentSQL}
- SQL executed: ${!!state.executionResult}
- Execution success: ${state.executionResult?.success || false}
- Correction attempts: ${state.correctionAttempts}/${MAX_CORRECTION_ATTEMPTS}

Choose your next action. Respond with either:
1. "TOOL: [tool_name]" to call a tool
2. "FINAL_ANSWER: [answer]" when ready to answer the user`;

    const promptForAgent = baseSystemPrompt + conversationContext + currentStateSummary + `\n\nWhat is your next action?`;

    // The old debug block is now removed/commented out as requested
    // 🐛 DEBUG BLOCK: Print the full context being sent to the LLM
    // console.log('\n\n' + '<<<'+'='.repeat(30) + ' AGENT PROMPT CONTEXT ' + '='.repeat(30) + '>>>');
    // console.log(promptForAgent);
    // console.log('<<<' + '='.repeat(78) + '>>>\n');
    // 🐛 END DEBUG BLOCK

    let response;
    try {
        // Call the orchestrator agent (the core LLM decision)
        response = await ai.models.generateContent({
            model: MODEL,
            contents: promptForAgent,
            config: {
                temperature: 0.3, // Lower temperature for more deterministic tool selection
            },
        });
        
        // Track token usage for orchestrator decision
        tokenTracker.push({
          promptTokens: response.usageMetadata?.promptTokenCount || 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata?.totalTokenCount || 0,
        });
        
        consecutiveApiFailures = 0;
    } catch (error) {
        const errorString = String(error);
        if (errorString.includes('429') || errorString.includes('503')) {
            consecutiveApiFailures++;
            console.error(`\n🚨 Rate Limit/Service Unavailable Error: ${errorString.split('\n')[0].trim()}`);
            
            state.conversationHistory.push({
                role: 'system',
                content: `LLM API failed with Quota/Service Error. Retrying.`,
            });
            
            continue;
        } else {
            console.error('\n🚨 Unrecoverable Error during agent decision:', error);
            
            // Return error result
            const totalMs = Date.now() - startTime;
            return {
              success: false,
              question,
              finalAnswer: `Error: ${errorString}`,
              timings: { total_ms: totalMs },
              tokenUsage: {
                model: MODEL,
                perTool: [],
                aggregate: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 }
              },
              iterations: iteration
            };
        }
    }
    
    const agentDecision = response.text?.trim() || '';
    console.log('\n🤖 Agent Decision:', agentDecision);

    // Parse the decision
    if (agentDecision.startsWith('FINAL_ANSWER:')) {
      const finalAnswer = agentDecision.replace('FINAL_ANSWER:', '').trim();
      state.finalAnswer = finalAnswer;
      state.completed = true;
      
      console.log('\n' + '='.repeat(80));
      console.log('✅ FINAL ANSWER');
      console.log('='.repeat(80));
      console.log(finalAnswer);
      
      if (state.visualizationResult) {
        console.log(`\n Visualization: ${state.visualizationResult.plot_file_path}`);
      }
      
    } else if (agentDecision.startsWith('TOOL:')) {
      const toolName = agentDecision.replace('TOOL:', '').trim();
      
      // Call tool with token tracker
      try {
        let toolResult: string;
        
        // Call tool based on name with appropriate parameters
        switch (toolName) {
          case 'load_schema':
            toolResult = await toolLoadSchema(state);
            break;
          case 'schema_linking':
            toolResult = await toolSchemaLinking(state, tokenTracker);
            break;
          case 'kpi_decomposition':
            toolResult = await toolKPIDecomposition(state, tokenTracker);
            break;
          case 'generate_query_plan': // NEW/COMBINED TOOL
            toolResult = await toolGenerateQueryPlan(state, tokenTracker);
            break;
          case 'sql_generation': // Tool index shifted from 6 to 5
            toolResult = await toolSQLGeneration(state, tokenTracker);
            break;
          case 'execute_sql': // Tool index shifted from 7 to 6
            toolResult = await toolExecuteSQL(state);
            break;
          case 'error_correction': // Tool index shifted from 8 to 7
            toolResult = await toolErrorCorrection(state, tokenTracker);
            break;
          case 'visualize_results': // Tool index shifted from 9 to 8
            toolResult = await toolVisualizeResults(state, tokenTracker);
            break;
          default:
            console.log(`\n⚠  Unknown tool: ${toolName}`);
            state.conversationHistory.push({
              role: 'system',
              content: `Unknown tool: ${toolName}. Available tools: ${Object.keys(TOOL_DESCRIPTIONS).join(', ')}`,
            });
            continue;
        }
        
        console.log(`\n📤 Tool Result: ${toolResult}`);
        
        // Add to conversation history
        state.conversationHistory.push({
          role: 'agent',
          content: `Called tool: ${toolName}`,
        });
        state.conversationHistory.push({
          role: 'system',
          content: `Tool result: ${toolResult}`,
        });

      } catch (error) {
        console.error(`\n❌ Tool Error: ${error}`);
        state.conversationHistory.push({
          role: 'system',
          content: `Tool ${toolName} failed: ${error}`,
        });
        
        const errorString = String(error);
        if (errorString.includes('429') || errorString.includes('503')) {
            consecutiveApiFailures++;
        }
      }
    } else {
      console.log('\n⚠  Agent provided invalid response format. Expected TOOL: or FINAL_ANSWER:');
      state.conversationHistory.push({
        role: 'system',
        content: 'Invalid response format. Please respond with either "TOOL: [tool_name]" or "FINAL_ANSWER: [answer]"',
      });
    }

    // Safety check: if we have results and haven't answered, prompt for answer
    if (state.executionResult?.success && !state.completed && iteration > 10) {
      console.log('\n⚠  Agent has results but hasn\'t provided answer. Prompting...');
      state.conversationHistory.push({
        role: 'system',
        content: 'You have successfully executed the query and have results. Please provide the FINAL_ANSWER now.',
      });
    }
  }

  const totalMs = Date.now() - startTime;

  if (!state.completed) {
    console.log('\n⚠  Maximum iterations reached without completing the task.');
  }

  console.log('\n' + '='.repeat(80));
  console.log(state.completed ? '✅ Orchestration completed!' : '⚠  Orchestration incomplete');
  console.log('='.repeat(80) + '\n');

  // Calculate aggregate token usage
  const aggregateTokens = tokenTracker.reduce(
    (acc, usage) => ({
      totalPromptTokens: acc.totalPromptTokens + usage.promptTokens,
      totalCompletionTokens: acc.totalCompletionTokens + usage.completionTokens,
      totalTokens: acc.totalTokens + usage.totalTokens,
    }),
    { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 }
  );

  // Extract metadata
  const resultsConverted = state.executionResult?.result 
    ? convertBigIntsToStrings(state.executionResult.result)
    : [];

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

  // Return structured result
  return {
    success: state.completed && !!state.finalAnswer,
    question,
    sql: state.currentSQL,
    results: resultsConverted,
    row_count: state.executionResult?.row_count || 0,
    finalAnswer: state.finalAnswer || 'Task incomplete',
    visualization: state.visualizationResult,
    timings: {
      total_ms: totalMs,
    },
    tokenUsage: {
      model: MODEL,
      perTool: tokenTracker.map((usage, idx) => ({
        tool: `call_${idx + 1}`,
        ...usage,
      })),
      aggregate: aggregateTokens,
    },
    iterations: iteration,
    metadata: {
      tables: state.linkedSchema?.tables || [],
      rowCount: state.executionResult?.row_count || 0,
      keyMetric,
    },
  };
}

// ----------------------------------------------------------------------
// DEMO EXECUTION (for standalone testing)
// ----------------------------------------------------------------------

const DEMO_QUERIES = [
  'Why is our battery component inventory at Fremont CA expected to be below the safety stock level next week?',
  'What is the total quantity in stock for components with the Type "Battery", grouped by their WarehouseLocation?',
  'Show me the average unit cost of all components ordered in Purchase Orders that were ultimately marked as "Delayed", excluding those manufactured in China.',
  'What is the average order to deliver time per warehouse across all battery components?',
];

// Only run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const questionIndex = process.argv[2] ? parseInt(process.argv[2]) : 0;
  const question = DEMO_QUERIES[questionIndex] || DEMO_QUERIES[0];

  runOrchestrator(question)
    .then(result => {
      console.log('\n📊 Final Result:', {
        success: result.success,
        sql: result.sql,
        rowCount: result.row_count,
        answer: result.finalAnswer,
        iterations: result.iterations,
        totalTokens: result.tokenUsage.aggregate.totalTokens,
      });
    })
    .catch(console.error);
}