/**
 * Main Evaluation Orchestrator
 * Runs test execution + both judges, generates combined results
 * Calls SQL and Docking agents directly (no router needed)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import { runOrchestrator } from '../agent.js';
import { evaluateOutput } from './judge-output-evaluator.js';
import { evaluateProcess } from './judge-process-evaluator.js';
import type { TestQuestion, TestResult, EvaluationResult } from './evaluation-types.js';

// Configuration
const TEST_QUESTIONS_PATH = join(process.cwd(), 'test_questions_answers.json');
const REPORTS_DIR = join(process.cwd(), 'reports', 'evaluation-runs');
const DOCKING_API_URL = "http://localhost:8088/qa";

/**
 * Generate timestamped run ID
 */
function generateRunId(): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, -5);
  return `run-${timestamp}`;
}

/**
 * Load test questions from JSON file
 */
function loadTestQuestions(): TestQuestion[] {
  const content = readFileSync(TEST_QUESTIONS_PATH, 'utf-8');
  return JSON.parse(content);
}

/**
 * Execute SQL agent test
 */
async function executeSQLTest(testQuestion: TestQuestion): Promise<TestResult> {
  console.log(`\n📍 [1/3] Executing SQL agent...`);
  const startTime = Date.now();
  
  try {
    // Call runOrchestrator directly - it returns full OrchestratorResult
    const orchestratorResult = await runOrchestrator(testQuestion.question, undefined);
    const executionTime = Date.now() - startTime;
    
    // Extract actual tool names from toolCallSequence
    const toolCalls = orchestratorResult.toolCallSequence || [];
    
    const testResult: TestResult = {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: 'sql',
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      generated_sql: orchestratorResult.sql,
      results: orchestratorResult.results || [],
      row_count: orchestratorResult.row_count || 0,
      tool_calls: toolCalls,
      iterations: orchestratorResult.iterations || 0,
      final_answer: orchestratorResult.finalAnswer,
      execution_time_ms: executionTime,
      success: orchestratorResult.success,
    };
    
    console.log(`   ✅ SQL agent completed (${executionTime}ms, ${testResult.iterations} iterations, ${toolCalls.length} tools)`);
    
    return testResult;
    
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    console.error(`   ❌ SQL agent failed: ${error.message}`);
    
    return {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: 'sql',
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      execution_time_ms: executionTime,
      success: false,
      error: error.message,
    };
  }
}

/**
 * Execute Docking agent test
 */
async function executeDockingTest(testQuestion: TestQuestion): Promise<TestResult> {
  console.log(`\n📍 [1/3] Executing Docking agent...`);
  const startTime = Date.now();
  
  try {
    // Call docking agent API directly
    const response = await fetch(DOCKING_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: testQuestion.question }),
    });
    
    const executionTime = Date.now() - startTime;
    
    if (!response.ok) {
      throw new Error(`Docking API returned status ${response.status}`);
    }
    
    const data = await response.json() as any;
    
    const testResult: TestResult = {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: 'docking',
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      docking_answer: data.answer,
      docking_explanation: data.explanation,
      final_answer: data.explanation || String(data.answer || 'No answer'),
      execution_time_ms: executionTime,
      success: data.answer !== null && data.answer !== undefined,
    };
    
    console.log(`   ✅ Docking agent completed (${executionTime}ms)`);
    
    return testResult;
    
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    console.error(`   ❌ Docking agent failed: ${error.message}`);
    
    return {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: 'docking',
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      execution_time_ms: executionTime,
      success: false,
      error: error.message,
    };
  }
}

/**
 * Execute a single test and evaluate it with both judges
 */
