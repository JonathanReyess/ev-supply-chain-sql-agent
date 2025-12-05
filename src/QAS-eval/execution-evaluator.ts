/**
 * Execution Evaluator - Data-level correctness validation
 */

/**
 * Compare two numeric values with tolerance for floating point
 */
function compareNumbers(actual: number, expected: number, tolerance = 0.01): boolean {
    if (!isFinite(actual) || !isFinite(expected)) {
        return actual === expected;
    }
    return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1) < tolerance;
}

/**
 * Normalize result for comparison
 */
function normalizeForComparison(result: any): any {
    if (result === null || result === undefined) return null;

    // Handle 1x1 arrays
    if (Array.isArray(result) && result.length === 1) {
        if (typeof result[0] === 'object' && result[0] !== null) {
            const keys = Object.keys(result[0]);
            if (keys.length === 1) {
                return result[0][keys[0]];
            }
        }
    }

    return result;
}

/**
 * Compare table results (arrays of objects)
 */
function compareTables(
    actualResults: any[],
    expectedResults: any[]
): { score: number; explanation: string } {

    if (!Array.isArray(actualResults) || !Array.isArray(expectedResults)) {
        return {
            score: 0.0,
            explanation: 'Results are not in table format',
        };
    }

    // Empty table cases
    if (expectedResults.length === 0 && actualResults.length === 0) {
        return {
            score: 1.0,
            explanation: 'Both tables empty (correct)',
        };
    }

    if (expectedResults.length === 0 || actualResults.length === 0) {
        return {
            score: 0.3,
            explanation: `Row count mismatch: expected ${expectedResults.length}, got ${actualResults.length}`,
        };
    }

    // Check row counts
    const rowCountMatch = actualResults.length === expectedResults.length;
    let rowScore = rowCountMatch ? 1.0 : 0.5;

    // Check column names (from first row)
    const expectedCols = Object.keys(expectedResults[0]).sort();
    const actualCols = Object.keys(actualResults[0]).sort();
    const colMatch = JSON.stringify(expectedCols) === JSON.stringify(actualCols);
    let colScore = colMatch ? 1.0 : 0.5;

    // Sample data comparison (first 3 rows)
    let dataScore = 0.0;
    const sampleSize = Math.min(3, expectedResults.length, actualResults.length);
    let matchedRows = 0;

    for (let i = 0; i < sampleSize; i++) {
        const expectedRow = expectedResults[i];
        const actualRow = actualResults[i];

        let cellMatches = 0;
        let totalCells = 0;

        for (const col of expectedCols) {
            totalCells++;
            const expectedVal = expectedRow[col];
            const actualVal = actualRow[col];

            // Compare values
            if (typeof expectedVal === 'number' && typeof actualVal === 'number') {
                if (compareNumbers(actualVal, expectedVal)) {
                    cellMatches++;
                }
            } else if (expectedVal === actualVal) {
                cellMatches++;
            } else if (String(expectedVal) === String(actualVal)) {
                cellMatches++;
            }
        }

        if (totalCells > 0 && cellMatches / totalCells > 0.8) {
            matchedRows++;
        }
    }

    dataScore = sampleSize > 0 ? matchedRows / sampleSize : 0;

    // Weighted combination
    const finalScore = (rowScore * 0.3) + (colScore * 0.3) + (dataScore * 0.4);

    let explanation = `Table comparison: ${actualResults.length} rows (expected ${expectedResults.length}), `;
    explanation += `columns ${colMatch ? 'match' : 'differ'}, `;
    explanation += `data ${Math.round(dataScore * 100)}% match in sample`;

    return {
        score: Math.max(0.0, Math.min(1.0, finalScore)),
        explanation,
    };
}

/**
 * Evaluate execution similarity - compare actual results with expected results
 * Returns score 0.0-1.0 and explanation
 */
export function evaluateExecutionSimilarity(
    actualResults: any,
    expectedResults: any,
    expectedType: string,
    success: boolean
): { score: number; explanation: string } {

    // If query failed to execute
    if (!success) {
        return {
            score: 0.0,
            explanation: 'Query execution failed',
        };
    }

    // If no expected results available (fallback for questions without ground truth)
    if (expectedResults === null || expectedResults === undefined) {
        return {
            score: success ? 1.0 : 0.0,
            explanation: success
                ? 'Query executed successfully (no ground truth for comparison)'
                : 'Query failed',
        };
    }

    // Normalize results
    const normalizedActual = normalizeForComparison(actualResults);
    const normalizedExpected = normalizeForComparison(expectedResults);

    // Type-specific comparison
    switch (expectedType) {
        case 'number':
        case 'kpi': {
            const actualNum = typeof normalizedActual === 'number'
                ? normalizedActual
                : parseFloat(String(normalizedActual));
            const expectedNum = typeof normalizedExpected === 'number'
                ? normalizedExpected
                : parseFloat(String(normalizedExpected));

            if (isNaN(actualNum) || isNaN(expectedNum)) {
                return {
                    score: 0.0,
                    explanation: 'Non-numeric results cannot be compared',
                };
            }

            const matches = compareNumbers(actualNum, expectedNum);
            return {
                score: matches ? 1.0 : 0.0,
                explanation: matches
                    ? `Numeric match: ${actualNum} ≈ ${expectedNum}`
                    : `Numeric mismatch: got ${actualNum}, expected ${expectedNum}`,
            };
        }

        case 'table':
            return compareTables(actualResults, expectedResults);

        case 'boolean': {
            const actualBool = String(normalizedActual).toLowerCase();
            const expectedBool = String(normalizedExpected).toLowerCase();

            // Normalize boolean representations
            const toBool = (val: string) => {
                if (['true', 'yes', '1'].includes(val)) return 'true';
                if (['false', 'no', '0'].includes(val)) return 'false';
                return val;
            };

            const match = toBool(actualBool) === toBool(expectedBool);
            return {
                score: match ? 1.0 : 0.0,
                explanation: match
                    ? 'Boolean values match'
                    : `Boolean mismatch: got ${actualBool}, expected ${expectedBool}`,
            };
        }

        case 'list':
        case 'schedule':
            if (Array.isArray(actualResults) && Array.isArray(expectedResults)) {
                return compareTables(actualResults, expectedResults);
            }
            return {
                score: 0.3,
                explanation: 'Results not in expected list format for comparison',
            };

        default:
            // Generic comparison - just check if something was returned
            const hasResult = normalizedActual !== null && normalizedActual !== undefined;
            return {
                score: hasResult ? 0.7 : 0.0,
                explanation: hasResult
                    ? `Result returned but type '${expectedType}' comparison not implemented`
                    : 'No result to compare',
            };
    }
}
