// judge-agent.ts
// State-of-the-art AI Judge for evaluating multi-agent system performance

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

interface JudgeEvaluation {
  questionId: string;
  question: string;
  
  // Routing Evaluation
  routingCorrectness: number; // 0-10 score
  routingReasoning: string;
  expectedAgents: string[];
  actualAgents: string[];
  routingMismatch: boolean;
  
  // Efficiency Evaluation
  efficiencyScore: number; // 0-10 score
  efficiencyReasoning: string;
  unnecessaryToolCalls: string[];
  optimalPath: string;
  
  // Answer Quality
  answerQualityScore: number; // 0-10 score
  answerQualityReasoning: string;
  answerCompleteness: number; // 0-10
  answerAccuracy: number; // 0-10 (if ground truth available)
  
  // SQL Quality (if applicable)
  sqlQualityScore?: number; // 0-10 score
  sqlReasoning?: string;
  sqlIssues?: string[];
  
  // Overall Assessment
  overallScore: number; // 0-10 weighted average
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
}

interface JudgeReport {
  runId: string;
  evaluationTimestamp: string;
  totalEvaluations: number;
  
  // Aggregate Metrics
  averageRoutingCorrectness: number;
  averageEfficiency: number;
  averageAnswerQuality: number;
  averageOverallScore: number;
  
  // Pattern Analysis
  commonRoutingErrors: string[];
  efficiencyBottlenecks: string[];
  frequentIssues: string[];
  
  evaluations: JudgeEvaluation[];
}

const JUDGE_SYSTEM_PROMPT = `You are an expert AI system evaluator specializing in multi-agent orchestration systems. Your task is to rigorously evaluate the performance of a router agent that coordinates between specialized agents.

**Evaluation Dimensions:**

1. **Routing Correctness (0-10)**
   - Did the router select the correct agent(s)?
   - Were agents called in the optimal order?
   - Were any necessary agents skipped?
   - Were any unnecessary agents called?

2. **Efficiency (0-10)**
   - Minimum number of tool calls to achieve the goal?
   - No redundant queries or operations?
   - Optimal use of available context?
   - Appropriate iteration count?

3. **Answer Quality (0-10)**
   - Completeness: Does it fully answer the question?
   - Accuracy: Is the information correct?
   - Clarity: Is the answer well-structured?
   - Relevance: Does it address what was asked?

4. **SQL Quality (0-10, if applicable)**
   - Correct tables and joins?
   - Efficient query structure?
   - Proper filtering and aggregation?
   - Handles edge cases?

**Scoring Guidelines:**
- 9-10: Exceptional performance, production-ready
- 7-8: Good performance, minor improvements possible
- 5-6: Acceptable but notable issues
- 3-4: Significant problems, needs improvement
- 0-2: Critical failures

**Output Format:**
Provide a structured evaluation in JSON format with scores, reasoning, and actionable recommendations.`;

async function evaluateWithJudge(trace: any): Promise<JudgeEvaluation> {
  const prompt = `
Evaluate the following multi-agent execution trace:

**Question:** ${trace.question}
**Category:** ${trace.category}
**Expected Agents:** ${trace.expectedAgents?.join(', ') || 'Not specified'}

**Execution Details:**
- Success: ${trace.success}
- Total Duration: ${trace.totalDurationMs}ms
- Total Iterations: ${trace.totalIterations}
- Agents Used: ${trace.agentsUsed.join(' → ')}

**Tool Calls (${trace.toolCalls.length}):**
${trace.toolCalls.map((tc: any, idx: number) => `
${idx + 1}. ${tc.toolName}
   Question: "${tc.question}"
   Duration: ${tc.durationMs}ms
   Result Preview: ${tc.result.substring(0, 150)}...
`).join('\n')}

**SQL Queries (if any):**
${trace.sqlQueries?.map((sql: string, idx: number) => `${idx + 1}. ${sql}`).join('\n') || 'None'}

**Final Answer:**
${trace.finalAnswer}

${trace.error ? `**Error:** ${trace.error}` : ''}

Provide a detailed evaluation with:
1. Routing correctness score (0-10) and reasoning
2. Efficiency score (0-10) and reasoning
3. Answer quality score (0-10) and reasoning
4. SQL quality score (0-10, if applicable) and reasoning
5. Overall assessment with strengths, weaknesses, and recommendations

Format your response as a JSON object matching this structure:
{
  "routingCorrectness": <score>,
  "routingReasoning": "<explanation>",
  "routingMismatch": <boolean>,
  "efficiencyScore": <score>,
  "efficiencyReasoning": "<explanation>",
  "unnecessaryToolCalls": [<list>],
  "optimalPath": "<description>",
  "answerQualityScore": <score>,
  "answerQualityReasoning": "<explanation>",
  "answerCompleteness": <score>,
  "sqlQualityScore": <score or null>,
  "sqlReasoning": "<explanation or null>",
  "sqlIssues": [<list or null>],
  "overallScore": <weighted average>,
  "strengths": [<list>],
  "weaknesses": [<list>],
  "recommendations": [<list>]
}`;

  const chat = ai.chats.create({
    model: MODEL,
    config: {
      temperature: 0.2,
      systemInstruction: JUDGE_SYSTEM_PROMPT,
    },
  });

  const response = await chat.sendMessage({ message: prompt });
  const responseText = response.text || '';
  
  // Extract JSON from response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Judge did not return valid JSON');
  }

  const judgeResponse = JSON.parse(jsonMatch[0]);

  const evaluation: JudgeEvaluation = {
    questionId: trace.questionId,
    question: trace.question,
    expectedAgents: trace.expectedAgents || [],
    actualAgents: trace.agentsUsed,
    routingCorrectness: judgeResponse.routingCorrectness || 0,
    routingReasoning: judgeResponse.routingReasoning || '',
    routingMismatch: judgeResponse.routingMismatch || false,
    efficiencyScore: judgeResponse.efficiencyScore || 0,
    efficiencyReasoning: judgeResponse.efficiencyReasoning || '',
    unnecessaryToolCalls: judgeResponse.unnecessaryToolCalls || [],
    optimalPath: judgeResponse.optimalPath || '',
    answerQualityScore: judgeResponse.answerQualityScore || 0,
    answerQualityReasoning: judgeResponse.answerQualityReasoning || '',
    answerCompleteness: judgeResponse.answerCompleteness || 0,
    answerAccuracy: judgeResponse.answerAccuracy || 0,
    sqlQualityScore: judgeResponse.sqlQualityScore,
    sqlReasoning: judgeResponse.sqlReasoning,
    sqlIssues: judgeResponse.sqlIssues,
    overallScore: judgeResponse.overallScore || 0,
    strengths: judgeResponse.strengths || [],
    weaknesses: judgeResponse.weaknesses || [],
    recommendations: judgeResponse.recommendations || []
  };

  return evaluation;
}

