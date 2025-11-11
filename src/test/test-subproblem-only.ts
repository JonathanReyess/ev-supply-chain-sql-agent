import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Test Subproblem Agent in Isolation
 */
async function testSubproblemAgentOnly(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Testing Subproblem Agent (Standalone)');
  console.log('='.repeat(60) + '\n');
  
  const ai = new GoogleGenAI({});
  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  
  // Test multiple questions
  const testCases = [
    {
      question: 'What is the average unit cost of components ordered in delayed purchase orders?',
      linkedSchema: {
        tables: ['components', 'purchase_orders', 'po_line_items'],
        columns: {
          components: ['componentid', 'name', 'unitcost', 'type'],
          purchase_orders: ['po_id', 'status'],
          po_line_items: ['po_id', 'componentid', 'quantityordered']
        }
      }
    },
    {
      question: 'List the names and contact emails of all suppliers with a reliability score above 90',
      linkedSchema: {
        tables: ['suppliers'],
        columns: {
          suppliers: ['supplierid', 'name', 'locationcountry', 'locationcity', 'reliabilityscore']
        }
      }
    },
    {
      question: 'Show me the top 5 components with the highest stock levels',
      linkedSchema: {
        tables: ['components', 'inventory'],
        columns: {
          components: ['componentid', 'name', 'type'],
          inventory: ['componentid', 'quantityinstock']
        }
      }
    }
  ];
  
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
        }
      }
    },
    required: ["clauses"]
  };
  
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Test Case ${i + 1}/${testCases.length}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`📝 Question: ${testCase.question}`);
    console.log(`📊 Tables: ${testCase.linkedSchema.tables.join(', ')}`);
    console.log(`📋 Columns:`, JSON.stringify(testCase.linkedSchema.columns, null, 2));
    console.log('');
    
    const prompt = `Break down this SQL query question into constituent clauses.

Question: "${testCase.question}"
Available Tables: ${testCase.linkedSchema.tables.join(', ')}
Available Columns: ${JSON.stringify(testCase.linkedSchema.columns)}

Identify which SQL clauses are needed. Return JSON with a "clauses" object containing descriptions for each SQL clause (SELECT, FROM, JOIN, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT).`;
    
    // Add retry logic for network issues
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    
    while (attempt < maxAttempts && !success) {
      try {
        if (attempt > 0) {
          console.log(`  🔄 Retry attempt ${attempt}/${maxAttempts}...`);
        } else {
          console.log('  📡 Making API call...');
        }
        
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
        
        if (result.clauses) {
          for (const [clause, description] of Object.entries(result.clauses)) {
            console.log(`  ${clause.padEnd(12)}: ${description}`);
          }
        } else {
          console.log('  ⚠️  No clauses returned in response');
        }
        
        success = true;
        
      } catch (error: any) {
        attempt++;
        console.error(`❌ Attempt ${attempt} failed:`, error.message);
        
        if (attempt >= maxAttempts) {
          console.error('❌ Max retries reached for this test case.');
          console.error('   Error details:', error);
        } else {
          // Wait before retrying (exponential backoff)
          const waitTime = 1000 * Math.pow(2, attempt - 1);
          console.log(`   ⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    if (!success) {
      console.log('⚠️  Skipping to next test case...');
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Subproblem Agent Testing Complete');
  console.log('='.repeat(60) + '\n');
}

// Run the test
testSubproblemAgentOnly().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});