/**
 * SQL-of-Thought: Multi-agent Text-to-SQL with Looping Orchestrator
 * Using GEMINI 2.5 Flash with agentic tool-calling loop
 */

import { GoogleGenAI } from '@google/genai';
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
 * Tool 2: Schema Linking (FIXED for robustness)
 */
async function toolSchemaLinking(state: AgentState): Promise<string> {
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

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  const result = JSON.parse(jsonText);
  state.linkedSchema = result;
  console.log('  ✓ Identified tables:', result.tables);
  return `Schema linking complete. Identified ${result.tables.length} relevant tables: ${result.tables.join(', ')}. Reasoning: ${result.reasoning}`;
}

/**
 * Tool 3: KPI Decomposition (FIXED for robustness)
 */
async function toolKPIDecomposition(state: AgentState): Promise<string> {
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

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  const result = JSON.parse(jsonText);
  state.kpiDecomposition = result;
  console.log('  ✓ Decomposed KPI:', result.kpi_name);
  return `KPI decomposed: ${result.kpi_name}. Primary calculation: ${result.primary_calculation?.operation} on ${result.primary_calculation?.target}`;
}

/**
 * Tool 4: Subproblem Identification (FIXED)
 */
async function toolSubproblemIdentification(state: AgentState): Promise<string> {
  console.log('\n🧩 [Tool: Subproblem Identification] Breaking down query...');
  
  if (!state.linkedSchema) {
    return 'Error: Schema linking not performed. Please link schema first.';
  }

  const prompt = `You are a SQL query decomposition expert. Given a natural language question, break it down into SQL clause-level subproblems.

Question: "${state.question}"

Relevant tables: ${state.linkedSchema.tables.join(', ')}

Identify which SQL clauses are needed and what each should accomplish. Return the JSON object describing the clauses.`;
  // 👆 END FIX

  const subproblemSchema = {
    type: "OBJECT",
    description: "A decomposition of the natural language question into SQL clauses.",
    properties: {
      clauses: {
        type: "OBJECT",
        description: "A dictionary where keys are SQL clauses and values are descriptions.",
        properties: {
          "SELECT": { type: "STRING" },
          "FROM": { type: "STRING" },
          "JOIN": { type: "STRING" },
          "WHERE": { type: "STRING" },
          "GROUP BY": { type: "STRING" },
          "HAVING": { type: "STRING" },
          "ORDER BY": { type: "STRING" },
          "LIMIT": { type: "STRING" },
        },
      }
    },
    required: ["clauses"],
  };

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
      responseSchema: subproblemSchema,
    },
  });

  // Use the robust cleanJsonString function
  const jsonText = cleanJsonString(response.text || '{}');
  
  try {
    const result = JSON.parse(jsonText); 
    state.subproblems = result;
    const identifiedClauses = Object.keys(result.clauses || {});
    console.log('  ✓ Identified clauses:', identifiedClauses);
    return `Subproblems identified. Required SQL clauses: ${identifiedClauses.join(', ')}`;
  } catch (e) {
      console.error(`Failed to parse JSON for subproblem identification. Error: ${e}`);
      console.error('Original (uncleaned) text:', response.text);
      console.error('Cleaned text that failed:', jsonText);
      return `Tool Error: Failed to parse LLM response into JSON. Error: ${e}`;
  }
}

/**
 * Tool 5: Query Planning (FIXED for robustness)
 */
