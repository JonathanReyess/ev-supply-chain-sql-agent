/**
 * Judge Agent #2: Process Evaluator
 * Evaluates efficiency of tool selection and execution process
 */

import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import type { TestQuestion, TestResult, ProcessEvaluation } from './evaluation-types.js';

dotenv.config();

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Define expected tool sequences by difficulty
 */
const EXPECTED_TOOLS = {
  easy: {
    required: ['load_schema', 'schema_linking', 'generate_query_plan', 'sql_generation', 'execute_sql'],
    optional: [],
    discouraged: ['kpi_decomposition'], // Not needed for simple queries
  },
  medium: {
    required: ['load_schema', 'schema_linking', 'generate_query_plan', 'sql_generation', 'execute_sql'],
    optional: ['kpi_decomposition'], // May be needed for some medium queries
    discouraged: [],
  },
  hard: {
    required: ['load_schema', 'schema_linking', 'generate_query_plan', 'sql_generation', 'execute_sql'],
    optional: ['kpi_decomposition', 'error_correction', 'visualize_results'],
    discouraged: [],
  },
};

/**
 * Evaluate tool selection efficiency using Gemini
 */
async function evaluateToolSelection(
  toolCalls: string[],
  difficulty: string,
  category: string,
  question: string
): Promise<{ score: number; unnecessary: string[]; missing: string[]; explanation: string }> {
  
  const expectedConfig = EXPECTED_TOOLS[difficulty as keyof typeof EXPECTED_TOOLS] || EXPECTED_TOOLS.medium;
  
  const prompt = `You are an AI system evaluator analyzing the efficiency of tool selection for a SQL query generation task.

QUESTION: "${question}"
DIFFICULTY: ${difficulty}
CATEGORY: ${category}

TOOLS CALLED (in order):
${toolCalls.map((tool, i) => `${i + 1}. ${tool}`).join('\n')}

EXPECTED TOOLS FOR ${difficulty.toUpperCase()} DIFFICULTY:
Required: ${expectedConfig.required.join(', ')}
Optional: ${expectedConfig.optional.join(', ') || 'none'}
Discouraged: ${expectedConfig.discouraged.join(', ') || 'none'}

Evaluate the tool selection:
1. Were all required tools called?
2. Were any unnecessary tools called? (e.g., kpi_decomposition for simple aggregation)
3. Was the tool order logical?
4. Was error_correction called excessively (more than 2 times)?

Scoring Guide:
- 10/10: Perfect tool selection, no unnecessary calls
- 8-9/10: Good selection, one minor inefficiency
- 6-7/10: Acceptable but with unnecessary tools
- 4-5/10: Multiple inefficiencies or wrong order
- 0-3/10: Missing required tools or excessive errors

Return ONLY a JSON object:
{
  "score": <number 0-10>,
  "unnecessary_tools": [<list of unnecessary tool names>],
  "missing_tools": [<list of missing required tool names>],
  "explanation": "<brief explanation focusing on inefficiencies>"
}`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });

  const result = JSON.parse(response.text || '{"score": 5, "unnecessary_tools": [], "missing_tools": [], "explanation": "Failed to parse"}');
  
  return {
    score: Math.max(0, Math.min(10, result.score)),
    unnecessary: result.unnecessary_tools || [],
    missing: result.missing_tools || [],
    explanation: result.explanation || 'No explanation provided',
  };
}

/**
 * Main evaluation function for Judge #2
 */
export async function evaluateProcess(
  testQuestion: TestQuestion,
  testResult: TestResult
): Promise<ProcessEvaluation> {
  
  console.log(`\n⚖️  [Judge #2] Evaluating Test ID ${testQuestion.id}...`);
  
  // For SQL agent, evaluate tool selection
  if (testResult.agent_used === 'sql') {
    const toolCalls = testResult.tool_calls || [];
    
    if (toolCalls.length === 0) {
      return {
        tool_efficiency_score: 0,
        tools_called: [],
        unnecessary_tools: [],
        missing_tools: ['All required tools'],
        explanation: 'No tool calls captured (likely execution error)',
        passed: false,
      };
    }
    
    try {
      // Gemini-based evaluation
      const evaluation = await evaluateToolSelection(
        toolCalls,
        testQuestion.difficulty,
        testQuestion.category,
        testQuestion.question
      );
      
      return {
        tool_efficiency_score: evaluation.score,
        tools_called: toolCalls,
        unnecessary_tools: evaluation.unnecessary,
        missing_tools: evaluation.missing,
        explanation: evaluation.explanation,
        passed: evaluation.score >= 7.0,
      };
      
    } catch (error) {
      console.error(`   ❌ Judge #2 Gemini evaluation failed: ${error}`);
      
      return {
        tool_efficiency_score: 0,
        tools_called: toolCalls,
        unnecessary_tools: [],
        missing_tools: [],
        explanation: `Gemini API failed: ${error instanceof Error ? error.message : String(error)}`,
        passed: false,
      };
    }
  }
  
  // For Docking agent, simple evaluation (just check if it succeeded)
  if (testResult.agent_used === 'docking') {
    const score = testResult.success ? 9 : 3;
    
    return {
      tool_efficiency_score: score,
      tools_called: ['docking_api_call'],
      unnecessary_tools: [],
      missing_tools: testResult.success ? [] : ['successful_api_call'],
      explanation: testResult.success
        ? 'Docking agent API call successful'
        : `Docking agent call failed: ${testResult.error || 'Unknown error'}`,
      passed: score >= 7.0,
    };
  }
  
  return {
    tool_efficiency_score: 0,
    tools_called: [],
    unnecessary_tools: [],
    missing_tools: [],
    explanation: 'Unknown agent type',
    passed: false,
  };
}

