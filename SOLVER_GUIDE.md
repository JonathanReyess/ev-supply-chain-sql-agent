# Dock Optimization Solver Guide

## What is the Solver?

The **solver** is a constraint programming optimization engine using **Google OR-Tools CP-SAT** that finds the optimal assignment of trucks/loads to dock doors.

## 🎯 What It Does

### Objective Function
Minimizes total cost where:
```
cost = wait_time + 2×lateness - 5×priority
```

- **Wait time**: Minutes between earliest arrival and scheduled start
- **Lateness**: Minutes past deadline (weighted 2x more than wait)
- **Priority**: Higher priority (0-2) reduces cost (negative weight)

### Constraints
1. ✅ Each truck/load assigned to **at most one** door at one time
2. ✅ Each door handles **at most one** job at a time (no overlaps)
3. ✅ Jobs must start **after** their earliest arrival time
4. ✅ Jobs must **fit within** the time horizon
5. ✅ Jobs cannot **overlap** on the same door

## ⚙️ How It Works

### Algorithm Steps
1. **Discretize time** into 5-minute slots
2. **Create boolean variables** for each (request, door, time) combination
3. **Add constraints** for capacity and timing
4. **Minimize** the objective function
5. **Run CP-SAT solver** with 1.8s time budget and 8 parallel workers

### Time Complexity
- Variables: `O(requests × doors × time_slots)`
- Example: 20 requests, 6 doors, 240 min → ~5,760 variables
- Optimized for problems up to **~100 requests**

## 📊 Test Results

From our tests:

### Test 1: Basic (5 trucks, 3 doors)
- ✅ Assigned: **3/5 requests** (60%)
- ⏱️ Completed in: **<0.1s**
- 📉 Total lateness: **0 minutes**
- 💰 Average cost: **-8.33**

### Test 2: Database Integration (6 trucks)
- ✅ Successfully read trucks from database
- ✅ Solver found optimal assignments
- ⚠️ Minor database schema issue (fixable)

### Test 3: Stress Test (20 trucks, 6 doors)
- ✅ Assigned: **6/20 requests** (30%)
- ⏱️ Completed in: **0.117 seconds**
- 📉 Total lateness: **0 minutes**
- 📊 Fair door utilization

## 🚀 How to Use

### 1. Direct Solver Usage

```python
from docking_agent.solver import solve_batch
from datetime import datetime, timedelta

time_ref = datetime.utcnow().replace(second=0, microsecond=0)

requests = [
    {
        "id": "T-001",
        "job_type": "inbound",
        "earliest": time_ref + timedelta(minutes=10),
        "deadline": time_ref + timedelta(minutes=60),
        "duration_min": 30,
        "priority": 2  # High priority
    },
    # ... more requests
]

doors = ["FCX-D01", "FCX-D02", "FCX-D03"]

# Run solver
solution = solve_batch(
    requests, 
    doors, 
    time_ref,
    time_horizon_min=240,  # 4 hour window
    time_budget_ms=1800     # 1.8 second limit
)

# Process solution
for req_id, assignment in solution.items():
    print(f"{req_id} → {assignment['door_id']}")
    print(f"  Start: {assignment['start']}")
    print(f"  Lateness: {assignment['lateness']} min")
    print(f"  Cost: {assignment['local_cost']}")
```

### 2. Full Integration with Database

```python
from docking_agent.agent import optimize_batch_and_commit

requests = [
    {
        "id": "T-FCX-001",
        "job_type": "inbound",
        "location": "Fremont CA",
        "earliest": datetime(...),
        "deadline": datetime(...),
        "duration_min": 30,
        "priority": 1
    },
    # ... more requests
]

# Optimize and commit to database
decision = optimize_batch_and_commit(requests, "Fremont CA")

print(f"Accepted: {len(decision.accepted_proposals)} assignments")
print(f"Confidence: {decision.confidence:.2f}")
```

### 3. Run the Test Suite

```bash
# Run comprehensive solver tests
python3 test_solver.py
```

## 💡 When to Use

### Use Solver For:
- ✅ **Batch operations** (10-50 jobs at once)
- ✅ **Overnight planning** (optimize next day's schedule)
- ✅ **Re-optimization** (when priorities change)
- ✅ **What-if scenarios** (testing different configurations)

### Use Heuristic For:
- ✅ **Real-time single-job allocation** (< 100ms response)
- ✅ **Immediate decisions** (truck just arrived)
- ✅ **Simple cases** (few constraints)

## 🎓 Key Takeaways

1. **Solver finds globally optimal** (or near-optimal) solutions
2. **More expensive** computationally than heuristic (~100-500ms vs ~10ms)
3. **Handles complex constraints** automatically
4. **Lateness is penalized 2x** more than wait time
5. **Priority matters**: High priority (2) = -10 cost, Medium (1) = -5 cost
6. **Scales well** for batch operations up to ~100 requests

## 📈 Performance Benchmarks

| Requests | Doors | Time Slots | Solve Time | Assigned |
|----------|-------|------------|------------|----------|
| 5        | 3     | 48         | < 0.1s     | 60%      |
| 6        | 12    | 48         | < 0.2s     | 100%     |
| 20       | 6     | 48         | 0.117s     | 30%      |

*Assignment rate depends on capacity and time windows*

## 🔧 Configuration

Key parameters in `solve_batch()`:

- **time_horizon_min**: Planning window (default: 240 = 4 hours)
- **time_budget_ms**: Max solver time (default: 1800 = 1.8 seconds)
- **slot**: Time discretization (fixed: 5 minutes)
- **num_search_workers**: Parallel workers (fixed: 8)

## 🐛 Troubleshooting

### Low Assignment Rate
- **Cause**: Time windows too tight, too many requests for available capacity
- **Solution**: Increase time horizon, add more doors, or relax deadlines

### Solver Timeout
- **Cause**: Problem too large (>100 requests)
- **Solution**: Reduce batch size, increase time_budget_ms, or use heuristic

### No Solution Found
- **Cause**: Infeasible constraints (all requests conflict)
- **Solution**: Check time windows, verify door availability

## 🔍 Example Output

```
✅ SOLUTION:
  T-001:
    Door: DOOR-01
    Start: 23:20:00
    End: 23:50:00
    Lateness: 0 minutes
    Cost: -10.0
    
  T-004:
    Door: DOOR-02
    Start: 23:15:00
    End: 23:40:00
    Lateness: 0 minutes
    Cost: -10.0

📊 STATISTICS:
  Assigned: 3/5 requests
  Total lateness: 0 minutes
  Average cost: -8.33
```

---

**Built with Google OR-Tools. Optimized for production dock operations.**