async function executeAndEvaluateTest(
  testQuestion: TestQuestion,
  runDir: string
): Promise<EvaluationResult> {
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🧪 Test ID ${testQuestion.id}: ${testQuestion.question.substring(0, 60)}...`);
  console.log(`   Agent: ${testQuestion.agent}, Difficulty: ${testQuestion.difficulty}, Category: ${testQuestion.category}`);
  console.log(`${'='.repeat(80)}`);
  
  try {
    // Step 1: Execute test based on agent type
    const testResult = testQuestion.agent === 'sql'
      ? await executeSQLTest(testQuestion)
      : await executeDockingTest(testQuestion);
    
    // Save test result
    const testResultsFile = join(runDir, 'test-results.jsonl');
    writeFileSync(testResultsFile, JSON.stringify(testResult) + '\n', { flag: 'a' });
    
    // Step 2: Judge #1 - Output Evaluation
    console.log(`\n📍 [2/3] Running Judge #1 (Output Evaluator)...`);
    const outputEval = await evaluateOutput(testQuestion, testResult);
    console.log(`   ${outputEval.passed ? '✅' : '❌'} Score: ${outputEval.overall_score}/10`);
    
    // Step 3: Judge #2 - Process Evaluation
    console.log(`\n📍 [3/3] Running Judge #2 (Process Evaluator)...`);
    const processEval = await evaluateProcess(testQuestion, testResult);
    console.log(`   ${processEval.passed ? '✅' : '❌'} Score: ${processEval.tool_efficiency_score}/10`);
    
    // Combine into evaluation result
    const evaluationResult: EvaluationResult = {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: testResult.agent_used,
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      expected_sql: testQuestion.expected_sql,
      generated_sql: testResult.generated_sql,
      judge_output: outputEval,
      judge_process: processEval,
    };
    
    console.log(`\n📊 Combined Result: Output ${outputEval.overall_score}/10, Process ${processEval.tool_efficiency_score}/10`);
    console.log(`   Overall: ${outputEval.passed && processEval.passed ? '✅ PASS' : '❌ FAIL'}`);
    
    return evaluationResult;
    
  } catch (error: any) {
    console.error(`\n❌ Test ${testQuestion.id} failed:`, error.message);
    
    // Create failed evaluation result
    return {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: testQuestion.agent,
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      expected_sql: testQuestion.expected_sql,
      judge_output: {
        overall_score: 0,
        explanation: `Execution failed: ${error.message}`,
        passed: false,
      },
      judge_process: {
        tool_efficiency_score: 0,
        tools_called: [],
        unnecessary_tools: [],
        missing_tools: [],
        explanation: `Execution failed: ${error.message}`,
        passed: false,
      },
    };
  }
}

/**
 * Main evaluation function
 */
