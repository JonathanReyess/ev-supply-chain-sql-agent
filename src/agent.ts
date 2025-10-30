/**
 * SQL-of-Thought: Multi-agent Text-to-SQL with Guided Error Correction
 * Using GEMINI 2.5 Flash and custom tools
 */

import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { getCompleteSchema, formatSchemaForPrompt } from './tools/schema-tool.js';
import { executeSQL } from './tools/sql-executor-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DB_PATH = join(process.cwd(), 'data', 'ev_supply_chain.db')
const ERROR_TAXONOMY_PATH = join(__dirname, '../data/error-taxonomy.json');
const MAX_CORRECTION_ATTEMPTS = 3;

// Initialize GoogleGenAI - Client automatically picks up GEMINI_API_KEY from .env
const ai = new GoogleGenAI({}); 

// FIX 1: Use GEMINI environment variable and default model
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '1');

// Load resources
// NOTE: Ensure error-taxonomy.json exists in the /data folder
const errorTaxonomy = JSON.parse(readFileSync(ERROR_TAXONOMY_PATH, 'utf-8'));

/**
 * Agent 1: Schema Linking (Converts to Gemini API)
 */
async function schemaLinkingAgent(question: string, schema: any): Promise<any> {
  console.log('\n📊 [Schema Linking Agent] Analyzing question...');

  const prompt = `${readFileSync(join(__dirname, 'prompts/schema-linking.md'), 'utf-8')}

## Database Schema

${formatSchemaForPrompt(schema)}

## Question

"${question}"

Analyze the question and identify the relevant tables, columns, and relationships needed. Return ONLY a valid JSON object as specified in the output format.`;

  // FIX 2: Use ai.models.generateContent method
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt, // Use contents for prompt string
    config: {
        temperature: TEMPERATURE,
        responseMimeType: 'application/json', // Force JSON output
    },
  });

  // FIX 3: Parse response from response.text
  const result = JSON.parse(response.text || '{}');
  console.log('  ✓ Identified tables:', result.tables);
  return result;
}

/**
 * Agent 2: Subproblem Identification (Converts to Gemini API & enforces JSON Schema)
 */
async function subproblemAgent(question: string, linkedSchema: any): Promise<any> {
  console.log('\n🧩 [Subproblem Agent] Breaking down query...');

  const prompt = `You are a SQL query decomposition expert. Given a natural language question, break it down into SQL clause-level subproblems.

Question: "${question}"

Relevant tables: ${linkedSchema.tables.join(', ')}
Relevant columns: ${JSON.stringify(linkedSchema.columns)}

Identify which SQL clauses are needed and what each should accomplish. Return the JSON object describing the clauses.`;
  
  // --- DEFINITIVE FIX: Rigid JSON Schema for Subproblem Clauses ---
  const subproblemSchema = {
    type: "OBJECT",
    description: "A decomposition of the natural language question into SQL clauses.",
    properties: {
      clauses: {
        type: "OBJECT",
        description: "A dictionary where keys are SQL clauses (e.g., SELECT, FROM, JOIN) and values are plain text descriptions of what that clause must accomplish.",
        properties: {
            "SELECT": { type: "STRING", description: "Describes the columns and aggregations to retrieve (e.g., SUM(Quantity) as Total, Name)." },
            "FROM": { type: "STRING", description: "The base table(s) to query." },
            "JOIN": { type: "STRING", description: "The necessary join conditions or join strategy (e.g., JOIN inventory ON C.id = I.id)." },
            "WHERE": { type: "STRING", description: "The filter conditions (e.g., status = 'Delayed')." },
            "GROUP BY": { type: "STRING", description: "The columns required for grouping." },
            "HAVING": { type: "STRING", description: "Post-aggregation filters." },
            "ORDER BY": { type: "STRING", description: "Sorting criteria." },
            "LIMIT": { type: "STRING", description: "Row limit for results." },
        },
        // All fields are optional because not all queries need GROUP BY or LIMIT
        propertyOrdering: ["SELECT", "FROM", "JOIN", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]
      }
    },
    required: ["clauses"], // Only the outer 'clauses' object is strictly required
  };

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
        temperature: TEMPERATURE,
        responseMimeType: 'application/json',
        responseSchema: subproblemSchema, // <-- Apply the Schema
    },
  });

  const result = JSON.parse(response.text || '{}');
  const identifiedClauses = Object.keys(result.clauses || {});
  console.log('  ✓ Identified clauses:', identifiedClauses);
  
  return result;
}

/**
 * Agent 3: Query Plan Generation (Chain-of-Thought) (Converts to Gemini API)
 */
