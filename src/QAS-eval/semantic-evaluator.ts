/**
 * Semantic Evaluator - LLM-based SQL similarity comparison
 */

import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Evaluate semantic similarity between generated and expected SQL
 * Returns score 0.0-1.0 and explanation
 */
export async function evaluateSemanticSimilarity(
    generatedSQL: string,
    expectedSQL: string,
    question: string
): Promise<{ score: number; explanation: string }> {

    // Handle missing SQL cases
    if (!generatedSQL || !expectedSQL) {
        return {
            score: 0.0,
            explanation: generatedSQL ? 'No expected SQL for comparison' : 'No SQL was generated',
        };
    }

    const prompt = `You are a SQL expert evaluating semantic equivalence between two SQL queries.

USER QUESTION: "${question}"

EXPECTED SQL:
\`\`\`sql
${expectedSQL}
\`\`\`

GENERATED SQL:
\`\`\`sql
${generatedSQL}
\`\`\`

Evaluate whether the GENERATED SQL is semantically equivalent to the EXPECTED SQL.

Consider:
1. Do both queries produce the same results?
2. Are table joins logically correct?
3. Are WHERE conditions equivalent (allowing for different syntax)?
4. Are aggregations and GROUP BY clauses correct?
5. Minor differences in aliases, column order, or syntax style are acceptable if results match.

Scoring (return as 0.0-1.0 decimal):
- 1.0: Exact match or semantically identical
- 0.8-0.9: Achieves same result with slightly different approach (e.g., different join order)
- 0.6-0.7: Mostly correct but minor issues (e.g., missing LOWER() for case-insensitive comparison)
- 0.4-0.5: Partially correct (correct tables but wrong filters or aggregations)
- 0.0-0.3: Wrong approach or major errors

Return ONLY a JSON object:
{
  "score": <decimal between 0.0 and 1.0>,
  "explanation": "<brief explanation of score>"
}`;

    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: prompt,
            config: {
                temperature: 0.1,
                responseMimeType: 'application/json',
            },
        });

        const result = JSON.parse(response.text || '{"score": 0.0, "explanation": "Failed to parse"}');

        return {
            score: Math.max(0.0, Math.min(1.0, result.score)),
            explanation: result.explanation || 'No explanation provided',
        };

    } catch (error) {
        console.error(`  ❌ Semantic evaluation failed: ${error}`);
        return {
            score: 0.0,
            explanation: `LLM evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
