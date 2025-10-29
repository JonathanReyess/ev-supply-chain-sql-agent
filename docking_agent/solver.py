from ortools.sat.python import cp_model
from datetime import datetime, timedelta

def solve_batch(requests, doors, time_ref, time_horizon_min=240, time_budget_ms=1800):
    slot = 5
    H = time_horizon_min // slot
    model = cp_model.CpModel()
    x={}
    for i,req in enumerate(requests):
        for d,_door in enumerate(doors):
            for t in range(H):
                x[(i,d,t)] = model.NewBoolVar(f"x_{i}_{d}_{t}")
    # each job at most once
    for i,_ in enumerate(requests):
        model.Add(sum(x[(i,d,t)] for d in range(len(doors)) for t in range(H)) <= 1)
    # door capacity
    for d in range(len(doors)):
        for t in range(H):
            active=[]
            for i,req in enumerate(requests):
                k = max(1, req["duration_min"]//slot)
                for s in range(max(0, t-k+1), t+1):
                    active.append(x[(i,d,s)])
            if active:
                model.Add(sum(active) <= 1)
    obj=[]
    for i,req in enumerate(requests):
        dur_k = max(1, req["duration_min"]//slot)
        earliest_k = max(0, int((req["earliest"]-time_ref).total_seconds()//60)//slot)
        latest_k = H - dur_k
        for d,_ in enumerate(doors):
            for t in range(H):
                # outside window
                if t < earliest_k or t > latest_k:
                    model.Add(x[(i,d,t)]==0)
                    continue
                end_min = (t+dur_k)*slot
                deadline_min = None
                lateness = 0
                if req["deadline"] is not None:
                    deadline_min = max(0, int((req["deadline"]-time_ref).total_seconds()//60))
                    lateness = max(0, end_min - deadline_min)
                wait = max(0, t*slot - max(0,int((req["earliest"]-time_ref).total_seconds()//60)))
                cost = wait + 2*lateness - 5*req["priority"]
                obj.append(cost * x[(i,d,t)])
    model.Minimize(sum(obj) if obj else 0)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_budget_ms/1000.0
    solver.parameters.num_search_workers = 8
    res = solver.Solve(model)
    out={}
    if res in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for i,req in enumerate(requests):
            found=False
            for d,door in enumerate(doors):
                for t in range(H):
                    if solver.Value(x[(i,d,t)])==1:
                        start = time_ref + timedelta(minutes=t*slot)
                        end = start + timedelta(minutes=req["duration_min"])
                        lateness = 0
                        if req["deadline"] is not None:
                            lateness = max(0, int((end-req["deadline"]).total_seconds()//60))
                        wait = max(0, int((start-req["earliest"]).total_seconds()//60))
                        local_cost = wait + 2*lateness - 5*req["priority"]
                        out[req["id"]] = {"door_id": doors[d], "start": start, "end": end,
                                          "lateness": lateness, "local_cost": local_cost}
                        found=True; break
                if found: break
    return out