async function toolQueryPlanning(state: AgentState): Promise<string> {
  console.log('\n🤔 [Tool: Query Planning] Generating execution plan...');
  
  if (!state.linkedSchema) {
    return 'Error: Schema linking not performed.';
  }

  const planInput = state.kpiDecomposition || state.subproblems;
  if (!planInput) {
    return 'Error: No decomposition available. Run KPI decomposition or subproblem identification first.';
  }

  const isKpiPlan = !!state.kpiDecomposition;
  const inputSection = isKpiPlan 
    ? `## KPI Decomposition\n${JSON.stringify(planInput, null, 2)}`
    : `## Identified Clauses\n${JSON.stringify(planInput.clauses, null, 2)}`;

  // NOTE: Assuming your prompts/query-planning.md path is correct
  const prompt = `${readFileSync(join(__dirname, 'prompts/query-planning.md'), 'utf-8')}

## Question
"${state.question}"

## Schema Information
Tables: ${state.linkedSchema.tables.join(', ')}
Columns: ${JSON.stringify(state.linkedSchema.columns, null, 2)}
Foreign Keys: ${JSON.stringify(state.linkedSchema.foreign_keys, null, 2)}

${inputSection}

Create a detailed step-by-step query plan using Chain-of-Thought reasoning. Return ONLY valid JSON as specified.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
    },
  });

  const jsonText = cleanJsonString(response.text || '{}'); // Apply fix
  const result = JSON.parse(jsonText);
  state.queryPlan = result;
  console.log('  ✓ Generated plan with', result.steps?.length || 0, 'steps');
  return `Query plan created with ${result.steps?.length || 0} steps. Strategy: ${result.final_strategy}`;
}

/**
 * Tool 6: SQL Generation
 */
async function toolSQLGeneration(state: AgentState): Promise<string> {
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
 * Tool 7: Execute SQL
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
 * Tool 8: Error Correction (Correction Plan step FIXED for robustness)
 */
async function toolErrorCorrection(state: AgentState): Promise<string> {
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
 * Tool 9: Visualize Results
 */
async function toolVisualizeResults(state: AgentState): Promise<string> {
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
type ToolName = keyof typeof TOOLS;
const TOOLS = {
  load_schema: toolLoadSchema,
  schema_linking: toolSchemaLinking,
  kpi_decomposition: toolKPIDecomposition,
  subproblem_identification: toolSubproblemIdentification,
  query_planning: toolQueryPlanning,
  sql_generation: toolSQLGeneration,
  execute_sql: toolExecuteSQL,
  error_correction: toolErrorCorrection,
  visualize_results: toolVisualizeResults,
};

const TOOL_DESCRIPTIONS = {
  load_schema: "Load the database schema to understand available tables and columns",
  schema_linking: "Identify relevant tables, columns, and relationships for the question",
  kpi_decomposition: "Break down a KPI metric into its component calculations (use for complex metrics)",
  subproblem_identification: "Decompose the question into SQL clause-level subproblems (use for standard queries)",
  query_planning: "Create a step-by-step execution plan for the SQL query",
  sql_generation: "Generate the actual SQL query from the execution plan",
  execute_sql: "Execute the SQL query against the database",
  error_correction: "Analyze and fix SQL execution errors",
  visualize_results: "Create a visualization from successful query results",
};

// ----------------------------------------------------------------------
// DEBUG: STATE LOGGING HELPER (Optional - kept for context)
// ----------------------------------------------------------------------

/**
 * Helper function to log a summary of the current agent state.
 */
function logStateSummary(state: AgentState, phase: 'BEFORE ACTION' | 'AFTER TOOL EXECUTION', iteration: number, toolName?: string) {
  const visualState = {
    'Phase': phase,
    'Iteration': iteration,
    'Question': state.question.substring(0, 50) + '...',
    'Schema Loaded': !!state.schema,
    'Schema Linked': !!state.linkedSchema,
    'KPI Decomposed': !!state.kpiDecomposition,
    'Subproblems': !!state.subproblems,
    'Query Plan': !!state.queryPlan,
    'Current SQL': state.currentSQL ? state.currentSQL.substring(0, 30) + '...' : 'N/A',
    'SQL Success': state.executionResult?.success === true ? 'Yes' : (state.executionResult?.success === false ? 'No' : 'N/A'),
    'Correction Attempts': `${state.correctionAttempts}/${MAX_CORRECTION_ATTEMPTS}`,
    'Final Answer': !!state.finalAnswer,
    'Completed': state.completed,
    'Last Tool': toolName || 'Orchestrator Decision'
  };

  console.log(`\n${'='.repeat(20)} ${phase} - State Snapshot ${'='.repeat(20)}`);
  for (const [key, value] of Object.entries(visualState)) {
    console.log(`  ${key.padEnd(25)}: ${value}`);
  }
  console.log('='.repeat(69));
}

// ----------------------------------------------------------------------
// LOOPING ORCHESTRATOR AGENT
// ----------------------------------------------------------------------

/**
 * The main Orchestrator Agent that runs in a loop
 */
async function orchestratorAgent(question: string): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log(' SQL-of-Thought: Looping Orchestrator Agent');
  console.log('='.repeat(80));
  console.log('\n📝 Question:', question);

  const state = createInitialState(question);
  let iteration = 0;

  // System prompt for the orchestrator (defines the agent's identity and rules)
  const systemPrompt = `You are an intelligent data analyst orchestrator agent. Your goal is to answer the user's question about data in a database.

You have access to these tools:
${Object.entries(TOOL_DESCRIPTIONS).map(([name, desc]) => `- ${name}: ${desc}`).join('\n')}

At each step, you should:
1. Analyze the current state and what's been accomplished
2. Decide which tool to call next (if any) to get closer to answering the question
3. Or, if you have all the information needed, provide a final answer to the user

Guidelines:
- Always start by loading the schema
- For KPI questions (metrics like "average time", "total count"), use kpi_decomposition
- For standard queries, use subproblem_identification
- After generating SQL, always execute it
- If execution fails, use error_correction (up to ${MAX_CORRECTION_ATTEMPTS} times)
- Consider visualization for numerical results
- When you have the answer, respond with "FINAL_ANSWER: [your answer]"

Current state summary:
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

  while (iteration < MAX_AGENT_ITERATIONS && !state.completed) {
    iteration++;
    
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`🔄 Iteration ${iteration}/${MAX_AGENT_ITERATIONS}`);
    console.log(`${'─'.repeat(80)}`);

    // Build conversation history (short-term memory)
    const conversationContext = state.conversationHistory.length > 0
      ? `\n\nPrevious actions:\n${state.conversationHistory.map(h => `${h.role}: ${h.content}`).join('\n')}`
      : '';

    const promptForAgent = systemPrompt + conversationContext + `\n\nWhat is your next action?`;

    // 🐛 DEBUG BLOCK: Print the full context being sent to the LLM
    console.log('\n\n' + '<<<'+'='.repeat(30) + ' AGENT PROMPT CONTEXT ' + '='.repeat(30) + '>>>');
    console.log(promptForAgent);
    console.log('<<<' + '='.repeat(78) + '>>>\n');
    // 🐛 END DEBUG BLOCK

    // Call the orchestrator agent (the core LLM decision)
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: promptForAgent,
      config: {
        temperature: 0.3, // Lower temperature for more deterministic tool selection
      },
    });

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
      
      if (toolName in TOOLS) {
        const tool = TOOLS[toolName as ToolName];
        try {
          const toolResult = await tool(state);
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
          console.error(`\n Tool Error: ${error}`);
          state.conversationHistory.push({
            role: 'system',
            content: `Tool ${toolName} failed: ${error}`,
          });
        }
      } else {
        console.log(`\n⚠  Unknown tool: ${toolName}`);
        state.conversationHistory.push({
          role: 'system',
          content: `Unknown tool: ${toolName}. Available tools: ${Object.keys(TOOLS).join(', ')}`,
        });
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

  if (!state.completed) {
    console.log('\n⚠  Maximum iterations reached without completing the task.');
  }

  console.log('\n' + '='.repeat(80));
  console.log(state.completed ? ' Orchestration completed!' : '⚠  Orchestration incomplete');
  console.log('='.repeat(80) + '\n');
}

// ----------------------------------------------------------------------
// DEMO EXECUTION
// ----------------------------------------------------------------------

const DEMO_QUERIES = [
  'List the names and contact emails of all suppliers with a reliability score above 90.',
  'What is the total quantity in stock for components with the Type "Battery", grouped by their WarehouseLocation?',
  'Show me the average unit cost of all components ordered in Purchase Orders that were ultimately marked as "Delayed", excluding those manufactured in China.',
  'What is the average order to deliver time per warehouse across all battery components?',
];

// Allows running different queries using "node your_file.js [index]"
const questionIndex = process.argv[2] ? parseInt(process.argv[2]) : 0;
const question = DEMO_QUERIES[questionIndex] || DEMO_QUERIES[0];

// Execute the main function
orchestratorAgent(question).catch(console.error);