/**
 * Conversation History Comparison Test
 * Compares Summary-based (port 8000) vs Embedding-based (port 8001) approaches
 * 
 * Tests multi-turn conversations with:
 * - Sequential refinements
 * - Anaphora (references to previous results)
 * - Topic switches
 * - Complex multi-table joins
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

// Configuration
const SUMMARY_API_URL = 'http://localhost:8000';
const EMBEDDINGS_API_URL = 'http://localhost:8001';
const RATE_LIMIT_DELAY_MS = 6000; // 10 calls/minute = 6 seconds between calls
const CONVERSATION_ID_PREFIX = 'test_comparison_';

interface TestResult {
  conversationId: string;
  method: 'summary' | 'embeddings';
  turnNumber: number;
  question: string;
  success: boolean;
  sql?: string;
  rowCount?: number;
  tokenUsage?: any;
  timings?: any;
  context?: any;
  error?: string;
}

interface ConversationComparison {
  conversationName: string;
  questions: string[];
  summaryResults: TestResult[];
  embeddingsResults: TestResult[];
  summary: {
    totalTokens: { summary: number; embeddings: number };
    avgLatency: { summary: number; embeddings: number };
    successRate: { summary: number; embeddings: number };
  };
}

// Test Conversations
const TEST_CONVERSATIONS = [
  {
    name: 'Conversation 1: Supply Chain Cost Analysis',
    description: 'Sequential refinement with multi-table joins',
    questions: [
      'How many suppliers do we have?',
      "What's their average reliability score?",
      'Show me the top 5 most reliable suppliers',
      'What components do those suppliers provide?', // Anaphora: "those" refers to Q3
    ]
  },
  {
    name: 'Conversation 2: Inventory & Warehouse Operations',
    description: 'Aggregation across warehouses with filtering',
    questions: [
      'List all warehouse locations',
      'What is the total inventory quantity in Austin TX?',
      'Show me battery components stored there', // Anaphora: "there" refers to Austin
      'Which suppliers provide those battery components?', // Anaphora: "those" refers to Q3
    ]
  },
  {
    name: 'Conversation 3: Quality & Delivery Performance',
    description: 'Correlation analysis with anaphora',
    questions: [
      'How many purchase orders have status Delayed?',
      'Which suppliers have the most delayed orders?',
      "What's the average reliability score of those suppliers?", // Anaphora: "those" refers to Q2
      'Show me the components from the least reliable one', // Anaphora: "the least reliable one"
    ]
  },
  {
    name: 'Conversation 4: Topic Switch Test',
    description: 'Multiple topic switches to test context relevance',
    questions: [
      'List all warehouse locations',
      'How many components do we have?', // Topic switch: warehouses → components
      "What's the average cost of Motor type components?", // Refinement on components
      'How many suppliers are in China?', // Topic switch: components → suppliers
    ]
  },
  {
    name: 'Conversation 5: Complex Multi-Table Query',
    description: 'Long conversation with complex joins',
    questions: [
      'Show me components with Type Battery',
      'Sort those by unit cost lowest to highest', // Anaphora + refinement
      'What is the total target stock for those components?', // Anaphora + aggregation
      'Which warehouses store those battery components?', // Anaphora + join
      'What is the total quantity in stock across all warehouses?', // Aggregation
      'Show me the supplier names for the top 3 cheapest batteries', // Complex multi-table
    ]
  }
];

/**
 * Delay execution to respect rate limits
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query an API endpoint
 */
