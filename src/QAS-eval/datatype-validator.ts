/**
 * Data Type Validator - Flexible type checking with normalization
 */

/**
 * Normalize result based on expected answer type
 * Handles edge cases like 1x1 DataFrame → number conversion
 */
function normalizeResult(result: any, expectedType: string): any {
    if (result === null || result === undefined) {
        return null;
    }

    // Handle arrays (potential DataFrame results)
    if (Array.isArray(result)) {
        // 1x1 array of objects (DataFrame with single cell)
        if (result.length === 1 && typeof result[0] === 'object' && result[0] !== null) {
            const keys = Object.keys(result[0]);
            if (keys.length === 1 && (expectedType === 'number' || expectedType === 'kpi')) {
                // Extract the single value
                return result[0][keys[0]];
            }
        }
    }

    return result;
}

/**
 * Validate data type matches expected type with flexible normalization
 * Returns 1.0 for valid, 0.0 for invalid
 */
export function validateDataType(
    result: any,
    expectedType: string
): { score: number; explanation: string } {

    // Check if result exists
    if (result === null || result === undefined) {
        return {
            score: 0.0,
            explanation: 'No result returned',
        };
    }

    // Check for error strings
    if (typeof result === 'string' && result.toLowerCase().includes('error')) {
        return {
            score: 0.0,
            explanation: `Result is an error: ${result}`,
        };
    }

    // Normalize the result
    const normalized = normalizeResult(result, expectedType);

    // Type-specific validation
    switch (expectedType) {
        case 'number':
        case 'kpi':
            if (typeof normalized === 'number' || typeof normalized === 'bigint') {
                return {
                    score: 1.0,
                    explanation: 'Valid numeric value',
                };
            }
            // Try parsing string as number
            if (typeof normalized === 'string') {
                const parsed = parseFloat(normalized);
                if (!isNaN(parsed)) {
                    return {
                        score: 1.0,
                        explanation: 'Valid numeric string (parseable)',
                    };
                }
            }
            // Check if still wrapped in array/object
            if (Array.isArray(normalized) && normalized.length === 1) {
                return {
                    score: 0.5,
                    explanation: 'Numeric value wrapped in array (format issue)',
                };
            }
            return {
                score: 0.0,
                explanation: `Expected number, got ${typeof normalized}`,
            };

        case 'table':
            // Should be an array of objects
            if (Array.isArray(result)) {
                if (result.length === 0) {
                    return {
                        score: 0.5,
                        explanation: 'Empty table (may be correct if no data matches)',
                    };
                }
                if (typeof result[0] === 'object' && result[0] !== null) {
                    return {
                        score: 1.0,
                        explanation: `Valid table with ${result.length} rows`,
                    };
                }
            }
            return {
                score: 0.0,
                explanation: `Expected table (array of objects), got ${typeof result}`,
            };

        case 'boolean':
            if (typeof normalized === 'boolean') {
                return {
                    score: 1.0,
                    explanation: 'Valid boolean value',
                };
            }
            // Check for string representations
            if (typeof normalized === 'string') {
                const lower = normalized.toLowerCase();
                if (['yes', 'no', 'true', 'false', '0', '1'].includes(lower)) {
                    return {
                        score: 1.0,
                        explanation: 'Valid boolean string representation',
                    };
                }
            }
            return {
                score: 0.0,
                explanation: `Expected boolean, got ${typeof normalized}`,
            };

        case 'list':
        case 'schedule':
            if (Array.isArray(result)) {
                return {
                    score: 1.0,
                    explanation: `Valid list with ${result.length} items`,
                };
            }
            return {
                score: 0.0,
                explanation: `Expected list/array, got ${typeof result}`,
            };

        case 'analysis':
        case 'plan':
        case 'optimization_plan':
            // These can be objects or structured strings
            if (typeof result === 'object' && result !== null) {
                return {
                    score: 1.0,
                    explanation: 'Valid structured analysis/plan object',
                };
            }
            if (typeof result === 'string' && result.length > 10) {
                return {
                    score: 0.8,
                    explanation: 'Valid analysis/plan as text (not structured object)',
                };
            }
            return {
                score: 0.0,
                explanation: `Expected analysis/plan object, got ${typeof result}`,
            };

        default:
            // Unknown type - just check if something was returned
            return {
                score: 0.7,
                explanation: `Result returned but type '${expectedType}' not explicitly validated`,
            };
    }
}
