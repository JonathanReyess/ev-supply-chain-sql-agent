import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getCompleteSchema, formatSchemaForPrompt } from '../tools/schema-tool.js';
import { executeSQL } from '../tools/sql-executor-tool.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(process.cwd(), 'data', 'ev_supply_chain.db');

// Type definitions for schema
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
 * Test 1: Schema Tool
 */
async function testSchemaTool(): Promise<DatabaseSchema> {
  console.log('='.repeat(60));
  console.log('Testing Schema Tool...');
  console.log('='.repeat(60) + '\n');
  
  try {
    const schema = await getCompleteSchema(DB_PATH) as DatabaseSchema;
    
    console.log('✅ Schema loaded successfully');
    console.log('Tables found:', Object.keys(schema.tables).join(', '));
    console.log('\nTable details:');
    
    for (const [tableName, tableInfo] of Object.entries(schema.tables)) {
      console.log(`\n📋 ${tableName}:`);
      console.log('  Columns:', tableInfo.columns.map((c: SchemaColumn) => c.name).join(', '));
      console.log('  Column count:', tableInfo.columns.length);
    }
    
    if (schema.foreign_keys.length > 0) {
      console.log('\n🔗 Foreign Keys:');
      schema.foreign_keys.forEach(fk => {
        console.log(`  ${fk.from} → ${fk.to}`);
      });
    }
    
    console.log('\n📄 Formatted Schema Preview:');
    const formatted = formatSchemaForPrompt(schema);
    console.log(formatted.substring(0, 500) + '...\n');
    
    return schema;
  } catch (error) {
    console.error('❌ Schema test failed:', error);
    throw error;
  }
}

/**
 * Test 2: SQL Executor
 */
async function testSQLExecutor(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Testing SQL Executor...');
  console.log('='.repeat(60) + '\n');
  
  const testQueries = [
    {
      name: 'Simple SELECT',
      sql: 'SELECT * FROM suppliers LIMIT 3'  // Remove ev_db. prefix
    },
    {
      name: 'COUNT aggregation',
      sql: 'SELECT COUNT(*) as total FROM components'  // Remove ev_db. prefix
    },
    {
      name: 'JOIN query',
      sql: 'SELECT s.name, COUNT(c.componentid) as component_count FROM suppliers s LEFT JOIN components c ON s.supplierid = c.supplierid GROUP BY s.name LIMIT 5'  // Remove ev_db. prefix
    },
    {
      name: 'Intentional error',
      sql: 'SELECT * FROM nonexistent_table'  // Remove ev_db. prefix
    },
  ];
  
  for (const { name, sql } of testQueries) {
    console.log(`\n🔍 Test: ${name}`);
    console.log(`SQL: ${sql}`);
    
    const result = await executeSQL(sql, DB_PATH);
    
    if (result.success) {
      console.log(`✅ Success: ${result.row_count} rows in ${result.execution_time_ms}ms`);
      if (result.result && result.result.length > 0) {
        console.log('First row:', JSON.stringify(result.result[0], (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ));
      }
    } else {
      console.log('❌ Error:', result.error);
    }
    console.log('-'.repeat(60));
  }
}

/**
 * Test 3: Schema Linking Agent
 */
async function testSchemaLinking(schema: DatabaseSchema): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing Schema Linking Agent...');
  console.log('='.repeat(60) + '\n');
  
  const ai = new GoogleGenAI({});
  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  const testQuestions = [
    'List all suppliers with their contact information',
    'What is the total quantity of batteries in stock?',
    'Show delayed purchase orders with their supplier names',
  ];
  
  for (const question of testQuestions) {
    console.log(`\n📝 Question: ${question}`);
    
    const prompt = `You are a schema linking expert. Analyze this question and identify relevant database elements.

Database Schema:
${formatSchemaForPrompt(schema)}

Question: "${question}"

Return a JSON object with:
- tables: array of relevant table names
- columns: object mapping table names to arrays of column names
- foreign_keys: array of {from: "table.column", to: "table.column"}
- reasoning: brief explanation

Return ONLY valid JSON.`;
    
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          temperature: 1,
          responseMimeType: 'application/json',
        },
      });
      
      const result = JSON.parse(response.text || '{}');
      console.log('✅ Linked Schema:');
      console.log('  Tables:', result.tables?.join(', '));
      console.log('  Columns:', JSON.stringify(result.columns, null, 2));
      console.log('  Reasoning:', result.reasoning);
    } catch (error) {
      console.error('❌ Schema linking failed:', error);
    }
    console.log('-'.repeat(60));
  }
}

/**
 * Test 4: Subproblem Agent
 */