async function queryAPI(
  apiUrl: string,
  question: string,
  conversationId: string
): Promise<any> {
  try {
    const response = await fetch(`${apiUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        conversation_id: conversationId
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error: any) {
    console.error(`  ❌ API call failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Clear conversation history for a given API
 */
async function clearConversation(apiUrl: string, conversationId: string): Promise<void> {
  try {
    await fetch(`${apiUrl}/clear/${conversationId}`, {
      method: 'POST'
    });
  } catch (error) {
    console.warn(`Warning: Could not clear conversation ${conversationId}`);
  }
}

/**
 * Test a single conversation on one API
 */
async function testConversation(
  apiUrl: string,
  method: 'summary' | 'embeddings',
  conversationId: string,
  questions: string[]
): Promise<TestResult[]> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🧪 Testing on ${method.toUpperCase()} API (${apiUrl})`);
  console.log(`   Conversation: ${conversationId}`);
  console.log(`${'='.repeat(80)}`);

  const results: TestResult[] = [];

  // Clear any existing conversation history
  await clearConversation(apiUrl, conversationId);
  await delay(1000); // Brief pause after clear

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    console.log(`\n📝 Turn ${i + 1}/${questions.length}: "${question}"`);

    const startTime = Date.now();
    const response = await queryAPI(apiUrl, question, conversationId);
    const endTime = Date.now();

    const result: TestResult = {
      conversationId,
      method,
      turnNumber: i + 1,
      question,
      success: response.success || false,
      sql: response.sql,
      rowCount: response.row_count,
      tokenUsage: response.tokenUsage,
      timings: {
        ...response.timings,
        total_api_latency_ms: endTime - startTime
      },
      context: response.context || response.summary,
      error: response.error
    };

    if (result.success) {
      console.log(`  ✅ Success: ${result.rowCount} rows`);
      console.log(`  📊 Tokens: ${result.tokenUsage?.aggregate?.totalTokens || 'N/A'}`);
      console.log(`  ⏱️  Latency: ${result.timings.total_api_latency_ms}ms`);
      
      if (method === 'summary' && result.context?.summaryText) {
        console.log(`  📝 Summary active: "${result.context.summaryText.substring(0, 60)}..."`);
      } else if (method === 'embeddings' && result.context) {
        console.log(`  🔍 Context: ${result.context.recentTurns} recent, ${result.context.retrievedTurns} retrieved`);
      }
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
    }

    results.push(result);

    // Rate limit delay (except for last question)
    if (i < questions.length - 1) {
      console.log(`  ⏳ Waiting ${RATE_LIMIT_DELAY_MS / 1000}s (rate limit)...`);
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  return results;
}

/**
 * Compare results and generate summary statistics
 */
function compareResults(
  conversationName: string,
  questions: string[],
  summaryResults: TestResult[],
  embeddingsResults: TestResult[]
): ConversationComparison {
  // Calculate totals
  const summaryTokens = summaryResults.reduce(
    (sum, r) => sum + (r.tokenUsage?.aggregate?.totalTokens || 0),
    0
  );
  const embeddingsTokens = embeddingsResults.reduce(
    (sum, r) => sum + (r.tokenUsage?.aggregate?.totalTokens || 0),
    0
  );

  const summaryLatency = summaryResults.reduce(
    (sum, r) => sum + (r.timings?.total_api_latency_ms || 0),
    0
  ) / summaryResults.length;
  const embeddingsLatency = embeddingsResults.reduce(
    (sum, r) => sum + (r.timings?.total_api_latency_ms || 0),
    0
  ) / embeddingsResults.length;

  const summarySuccess = summaryResults.filter(r => r.success).length / summaryResults.length;
  const embeddingsSuccess = embeddingsResults.filter(r => r.success).length / embeddingsResults.length;

  return {
    conversationName,
    questions,
    summaryResults,
    embeddingsResults,
    summary: {
      totalTokens: {
        summary: summaryTokens,
        embeddings: embeddingsTokens
      },
      avgLatency: {
        summary: Math.round(summaryLatency),
        embeddings: Math.round(embeddingsLatency)
      },
      successRate: {
        summary: summarySuccess,
        embeddings: embeddingsSuccess
      }
    }
  };
}

/**
 * Print comparison summary table
 */
function printComparisonTable(comparisons: ConversationComparison[]): void {
  console.log(`\n${'='.repeat(100)}`);
  console.log('📊 COMPARISON SUMMARY');
  console.log(`${'='.repeat(100)}\n`);

  console.log('| Conversation | Total Tokens (Summary) | Total Tokens (Embeddings) | Token Savings |');
  console.log('|--------------|------------------------|---------------------------|---------------|');

  comparisons.forEach(comp => {
    const summaryTokens = comp.summary.totalTokens.summary;
    const embeddingsTokens = comp.summary.totalTokens.embeddings;
    const savings = summaryTokens - embeddingsTokens;
    const savingsPercent = summaryTokens > 0 
      ? ((savings / summaryTokens) * 100).toFixed(1)
      : '0.0';

    console.log(
      `| ${comp.conversationName.substring(0, 12).padEnd(12)} | ` +
      `${summaryTokens.toString().padStart(22)} | ` +
      `${embeddingsTokens.toString().padStart(25)} | ` +
      `${savings > 0 ? '+' : ''}${savings} (${savingsPercent}%) |`
    );
  });

  console.log('\n| Conversation | Avg Latency (Summary) | Avg Latency (Embeddings) | Difference |');
  console.log('|--------------|----------------------|--------------------------|------------|');

  comparisons.forEach(comp => {
    const summaryLatency = comp.summary.avgLatency.summary;
    const embeddingsLatency = comp.summary.avgLatency.embeddings;
    const diff = embeddingsLatency - summaryLatency;

    console.log(
      `| ${comp.conversationName.substring(0, 12).padEnd(12)} | ` +
      `${summaryLatency.toString().padStart(20)}ms | ` +
      `${embeddingsLatency.toString().padStart(24)}ms | ` +
      `${diff > 0 ? '+' : ''}${diff}ms |`
    );
  });

  console.log('\n| Conversation | Success Rate (Summary) | Success Rate (Embeddings) |');
  console.log('|--------------|------------------------|---------------------------|');

  comparisons.forEach(comp => {
    const summarySuccess = (comp.summary.successRate.summary * 100).toFixed(0);
    const embeddingsSuccess = (comp.summary.successRate.embeddings * 100).toFixed(0);

    console.log(
      `| ${comp.conversationName.substring(0, 12).padEnd(12)} | ` +
      `${(summarySuccess + '%').padStart(22)} | ` +
      `${(embeddingsSuccess + '%').padStart(25)} |`
    );
  });

  console.log(`\n${'='.repeat(100)}\n`);

  // Overall statistics
  const totalSummaryTokens = comparisons.reduce((sum, c) => sum + c.summary.totalTokens.summary, 0);
  const totalEmbeddingsTokens = comparisons.reduce((sum, c) => sum + c.summary.totalTokens.embeddings, 0);
  const overallSavings = totalSummaryTokens - totalEmbeddingsTokens;
  const overallSavingsPercent = totalSummaryTokens > 0
    ? ((overallSavings / totalSummaryTokens) * 100).toFixed(1)
    : '0.0';

  console.log('🎯 OVERALL STATISTICS');
  console.log(`   Total Tokens (Summary):     ${totalSummaryTokens}`);
  console.log(`   Total Tokens (Embeddings):  ${totalEmbeddingsTokens}`);
  console.log(`   Token Difference:           ${overallSavings > 0 ? '+' : ''}${overallSavings} (${overallSavingsPercent}%)`);

  const avgSummaryLatency = Math.round(
    comparisons.reduce((sum, c) => sum + c.summary.avgLatency.summary, 0) / comparisons.length
  );
  const avgEmbeddingsLatency = Math.round(
    comparisons.reduce((sum, c) => sum + c.summary.avgLatency.embeddings, 0) / comparisons.length
  );

  console.log(`\n   Avg Latency (Summary):      ${avgSummaryLatency}ms`);
  console.log(`   Avg Latency (Embeddings):   ${avgEmbeddingsLatency}ms`);
  console.log(`   Latency Difference:         ${avgEmbeddingsLatency - avgSummaryLatency > 0 ? '+' : ''}${avgEmbeddingsLatency - avgSummaryLatency}ms`);
}

/**
 * Main test execution
 */
async function main() {
  console.log('\n' + '='.repeat(100));
  console.log('🧪 SQL-of-Thought: Conversation History Method Comparison');
  console.log('='.repeat(100));
  console.log(`\n📋 Test Plan:`);
  console.log(`   - ${TEST_CONVERSATIONS.length} conversations`);
  console.log(`   - Testing: Summary (port 8000) vs Embeddings (port 8001)`);
  console.log(`   - Rate limit: ${RATE_LIMIT_DELAY_MS / 1000}s between API calls`);
  console.log(`   - Sequential execution to avoid rate limits\n`);

  // Check API availability
  console.log('🔍 Checking API availability...');
  try {
    const summaryHealth = await fetch(`${SUMMARY_API_URL}/health`);
    const embeddingsHealth = await fetch(`${EMBEDDINGS_API_URL}/health`);

    if (!summaryHealth.ok || !embeddingsHealth.ok) {
      throw new Error('One or both APIs are not responding');
    }

    const summaryStatus = await summaryHealth.json() as { status: string };
    const embeddingsStatus = await embeddingsHealth.json() as { status: string };
    console.log(`   ✅ Summary API (port 8000): ${summaryStatus.status}`);
    console.log(`   ✅ Embeddings API (port 8001): ${embeddingsStatus.status}\n`);
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message}`);
    console.error('Please ensure both APIs are running:');
    console.error('  Terminal 1: npm run api          (Summary API on port 8000)');
    console.error('  Terminal 2: npm run api:embeddings  (Embeddings API on port 8001)\n');
    process.exit(1);
  }

  const allComparisons: ConversationComparison[] = [];

  // Run tests
  for (let i = 0; i < TEST_CONVERSATIONS.length; i++) {
    const conversation = TEST_CONVERSATIONS[i];
    const conversationId = `${CONVERSATION_ID_PREFIX}${i + 1}`;

    console.log(`\n\n${'█'.repeat(100)}`);
    console.log(`🗣️  ${conversation.name}`);
    console.log(`   ${conversation.description}`);
    console.log(`   Questions: ${conversation.questions.length}`);
    console.log(`${'█'.repeat(100)}`);

    // Test on Summary API
    const summaryResults = await testConversation(
      SUMMARY_API_URL,
      'summary',
      conversationId,
      conversation.questions
    );

    // Brief pause between APIs
    console.log(`\n⏳ Pausing before switching APIs...`);
    await delay(3000);

    // Test on Embeddings API
    const embeddingsResults = await testConversation(
      EMBEDDINGS_API_URL,
      'embeddings',
      conversationId,
      conversation.questions
    );

    // Compare and store results
    const comparison = compareResults(
      conversation.name,
      conversation.questions,
      summaryResults,
      embeddingsResults
    );
    allComparisons.push(comparison);
  }

  // Print comparison table
  printComparisonTable(allComparisons);

  // Save results to file
  const timestamp = new Date().toISOString().split('T')[0];
  const outputPath = join(process.cwd(), 'logs', `conversation-comparison-${timestamp}.json`);

  writeFileSync(outputPath, JSON.stringify(allComparisons, null, 2));

  console.log(`\n💾 Results saved to: ${outputPath}`);
  console.log('\n✅ Comparison test complete!\n');
}

// Run tests
main().catch(error => {
  console.error('\n❌ Test execution failed:', error);
  process.exit(1);
});

