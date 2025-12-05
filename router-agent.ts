// router-agent-enhanced.ts

import { GoogleGenAI, Type } from '@google/genai';
import fetch from 'node-fetch'; 
import { runOrchestrator } from '../ev-supply-chain-sql-agent/dist/agent.js'; 
import * as dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

interface DockingAgentResponse {
    answer: Array<{
        door_id: string;
        job_type: string;
        start_utc: string;
        end_utc: string;
        [key: string]: any; 
    }> | unknown;
    explanation?: string;
    [key: string]: any;
}

// --- SYSTEM PROMPT ---
const ROUTER_SYSTEM_PROMPT = `You are an intelligent routing coordinator for an EV supply chain system. Your job is to orchestrate multiple specialized agents to answer complex user queries.

**Available Agents:**

1. **docking_agent_api**: Real-time logistics data
   - Use for: Current door schedules, dock assignments, real-time status, reassignment reasons
   - Examples: "What's on door D10?", "Show Shanghai schedule", "Why was door X reassigned?"

2. **sql_orchestrator_agent**: Historical analysis & aggregations
   - Use for: Trends, counts, averages, costs, inventory levels, comparisons across time/locations
   - Examples: "Average delivery time", "Total orders last month", "Compare warehouses"

**Multi-Step Reasoning:**
- You can call agents MULTIPLE times to answer complex questions
- Break down complex queries into sub-tasks
- Combine results from different agents when needed
- If one agent's answer is insufficient, call another or refine your approach

**Decision Rules:**
- For "current/now/today" → docking_agent_api
- For "how many/average/total/trend" → sql_orchestrator_agent  
- For questions needing both real-time + historical → call both agents
- Always explain your reasoning when combining results

**Output:**
When you have enough information, provide a clear, concise final answer. If you need more data, make another tool call.`;

// --- TOOL SCHEMAS ---

const DOCKING_TOOL_SCHEMA = {
  name: "docking_agent_api",
  description: "Get real-time docking and logistics information. Use for current schedules, door status, and reassignment explanations.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: { 
        type: Type.STRING, 
        description: "Natural language question focused on real-time logistics data." 
      },
    },
    required: ["question"],
  },
};

const SQL_TOOL_SCHEMA = {
  name: "sql_orchestrator_agent",
  description: "Query database for analytical insights, historical data, aggregations, or comparisons. Use for counts, averages, trends, and multi-dimensional analysis.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: { 
        type: Type.STRING, 
        description: "Natural language question requiring database analysis." 
      },
    },
    required: ["question"],
  },
};

// --- TOOL IMPLEMENTATIONS ---

