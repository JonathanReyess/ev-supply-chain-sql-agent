# 🚀 Quick Start Guide

Get the EV Supply Chain SQL Agent running in 5 minutes.

---

## Prerequisites

- Python 3.8 or higher
- pip (Python package manager)
- Gemini API key

---

## Step 1: Get Gemini API Key

1. Visit https://makersuite.google.com/app/apikey
2. Click "Create API Key"
3. Copy your key (starts with `AIza...`)

---

## Step 2: Clone & Setup

### Option A: Automated Setup (Recommended)

```bash
cd ev-supply-chain-sql-agent
./setup_gemini.sh
```

The script will:
- ✅ Check dependencies
- ✅ Create `.env` file
- ✅ Prompt for API key
- ✅ Install Python packages
- ✅ Initialize database
- ✅ Verify setup

### Option B: Manual Setup

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Edit .env and add your API key
nano .env
# Change: GOOGLE_API_KEY=your_api_key_here

# 3. Install dependencies
pip install -r docking_agent/requirements.txt
pip install google-generativeai

# 4. Load environment variables
export $(cat .env | xargs)

# 5. Initialize database
python -m docking_agent.run_migrations

# 6. Generate sample data (optional)
python generate_data.py
python -m docking_agent.seed_events
```

---

## Step 3: Start the Server

```bash
uvicorn docking_agent.api:app --reload --port 8088
```

You should see:
```
INFO:     Uvicorn running on http://127.0.0.1:8088
INFO:     Application startup complete.
```

✅ **Server is running!**

---

## Step 4: Test Queries

Open a new terminal and try these examples:

### Test 1: Door Schedule
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the door schedule at Fremont?"}'
```

Expected response:
```json
{
  "answer": "Found 5 door assignments at Fremont...",
  "intent": "door_schedule",
  "results": [...]
}
```

### Test 2: Count Query
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "How many inbound trucks at Shanghai?"}'
```

### Test 3: Event Analysis
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Why was door 4 reassigned?"}'
```

### Test 4: Component Query
```bash
curl -X POST http://localhost:8088/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Show me battery inventory at Austin"}'
```

---

## Step 5: View API Documentation

Open your browser and visit:

**http://localhost:8088/docs**

This opens Swagger UI where you can:
- 📖 See all available endpoints
- 🧪 Test queries interactively
- 📋 View request/response schemas

---

## Step 6: Try the Web UI (Optional)

1. Open `frontend/index.html` in your browser
2. Make sure the API is running on port 8088
3. Type natural language queries
4. View results and charts

---

## Step 7: Run Evaluations

### Make Test Calls
```bash
# Make a few queries first
for i in {1..5}; do
  curl -X POST http://localhost:8088/qa \
    -H "Content-Type: application/json" \
    -d '{"question": "Show me doors at Fremont"}'
  sleep 1
done
```

### Trigger Evaluation
```bash
# Evaluate via API
curl -X POST "http://localhost:8088/analysis/eval?limit=10"

# Or run directly
python -m docking_agent.eval_agent_gemini 10
```

### View Results
```bash
# Get statistics
curl http://localhost:8088/analysis/eval/stats | python -m json.tool

# Get recent evaluations
curl "http://localhost:8088/analysis/eval/recent?limit=5" | python -m json.tool
```

---

## ✅ Verification Checklist

- [ ] Gemini API key obtained
- [ ] Dependencies installed
- [ ] `.env` file configured
- [ ] Database initialized
- [ ] Server starts without errors
- [ ] Test queries return results
- [ ] Swagger UI loads at `/docs`
- [ ] Evaluations run successfully

---

## 🎯 What You Can Ask

### Location-Based Queries
- "What's happening at Shanghai?"
- "Show me Fremont doors"
- "How many active doors at Austin?"

### Count Queries
- "How many inbound trucks at Shanghai?"
- "Count outbound loads at Fremont"
- "How many doors are available?"

### Event Queries
- "Why was door 4 reassigned?"
- "What caused the reassignment at FCX-D10?"
- "Tell me about door changes at Berlin"

### Component Queries
- "Show me battery inventory"
- "What's the earliest ETA for motors?"
- "Which suppliers provide semiconductors?"

### Status Queries
- "What doors are available?"
- "Show me active assignments"
- "What's the status at Austin?"

---

## 🐛 Troubleshooting

### Problem: "No Gemini API key found"
```bash
# Check if key is set
echo $GOOGLE_API_KEY

# If empty, reload environment
export $(cat .env | xargs)

# Verify
echo $GOOGLE_API_KEY
```

