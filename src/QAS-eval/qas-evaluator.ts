/**
 * QAS (Query Affinity Score) Evaluator
 * Main orchestrator combining semantic, execution, and datatype evaluations
 */

import { evaluateSemanticSimilarity } from './semantic-evaluator.js';
import { evaluateExecutionSimilarity } from './execution-evaluator.js';
import { validateDataType } from './datatype-validator.js';
import type {
    TestQuestion,
    TestResult,
    QASEvaluation,
    QASWeights
} from './evaluation-types.js';

// Default weights from QAS paper
const DEFAULT_WEIGHTS: QASWeights = {
    semantic: 0.40,
    execution: 0.40,
    datatype: 0.20,
};

/**
 * Extract actual results from test result
 */
function extractActualResults(testResult: TestResult): any {
    if (testResult.agent_used === 'sql') {
        return testResult.results;
    }
    if (testResult.agent_used === 'docking') {
        return testResult.docking_answer;
    }
    return null;
}

/**
 * Main QAS evaluation function
 * Combines semantic, execution, and datatype scores
 */
export async function evaluateQAS(
    testQuestion: TestQuestion,
    testResult: TestResult,
    weights: QASWeights = DEFAULT_WEIGHTS
): Promise<QASEvaluation> {

    console.log(`\n⚖️  [QAS] Evaluating Test ID ${testQuestion.id}...`);

    // Extract actual results
    const actualResults = extractActualResults(testResult);

    // 1. Semantic Similarity (for SQL agent)
    let semanticScore = 0.0;
    let semanticExplanation = '';

    if (testResult.agent_used === 'sql' && testQuestion.expected_sql) {
        const semantic = await evaluateSemanticSimilarity(
            testResult.generated_sql || '',
            testQuestion.expected_sql,
            testQuestion.question
        );
        semanticScore = semantic.score;
        semanticExplanation = semantic.explanation;
    } else if (testResult.agent_used === 'docking') {
        // For docking agent, semantic score is based on successful API call
        semanticScore = testResult.success ? 1.0 : 0.0;
        semanticExplanation = testResult.success
            ? 'Docking API call successful'
            : `Docking API failed: ${testResult.error || 'Unknown error'}`;
    } else {
        semanticExplanation = 'No expected SQL for semantic comparison';
    }

    // 2. Execution Similarity (data-level correctness)
    const execution = evaluateExecutionSimilarity(
        actualResults,
        testQuestion.expected_results,
        testQuestion.expected_answer_type,
        testResult.success
    );
    const executionScore = execution.score;
    const executionExplanation = execution.explanation;

    // 3. Data Type Validity
    const datatype = validateDataType(
        actualResults,
        testQuestion.expected_answer_type
    );
    const datatypeScore = datatype.score;
    const datatypeExplanation = datatype.explanation;

    // Calculate weighted final score
    const finalScore =
        (semanticScore * weights.semantic) +
        (executionScore * weights.execution) +
        (datatypeScore * weights.datatype);

    // Determine pass/fail (threshold: 0.7)
    const passed = finalScore >= 0.7;

    const evaluation: QASEvaluation = {
        semantic_score: Math.round(semanticScore * 1000) / 1000,
        execution_score: Math.round(executionScore * 1000) / 1000,
        datatype_score: Math.round(datatypeScore * 1000) / 1000,
        final_score: Math.round(finalScore * 1000) / 1000,
        passed,
        breakdown: {
            semantic_explanation: semanticExplanation,
            execution_explanation: executionExplanation,
            datatype_explanation: datatypeExplanation,
        },
    };

    console.log(`   Semantic: ${evaluation.semantic_score.toFixed(2)} | Execution: ${evaluation.execution_score.toFixed(2)} | Type: ${evaluation.datatype_score.toFixed(2)}`);
    console.log(`   Final Score: ${evaluation.final_score.toFixed(2)} (${evaluation.passed ? 'PASS' : 'FAIL'})`);

    return evaluation;
}
