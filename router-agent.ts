// router-agent.ts

import { GoogleGenAI, Type } from '@google/genai';
import fetch from 'node-fetch'; 
import { runOrchestrator } from '../ev-supply-chain-sql-agent/dist/agent.js'; 
import * as dotenv from 'dotenv';

dotenv.config();

// Initialize GoogleGenAI
const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// 🚨 NEW INTERFACE for Type Safety 🚨
interface DockingAgentResponse {
    answer: Array<{
        door_id: string;
        job_type: string;
        start_utc: string;
        end_utc: string;
        [key: string]: any; 
    }> | unknown; // Allow 'answer' to be unknown if it's missing or malformed
    explanation?: string;
    [key: string]: any; // Allow other properties
}

// --- TOOL SCHEMAS for the ROUTER AGENT ---

const DOCKING_TOOL_SCHEMA = {
  name: "docking_agent_api",
  description: "Use this tool to get real-time docking and logistics information from the API server. This is suitable for questions about door schedules, reassignments, or direct location/door status. ONLY use this for real-time schedule questions.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING, description: "The user's original natural language question." },
    },
    required: ["question"],
  },
};

const SQL_TOOL_SCHEMA = {
  name: "sql_orchestrator_agent",
  description: "Use this tool to answer complex analytical, historical, aggregated, or comparative questions that require database queries. This is suitable for questions involving counts, averages, totals, costs, inventory levels, or multi-step analysis.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING, description: "The user's original natural language question." },
    },
    required: ["question"],
  },
};

// --- TOOL IMPLEMENTATIONS ---

async function callDockingAgent(question: string): Promise<string> {
  const DOCKING_API_URL = "http://localhost:8088/qa";
  console.log(`\n📦 [Router] Calling Docking Agent API with: "${question}"`);
  
  try {
    const response = await fetch(DOCKING_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
        return `Docking Agent API returned status code ${response.status} (${response.statusText}).`;
    }

    // 🚨 FIX APPLIED for Error 2322: Assert the type
    const data = await response.json() as DockingAgentResponse;
    
    // 🛡️ Use a safe check to ensure data.answer is a mappable array
    const answer = Array.isArray(data.answer) 
        ? data.answer.map((job: any) => 
            `${job.door_id} (${job.job_type}): ${job.start_utc} - ${job.end_utc}`
          ).join('; ')
        : "No schedule information found in the API response."; 
    
    const explanation = data.explanation || "Schedule data.";

    return `Docking Agent successfully retrieved the schedule (${explanation}): ${answer.substring(0, 500)}...`;

  } catch (error) {
    console.error("Docking Agent API error:", error);
    return `Docking Agent API failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function callSQLOrchestrator(question: string): Promise<string> {
  console.log(`\n⚙️ [Router] Calling SQL Orchestrator Agent with: "${question}"`);
  
  try {
    // Pass 'undefined' for the optional contextHistory argument
    const result = await runOrchestrator(question, undefined); 

    if (result.success) {
      return `SQL Agent successfully answered: ${result.finalAnswer}`;
    } else {
      return `SQL Agent failed to complete the query. Final Answer Status: ${result.finalAnswer}. Last SQL: ${result.sql || 'N/A'}`;
    }
  } catch (error) {
    console.error("SQL Orchestrator error:", error);
    return `SQL Orchestrator failed completely due to a code error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// --- MAIN ROUTER LOGIC ---

export async function runRouterAgent(question: string): Promise<string> {
    console.log('\n' + '═'.repeat(80));
    console.log(' ✨ ROUTER AGENT: Starting Query...');
    console.log('═'.repeat(80));
    console.log(`\nUser Question: "${question}"`);
    
    const toolFunctions: Record<string, (q: string) => Promise<string>> = {
        docking_agent_api: callDockingAgent,
        sql_orchestrator_agent: callSQLOrchestrator,
    };

    const toolSchemas = [DOCKING_TOOL_SCHEMA, SQL_TOOL_SCHEMA];

    let chat = ai.chats.create({
        model: MODEL,
        config: {
            tools: [{ functionDeclarations: toolSchemas }],
            temperature: 0.1, 
        },
    });

    let response = await chat.sendMessage({ message: question });

    while (response.functionCalls && response.functionCalls.length > 0) {
        const toolCall = response.functionCalls[0];
        
        // 🚨 FIX APPLIED for Errors 2345, 2538: Check for required properties explicitly
        const toolName = toolCall.name;
        // Assert args exists and minimally contains 'question'
        const args = toolCall.args as { question?: string }; 

        if (!toolName || !args || !args.question) {
            console.error(`Tool call received with missing name or question argument.`);
            return `Router Error: Invalid tool call structure received from LLM.`;
        }

        const questionArgument: string = args.question; 

        if (toolFunctions.hasOwnProperty(toolName)) {
            console.log(`\n➡️ [Router] Decision: Calling ${toolName} with question: "${questionArgument}"`);
            
            const functionResult = await toolFunctions[toolName](questionArgument);
            
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
    
    const finalAnswer = response.text || "Could not generate a final text answer.";

    console.log('\n' + '═'.repeat(80));
    console.log(' ✅ FINAL ANSWER from Router');
    console.log('═'.repeat(80));

    return finalAnswer;
}

// ----------------------------------------------------------------------
// DEMO EXECUTION (for standalone testing)
// ----------------------------------------------------------------------

const ROUTER_DEMO_QUERIES = [
    'What is the schedule for Shanghai doors?', 
    'How many inbound at Fremont CA?', 
    'Why was door FCX-D10 reassigned?', 
    'What is the average order to deliver time per warehouse across all battery components?', 
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const questionIndex = process.argv[2] ? parseInt(process.argv[2]) : 0;
  const question = ROUTER_DEMO_QUERIES[questionIndex] || ROUTER_DEMO_QUERIES[0];

  runRouterAgent(question)
    .then(result => {
      console.log(`\nFinal Response: ${result}`);
    })
    .catch(console.error);
}