### Problem: "Module not found: google.generativeai"
```bash
pip install google-generativeai
```

### Problem: "Unable to open database file"
```bash
# Initialize database
python -m docking_agent.run_migrations

# Generate sample data
python generate_data.py
```

### Problem: "Connection refused" on API calls
```bash
# Make sure server is running
ps aux | grep uvicorn

# Check port 8088 is not in use
lsof -i :8088

# Restart server
uvicorn docking_agent.api:app --reload --port 8088
```

### Problem: "LLM Router returns 'unknown' intent"
```bash
# Check configuration
echo $USE_LLM_ROUTER    # Should be: true
echo $LLM_PROVIDER      # Should be: gemini

# Enable debug mode
export DEBUG_LLM_ROUTER=true

# Restart server and check logs
```

### Problem: "Rate limit exceeded"
```bash
# You hit Gemini API rate limit
# Wait 1 minute or upgrade to paid tier
# Free tier: 60 requests/minute
```

### Problem: Empty responses
```bash
# Check if database has data
sqlite3 data/ev_supply_chain.db "SELECT COUNT(*) FROM dock_assignments"

# If zero, generate data
python generate_data.py
python -m docking_agent.seed_events
```

---

## 💡 Pro Tips

### 1. Keep Server Running
Use `screen` or `tmux` to keep the server running:
```bash
screen -S api
uvicorn docking_agent.api:app --reload --port 8088
# Press Ctrl+A then D to detach
# screen -r api to reattach
```

### 2. Enable Debug Mode
See detailed LLM routing decisions:
```bash
export DEBUG_LLM_ROUTER=true
```

### 3. Monitor API Usage
Track your Gemini usage at:
https://console.cloud.google.com/apis/dashboard

### 4. Automated Evaluation
Set up hourly evaluation:
```bash
# Add to crontab
0 * * * * cd /path/to/repo && python -m docking_agent.eval_agent_gemini 50
```

### 5. Use the Frontend
The web UI (`frontend/index.html`) is easier for exploration:
- Visual query builder
- Chart generation
- Export results to CSV

### 6. Query History
Check recent queries:
```bash
sqlite3 data/ev_supply_chain.db \
  "SELECT user_question, router_intent, created_utc 
   FROM agent_call_logs 
   ORDER BY created_utc DESC 
   LIMIT 10"
```

---

## 📊 Example Queries with Expected Results

### Query: "How many inbound at Fremont?"
```json
{
  "answer": "There are 8 inbound trucks at Fremont CA",
  "count": 8,
  "intent": "count_schedule",
  "location": "Fremont CA"
}
```

### Query: "Why was door 4 reassigned?"
```json
{
  "answer": "Door 4 was reassigned due to priority_change...",
  "events": [
    {
      "event_type": "reassigned",
      "reason": "priority_change",
      "context": {...}
    }
  ]
}
```

### Query: "Show me battery inventory"
```json
{
  "answer": "Found 3 battery components in inventory...",
  "results": [
    {
      "component_name": "LFP Battery",
      "quantity": 1500,
      "warehouse": "Fremont CA"
    }
  ]
}
```

---

## 🚀 Next Steps

### Learn More
- 📖 Read full documentation: `README.md`
- 🎯 Understand architecture: See Architecture section in README
- 🧪 Run test suite: `pytest docking_agent/test_advanced.py`

### Customize
- Add new intents in `docking_agent/llm_router.py`
- Add new handlers in `docking_agent/query_handlers.py`
- Modify prompts for your use case

### Production
- Set up monitoring dashboard
- Configure automated evaluations
- Add rate limiting
- Set up database backups

### Integrate
- Connect to your existing databases
- Customize schema for your data
- Add authentication/authorization
- Deploy to production infrastructure

---

## 📞 Need Help?

### Resources
- **API Docs**: http://localhost:8088/docs
- **Gemini Docs**: https://ai.google.dev/docs
- **API Keys**: https://makersuite.google.com/app/apikey

### Quick Commands
```bash
# View logs
tail -f logs/api.log

# Check database
sqlite3 data/ev_supply_chain.db

# Restart server
pkill -f uvicorn
uvicorn docking_agent.api:app --reload --port 8088

# Test setup
python test_gemini_setup.py
```

---

## 🎉 You're Ready!

Your EV Supply Chain SQL Agent is now running with:
- ✅ Natural language query processing
- ✅ Gemini-powered intent classification  
- ✅ Automatic quality evaluation
- ✅ Production-ready logging

**Start asking questions and let the agent help manage your supply chain!** 🚗⚡

