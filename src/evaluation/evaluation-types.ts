/**
 * TypeScript interfaces for Judge AI Evaluation System
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

// Judge #1: Output Evaluator scores
export interface OutputEvaluation {
  sql_correctness_score?: number;  // 0-10 (SQL only)
  results_accuracy_score?: number; // 0-10
  answer_correctness_score?: number; // 0-10 (Docking only)
  data_completeness_score?: number;  // 0-10 (Docking only)
  overall_score: number; // 0-10
  explanation: string;
  passed: boolean; // >= 7/10
}

// Judge #2: Process Evaluator scores
export interface ProcessEvaluation {
  tool_efficiency_score: number; // 0-10
  tools_called: string[];
  unnecessary_tools: string[];
  missing_tools: string[];
  explanation: string;
  passed: boolean; // >= 7/10
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
  
  judge_output: OutputEvaluation;
  judge_process: ProcessEvaluation;
}

