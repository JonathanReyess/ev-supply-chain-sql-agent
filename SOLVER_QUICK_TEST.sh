#!/bin/bash
# Quick Solver Test Script

echo "🔧 QUICK SOLVER TEST"
echo "==================="
echo ""

echo "Running solver tests..."
python3 test_solver.py 2>&1 | grep -A 20 "TEST 1: Basic Solver Test" | head -40

echo ""
echo "✅ Solver test complete!"
echo ""
echo "📖 Read full guide: cat SOLVER_GUIDE.md"
echo "🧪 Run full tests: python3 test_solver.py"
