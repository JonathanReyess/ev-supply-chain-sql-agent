// evaluation-runner.ts
// Runs router agent on test questions and collects detailed execution traces

import { runRouterAgent } from './router-agent.js';
import * as fs from 'fs';
import * as path from 'path';

interface ToolCall {
  toolName: string;
  question: string;
  result: string;
  startTime: number;
  endTime: number;
  durationMs: number;
}

interface EvaluationTrace {
  questionId: string;
  question: string;
  category: string;
  expectedAgents?: string[];
  
  // Execution details
  finalAnswer: string;
  totalDurationMs: number;
  totalIterations: number;
  toolCalls: ToolCall[];
  
  // Routing decisions
  agentsUsed: string[];
  routingSequence: string[];
  
  // Performance metrics
  startTimestamp: string;
  endTimestamp: string;
  
  // For SQL queries
  sqlQueries?: string[];
  sqlResults?: any[];
  
  // --- MODIFIED/NEW FIELDS FOR TRACE DETAIL ---
  finalSql?: string; // Captured from [Router] SQL_FINAL_QUERY
  internalSqlAgentSequence?: string[]; // Captured from [Router] SQL_AGENT_SEQUENCE
  internalSqlAgentDetails?: string[]; // Captured from [Router] SQL_AGENT_DETAILS_JSON (Tool Results)
  // ------------------------------------------

  // Error handling
  error?: string;
  success: boolean;
}

interface EvaluationRun {
  runId: string;
  timestamp: string;
  model: string;
  totalQuestions: number;
  successCount: number;
  failureCount: number;
  averageDurationMs: number;
  traces: EvaluationTrace[];
}

