# EV Supply Chain SQL-of-Thought Agent

## Project Purpose

This project implements the **SQL-of-Thought** multi-agent framework to reliably convert complex natural language questions into executable SQL queries against a structured database.


It is based on the paper **[“SQL-of-Thought: Multi-agentic Text-to-SQL with Guided Error Correction”](https://arxiv.org/html/2509.00581v1)**. 

---

## Core Components

The agent pipeline performs the following steps:

1. **Schema Linking:** Identifies necessary tables and columns.  
2. **Query Planning (Chain-of-Thought):** Breaks the request into logical SQL steps.  
3. **SQL Generation:** Creates the initial SQL query.  
4. **Execution & Correction Loop:** Executes the query against the local database (DuckDB/SQLite). If an error occurs, a specialized correction agent diagnoses the error based on an error taxonomy and rewrites the SQL.

---

## Technology Stack

* **Language:** TypeScript  
* **LLM Provider:** Google Gemini API (`gemini-2.5-flash`)  
* **Database:** DuckDB (used to query local SQLite file)

---

## Getting Started (Local Setup)

To run this project on your machine, follow these steps:

### 1. Prerequisites

* Node.js (v18+)  
* Python (v3.8+ to regenerate data)  
* A valid **Gemini API Key**

---

### 2. Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/JonathanReyess/ev-supply-chain-sql-agent.git
   cd ev-supply-chain-sql-agent
   ```

2. **Install dependencies:**
   ```bash
   # Install Node.js packages
   npm install

   # Install Python dependencies to regenerate data
   pip install requirements.txt
   ```

3. **Configure API Key:**
   Create a file named **.env** in the root directory and add your Gemini API key:
   ```env
   GEMINI_API_KEY=AIzaSy...YOUR_SECRET_KEY...
   ```

4. **Generate Database:**
   If you need to regenerate the synthetic EV supply chain dataset (10 tables: suppliers, components, inventory, etc.), run:
   ```bash
   python generate_data.py
   ```
   *This creates the `ev_supply_chain.db` file in the `./data` directory.*

---

## Running the Agent

You can run predefined demo queries that showcase the multi-agent reasoning pipeline.

| Index | Command | Query Description |
| :---: | :--- | :--- |
| **0** | `npm start` | Simple (Supplier details) |
| **1** | `npm start 1` | Medium (Battery stock aggregation) |
| **2** | `npm start 2` | Complex (Delayed PO analysis) |

**Example:**
```bash
npm start 1
```

---

## Build and Execution Workflow

If you encounter `ts-node` or runtime errors, use the **compile-then-run** workflow.  
This ensures stable execution by first compiling TypeScript into JavaScript, then running the compiled agent.

### 1. Run the Build

This step uses the TypeScript Compiler (`tsc`) to read your source files (`src/*.ts`) and generate runnable JavaScript inside the `dist/` directory.

```bash
npm run build
```

*Expected behavior:*  
The build process should complete without errors and create the `dist/` folder.

---

### 2. Execute the Agent

Once the build is complete, you can run the agent using the compiled JavaScript output.

```bash
npm start
```

By default, this runs the first demo query (index **0**).  
You can also specify a query index to execute a different scenario:

```bash
npm start 1
```

---

### Expected Output Flow

During execution, the console will display a detailed process log showing:

1. **Schema Loading and Validation**  
   The database schema is read from your local SQLite/DuckDB instance.

2. **Gemini API Calls**  
   The agent performs schema linking, subproblem identification, and query planning using the Gemini API.

3. **SQL Generation and Execution**  
   The agent generates, executes, and (if needed) automatically corrects SQL queries against your database.

---

*Example successful run output snippet:*

```text
[Agent] Loading schema from ./data/ev_supply_chain.db
[Planner] Identified 3 relevant tables: suppliers, components, inventory
[LLM] Generated initial SQL plan...
[Executor] Query executed successfully. Rows returned: 25
```

---

## Directory Structure

```bash
ev-supply-chain-sql-agent/
│
├── src/                     # Core TypeScript source code
│   ├── agents/              # Sub-agents (planner, executor, corrector)
│   ├── utils/               # Helper utilities
│   └── index.ts             # Main pipeline entry point
│
├── data/
│   └── ev_supply_chain.db   # Local SQLite database
│
├── generate_data.py         # Python script to create synthetic tables
├── package.json
├── tsconfig.json
├── requirements.txt
├── .env                     # API key (not committed)
└── README.md
```

---

## License

This project is distributed under the **MIT License**.  
You are free to modify, distribute, and use it for research or production purposes.

