/**
 * Main Evaluation Orchestrator - QAS Version
 * Runs test execution + QAS evaluation, generates results
 * Calls SQL and Docking agents directly (no router needed)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import { runOrchestrator } from '../agent.js';
import { evaluateQAS } from './qas-evaluator.js';
import type { TestQuestion, TestResult, EvaluationResult } from './evaluation-types.js';

// Configuration
const TEST_QUESTIONS_PATH = join(process.cwd(), 'test_workflow', 'test_questions_answers.json');
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
  console.log(`\n📍 [1/2] Executing SQL agent...`);
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
  console.log(`\n📍 [1/2] Executing Docking agent...`);
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
 * Execute a single test and evaluate it with QAS
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

    // Step 2: QAS Evaluation
    console.log(`\n📍 [2/2] Running QAS Evaluation...`);
    const qasEval = await evaluateQAS(testQuestion, testResult);

    // Extract actual results for storage
    const actualResults = testResult.agent_used === 'sql'
      ? testResult.results
      : testResult.docking_answer;

    // Combine into evaluation result
    const evaluationResult: EvaluationResult = {
      test_id: testQuestion.id,
      question: testQuestion.question,
      agent_used: testResult.agent_used,
      difficulty: testQuestion.difficulty,
      category: testQuestion.category,
      expected_sql: testQuestion.expected_sql,
      generated_sql: testResult.generated_sql,
      expected_results: testQuestion.expected_results,
      actual_results: actualResults,
      qas_evaluation: qasEval,
    };

    console.log(`\n📊 QAS Result: ${qasEval.final_score.toFixed(2)} (${qasEval.passed ? '✅ PASS' : '❌ FAIL'})`);

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
      qas_evaluation: {
        semantic_score: 0.0,
        execution_score: 0.0,
        datatype_score: 0.0,
        final_score: 0.0,
        passed: false,
        breakdown: {
          semantic_explanation: `Execution failed: ${error.message}`,
          execution_explanation: 'N/A',
          datatype_explanation: 'N/A',
        },
      },
    };
  }
}

/**
 * Main evaluation function
 */
export async function runFullEvaluation(limitTests?: number): Promise<void> {
  console.log('\n' + '╔'.repeat(80));
  console.log('🤖 QAS EVALUATION SYSTEM - FULL RUN');
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

  const passed = evaluations.filter(e => e.qas_evaluation.passed).length;
  const avgFinalScore = evaluations.reduce((sum, e) => sum + e.qas_evaluation.final_score, 0) / evaluations.length;
  const avgSemanticScore = evaluations.reduce((sum, e) => sum + e.qas_evaluation.semantic_score, 0) / evaluations.length;
  const avgExecutionScore = evaluations.reduce((sum, e) => sum + e.qas_evaluation.execution_score, 0) / evaluations.length;
  const avgDatatypeScore = evaluations.reduce((sum, e) => sum + e.qas_evaluation.datatype_score, 0) / evaluations.length;

  console.log(`\nTotal Tests: ${evaluations.length}`);
  console.log(`Passed: ${passed}/${evaluations.length} (${((passed / evaluations.length) * 100).toFixed(1)}%)`);
  console.log(`\nAverage Scores (0.0-1.0):`);
  console.log(`  Final (Weighted):  ${avgFinalScore.toFixed(3)}`);
  console.log(`  Semantic (40%):    ${avgSemanticScore.toFixed(3)}`);
  console.log(`  Execution (40%):   ${avgExecutionScore.toFixed(3)}`);
  console.log(`  Datatype (20%):    ${avgDatatypeScore.toFixed(3)}`);

  // Breakdown by difficulty
  console.log(`\nBy Difficulty:`);
  for (const diff of ['easy', 'medium', 'hard']) {
    const diffTests = evaluations.filter(e => e.difficulty === diff);
    if (diffTests.length > 0) {
      const diffPassed = diffTests.filter(e => e.qas_evaluation.passed).length;
      const diffAvgFinal = diffTests.reduce((sum, e) => sum + e.qas_evaluation.final_score, 0) / diffTests.length;
      console.log(`  ${diff}: ${diffPassed}/${diffTests.length} passed, Avg Final: ${diffAvgFinal.toFixed(3)}`);
    }
  }

  // Breakdown by agent
  console.log(`\nBy Agent:`);
  for (const agent of ['sql', 'docking']) {
    const agentTests = evaluations.filter(e => e.agent_used === agent);
    if (agentTests.length > 0) {
      const agentPassed = agentTests.filter(e => e.qas_evaluation.passed).length;
      const agentAvgFinal = agentTests.reduce((sum, e) => sum + e.qas_evaluation.final_score, 0) / agentTests.length;
      console.log(`  ${agent}: ${agentPassed}/${agentTests.length} passed, Avg Final: ${agentAvgFinal.toFixed(3)}`);
    }
  }

  // Failed tests
  const failed = evaluations.filter(e => !e.qas_evaluation.passed);
  if (failed.length > 0) {
    console.log(`\n❌ Failed Tests (${failed.length}):`);
    failed.forEach(e => {
      console.log(`  ID ${e.test_id}: ${e.question.substring(0, 50)}...`);
      console.log(`    QAS: ${e.qas_evaluation.final_score.toFixed(2)} (S:${e.qas_evaluation.semantic_score.toFixed(2)} E:${e.qas_evaluation.execution_score.toFixed(2)} T:${e.qas_evaluation.datatype_score.toFixed(2)})`);
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
  console.log('   - Each test includes 1 Gemini API call (semantic evaluation)\n');

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