// Instrumented version of router agent that captures execution details
export async function runRouterAgentWithTracing(
  question: string,
  questionId: string,
  category: string,
  expectedAgents?: string[]
): Promise<EvaluationTrace> {
  const trace: EvaluationTrace = {
    questionId,
    question,
    category,
    expectedAgents,
    finalAnswer: '',
    totalDurationMs: 0,
    totalIterations: 0,
    toolCalls: [],
    agentsUsed: [],
    routingSequence: [],
    startTimestamp: new Date().toISOString(),
    endTimestamp: '',
    sqlQueries: [],
    sqlResults: [],
    finalSql: undefined,
    internalSqlAgentSequence: [],
    internalSqlAgentDetails: [], // Initialize
    success: false
  };

  const startTime = Date.now();

  try {
    // Intercept console.log to capture tool calls and decisions
    const originalLog = console.log;
    let currentToolCall: Partial<ToolCall> | null = null;

    console.log = (...args: any[]) => {
      const message = args.join(' ');
      
      // Capture tool call starts
      if (message.includes('[Router] Decision: Calling')) {
        const toolMatch = message.match(/Calling (\w+)/);
        if (toolMatch) {
          currentToolCall = {
            toolName: toolMatch[1],
            startTime: Date.now()
          };
        }
      }
      
      // Capture sub-questions
      if (message.includes('Sub-question:') && currentToolCall) {
        const questionMatch = message.match(/Sub-question: "(.+)"/);
        if (questionMatch) {
          currentToolCall.question = questionMatch[1];
        }
      }
      
      // --- START FIX: Robust Multiline Tool Result Capture ---
      if (message.includes('returned:') && currentToolCall) {
        const resultMatch = message.match(/returned:([\s\S]*)$/); 
        
        if (resultMatch) {
          currentToolCall.result = resultMatch[1].trim(); 
          currentToolCall.endTime = Date.now();
          currentToolCall.durationMs = currentToolCall.endTime - (currentToolCall.startTime || 0);
          
          trace.toolCalls.push(currentToolCall as ToolCall);
          trace.agentsUsed.push(currentToolCall.toolName || '');
          trace.routingSequence.push(currentToolCall.toolName || '');
          
          currentToolCall = null;
        }
      }
      // --- END FIX ---
      
      // Capture SQL queries (logs from within the SQL orchestrator)
      if (message.includes('SQL query generated:')) {
        const sqlMatch = message.match(/SQL query generated: (.+)/);
        if (sqlMatch) {
          trace.sqlQueries?.push(sqlMatch[1]);
        }
      }

      // --- START NEW LOGIC: Capture Internal Trace Details ---
      // Capture SQL agent's internal tool sequence
      if (message.includes('[Router] SQL_AGENT_SEQUENCE:')) {
        const sequenceMatch = message.match(/SQL_AGENT_SEQUENCE: (.+)$/);
        if (sequenceMatch && sequenceMatch[1]) {
          trace.internalSqlAgentSequence = sequenceMatch[1].split(' -> ').map(s => s.trim());
        }
      }

      // Capture the final generated SQL query reported by the router
      if (message.includes('[Router] SQL_FINAL_QUERY:')) {
        const sqlMatch = message.match(/SQL_FINAL_QUERY: (.+)$/);
        if (sqlMatch && sqlMatch[1]) {
          trace.finalSql = sqlMatch[1].trim();
        }
      }
      
      // Capture the detailed internal tool results (logged as a JSON string by the router)
      if (message.includes('[Router] SQL_AGENT_DETAILS_JSON:')) {
        const detailsMatch = message.match(/SQL_AGENT_DETAILS_JSON: (\[[\s\S]*\])$/);
        if (detailsMatch && detailsMatch[1]) {
            try {
                // Parse the JSON array logged by the router
                trace.internalSqlAgentDetails = JSON.parse(detailsMatch[1]);
            } catch (e) {
                console.error("Failed to parse SQL_AGENT_DETAILS_JSON:", e);
            }
        }
      }
      // --- END NEW LOGIC ---
      
      // Capture iteration counts
      if (message.includes('[Router] Iteration')) {
        const iterMatch = message.match(/Iteration (\d+)\//);
        if (iterMatch) {
          trace.totalIterations = parseInt(iterMatch[1]);
        }
      }
      
      // Still log to console
      originalLog.apply(console, args);
    };

    // Run the agent
    const answer = await runRouterAgent(question, 5);
    trace.finalAnswer = answer;
    trace.success = true;

    // Restore console.log
    console.log = originalLog;

  } catch (error) {
    trace.error = error instanceof Error ? error.message : String(error);
    trace.success = false;
  }

  const endTime = Date.now();
  trace.totalDurationMs = endTime - startTime;
  trace.endTimestamp = new Date().toISOString();
  
  // Deduplicate agents used
  trace.agentsUsed = [...new Set(trace.agentsUsed)];

  return trace;
}

/**
 * Loads test questions using a hardcoded structure. 
 * File reading logic is removed to ensure single-question testing works out-of-the-box.
 */
function loadTestQuestions(jsonPath: string): any {
  console.log('📝 Using hardcoded test questions for evaluation run.');
  
  // Define your hardcoded test suite structure here.
  const hardcodedTestSuite = {
    recommended_test_suite: {
      single_test_run: [
        'How many inbound shipments are there at Fremont CA?', 
      ]
    }
  };
  return hardcodedTestSuite;
}

// Run evaluation on a set of questions
export async function runEvaluation(
  questionsJsonPath: string, 
  outputDir: string = './evaluation-results'
): Promise<EvaluationRun> {
  
  console.log('\n' + '='.repeat(100));
  console.log('STARTING EVALUATION RUN (Hardcoded Questions)');
  console.log('='.repeat(100));
  
  const testQuestions = loadTestQuestions(questionsJsonPath);
  
  const runId = `eval-${Date.now()}`;
  const timestamp = new Date().toISOString();
  
  const evaluationRun: EvaluationRun = {
    runId,
    timestamp,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    totalQuestions: 0,
    successCount: 0,
    failureCount: 0,
    averageDurationMs: 0,
    traces: []
  };

  // Prepare question list with metadata
  const questionList: Array<{
    id: string;
    question: string;
    category: string;
    expectedAgents?: string[];
  }> = [];

  // Parse test questions JSON structure
  if (testQuestions.recommended_test_suite) {
    // Use the phased test suite
    for (const [phase, questions] of Object.entries(testQuestions.recommended_test_suite)) {
      (questions as string[]).forEach((q, idx) => {
        const category = phase.replace(/_/g, ' ');
        // Determine expected agents based on phase name (original logic)
        const expectedAgents = 
          phase.includes('phase_1') ? ['sql_orchestrator_agent'] :
          phase.includes('phase_2') ? ['sql_orchestrator_agent'] :
          phase.includes('phase_3') ? ['docking_agent_api', 'sql_orchestrator_agent'] :
          phase.includes('phase_4') ? ['docking_agent_api', 'sql_orchestrator_agent'] :
          phase.includes('phase_5') ? ['docking_agent_api', 'sql_orchestrator_agent'] :
          // Assign expected agent for the hardcoded 'single_test_run'
          phase.includes('single_test_run') ? ['sql_orchestrator_agent'] :
          undefined;
        
        questionList.push({
          id: `${phase}-${idx}`,
          question: q,
          category,
          expectedAgents
        });
      });
    }
  }

  evaluationRun.totalQuestions = questionList.length;

  console.log(`\nTotal questions to evaluate: ${questionList.length}\n`);

  // Run evaluation on each question
  for (let i = 0; i < questionList.length; i++) {
    const testCase = questionList[i];
    
    console.log('\n' + '='.repeat(100));
    console.log(`EVALUATING QUESTION ${i + 1}/${questionList.length}`);
    console.log(`ID: ${testCase.id}`);
    console.log(`Category: ${testCase.category}`);
    console.log('='.repeat(100));
    console.log(`Question: "${testCase.question}"\n`);

    try {
      const trace = await runRouterAgentWithTracing(
        testCase.question,
        testCase.id,
        testCase.category,
        testCase.expectedAgents
      );

      evaluationRun.traces.push(trace);
      
      if (trace.success) {
        evaluationRun.successCount++;
        console.log(`\n✅ SUCCESS (${trace.totalDurationMs}ms)`);
      } else {
        evaluationRun.failureCount++;
        console.log(`\n❌ FAILURE: ${trace.error}`);
      }

      // Rate limiting: wait between questions
      if (i < questionList.length - 1) {
        console.log('\nWaiting 3 seconds before next question...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

    } catch (error) {
      console.error(`\n❌ ERROR evaluating question: ${error}`);
      evaluationRun.failureCount++;
      
      evaluationRun.traces.push({
        questionId: testCase.id,
        question: testCase.question,
        category: testCase.category,
        expectedAgents: testCase.expectedAgents,
        finalAnswer: '',
        totalDurationMs: 0,
        totalIterations: 0,
        toolCalls: [],
        agentsUsed: [],
        routingSequence: [],
        startTimestamp: new Date().toISOString(),
        endTimestamp: new Date().toISOString(),
        finalSql: undefined,
        internalSqlAgentSequence: [], 
        internalSqlAgentDetails: [], 
        error: error instanceof Error ? error.message : String(error),
        success: false
      });
    }
  }

  // Calculate average duration
  const totalDuration = evaluationRun.traces.reduce((sum, t) => sum + t.totalDurationMs, 0);
  evaluationRun.averageDurationMs = totalDuration / evaluationRun.traces.length;

  // Save results
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `${runId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(evaluationRun, null, 2));

  console.log('\n' + '='.repeat(100));
  console.log('EVALUATION COMPLETE');
  console.log('='.repeat(100));
  console.log(`\nResults saved to: ${outputPath}`);
  console.log(`\nSummary:`);
  console.log(`  Total Questions: ${evaluationRun.totalQuestions}`);
  console.log(`  Successful: ${evaluationRun.successCount}`);
  console.log(`  Failed: ${evaluationRun.failureCount}`);
  console.log(`  Average Duration: ${evaluationRun.averageDurationMs.toFixed(2)}ms`);
  console.log(`  Success Rate: ${((evaluationRun.successCount / evaluationRun.totalQuestions) * 100).toFixed(1)}%`);

  return evaluationRun;
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const questionsPath = process.argv[2] || './test-questions.json'; 
  const outputDir = process.argv[3] || './evaluation-results';

  runEvaluation(questionsPath, outputDir)
    .then(() => {
      console.log('\n✅ Evaluation runner completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Evaluation runner failed:', error);
      process.exit(1);
    });
}