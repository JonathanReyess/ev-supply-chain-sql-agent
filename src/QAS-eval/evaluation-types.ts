/**
 * TypeScript interfaces for QAS (Query Affinity Score) Evaluation System
 */

// Test question structure from test_questions_answers.json
export interface TestQuestion {
  id: number;
  question: string;
  agent: 'sql' | 'docking';
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  expected_sql?: string;
  expected_answer_type: string;
  tables_involved: string[];
  expected_api?: string;
  expected_results?: any; // Ground-truth data for execution similarity scoring
}

// Raw test execution result
export interface TestResult {
  test_id: number;
  question: string;
  agent_used: 'sql' | 'docking';
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;

  // SQL agent specific
  generated_sql?: string;
  results?: any[];
  row_count?: number;
  tool_calls?: string[];
  iterations?: number;

  // Docking agent specific
  docking_answer?: any;
  docking_explanation?: string;

  // Common
  final_answer?: string;
  execution_time_ms?: number;
  success: boolean;
  error?: string;
}

// QAS Evaluation breakdown
export interface QASBreakdown {
  semantic_explanation: string;
  execution_explanation: string;
  datatype_explanation: string;
}

// QAS Evaluation result
export interface QASEvaluation {
  semantic_score: number;        // 0.0-1.0
  execution_score: number;       // 0.0-1.0
  datatype_score: number;        // 0.0-1.0
  final_score: number;           // 0.0-1.0 (weighted combination)
  passed: boolean;               // >= 0.7
  breakdown: QASBreakdown;
}

// Combined evaluation result (one per question)
export interface EvaluationResult {
  test_id: number;
  question: string;
  agent_used: 'sql' | 'docking';
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
  expected_sql?: string;
  generated_sql?: string;
  expected_results?: any;
  actual_results?: any;

  qas_evaluation: QASEvaluation;
}

// Configuration for QAS weights
export interface QASWeights {
  semantic: number;    // Default: 0.40
  execution: number;   // Default: 0.40
  datatype: number;    // Default: 0.20
}
