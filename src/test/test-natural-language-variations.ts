import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { getCompleteSchema, formatSchemaForPrompt } from '../tools/schema-tool.js';
import { executeSQL } from '../tools/sql-executor-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(process.cwd(), 'data', 'ev_supply_chain.db');

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '1');

interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primary_key: boolean;
}

interface SchemaTable {
  columns: SchemaColumn[];
}

interface DatabaseSchema {
  tables: Record<string, SchemaTable>;
  foreign_keys: Array<{ from: string; to: string }>;
}

/**
 * Schema Linking Agent (YOUR ORIGINAL - using your prompt file)
 */
async function schemaLinkingAgent(question: string, schema: DatabaseSchema): Promise<any> {
  console.log('  🔗 Schema Linking...');

  const prompt = `${readFileSync(join(__dirname, '../prompts/schema-linking.md'), 'utf-8')}

## Database Schema

${formatSchemaForPrompt(schema)}

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

  return JSON.parse(response.text || '{}');
}

/**
 * Subproblem Agent (YOUR ORIGINAL - with your schema)
 */
async function subproblemAgent(question: string, linkedSchema: any): Promise<any> {
  console.log('  🧩 Subproblem Decomposition...');

  const prompt = `You are a SQL query decomposition expert. Given a natural language question, break it down into SQL clause-level subproblems.

Question: "${question}"

Relevant tables: ${linkedSchema.tables.join(', ')}
Relevant columns: ${JSON.stringify(linkedSchema.columns)}

Identify which SQL clauses are needed and what each should accomplish. Return the JSON object describing the clauses.`;

  const subproblemSchema = {
    type: "OBJECT",
    properties: {
      clauses: {
        type: "OBJECT",
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
        propertyOrdering: ["SELECT", "FROM", "JOIN", "WHERE", "GROUP BY", "ORDER BY", "LIMIT"]
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

  return JSON.parse(response.text || '{}');
}

/**
 * Query Plan Agent (YOUR ORIGINAL - using your prompt file)
 */
async function queryPlanAgent(question: string, linkedSchema: any, subproblems: any): Promise<any> {
  console.log('  🤔 Query Planning...');

  const prompt = `${readFileSync(join(__dirname, '../prompts/query-planning.md'), 'utf-8')}

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

  return JSON.parse(response.text || '{}');
}

/**
 * SQL Generation Agent (YOUR ORIGINAL - inline prompt from agent.ts)
 */
// Updated SQL Generation Agent with Case-Insensitivity Rule
async function sqlGenerationAgent(question: string, queryPlan: any, linkedSchema: any): Promise<string> {
    console.log('  ⚡ SQL Generation...');
  
    const prompt = `You are an expert SQL query generator. Given a query plan, generate the exact SQL query.
  
  Question: "${question}"
  
  Query Plan:
  ${JSON.stringify(queryPlan, null, 2)}
  
  Schema:
  ${JSON.stringify(linkedSchema, null, 2)}
  
  **IMPORTANT: For WHERE clause string comparisons, always use case-insensitive matching with LOWER():**
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
  
    return cleanedSQL;
  }

/**
 * Test natural language variations using YOUR FULL PIPELINE
 */
async function testNaturalLanguageVariations(): Promise<void> {
  console.log('\n' + '🔤 '.repeat(30));
  console.log('Testing Natural Language Variations & Case Sensitivity');
  console.log('Using YOUR ORIGINAL AGENT PROMPTS');
  console.log('🔤 '.repeat(30) + '\n');
  
  // Load schema first
  console.log('📥 Loading database schema...\n');
  const schema = await getCompleteSchema(DB_PATH) as DatabaseSchema;
  
  // Test variations of the same query
  const testVariations = [
    {
      group: "Battery Type Queries - Case Variations",
      questions: [
        "show me components with Type Battery",
        "show me components with type battery",
        //"show me components with TYPE BATTERY",
        //"Show me components with type 'Battery'",
        //"list all components where type is Battery",
        //"get components that have Battery as their type",
      ]
    }
];
/*
    {
      group: "Supplier Queries - Phrasing Variations",
      questions: [
        "List suppliers with reliability score above 90",
        "Show me suppliers that have reliabilityscore greater than 90",
        "Which suppliers have a reliability score over 90?",
        "Get all suppliers where ReliabilityScore > 90",
        "Find suppliers with high reliability (above 90)",
      ]
    },
    {
      group: "Column Name Variations",
      questions: [
        "Show me component names and their unit cost",
        "Display the name and unitcost for components",
        "List componentName and unitCost",
        "Get component.name and component.unitcost",
      ]
    },
    {
      group: "Status Filter Variations",
      questions: [
        "Show delayed purchase orders",
        "List purchase orders with status Delayed",
        "Get all POs where status is 'delayed'",
        "Find purchase orders that are DELAYED",
      ]
    }
  ];
*/
  for (const testGroup of testVariations) {
    console.log('\n' + '='.repeat(70));
    console.log(`📋 ${testGroup.group}`);
    console.log('='.repeat(70));
    
    for (let i = 0; i < testGroup.questions.length; i++) {
      const question = testGroup.questions[i];
      console.log(`\n${'-'.repeat(70)}`);
      console.log(`Question ${i + 1}/${testGroup.questions.length}: "${question}"`);
      console.log(`${'-'.repeat(70)}`);
      
      try {
        // YOUR FULL PIPELINE
        const linkedSchema = await schemaLinkingAgent(question, schema);
        console.log('    Tables:', linkedSchema.tables?.join(', ') || 'none');
        
        const subproblems = await subproblemAgent(question, linkedSchema);
        const clauseKeys = Object.keys(subproblems.clauses || {});
        console.log('    Clauses:', clauseKeys.join(', '));
        
        const queryPlan = await queryPlanAgent(question, linkedSchema, subproblems);
        console.log('    Plan steps:', queryPlan.steps?.length || 0);
        
        const sql = await sqlGenerationAgent(question, queryPlan, linkedSchema);
        console.log('  📄 Generated SQL:');
        console.log('    ', sql);
        
        // Execute SQL
        console.log('  🔧 Executing SQL...');
        const result = await executeSQL(sql, DB_PATH);
        
        if (result.success) {
          console.log(`  ✅ Success: ${result.row_count} rows in ${result.execution_time_ms}ms`);
          if (result.result && result.result.length > 0) {
            console.log('  📊 Sample result (first row):');
            const firstRow = result.result[0];
            const formatted: any = {};
            for (const [key, value] of Object.entries(firstRow)) {
              formatted[key] = typeof value === 'bigint' ? value.toString() : value;
            }
            console.log('    ', JSON.stringify(formatted));
          }
        } else {
          console.log(`  ❌ Execution failed: ${result.error}`);
        }
        
      } catch (error: any) {
        console.error(`  ❌ Pipeline error: ${error.message}`);
      }
      
      // Delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('Natural Language Variation Testing Complete!');
}

// Run the test
testNaturalLanguageVariations().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});