async function callDockingAgent(question: string): Promise<string> {
  const DOCKING_API_URL = "http://localhost:8088/qa";
  console.log(`\n[Router] Calling Docking Agent API with: "${question}"`);
  
  try {
    const response = await fetch(DOCKING_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
        return `Docking Agent API returned status code ${response.status} (${response.statusText}).`;
    }

    const data = await response.json() as DockingAgentResponse;
    
    // Handle array responses (schedules)
    if (Array.isArray(data.answer)) {
        const scheduleItems = data.answer.map((job: any) => {
            const doorId = job.door_id || 'Unknown';
            const jobType = job.job_type || 'Unknown';
            const refId = job.ref_id || '';
            const startTime = job.start_utc || '';
            const endTime = job.end_utc || '';
            const status = job.status || '';
            return `- ${doorId} [${jobType}] ${refId}: ${startTime} to ${endTime} (${status})`;
        }).join('\n');
        
        const explanation = data.explanation || "Schedule data";
        return `${explanation}:\n\n${scheduleItems}\n\nTotal assignments: ${data.answer.length}`;
    }
    
    // Handle single object responses
    if (data.answer && typeof data.answer === 'object') {
        const explanation = data.explanation || "Result";
        const answerStr = JSON.stringify(data.answer, null, 2);
        return `${explanation}:\n${answerStr}`;
    }
    
    // Handle simple string/number responses
    if (data.answer !== null && data.answer !== undefined) {
        const explanation = data.explanation || "Result";
        return `${explanation}: ${data.answer}`;
    }
    
    // No answer found
    return data.explanation || "No information found";

  } catch (error) {
    console.error("Docking Agent API error:", error);
    return `Docking Agent API failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function callSQLOrchestrator(question: string): Promise<string> {
  console.log(`\n[Router] Calling SQL Orchestrator Agent with: "${question}"`);
  
  try {
    const result = await runOrchestrator(question, undefined); 

    if (result.success) {
      return `${result.finalAnswer}`;
    } else {
      return `SQL Agent could not complete the query. Status: ${result.finalAnswer}. Last SQL: ${result.sql || 'N/A'}`;
    }
  } catch (error) {
    console.error("SQL Orchestrator error:", error);
    return `SQL Orchestrator failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// --- MAIN ROUTER LOGIC with MULTI-STEP SUPPORT ---

export async function runRouterAgent(
  question: string, 
  maxIterations: number = 5
): Promise<string> {
    console.log('\n' + '═'.repeat(80));
    console.log(' ROUTER AGENT: Starting Multi-Step Orchestration...');
    console.log('═'.repeat(80));
    console.log(`\nUser Question: "${question}"`);
    console.log(`Max Iterations: ${maxIterations}`);
    
    const toolFunctions: Record<string, (q: string) => Promise<string>> = {
        docking_agent_api: callDockingAgent,
        sql_orchestrator_agent: callSQLOrchestrator,
    };

    const toolSchemas = [DOCKING_TOOL_SCHEMA, SQL_TOOL_SCHEMA];

    // Suppress Gemini SDK warnings about thoughtSignature
    const originalConsoleWarn = console.warn;
    console.warn = (...args: any[]) => {
        const message = args.join(' ');
        if (!message.includes('thoughtSignature') && !message.includes('non-text parts')) {
            originalConsoleWarn.apply(console, args);
        }
    };

    try {
        let chat = ai.chats.create({
            model: MODEL,
            config: {
                tools: [{ functionDeclarations: toolSchemas }],
                temperature: 0.1,
                systemInstruction: ROUTER_SYSTEM_PROMPT,
            },
        });

        let response = await chat.sendMessage({ message: question });
        let iterationCount = 0;

        // Multi-iteration loop
        while (response.functionCalls && response.functionCalls.length > 0 && iterationCount < maxIterations) {
            iterationCount++;
            console.log(`\n[Router] Iteration ${iterationCount}/${maxIterations}`);
            
            const toolCall = response.functionCalls[0];
            const toolName = toolCall.name;
            const args = toolCall.args as { question?: string }; 

            if (!toolName || !args || !args.question) {
                console.error(`Tool call received with missing name or question argument.`);
                return `Router Error: Invalid tool call structure received from LLM.`;
            }

            const questionArgument: string = args.question; 

            if (toolFunctions.hasOwnProperty(toolName)) {
                console.log(`\n[Router] Decision: Calling ${toolName}`);
                console.log(`   Sub-question: "${questionArgument}"`);
                
                const functionResult = await toolFunctions[toolName](questionArgument);
                
                console.log(`\n[Router] ${toolName} returned:`);
                console.log(`   ${functionResult.substring(0, 300)}${functionResult.length > 300 ? '...' : ''}`);
                
                // Send result back to LLM for next decision
                response = await chat.sendMessage({
                    message: {
                        functionResponse: {
                            name: toolName,
                            response: { result: functionResult }, 
                        },
                    },
                });
            } else {
                return `Router Error: Unknown tool called: ${toolName}`;
            }
        }

        // Check if we hit iteration limit
        if (iterationCount >= maxIterations && response.functionCalls && response.functionCalls.length > 0) {
            console.warn(`\n[Router] Hit max iterations (${maxIterations}). Forcing completion.`);
        }
        
        // Extract text from response, handling non-text parts
        let finalAnswer = "";
        if (response.text) {
            finalAnswer = response.text;
        } else if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts) {
                // Concatenate all text parts
                finalAnswer = candidate.content.parts
                    .filter((part: any) => part.text)
                    .map((part: any) => part.text)
                    .join('\n');
            }
        }
        
        if (!finalAnswer) {
            finalAnswer = "Could not generate a final text answer.";
        }

        console.log('\n' + '═'.repeat(80));
        console.log(` FINAL ANSWER (after ${iterationCount} tool calls)`);
        console.log('═'.repeat(80));

        return finalAnswer;
    } finally {
        // Restore original console.warn
        console.warn = originalConsoleWarn;
    }
}

// Each query is independent - no conversation history maintained

// ----------------------------------------------------------------------
// DEMO EXECUTION
// ----------------------------------------------------------------------

const ROUTER_DEMO_QUERIES = [
  'How many inbound shipments are there at Fremont CA?', 
  'Why was door FCX-D10 reassigned and how many times has this happened this month?', // Multi-step!
  'What is the average order to deliver time per warehouse for battery components, and which warehouse is currently handling the most shipments?', // Requires both agents!
];

// --- MODIFIED BLOCK STARTS HERE ---
if (import.meta.url === `file://${process.argv[1]}`) {
// Use a hardcoded question for a single test run, e.g., the multi-step one
const singleTestQuestion = ROUTER_DEMO_QUERIES[0]; 

console.log('\n' + '█'.repeat(80));
console.log(' SINGLE TEST RUN: Starting Orchestration for a specific question.');
console.log('█'.repeat(80));

runRouterAgent(singleTestQuestion, 5)
  .then(result => {
    console.log(`\nFinal Response:\n${result}`);
  })
  .catch(console.error);
}