export async function judgeEvaluationRun(
  evaluationRunPath: string,
  outputPath?: string
): Promise<JudgeReport> {
  
  console.log('\n' + '='.repeat(100));
  console.log('STARTING JUDGE EVALUATION');
  console.log('='.repeat(100));
  console.log(`\nReading evaluation run from: ${evaluationRunPath}\n`);

  const evaluationRun = JSON.parse(fs.readFileSync(evaluationRunPath, 'utf-8'));
  
  const report: JudgeReport = {
    runId: `judge-${evaluationRun.runId}`,
    evaluationTimestamp: new Date().toISOString(),
    totalEvaluations: evaluationRun.traces.length,
    averageRoutingCorrectness: 0,
    averageEfficiency: 0,
    averageAnswerQuality: 0,
    averageOverallScore: 0,
    commonRoutingErrors: [],
    efficiencyBottlenecks: [],
    frequentIssues: [],
    evaluations: []
  };

  // Evaluate each trace
  for (let i = 0; i < evaluationRun.traces.length; i++) {
    const trace = evaluationRun.traces[i];
    
    console.log(`\nEvaluating ${i + 1}/${evaluationRun.traces.length}: ${trace.questionId}`);
    
    try {
      const evaluation = await evaluateWithJudge(trace);
      report.evaluations.push(evaluation);
      
      console.log(`  Routing: ${evaluation.routingCorrectness}/10`);
      console.log(`  Efficiency: ${evaluation.efficiencyScore}/10`);
      console.log(`  Answer Quality: ${evaluation.answerQualityScore}/10`);
      console.log(`  Overall: ${evaluation.overallScore}/10`);
      
      // Rate limiting
      if (i < evaluationRun.traces.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
    } catch (error) {
      console.error(`  ❌ Error evaluating: ${error}`);
    }
  }

  // Calculate aggregate metrics
  const totalEvals = report.evaluations.length;
  report.averageRoutingCorrectness = report.evaluations.reduce((sum, e) => sum + e.routingCorrectness, 0) / totalEvals;
  report.averageEfficiency = report.evaluations.reduce((sum, e) => sum + e.efficiencyScore, 0) / totalEvals;
  report.averageAnswerQuality = report.evaluations.reduce((sum, e) => sum + e.answerQualityScore, 0) / totalEvals;
  report.averageOverallScore = report.evaluations.reduce((sum, e) => sum + e.overallScore, 0) / totalEvals;

  // Identify common issues
  const routingMismatches = report.evaluations.filter(e => e.routingMismatch);
  const lowEfficiency = report.evaluations.filter(e => e.efficiencyScore < 7);
  const allWeaknesses = report.evaluations.flatMap(e => e.weaknesses);
  
  report.commonRoutingErrors = [...new Set(routingMismatches.map(e => e.routingReasoning))].slice(0, 5);
  report.efficiencyBottlenecks = [...new Set(lowEfficiency.map(e => e.efficiencyReasoning))].slice(0, 5);
  report.frequentIssues = [...new Set(allWeaknesses)].slice(0, 10);

  // Save report
  const finalOutputPath = outputPath || evaluationRunPath.replace('.json', '-judged.json');
  fs.writeFileSync(finalOutputPath, JSON.stringify(report, null, 2));

  console.log('\n' + '='.repeat(100));
  console.log('JUDGE EVALUATION COMPLETE');
  console.log('='.repeat(100));
  console.log(`\nReport saved to: ${finalOutputPath}`);
  console.log(`\nAggregate Scores:`);
  console.log(`  Routing Correctness: ${report.averageRoutingCorrectness.toFixed(2)}/10`);
  console.log(`  Efficiency: ${report.averageEfficiency.toFixed(2)}/10`);
  console.log(`  Answer Quality: ${report.averageAnswerQuality.toFixed(2)}/10`);
  console.log(`  Overall: ${report.averageOverallScore.toFixed(2)}/10`);
  console.log(`\nTop Issues:`);
  report.frequentIssues.slice(0, 3).forEach((issue, idx) => {
    console.log(`  ${idx + 1}. ${issue}`);
  });

  return report;
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const evaluationPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!evaluationPath) {
    console.error('Usage: npx tsx judge-agent.ts <evaluation-run.json> [output-path.json]');
    process.exit(1);
  }

  judgeEvaluationRun(evaluationPath, outputPath)
    .then(() => {
      console.log('\n✅ Judge evaluation completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Judge evaluation failed:', error);
      process.exit(1);
    });
}