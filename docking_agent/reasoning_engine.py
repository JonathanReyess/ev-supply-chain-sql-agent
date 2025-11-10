"""
Intelligent Reasoning Engine for Docking Operations
Analyzes data to answer 'why' and 'how' questions through inference and analysis.
"""
import sqlite3
import os
import json
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass, field


@dataclass
class AnalysisResult:
    """Result of data analysis"""
    answer: str
    reasoning: List[str]  # step-by-step reasoning
    evidence: List[Dict[str, Any]]  # supporting data
    confidence: float
    insights: List[str] = field(default_factory=list)  # additional insights
    recommendations: List[str] = field(default_factory=list)


class ReasoningEngine:
    """
    Intelligent reasoning engine that analyzes data to answer why/how questions.
    Does NOT just return stored causality data - performs actual analysis.
    """
    
    def __init__(self, db_path: str):
        self.db_path = db_path
    
    def _conn(self):
        return sqlite3.connect(self.db_path)
    
    def analyze_reassignment(self, door_id: str) -> AnalysisResult:
        """
        Analyze WHY a door was reassigned by examining data patterns,
        not just returning stored reason codes.
        """
        conn = self._conn()
        c = conn.cursor()
        
        reasoning = []
        evidence = []
        insights = []
        recommendations = []
        
        # Normalize door ID
        door_like = f"%D{int(door_id):02d}" if door_id.isdigit() else f"%{door_id}%"
        
        # Step 1: Get assignment history
        reasoning.append("Examining assignment history for door")
        assignments = c.execute(
            """SELECT assignment_id, job_type, ref_id, start_utc, end_utc, created_utc, status, why_json
               FROM dock_assignments
               WHERE door_id LIKE ?
               ORDER BY datetime(created_utc) DESC LIMIT 10""",
            (door_like,)
        ).fetchall()
        
        if len(assignments) < 2:
            conn.close()
            return AnalysisResult(
                answer="Insufficient assignment history to analyze reassignment patterns.",
                reasoning=reasoning,
                evidence=[],
                confidence=0.3
            )
        
        # Step 2: Analyze timing patterns
        reasoning.append("Analyzing timing patterns and conflicts")
        recent_assignments = assignments[:5]
        
        # Check for overlaps
        overlaps = []
        for i, a1 in enumerate(recent_assignments):
            for a2 in recent_assignments[i+1:]:
                if self._check_overlap(a1[3], a1[4], a2[3], a2[4]):
                    overlaps.append((a1, a2))
                    evidence.append({
                        "type": "overlap_detected",
                        "assignment_1": {"id": a1[0], "start": a1[3], "end": a1[4]},
                        "assignment_2": {"id": a2[0], "start": a2[3], "end": a2[4]}
                    })
        
        if overlaps:
            reasoning.append(f"Found {len(overlaps)} timing conflicts requiring reassignment")
            insights.append("Door scheduling conflicts suggest high utilization or poor initial planning")
        
        # Step 3: Analyze job type patterns
        reasoning.append("Examining job type distribution")
        job_types = [a[1] for a in recent_assignments]
        inbound_count = job_types.count("inbound")
        outbound_count = job_types.count("outbound")
        
        if inbound_count > 0 and outbound_count > 0:
            evidence.append({
                "type": "mixed_job_types",
                "inbound": inbound_count,
                "outbound": outbound_count
            })
            insights.append("Door handles both inbound and outbound, increasing complexity")
        
        # Step 4: Check for ETA slips (inbound jobs)
        reasoning.append("Checking for ETA changes in inbound trucks")
        for assignment in recent_assignments:
            if assignment[1] == "inbound":
                truck_id = assignment[2]
                truck_info = c.execute(
                    "SELECT eta_utc, status FROM inbound_trucks WHERE truck_id=?",
                    (truck_id,)
                ).fetchone()
                
                if truck_info:
                    eta = datetime.fromisoformat(truck_info[0])
                    start = datetime.fromisoformat(assignment[3])
                    delay_min = (eta - start).total_seconds() / 60
                    
                    if abs(delay_min) > 15:
                        evidence.append({
                            "type": "eta_slip",
                            "truck_id": truck_id,
                            "delay_minutes": int(delay_min),
                            "assignment_id": assignment[0]
                        })
                        reasoning.append(f"Truck {truck_id} had {int(abs(delay_min))} minute delay")
                        insights.append("ETA slips are causing reactive reassignments")
        
        # Step 5: Check for priority changes
        reasoning.append("Analyzing priority-based preemptions")
        priority_changes = []
        for i in range(len(recent_assignments) - 1):
            curr = recent_assignments[i]
            prev = recent_assignments[i + 1]
            
            # Check if a higher priority job replaced a lower priority one
            curr_ref = curr[2]
            prev_ref = prev[2]
            
            # Get priorities
            curr_priority = self._get_job_priority(c, curr[1], curr_ref)
            prev_priority = self._get_job_priority(c, prev[1], prev_ref)
            
            if curr_priority > prev_priority:
                priority_changes.append({
                    "current": {"ref": curr_ref, "priority": curr_priority},
                    "previous": {"ref": prev_ref, "priority": prev_priority}
                })
                evidence.append({
                    "type": "priority_preemption",
                    "higher_priority_job": curr_ref,
                    "replaced_job": prev_ref
                })
        
        if priority_changes:
            reasoning.append(f"Found {len(priority_changes)} priority-based preemptions")
            insights.append("High-priority jobs are displacing lower-priority assignments")
            recommendations.append("Consider reserving doors for high-priority jobs in advance")
        
        # Step 6: Check resource constraints
        reasoning.append("Examining resource availability")
        door_info = c.execute(
            "SELECT location FROM dock_doors WHERE door_id LIKE ? LIMIT 1",
            (door_like,)
        ).fetchone()
        
        if door_info:
            location = door_info[0]
            # Check if resources were scarce during reassignments
            for assignment in recent_assignments[:3]:
                resources = c.execute(
                    """SELECT MIN(crews), MIN(forklifts) FROM dock_resources
                       WHERE location=? AND slot_start_utc<=? AND slot_end_utc>=?""",
                    (location, assignment[4], assignment[3])
                ).fetchone()
                
                if resources and (resources[0] or 0) < 2:
                    evidence.append({
                        "type": "resource_constraint",
                        "assignment_id": assignment[0],
                        "crews": resources[0],
                        "forklifts": resources[1]
                    })
                    insights.append("Resource constraints may be forcing suboptimal door assignments")
        
        # Step 7: Analyze utilization pressure
        reasoning.append("Calculating door utilization pressure")
        total_duration = sum(
            (datetime.fromisoformat(a[4]) - datetime.fromisoformat(a[3])).total_seconds() / 3600
            for a in recent_assignments
        )
        time_span = (
            datetime.fromisoformat(recent_assignments[0][3]) -
            datetime.fromisoformat(recent_assignments[-1][3])
        ).total_seconds() / 3600
        
        if time_span > 0:
            utilization = (total_duration / time_span) * 100
            evidence.append({
                "type": "utilization_metric",
                "utilization_percent": round(utilization, 1),
                "time_span_hours": round(time_span, 1)
            })
            
            if utilization > 80:
                insights.append(f"Door utilization is high ({utilization:.0f}%), increasing reassignment likelihood")
                recommendations.append("Consider activating additional doors to reduce pressure")
            elif utilization < 40:
                insights.append(f"Door utilization is low ({utilization:.0f}%), reassignments may be due to other factors")
        
        conn.close()
        
        # Synthesize answer
        primary_causes = []
        if overlaps:
            primary_causes.append("scheduling conflicts")
        if any(e["type"] == "eta_slip" for e in evidence):
            primary_causes.append("ETA delays")
        if priority_changes:
            primary_causes.append("priority preemptions")
        if any(e["type"] == "resource_constraint" for e in evidence):
            primary_causes.append("resource constraints")
        
        if not primary_causes:
            primary_causes.append("operational optimization")
        
        answer = (
            f"Door {door_id} was reassigned primarily due to: {', '.join(primary_causes)}. "
            f"Analysis of {len(recent_assignments)} recent assignments reveals patterns of "
            f"{', '.join(insights[:2]) if insights else 'dynamic operational adjustments'}."
        )
        
        confidence = min(0.95, 0.6 + (len(evidence) * 0.05))
        
        return AnalysisResult(
            answer=answer,
            reasoning=reasoning,
            evidence=evidence,
            confidence=confidence,
            insights=insights,
            recommendations=recommendations
        )
    
    def analyze_delays(self, location: Optional[str] = None, hours: int = 24) -> AnalysisResult:
        """Analyze delay patterns and root causes"""
        conn = self._conn()
        c = conn.cursor()
        
        reasoning = ["Analyzing delay patterns across assignments"]
        evidence = []
        insights = []
        recommendations = []
        
        # Get assignments with lateness
        query = """
            SELECT da.assignment_id, da.door_id, da.job_type, da.ref_id, 
                   da.start_utc, da.end_utc, da.why_json, da.location
            FROM dock_assignments da
            WHERE datetime(da.start_utc) >= datetime('now', '-{} hours')
        """.format(hours)
        
        if location:
            query += f" AND da.location LIKE '%{location}%'"
        
        assignments = c.execute(query).fetchall()
        
        delayed_count = 0
        total_delay_min = 0
        delay_by_type = {"inbound": [], "outbound": []}
        
        for assignment in assignments:
            job_type = assignment[2]
            ref_id = assignment[3]
            start_utc = datetime.fromisoformat(assignment[4])
            
            # Calculate actual delay
            if job_type == "inbound":
                truck = c.execute(
                    "SELECT eta_utc FROM inbound_trucks WHERE truck_id=?",
                    (ref_id,)
                ).fetchone()
                if truck:
                    eta = datetime.fromisoformat(truck[0])
                    delay_min = (start_utc - eta).total_seconds() / 60
                    if delay_min > 10:  # More than 10 min delay
                        delayed_count += 1
                        total_delay_min += delay_min
                        delay_by_type["inbound"].append({
                            "ref_id": ref_id,
                            "delay_min": int(delay_min),
                            "door": assignment[1]
                        })
            
            elif job_type == "outbound":
                load = c.execute(
                    "SELECT cutoff_utc FROM outbound_loads WHERE load_id=?",
                    (ref_id,)
                ).fetchone()
                if load:
                    cutoff = datetime.fromisoformat(load[0])
                    end_utc = datetime.fromisoformat(assignment[5])
                    delay_min = (end_utc - cutoff).total_seconds() / 60
                    if delay_min > 0:  # Missed cutoff
                        delayed_count += 1
                        total_delay_min += delay_min
                        delay_by_type["outbound"].append({
                            "ref_id": ref_id,
                            "delay_min": int(delay_min),
                            "door": assignment[1]
                        })
        
        if delayed_count == 0:
            conn.close()
            return AnalysisResult(
                answer=f"No significant delays detected in the past {hours} hours.",
                reasoning=reasoning,
                evidence=[],
                confidence=0.9,
                insights=["Operations are running smoothly"]
            )
        
        # Analyze delay patterns
        reasoning.append(f"Found {delayed_count} delayed assignments")
        
        avg_delay = total_delay_min / delayed_count if delayed_count > 0 else 0
        evidence.append({
            "type": "delay_summary",
            "total_delayed": delayed_count,
            "average_delay_min": round(avg_delay, 1),
            "inbound_delays": len(delay_by_type["inbound"]),
            "outbound_delays": len(delay_by_type["outbound"])
        })
        
        # Identify bottleneck doors
        door_delay_counts = {}
        for job_type in ["inbound", "outbound"]:
            for delay in delay_by_type[job_type]:
                door = delay["door"]
                door_delay_counts[door] = door_delay_counts.get(door, 0) + 1
        
        if door_delay_counts:
            bottleneck_doors = sorted(
                door_delay_counts.items(),
                key=lambda x: x[1],
                reverse=True
            )[:3]
            
            evidence.append({
                "type": "bottleneck_doors",
                "doors": [{"door": d, "delay_count": c} for d, c in bottleneck_doors]
            })
            insights.append(f"Doors {', '.join(d for d, _ in bottleneck_doors)} are experiencing the most delays")
            recommendations.append("Investigate capacity or operational issues at high-delay doors")
        
        # Analyze time-of-day patterns
        delay_hours = {}
        for job_type in ["inbound", "outbound"]:
            for delay in delay_by_type[job_type]:
                # Would need start time from assignment - simplified for now
                pass
        
        conn.close()
        
        answer = (
            f"Analysis of {len(assignments)} assignments in the past {hours} hours reveals "
            f"{delayed_count} delays ({(delayed_count/len(assignments)*100):.1f}% delay rate) "
            f"with an average delay of {avg_delay:.0f} minutes. "
            f"Primary issues: {', '.join(insights[:2]) if insights else 'operational bottlenecks'}."
        )
        
        return AnalysisResult(
            answer=answer,
            reasoning=reasoning,
            evidence=evidence,
            confidence=0.85,
            insights=insights,
            recommendations=recommendations
        )
    
    def analyze_utilization(self, location: str, hours: int = 24) -> AnalysisResult:
        """Analyze door utilization and efficiency"""
        conn = self._conn()
        c = conn.cursor()
        
        reasoning = ["Calculating door utilization metrics"]
        evidence = []
        insights = []
        recommendations = []
        
        # Get all doors at location
        doors = c.execute(
            "SELECT door_id, is_active FROM dock_doors WHERE location LIKE ?",
            (f"%{location}%",)
        ).fetchall()
        
        if not doors:
            conn.close()
            return AnalysisResult(
                answer=f"No doors found at location '{location}'.",
                reasoning=reasoning,
                evidence=[],
                confidence=0.3
            )
        
        active_doors = [d[0] for d in doors if d[1] == 1]
        reasoning.append(f"Analyzing {len(active_doors)} active doors")
        
        # Calculate utilization for each door
        time_window_hours = hours
        door_utilization = {}
        
        for door in active_doors:
            assignments = c.execute(
                """SELECT start_utc, end_utc FROM dock_assignments
                   WHERE door_id=? AND datetime(start_utc) >= datetime('now', '-{} hours')""".format(hours),
                (door,)
            ).fetchall()
            
            total_busy_min = sum(
                (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 60
                for start, end in assignments
            )
            
            available_min = time_window_hours * 60
            utilization_pct = (total_busy_min / available_min) * 100 if available_min > 0 else 0
            
            door_utilization[door] = {
                "utilization_pct": round(utilization_pct, 1),
                "busy_minutes": round(total_busy_min, 1),
                "assignment_count": len(assignments)
            }
        
        # Calculate statistics
        utilizations = [d["utilization_pct"] for d in door_utilization.values()]
        avg_util = sum(utilizations) / len(utilizations) if utilizations else 0
        max_util = max(utilizations) if utilizations else 0
        min_util = min(utilizations) if utilizations else 0
        
        evidence.append({
            "type": "utilization_summary",
            "average_utilization": round(avg_util, 1),
            "max_utilization": round(max_util, 1),
            "min_utilization": round(min_util, 1),
            "door_count": len(active_doors)
        })
        
        # Identify over/under-utilized doors
        overutilized = [d for d, u in door_utilization.items() if u["utilization_pct"] > 85]
        underutilized = [d for d, u in door_utilization.items() if u["utilization_pct"] < 30]
        
        if overutilized:
            evidence.append({
                "type": "overutilized_doors",
                "doors": overutilized,
                "count": len(overutilized)
            })
            insights.append(f"{len(overutilized)} doors are overutilized (>85%)")
            recommendations.append("Consider load balancing or activating additional doors")
        
        if underutilized:
            evidence.append({
                "type": "underutilized_doors",
                "doors": underutilized,
                "count": len(underutilized)
            })
            insights.append(f"{len(underutilized)} doors are underutilized (<30%)")
            recommendations.append("Consider consolidating operations or deactivating unused doors")
        
        # Calculate efficiency score
        variance = sum((u - avg_util) ** 2 for u in utilizations) / len(utilizations) if utilizations else 0
        balance_score = max(0, 100 - variance)  # Lower variance = better balance
        
        evidence.append({
            "type": "efficiency_metrics",
            "balance_score": round(balance_score, 1),
            "utilization_variance": round(variance, 1)
        })
        
        if balance_score > 80:
            insights.append("Door utilization is well-balanced")
        else:
            insights.append("Door utilization is imbalanced, suggesting optimization opportunities")
            recommendations.append("Run batch optimization to improve load distribution")
        
        conn.close()
        
        answer = (
            f"Door utilization at {location} averages {avg_util:.1f}% over the past {hours} hours. "
            f"Range: {min_util:.1f}% to {max_util:.1f}%. "
            f"Balance score: {balance_score:.0f}/100. "
            f"{', '.join(insights[:2]) if insights else 'Operations are balanced'}."
        )
        
        return AnalysisResult(
            answer=answer,
            reasoning=reasoning,
            evidence=evidence,
            confidence=0.9,
            insights=insights,
            recommendations=recommendations
        )
    
    def _check_overlap(self, start1: str, end1: str, start2: str, end2: str) -> bool:
        """Check if two time ranges overlap"""
        s1 = datetime.fromisoformat(start1)
        e1 = datetime.fromisoformat(end1)
        s2 = datetime.fromisoformat(start2)
        e2 = datetime.fromisoformat(end2)
        return not (e1 <= s2 or e2 <= s1)
    
    def _get_job_priority(self, cursor, job_type: str, ref_id: str) -> int:
        """Get priority for a job"""
        if job_type == "inbound":
            row = cursor.execute(
                "SELECT priority FROM inbound_trucks WHERE truck_id=?",
                (ref_id,)
            ).fetchone()
        elif job_type == "outbound":
            row = cursor.execute(
                "SELECT priority FROM outbound_loads WHERE load_id=?",
                (ref_id,)
            ).fetchone()
        else:
            return 0
        
        return row[0] if row else 0

