#!/bin/bash
# Quick Start Script for Docking Agent v2.0

set -e

echo "========================================="
echo "Docking Agent v2.0 - Quick Start"
echo "========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check Python
echo -e "${YELLOW}[1/6]${NC} Checking Python installation..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found. Please install Python 3.8+"
    exit 1
fi
echo -e "${GREEN}✓${NC} Python found: $(python3 --version)"

# Step 2: Install dependencies
echo ""
echo -e "${YELLOW}[2/6]${NC} Installing dependencies..."
pip install -q -r docking_agent/requirements.txt
echo -e "${GREEN}✓${NC} Dependencies installed"

# Step 3: Set up database
echo ""
echo -e "${YELLOW}[3/6]${NC} Setting up database..."
export DB_PATH=./data/ev_supply_chain.db
mkdir -p data
touch $DB_PATH

# Apply migrations
python3 - <<'PY'
import sqlite3, os
db = os.getenv("DB_PATH")
conn = sqlite3.connect(db)
for p in ["docking_agent/migrations/001_create_docking_tables.sql",
          "docking_agent/migrations/002_provenance.sql"]:
    conn.executescript(open(p).read())
conn.commit()
conn.close()
PY

echo -e "${GREEN}✓${NC} Database initialized"

# Step 4: Seed data
echo ""
echo -e "${YELLOW}[4/6]${NC} Seeding sample data..."
python3 -m docking_agent.simulate > /dev/null 2>&1
echo -e "${GREEN}✓${NC} Sample data created"

# Step 5: Configure
echo ""
echo -e "${YELLOW}[5/6]${NC} Configuring agent..."
export USE_ADVANCED_NLP=true
export USE_LLM_ROUTER=false  # Disable by default, enable if you have API key

cat > .env.docking <<'EOF'
# Docking Agent Configuration
DB_PATH=./data/ev_supply_chain.db
USE_ADVANCED_NLP=true
USE_LLM_ROUTER=false

# Optional: Enable LLM routing for complex queries
# USE_LLM_ROUTER=true
# LLM_PROVIDER=gemini
# GOOGLE_API_KEY=your_key_here
# GEMINI_MODEL=gemini-2.0-flash
EOF

echo -e "${GREEN}✓${NC} Configuration saved to .env.docking"

# Step 6: Run tests
echo ""
echo -e "${YELLOW}[6/6]${NC} Running tests..."
if python3 docking_agent/test_advanced.py > /tmp/test_output.txt 2>&1; then
    echo -e "${GREEN}✓${NC} All tests passed!"
else
    echo -e "${YELLOW}⚠${NC} Some tests failed (this is OK for first run)"
    echo "   Check /tmp/test_output.txt for details"
fi

echo ""
echo "========================================="
echo -e "${GREEN}Setup Complete!${NC}"
echo "========================================="
echo ""
echo "To start the API server:"
echo "  uvicorn docking_agent.api:app --reload --port 8088"
echo ""
echo "Then visit:"
echo "  - API docs: http://localhost:8088/docs"
echo "  - Health check: http://localhost:8088/health"
echo "  - Tools: http://localhost:8088/orchestrator/tools"
echo ""
echo "Try some queries:"
echo "  curl -X POST http://localhost:8088/qa \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"question\":\"What is the door schedule at Fremont?\"}'"
echo ""
echo "  curl -X POST http://localhost:8088/qa \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"question\":\"Why was door 4 reassigned?\"}'"
echo ""
echo "Documentation:"
echo "  - README: docking_agent/README.md"
echo "  - Advanced Features: docking_agent/ADVANCED_FEATURES.md"
echo "  - Integration Guide: docking_agent/INTEGRATION_GUIDE.md"
echo ""
echo "========================================="

