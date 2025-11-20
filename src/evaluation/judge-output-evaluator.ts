/**
 * Judge Agent #1: Output Evaluator
 * Evaluates correctness of agent outputs (SQL + results accuracy)
 */

import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import type { TestQuestion, TestResult, OutputEvaluation } from './evaluation-types.js';

dotenv.config();

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Evaluate SQL correctness using Gemini
 * Compares generated SQL vs expected SQL semantically
 */
async function evaluateSQLCorrectness(
  generatedSQL: string,
  expectedSQL: string,
  question: string
): Promise<{ score: number; explanation: string }> {
  
  const prompt = `You are a SQL expert evaluating the correctness of a generated SQL query.

USER QUESTION: "${question}"

EXPECTED SQL:
\`\`\`sql
${expectedSQL}
\`\`\`

GENERATED SQL:
\`\`\`sql
${generatedSQL}
\`\`\`

Evaluate whether the GENERATED SQL is semantically equivalent to the EXPECTED SQL. Consider:
1. Do both queries produce the same results?
2. Are table joins correct?
3. Are WHERE conditions equivalent (allowing for different syntax)?
4. Are aggregations and GROUP BY clauses correct?
5. Minor differences in aliases, column order, or syntax style are acceptable if results match.

Scoring Guide:
- 10/10: Exact match or semantically identical
- 8-9/10: Achieves same result with slightly different approach (e.g., different join order)
- 6-7/10: Mostly correct but minor issues (e.g., missing LOWER() for case-insensitive comparison)
- 4-5/10: Partially correct (correct tables but wrong filters or aggregations)
- 0-3/10: Wrong approach or major errors

Return ONLY a JSON object:
{
  "score": <number 0-10>,
  "explanation": "<brief explanation of score>"
}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{"score": 0, "explanation": "Failed to parse"}');
  return {
    score: Math.max(0, Math.min(10, result.score)),
    explanation: result.explanation || 'No explanation provided',
  };
}

/**
 * Evaluate results accuracy
 * Checks if the actual results match expected answer type
 */
function evaluateResultsAccuracy(
  testResult: TestResult,
  expectedAnswerType: string
): { score: number; explanation: string } {
  
  // Check if query was successful
  if (!testResult.success) {
    return {
      score: 0,
      explanation: `Query failed: ${testResult.error || 'Unknown error'}`,
    };
  }
  
  // For SQL agent
  if (testResult.agent_used === 'sql') {
    const results = testResult.results || [];
    
    switch (expectedAnswerType) {
      case 'number':
        // Should return a single row with one numeric column
        if (results.length === 1 && Object.keys(results[0]).length >= 1) {
          const value = Object.values(results[0])[0];
          if (typeof value === 'number' || typeof value === 'string') {
            return {
              score: 10,
              explanation: 'Single numeric value returned as expected',
            };
          }
        }
        return {
          score: 3,
          explanation: `Expected single number, got ${results.length} rows`,
        };
      
      case 'table':
        // Should return multiple rows with appropriate columns
        if (results.length > 0) {
          return {
            score: 10,
            explanation: `Table with ${results.length} rows returned`,
          };
        }
        return {
          score: 5,
          explanation: 'Empty table returned (may be correct if no data matches)',
        };
      
      case 'kpi':
        // Should return calculated metric(s)
        if (results.length > 0) {
          return {
            score: 10,
            explanation: `KPI metric calculated (${results.length} rows)`,
          };
        }
        return {
          score: 5,
          explanation: 'No KPI values returned',
        };
      
      default:
        return {
          score: 7,
          explanation: `Results returned but answer type '${expectedAnswerType}' not explicitly validated`,
        };
    }
  }
  
  // For Docking agent
  if (testResult.agent_used === 'docking') {
    if (testResult.docking_answer !== null && testResult.docking_answer !== undefined) {
      switch (expectedAnswerType) {
        case 'schedule':
        case 'list':
          if (Array.isArray(testResult.docking_answer)) {
            return {
              score: 10,
              explanation: `Schedule/list returned with ${testResult.docking_answer.length} items`,
            };
          }
          break;
        
        case 'boolean':
          if (typeof testResult.docking_answer === 'boolean' || 
              (typeof testResult.docking_answer === 'string' && 
               ['yes', 'no', 'true', 'false'].includes(testResult.docking_answer.toLowerCase()))) {
            return {
              score: 10,
              explanation: 'Boolean answer returned',
            };
          }
          break;
        
        case 'analysis':
        case 'plan':
        case 'optimization_plan':
          if (typeof testResult.docking_answer === 'object' || typeof testResult.docking_answer === 'string') {
            return {
              score: 10,
              explanation: 'Analysis/plan data returned',
            };
          }
          break;
      }
      
      return {
        score: 7,
        explanation: `Answer returned but format validation for '${expectedAnswerType}' is partial`,
      };
    }
    
    return {
      score: 0,
      explanation: 'No answer returned from docking agent',
    };
  }
  
  return {
    score: 0,
    explanation: 'Unknown agent type',
  };
}

/**
 * Main evaluation function for Judge #1
 */
export async function evaluateOutput(
  testQuestion: TestQuestion,
  testResult: TestResult
): Promise<OutputEvaluation> {
  
  console.log(`\n⚖️  [Judge #1] Evaluating Test ID ${testQuestion.id}...`);
  
  let evaluation: OutputEvaluation;
  
  if (testResult.agent_used === 'sql') {
    // Evaluate SQL correctness
    const sqlEval = testQuestion.expected_sql && testResult.generated_sql
      ? await evaluateSQLCorrectness(
          testResult.generated_sql,
          testQuestion.expected_sql,
          testQuestion.question
        )
      : { score: 0, explanation: 'Missing SQL data' };
    
    // Evaluate results accuracy
    const resultsEval = evaluateResultsAccuracy(testResult, testQuestion.expected_answer_type);
    
    // Calculate overall score (50% SQL + 50% results)
    const overallScore = (sqlEval.score * 0.5 + resultsEval.score * 0.5);
    
    evaluation = {
      sql_correctness_score: sqlEval.score,
      results_accuracy_score: resultsEval.score,
      overall_score: Math.round(overallScore * 10) / 10, // Round to 1 decimal
      explanation: `SQL: ${sqlEval.explanation}. Results: ${resultsEval.explanation}`,
      passed: overallScore >= 7.0,
    };
    
  } else {
    // Docking agent evaluation
    const resultsEval = evaluateResultsAccuracy(testResult, testQuestion.expected_answer_type);
    
    // For docking, results accuracy is the main metric
    // Data completeness is checked within results accuracy
    evaluation = {
      answer_correctness_score: resultsEval.score,
      data_completeness_score: resultsEval.score, // Same for now
      overall_score: resultsEval.score,
      explanation: resultsEval.explanation,
      passed: resultsEval.score >= 7.0,
    };
  }
  
  console.log(`   Score: ${evaluation.overall_score}/10 (${evaluation.passed ? 'PASS' : 'FAIL'})`);
  
  return evaluation;
}