export async function runFullEvaluation(limitTests?: number): Promise<void> {
  console.log('\n' + '╔'.repeat(80));
  console.log('🤖 JUDGE AI EVALUATION SYSTEM - FULL RUN');
  console.log('╚'.repeat(80) + '\n');
  
  // Generate run ID and create directories
  const runId = generateRunId();
  const runDir = join(REPORTS_DIR, runId);
  
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
    console.log(`📁 Created run directory: ${runDir}`);
  }
  
  // Load test questions
  const allQuestions = loadTestQuestions();
  const testQuestions = limitTests ? allQuestions.slice(0, limitTests) : allQuestions;
  
  console.log(`\n📋 Loaded ${testQuestions.length} test questions`);
  console.log(`   SQL: ${testQuestions.filter(q => q.agent === 'sql').length}`);
  console.log(`   Docking: ${testQuestions.filter(q => q.agent === 'docking').length}`);
  console.log(`   Easy: ${testQuestions.filter(q => q.difficulty === 'easy').length}, Medium: ${testQuestions.filter(q => q.difficulty === 'medium').length}, Hard: ${testQuestions.filter(q => q.difficulty === 'hard').length}`);
  
  // Execute all tests with evaluation
  const evaluations: EvaluationResult[] = [];
  const evaluationResultsFile = join(runDir, 'evaluation-results.jsonl');
  
  for (const question of testQuestions) {
    const evaluation = await executeAndEvaluateTest(question, runDir);
    evaluations.push(evaluation);
    
    // Save evaluation result incrementally
    writeFileSync(evaluationResultsFile, JSON.stringify(evaluation) + '\n', { flag: 'a' });
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Calculate summary statistics
  console.log('\n' + '='.repeat(80));
  console.log('📊 EVALUATION SUMMARY');
  console.log('='.repeat(80));
  
  const passedOutput = evaluations.filter(e => e.judge_output.passed).length;
  const passedProcess = evaluations.filter(e => e.judge_process.passed).length;
  const passedBoth = evaluations.filter(e => e.judge_output.passed && e.judge_process.passed).length;
  
  const avgOutputScore = evaluations.reduce((sum, e) => sum + e.judge_output.overall_score, 0) / evaluations.length;
  const avgProcessScore = evaluations.reduce((sum, e) => sum + e.judge_process.tool_efficiency_score, 0) / evaluations.length;
  
  console.log(`\nTotal Tests: ${evaluations.length}`);
  console.log(`\nJudge #1 (Output):`);
  console.log(`  Passed: ${passedOutput}/${evaluations.length} (${((passedOutput / evaluations.length) * 100).toFixed(1)}%)`);
  console.log(`  Avg Score: ${avgOutputScore.toFixed(2)}/10`);
  console.log(`\nJudge #2 (Process):`);
  console.log(`  Passed: ${passedProcess}/${evaluations.length} (${((passedProcess / evaluations.length) * 100).toFixed(1)}%)`);
  console.log(`  Avg Score: ${avgProcessScore.toFixed(2)}/10`);
  console.log(`\nOverall (Both Passed):`);
  console.log(`  Passed: ${passedBoth}/${evaluations.length} (${((passedBoth / evaluations.length) * 100).toFixed(1)}%)`);
  
  // Breakdown by difficulty
  console.log(`\nBy Difficulty:`);
  for (const diff of ['easy', 'medium', 'hard']) {
    const diffTests = evaluations.filter(e => e.difficulty === diff);
    if (diffTests.length > 0) {
      const diffPassed = diffTests.filter(e => e.judge_output.passed && e.judge_process.passed).length;
      const diffAvgOutput = diffTests.reduce((sum, e) => sum + e.judge_output.overall_score, 0) / diffTests.length;
      const diffAvgProcess = diffTests.reduce((sum, e) => sum + e.judge_process.tool_efficiency_score, 0) / diffTests.length;
      console.log(`  ${diff}: ${diffPassed}/${diffTests.length} passed, Avg: Output ${diffAvgOutput.toFixed(1)}, Process ${diffAvgProcess.toFixed(1)}`);
    }
  }
  
  // Breakdown by agent
  console.log(`\nBy Agent:`);
  for (const agent of ['sql', 'docking']) {
    const agentTests = evaluations.filter(e => e.agent_used === agent);
    if (agentTests.length > 0) {
      const agentPassed = agentTests.filter(e => e.judge_output.passed && e.judge_process.passed).length;
      const agentAvgOutput = agentTests.reduce((sum, e) => sum + e.judge_output.overall_score, 0) / agentTests.length;
      const agentAvgProcess = agentTests.reduce((sum, e) => sum + e.judge_process.tool_efficiency_score, 0) / agentTests.length;
      console.log(`  ${agent}: ${agentPassed}/${agentTests.length} passed, Avg: Output ${agentAvgOutput.toFixed(1)}, Process ${agentAvgProcess.toFixed(1)}`);
    }
  }
  
  // Failed tests
  const failed = evaluations.filter(e => !e.judge_output.passed || !e.judge_process.passed);
  if (failed.length > 0) {
    console.log(`\n❌ Failed Tests (${failed.length}):`);
    failed.forEach(e => {
      console.log(`  ID ${e.test_id}: ${e.question.substring(0, 50)}...`);
      console.log(`    Output: ${e.judge_output.overall_score}/10, Process: ${e.judge_process.tool_efficiency_score}/10`);
    });
  }
  
  console.log(`\n📂 Results saved to:`);
  console.log(`   ${evaluationResultsFile}`);
  console.log(`   ${join(runDir, 'test-results.jsonl')}`);
  console.log('='.repeat(80) + '\n');
  
  console.log('✅ Full evaluation complete!');
  console.log(`📂 Run ID: ${runId}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const limitArg = process.argv[2] ? parseInt(process.argv[2]) : undefined;
  
  console.log('\n⚠️  NOTE: This will execute tests against live agents.');
  console.log('   - SQL agent will query the database via runOrchestrator()');
  console.log('   - Docking agent must be running on port 8088');
  console.log('   - Each test includes 2 Gemini API calls (judges)\n');
  
  runFullEvaluation(limitArg)
    .then(() => {
      console.log('\n✨ Evaluation completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Evaluation failed:', error);
      process.exit(1);
    });
}

