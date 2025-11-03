# EV Supply Chain Agent - Frontend

A ChatGPT-like web interface for interacting with the SQL-of-Thought and Docking agents.

## How to Run

You need **3 terminals** running simultaneously:

### Terminal 1: SQL-of-Thought API
```bash
npm run api
```
Expected: `🚀 SQL-of-Thought API running on http://localhost:8000`

### Terminal 2: Docking Agent API
```bash
cd docking_agent
uvicorn api:app --reload --port 8088
```
Expected: `Uvicorn running on http://127.0.0.1:8088`

### Terminal 3: Frontend Server
```bash
npm run frontend
```
Expected: `Available on: http://127.0.0.1:3000`

**Alternative** (if npm has issues):
```bash
cd frontend
python3 -m http.server 3000
```

### Access the Interface
Open your browser: **http://localhost:3000**

## Quick Test

1. Open `http://localhost:3000`
2. Click any example prompt card
3. See the results!

Or manually type a question like:
- **SQL-of-Thought**: "List all suppliers with reliability score above 90"
- **Docking Agent**: "When is the earliest ETA for part C00015 at Fremont CA?"

## Features

- ✅ Select between SQL-of-Thought and Docking Agent via dropdown
- ✅ ChatGPT-like dark theme interface
- ✅ Message history
- ✅ Example prompt cards for quick testing
- ✅ Formatted table results
- ✅ Loading indicators

## Troubleshooting

**"Failed to fetch" error?**
- Ensure all 3 servers are running
- Check: `http://localhost:8000/health` and `http://localhost:8088/docs`

**Port already in use?**
```bash
lsof -ti:8000 | xargs kill -9
lsof -ti:8088 | xargs kill -9
lsof -ti:3000 | xargs kill -9
```

**npm cache permission errors?**
```bash
sudo chown -R $(id -u):$(id -g) ~/.npm
npm install
```