async function testSubproblemAgent(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing Subproblem Agent...');
  console.log('='.repeat(60) + '\n');
  
  const ai = new GoogleGenAI({});
  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  const testCase = {
    question: 'What is the average unit cost of components ordered in delayed purchase orders?',
    linkedSchema: {
      tables: ['components', 'purchase_orders', 'order_details'],
      columns: {
        components: ['ComponentID', 'ComponentName', 'UnitCost', 'Type'],
        purchase_orders: ['OrderID', 'Status'],
        order_details: ['OrderID', 'ComponentID', 'Quantity']
      }
    }
  };
  
  console.log(`📝 Question: ${testCase.question}`);
  console.log(`📊 Available tables: ${testCase.linkedSchema.tables.join(', ')}\n`);
  
  const prompt = `Break down this SQL query question into constituent clauses.

Question: "${testCase.question}"
Available Tables: ${testCase.linkedSchema.tables.join(', ')}
Available Columns: ${JSON.stringify(testCase.linkedSchema.columns)}

Identify which SQL clauses are needed. Return JSON with a "clauses" object.`;
  
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
          "ORDER BY": { type: "STRING" },
          "LIMIT": { type: "STRING" },
        }
      }
    },
    required: ["clauses"]
  };
  
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 1,
        responseMimeType: 'application/json',
        responseSchema: subproblemSchema,
      },
    });
    
    const result = JSON.parse(response.text || '{}');
    console.log('✅ Clauses Identified:');
    for (const [clause, description] of Object.entries(result.clauses || {})) {
      console.log(`  ${clause}: ${description}`);
    }
  } catch (error) {
    console.error('❌ Subproblem decomposition failed:', error);
  }
}

/**
 * Test 5: Error Correction
 */
async function testErrorCorrection(schema: DatabaseSchema): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing Error Correction...');
  console.log('='.repeat(60) + '\n');
  
  const ai = new GoogleGenAI({});
  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  // Intentionally broken SQL
// Intentionally broken SQL (without ev_db prefix)
const badSQL = 'SELECT NonExistentColumn, AnotherBadColumn FROM suppliers WHERE InvalidField = 123';
  const question = 'List all suppliers with their reliability scores';
  
  console.log(`📝 Question: ${question}`);
  console.log(`❌ Bad SQL: ${badSQL}\n`);
  
  console.log('Executing bad SQL to capture error...');
  const result = await executeSQL(badSQL, DB_PATH);
  
  if (!result.success) {
    console.log(`✅ Error captured (expected): ${result.error}\n`);
    
    // Test correction plan
    const prompt = `You are an SQL error correction expert. Analyze this error and provide a correction plan.

Question: "${question}"

Failed SQL:
${badSQL}

Error Message:
${result.error}

Available Schema for 'suppliers' table:
${JSON.stringify(schema.tables['suppliers'] || {}, null, 2)}

Return JSON with:
- error_categories: array of error types (e.g., ["schema_link.col_missing"])
- root_cause: explanation of what went wrong
- correction_plan: object with steps array
- specific_changes: object with incorrect_part, corrected_part, explanation

Return ONLY valid JSON.`;
    
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          temperature: 1,
          responseMimeType: 'application/json',
        },
      });
      
      const correction = JSON.parse(response.text || '{}');
      console.log('✅ Correction Plan Generated:');
      console.log('  Error Categories:', correction.error_categories?.join(', '));
      console.log('  Root Cause:', correction.root_cause);
      console.log('  Correction Steps:', correction.correction_plan?.steps?.length || 0, 'steps');
      if (correction.specific_changes) {
        console.log('\n  Specific Changes:');
        console.log('    Incorrect:', correction.specific_changes.incorrect_part);
        console.log('    Corrected:', correction.specific_changes.corrected_part);
      }
    } catch (error) {
      console.error('❌ Error correction failed:', error);
    }
  }
}

/**
 * Main Test Runner
 */
async function runAllTests(): Promise<void> {
  console.log('SQL-of-Thought Component Testing Suite');
  
  try {
    // Test 1: Schema
    const schema = await testSchemaTool();
    
    // Test 2: SQL Execution
    await testSQLExecutor();
    
    // Test 3: Schema Linking
    await testSchemaLinking(schema);
    
    // Test 4: Subproblem Decomposition
    await testSubproblemAgent();
    
    // Test 5: Error Correction
    await testErrorCorrection(schema);
    
    console.log('All component tests completed successfully!');

  } catch (error) {
    console.error('Test suite failed:', error);
    process.exit(1);
  }
}

// Run all tests
runAllTests();