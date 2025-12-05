#!/bin/bash
# Make diverse test API calls to generate evaluation data

echo "Making test API calls to generate evaluation data..."
echo ""

QUESTIONS=(
    "What's happening at Shanghai doors?"
    "How many inbound trucks at Fremont CA?"
    "When is the next truck arriving at Austin TX?"
    "Why was door 4 reassigned?"
    "Show me the schedule for Berlin"
    "Count all outbound at Shanghai"
    "What's the earliest ETA for part C00015?"
    "Optimize the schedule for Fremont CA"
    "Tell me about door FCX-D10"
    "How many assignments in the next 2 hours at Shanghai?"
)

for i in "${!QUESTIONS[@]}"; do
    question="${QUESTIONS[$i]}"
    echo "[$((i+1))/${#QUESTIONS[@]}] $question"
    
    curl -s -X POST http://localhost:8088/qa \
        -H "Content-Type: application/json" \
        -d "{\"question\": \"$question\"}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    answer = data.get('answer')
    if isinstance(answer, list):
        print(f'  ✅ Got {len(answer)} results')
    elif isinstance(answer, int):
        print(f'  ✅ Count: {answer}')
    elif answer is None:
        print(f'  ⚠️  No result: {data.get(\"explanation\", \"\")}')
    else:
        print(f'  ✅ Answer: {str(answer)[:60]}')
except Exception as e:
    print(f'  ❌ Error: {e}')
"
    sleep 0.3
done

echo ""
echo "✅ Test calls complete!"