async function queryPlanAgent(question: string, linkedSchema: any, subproblems: any): Promise<any> {
  console.log('\n🤔 [Query Plan Agent] Generating execution plan...');

  const prompt = `${readFileSync(join(__dirname, 'prompts/query-planning.md'), 'utf-8')}

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
  console.log('  ✓ Generated plan with', result.steps?.length || 0, 'steps');
  return result;
}

/**
 * Agent 4: SQL Generation (Converts to Gemini API)
 */
async function sqlGenerationAgent(question: string, queryPlan: any, linkedSchema: any): Promise<string> {
  console.log('\n⚡ [SQL Agent] Generating SQL query...');

  const prompt = `You are an expert SQL query generator. Given a query plan, generate the exact SQL query.

Question: "${question}"

Query Plan:
${JSON.stringify(queryPlan, null, 2)}

Schema:
${JSON.stringify(linkedSchema, null, 2)}

Generate the SQL query that implements this plan. Return ONLY the SQL query, no explanations or markdown. The query should be executable and syntactically correct.`;

  // Gemini API call for text output (no JSON requirement here)
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
        temperature: TEMPERATURE,
    },
  });

  const sql = response.text?.trim() || '';
  // Clean up SQL (remove markdown code blocks if present)
  const cleanedSQL = sql
    .replace(/```sql\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  console.log('  ✓ Generated SQL');
  return cleanedSQL;
}

/**
 * Agent 5: Correction Plan Agent (Converts to Gemini API)
 */
async function correctionPlanAgent(
  question: string,
  incorrectSQL: string,
  error: string,
  linkedSchema: any
): Promise<any> {
  console.log('\n🔍 [Correction Plan Agent] Analyzing error...');

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
  console.log('  ✓ Error categories:', result.error_categories);
  return result;
}

/**
 * Agent 6: Correction SQL Agent (Converts to Gemini API)
 */
async function correctionSQLAgent(
  question: string,
  incorrectSQL: string,
  correctionPlan: any,
  linkedSchema: any
): Promise<string> {
  console.log('\n🔧 [Correction SQL Agent] Generating corrected SQL...');

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

  console.log('  ✓ Generated corrected SQL');
  return cleanedSQL;
}

/**
 * Main SQL-of-Thought Pipeline (Unchanged logic)
 */
async function sqlOfThought(question: string): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 SQL-of-Thought: Multi-agent Text-to-SQL');
  console.log('='.repeat(80));
  console.log('\n📝 Question:', question);

  try {
    // Step 1: Get database schema
    console.log('\n📥 Loading database schema...');
    const schema = await getCompleteSchema(DB_PATH);
    console.log('  ✓ Schema loaded:', Object.keys(schema.tables).length, 'tables');

    // Step 2: Schema Linking
    const linkedSchema = await schemaLinkingAgent(question, schema);

    // Step 3: Subproblem Identification
    const subproblems = await subproblemAgent(question, linkedSchema);

    // Step 4: Query Plan Generation
    const queryPlan = await queryPlanAgent(question, linkedSchema, subproblems);

    // Step 5: SQL Generation
    let generatedSQL = await sqlGenerationAgent(question, queryPlan, linkedSchema);
    console.log('\n📄 Generated SQL:\n', generatedSQL);

    // Step 6: Execute and potentially correct
    let attempt = 0;
    let success = false;

    while (attempt <= MAX_CORRECTION_ATTEMPTS && !success) {
      if (attempt > 0) {
        console.log(`\n🔄 Correction attempt ${attempt}/${MAX_CORRECTION_ATTEMPTS}`);
      }

      console.log('\n⚙️  Executing SQL...');
      const result = await executeSQL(generatedSQL, DB_PATH);

      if (result.success) {
        console.log('✅ Query executed successfully!');
        console.log(`📊 Returned ${result.row_count} rows in ${result.execution_time_ms}ms`);
        console.log('\n📋 Results (first 5 rows):');

        // Convert BigInt to string for JSON serialization
        const resultsToShow = result.result?.slice(0, 5).map(row => {
          const converted: any = {};
          for (const [key, value] of Object.entries(row)) {
            converted[key] = typeof value === 'bigint' ? value.toString() : value;
          }
          return converted;
        });

        console.log(JSON.stringify(resultsToShow, null, 2));
        success = true;
      } else {
        console.log('❌ Query failed:', result.error);

        if (attempt < MAX_CORRECTION_ATTEMPTS) {
          // Enter correction loop
          const correctionPlan = await correctionPlanAgent(question, generatedSQL, result.error || '', linkedSchema);
          generatedSQL = await correctionSQLAgent(question, generatedSQL, correctionPlan, linkedSchema);
          console.log('\n📄 Corrected SQL:\n', generatedSQL);
        } else {
          console.log('\n⚠️  Max correction attempts reached');
        }

        attempt++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(success ? '✅ SQL-of-Thought completed successfully!' : '❌ SQL-of-Thought failed');
    console.log('='.repeat(80) + '\n');
  } catch (error) {
    console.error('\n❌ Pipeline error:', error);
  }
}

// Demo queries
const DEMO_QUERIES = [
  // Simple: Single table filter
  'List the names and contact emails of all suppliers with a reliability score above 90.',
  
  // Medium: Two-table join and aggregation
  'What is the total quantity in stock for components with the Type "Battery", grouped by their WarehouseLocation?',
  
  // Complex: Multi-table join, calculation, and filtering
  'Show me the average unit cost of all components ordered in Purchase Orders that were ultimately marked as "Delayed", excluding those manufactured in China.',
];

// Run demo
const questionIndex = process.argv[2] ? parseInt(process.argv[2]) : 0;
const question = DEMO_QUERIES[questionIndex] || DEMO_QUERIES[0];

sqlOfThought(question).catch(console.error);
