"""
Comprehensive Query Handlers for All Docking Operations
Handles any type of query about docking with intelligent data retrieval.
"""
import sqlite3
import os
import json
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from .nlp_engine import QueryIntent
from .reasoning_engine import ReasoningEngine


DB = os.getenv("DB_PATH", "./data/ev_supply_chain.db")


class QueryHandlers:
    """Comprehensive handlers for all docking-related queries"""
    
    def __init__(self, db_path: str = DB):
        self.db_path = db_path
        self.reasoning_engine = ReasoningEngine(db_path)
    
    def _conn(self):
        return sqlite3.connect(self.db_path)
    
    def handle_query(self, intent: QueryIntent) -> Dict[str, Any]:
        """Route query to appropriate handler based on intent"""
        
        handler_map = {
            # Query intents
            "door_schedule": self.handle_door_schedule,
            "earliest_eta": self.handle_earliest_eta,
            "availability": self.handle_availability,
            "utilization": self.handle_utilization_query,
            "yard_status": self.handle_yard_status,
            "assignments": self.handle_assignments,
            "resources": self.handle_resources,
            "general_query": self.handle_general_query,
            
            # Status intents
            "door_status": self.handle_door_status,
            "truck_status": self.handle_truck_status,
            "load_status": self.handle_load_status,
            "general_status": self.handle_general_status,
            
            # Analyze intents (why/how questions)
            "analyze_reassignment": self.handle_analyze_reassignment,
            "analyze_delays": self.handle_analyze_delays,
            "analyze_conflicts": self.handle_analyze_conflicts,
            "analyze_utilization": self.handle_analyze_utilization,
            "analyze_bottlenecks": self.handle_analyze_bottlenecks,
            "analyze_general": self.handle_analyze_general,
            
            # Compare intents
            "compare_locations": self.handle_compare_locations,
            "compare_doors": self.handle_compare_doors,
            "compare_periods": self.handle_compare_periods,
            
            # Count/aggregate intents
            "count_operation": self.handle_count,
            "aggregate_operation": self.handle_aggregate,
        }
        
        handler = handler_map.get(intent.sub_intent, self.handle_unknown)
        return handler(intent)
    
    # ===== QUERY HANDLERS =====
    
    def handle_door_schedule(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get door schedule for a location"""
        location = intent.entities.get("location", "")
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location (e.g., 'Fremont CA')",
                "intent": intent.__dict__
            }
        
        conn = self._conn()
        c = conn.cursor()
        
        # Build query with temporal filter if present
        query = """
            SELECT door_id, start_utc, end_utc, job_type, ref_id, status
            FROM dock_assignments
            WHERE location LIKE ?
        """
        params = [f"%{location}%"]
        
        if intent.temporal:
            query += " AND datetime(start_utc) >= ? AND datetime(end_utc) <= ?"
            params.extend([
                intent.temporal["start"].isoformat(sep=' '),
                intent.temporal["end"].isoformat(sep=' ')
            ])
        else:
            query += " AND datetime(start_utc) >= datetime('now')"
        
        query += " ORDER BY door_id, datetime(start_utc) LIMIT 200"
        
        rows = c.execute(query, params).fetchall()
        conn.close()
        
        if not rows:
            return {
                "answer": [],
                "explanation": f"No upcoming assignments at '{location}'.",
                "intent": intent.__dict__
            }
        
        schedule = [
            {
                "door": r[0],
                "start": r[1],
                "end": r[2],
                "job": r[3],
                "ref": r[4],
                "status": r[5]
            }
            for r in rows
        ]
        
        return {
            "answer": schedule,
            "explanation": f"Found {len(schedule)} assignments at {location}.",
            "intent": intent.__dict__
        }
    
    def handle_earliest_eta(self, intent: QueryIntent) -> Dict[str, Any]:
        """Find earliest ETA for parts or trucks"""
        location = intent.entities.get("location", "")
        part = intent.entities.get("part", "")
        
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location",
                "intent": intent.__dict__
            }
        
        conn = self._conn()
        c = conn.cursor()
        
        if part:
            # Search for specific part
            query = """
                SELECT it.truck_id, it.eta_utc, it.location, li.componentid, c.name
                FROM inbound_trucks it
                LEFT JOIN purchase_orders po ON po.po_id = it.po_id
                LEFT JOIN po_line_items li ON li.po_id = po.po_id
                LEFT JOIN components c ON c.componentid = li.componentid
                WHERE it.location LIKE ? AND (c.componentid = ? OR c.name LIKE ?)
                ORDER BY datetime(it.eta_utc) ASC LIMIT 1
            """
            row = c.execute(query, (f"%{location}%", part, f"%{part}%")).fetchone()
        else:
            # Just earliest truck
            query = """
                SELECT truck_id, eta_utc, location, NULL, NULL
                FROM inbound_trucks
                WHERE location LIKE ?
                ORDER BY datetime(eta_utc) ASC LIMIT 1
            """
            row = c.execute(query, (f"%{location}%",)).fetchone()
        
        conn.close()
        
        if not row:
            return {
                "answer": None,
                "explanation": f"No inbound trucks found for '{location}'" + (f" with part '{part}'" if part else ""),
                "intent": intent.__dict__
            }
        
        return {
            "answer": row[1],
            "context": {
                "truck_id": row[0],
                "location": row[2],
                "component_id": row[3],
                "component_name": row[4]
            },
            "explanation": f"Earliest ETA is {row[1]} on truck {row[0]}.",
            "intent": intent.__dict__
        }
    
    def handle_availability(self, intent: QueryIntent) -> Dict[str, Any]:
        """Check door availability"""
        location = intent.entities.get("location", "")
        
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location",
                "intent": intent.__dict__
            }
        
        conn = self._conn()
        c = conn.cursor()
        
        # Get all active doors
        doors = c.execute(
            "SELECT door_id FROM dock_doors WHERE location LIKE ? AND is_active=1",
            (f"%{location}%",)
        ).fetchall()
        
        if not doors:
            conn.close()
            return {
                "answer": [],
                "explanation": f"No active doors at '{location}'.",
                "intent": intent.__dict__
            }
        
        # Check availability for next few hours
        now = datetime.utcnow()
        horizon = now + timedelta(hours=4)
        
        availability = []
        for door_row in doors:
            door = door_row[0]
            
            # Get assignments in time window
            assignments = c.execute(
                """SELECT start_utc, end_utc FROM dock_assignments
                   WHERE door_id=? AND datetime(end_utc) >= ? AND datetime(start_utc) <= ?
                   ORDER BY datetime(start_utc)""",
                (door, now.isoformat(sep=' '), horizon.isoformat(sep=' '))
            ).fetchall()
            
            # Calculate free windows
            free_windows = []
            current_time = now
            
            for start, end in assignments:
                start_dt = datetime.fromisoformat(start)
                if current_time < start_dt:
                    free_windows.append({
                        "start": current_time.isoformat(),
                        "end": start_dt.isoformat(),
                        "duration_min": int((start_dt - current_time).total_seconds() / 60)
                    })
                current_time = max(current_time, datetime.fromisoformat(end))
            
            # Add final window if time remains
            if current_time < horizon:
                free_windows.append({
                    "start": current_time.isoformat(),
                    "end": horizon.isoformat(),
                    "duration_min": int((horizon - current_time).total_seconds() / 60)
                })
            
            availability.append({
                "door": door,
                "free_windows": free_windows,
                "total_free_min": sum(w["duration_min"] for w in free_windows)
            })
        
        conn.close()
        
        return {
            "answer": availability,
            "explanation": f"Availability for {len(availability)} doors at {location} over next 4 hours.",
            "intent": intent.__dict__
        }
    
    def handle_utilization_query(self, intent: QueryIntent) -> Dict[str, Any]:
        """Query utilization metrics"""
        location = intent.entities.get("location", "")
        
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location",
                "intent": intent.__dict__
            }
        
        # Use reasoning engine for detailed analysis
        result = self.reasoning_engine.analyze_utilization(location, hours=24)
        
        return {
            "answer": result.answer,
            "analysis": {
                "reasoning": result.reasoning,
                "evidence": result.evidence,
                "insights": result.insights,
                "recommendations": result.recommendations
            },
            "confidence": result.confidence,
            "intent": intent.__dict__
        }
    
    def handle_yard_status(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get yard queue status"""
        location = intent.entities.get("location", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        query = "SELECT id, location, truck_id, position, created_utc FROM yard_queue"
        params = []
        
        if location:
            query += " WHERE location LIKE ?"
            params.append(f"%{location}%")
        
        query += " ORDER BY location, position"
        
        rows = c.execute(query, params).fetchall()
        conn.close()
        
        queue = [
            {
                "id": r[0],
                "location": r[1],
                "truck_id": r[2],
                "position": r[3],
                "created": r[4]
            }
            for r in rows
        ]
        
        return {
            "answer": queue,
            "explanation": f"Found {len(queue)} trucks in yard queue.",
            "intent": intent.__dict__
        }
    
    def handle_assignments(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get assignment information"""
        conn = self._conn()
        c = conn.cursor()
        
        query = "SELECT assignment_id, location, door_id, job_type, ref_id, start_utc, end_utc, status FROM dock_assignments"
        params = []
        conditions = []
        
        if intent.entities.get("location"):
            conditions.append("location LIKE ?")
            params.append(f"%{intent.entities['location']}%")
        
        if intent.entities.get("door"):
            conditions.append("door_id LIKE ?")
            params.append(f"%{intent.entities['door']}%")
        
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        
        query += " ORDER BY datetime(start_utc) DESC LIMIT 50"
        
        rows = c.execute(query, params).fetchall()
        conn.close()
        
        assignments = [
            {
                "id": r[0],
                "location": r[1],
                "door": r[2],
                "job_type": r[3],
                "ref_id": r[4],
                "start": r[5],
                "end": r[6],
                "status": r[7]
            }
            for r in rows
        ]
        
        return {
            "answer": assignments,
            "explanation": f"Found {len(assignments)} assignments.",
            "intent": intent.__dict__
        }
    
    def handle_resources(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get resource availability"""
        location = intent.entities.get("location", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        query = """
            SELECT location, slot_start_utc, slot_end_utc, crews, forklifts
            FROM dock_resources
            WHERE datetime(slot_start_utc) >= datetime('now')
        """
        params = []
        
        if location:
            query += " AND location LIKE ?"
            params.append(f"%{location}%")
        
        query += " ORDER BY location, datetime(slot_start_utc) LIMIT 100"
        
        rows = c.execute(query, params).fetchall()
        conn.close()
        
        resources = [
            {
                "location": r[0],
                "slot_start": r[1],
                "slot_end": r[2],
                "crews": r[3],
                "forklifts": r[4]
            }
            for r in rows
        ]
        
        return {
            "answer": resources,
            "explanation": f"Found {len(resources)} resource slots.",
            "intent": intent.__dict__
        }
    
    def handle_general_query(self, intent: QueryIntent) -> Dict[str, Any]:
        """Handle general queries"""
        return {
            "answer": None,
            "explanation": "Please be more specific about what you'd like to know about docking operations.",
            "suggestions": [
                "Ask about door schedules at a location",
                "Check availability of doors",
                "Analyze utilization or delays",
                "Get status of trucks or loads"
            ],
            "intent": intent.__dict__
        }
    
    # ===== STATUS HANDLERS =====
    
    def handle_door_status(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get current status of specific door(s)"""
        door = intent.entities.get("door", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        # Get door info
        door_like = f"%{door}%" if door else "%"
        doors = c.execute(
            "SELECT door_id, location, is_active FROM dock_doors WHERE door_id LIKE ?",
            (door_like,)
        ).fetchall()
        
        if not doors:
            conn.close()
            return {
                "answer": None,
                "explanation": f"No doors found matching '{door}'.",
                "intent": intent.__dict__
            }
        
        status_list = []
        now = datetime.utcnow()
        
        for door_row in doors:
            door_id = door_row[0]
            
            # Get current assignment
            current = c.execute(
                """SELECT assignment_id, job_type, ref_id, start_utc, end_utc, status
                   FROM dock_assignments
                   WHERE door_id=? AND datetime(start_utc) <= ? AND datetime(end_utc) >= ?
                   ORDER BY datetime(start_utc) DESC LIMIT 1""",
                (door_id, now.isoformat(sep=' '), now.isoformat(sep=' '))
            ).fetchone()
            
            # Get next assignment
            next_assign = c.execute(
                """SELECT assignment_id, job_type, ref_id, start_utc, end_utc
                   FROM dock_assignments
                   WHERE door_id=? AND datetime(start_utc) > ?
                   ORDER BY datetime(start_utc) ASC LIMIT 1""",
                (door_id, now.isoformat(sep=' '))
            ).fetchone()
            
            status_list.append({
                "door": door_id,
                "location": door_row[1],
                "is_active": bool(door_row[2]),
                "current_assignment": {
                    "id": current[0],
                    "job_type": current[1],
                    "ref_id": current[2],
                    "start": current[3],
                    "end": current[4],
                    "status": current[5]
                } if current else None,
                "next_assignment": {
                    "id": next_assign[0],
                    "job_type": next_assign[1],
                    "ref_id": next_assign[2],
                    "start": next_assign[3],
                    "end": next_assign[4]
                } if next_assign else None
            })
        
        conn.close()
        
        return {
            "answer": status_list,
            "explanation": f"Status for {len(status_list)} door(s).",
            "intent": intent.__dict__
        }
    
    def handle_truck_status(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get truck status"""
        truck = intent.entities.get("truck", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        truck_like = f"%{truck}%" if truck else "%"
        trucks = c.execute(
            "SELECT truck_id, location, eta_utc, unload_min, priority, status FROM inbound_trucks WHERE truck_id LIKE ? LIMIT 20",
            (truck_like,)
        ).fetchall()
        
        if not trucks:
            conn.close()
            return {
                "answer": None,
                "explanation": f"No trucks found matching '{truck}'.",
                "intent": intent.__dict__
            }
        
        truck_list = []
        for t in trucks:
            # Check if assigned
            assignment = c.execute(
                "SELECT door_id, start_utc, end_utc FROM dock_assignments WHERE ref_id=? AND job_type='inbound' ORDER BY datetime(created_utc) DESC LIMIT 1",
                (t[0],)
            ).fetchone()
            
            truck_list.append({
                "truck_id": t[0],
                "location": t[1],
                "eta": t[2],
                "unload_min": t[3],
                "priority": t[4],
                "status": t[5],
                "assignment": {
                    "door": assignment[0],
                    "start": assignment[1],
                    "end": assignment[2]
                } if assignment else None
            })
        
        conn.close()
        
        return {
            "answer": truck_list,
            "explanation": f"Status for {len(truck_list)} truck(s).",
            "intent": intent.__dict__
        }
    
    def handle_load_status(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get load status"""
        load = intent.entities.get("load", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        load_like = f"%{load}%" if load else "%"
        loads = c.execute(
            "SELECT load_id, location, cutoff_utc, load_min, priority, status FROM outbound_loads WHERE load_id LIKE ? LIMIT 20",
            (load_like,)
        ).fetchall()
        
        if not loads:
            conn.close()
            return {
                "answer": None,
                "explanation": f"No loads found matching '{load}'.",
                "intent": intent.__dict__
            }
        
        load_list = []
        for ld in loads:
            # Check if assigned
            assignment = c.execute(
                "SELECT door_id, start_utc, end_utc FROM dock_assignments WHERE ref_id=? AND job_type='outbound' ORDER BY datetime(created_utc) DESC LIMIT 1",
                (ld[0],)
            ).fetchone()
            
            load_list.append({
                "load_id": ld[0],
                "location": ld[1],
                "cutoff": ld[2],
                "load_min": ld[3],
                "priority": ld[4],
                "status": ld[5],
                "assignment": {
                    "door": assignment[0],
                    "start": assignment[1],
                    "end": assignment[2]
                } if assignment else None
            })
        
        conn.close()
        
        return {
            "answer": load_list,
            "explanation": f"Status for {len(load_list)} load(s).",
            "intent": intent.__dict__
        }
    
    def handle_general_status(self, intent: QueryIntent) -> Dict[str, Any]:
        """Get general operational status"""
        location = intent.entities.get("location", "")
        
        conn = self._conn()
        c = conn.cursor()
        
        # Get summary statistics
        stats = {}
        
        # Active doors
        query = "SELECT COUNT(*) FROM dock_doors WHERE is_active=1"
        params = []
        if location:
            query += " AND location LIKE ?"
            params.append(f"%{location}%")
        stats["active_doors"] = c.execute(query, params).fetchone()[0]
        
        # Current assignments
        query = "SELECT COUNT(*) FROM dock_assignments WHERE datetime(start_utc) <= datetime('now') AND datetime(end_utc) >= datetime('now')"
        if location:
            query += " AND location LIKE ?"
        stats["current_assignments"] = c.execute(query, params).fetchone()[0]
        
        # Pending inbound
        query = "SELECT COUNT(*) FROM inbound_trucks WHERE status IN ('scheduled', 'arriving')"
        if location:
            query += " AND location LIKE ?"
        stats["pending_inbound"] = c.execute(query, params).fetchone()[0]
        
        # Pending outbound
        query = "SELECT COUNT(*) FROM outbound_loads WHERE status IN ('planned', 'staged')"
        if location:
            query += " AND location LIKE ?"
        stats["pending_outbound"] = c.execute(query, params).fetchone()[0]
        
        # Yard queue
        query = "SELECT COUNT(*) FROM yard_queue"
        if location:
            query += " WHERE location LIKE ?"
        stats["yard_queue"] = c.execute(query, params).fetchone()[0]
        
        conn.close()
        
        return {
            "answer": stats,
            "explanation": f"Operational status" + (f" at {location}" if location else ""),
            "intent": intent.__dict__
        }
    
    # ===== ANALYSIS HANDLERS (WHY/HOW) =====
    
    def handle_analyze_reassignment(self, intent: QueryIntent) -> Dict[str, Any]:
        """Analyze why a door was reassigned"""
        door = intent.entities.get("door", "")
        
        if not door:
            return {
                "answer": None,
                "explanation": "Please specify which door to analyze.",
                "intent": intent.__dict__
            }
        
        result = self.reasoning_engine.analyze_reassignment(door)
        
        return {
            "answer": result.answer,
            "analysis": {
                "reasoning": result.reasoning,
                "evidence": result.evidence,
                "insights": result.insights,
                "recommendations": result.recommendations
            },
            "confidence": result.confidence,
            "intent": intent.__dict__
        }
    
    def handle_analyze_delays(self, intent: QueryIntent) -> Dict[str, Any]:
        """Analyze delay patterns"""
        location = intent.entities.get("location")
        hours = 24
        
        if intent.temporal:
            hours = int((intent.temporal["end"] - intent.temporal["start"]).total_seconds() / 3600)
        
        result = self.reasoning_engine.analyze_delays(location, hours)
        
        return {
            "answer": result.answer,
            "analysis": {
                "reasoning": result.reasoning,
                "evidence": result.evidence,
                "insights": result.insights,
                "recommendations": result.recommendations
            },
            "confidence": result.confidence,
            "intent": intent.__dict__
        }
    
    def handle_analyze_conflicts(self, intent: QueryIntent) -> Dict[str, Any]:
        """Analyze scheduling conflicts"""
        # Implement conflict analysis
        return {
            "answer": "Conflict analysis coming soon",
            "intent": intent.__dict__
        }
    
    def handle_analyze_utilization(self, intent: QueryIntent) -> Dict[str, Any]:
        """Analyze utilization patterns"""
        location = intent.entities.get("location", "")
        
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location to analyze.",
                "intent": intent.__dict__
            }
        
        result = self.reasoning_engine.analyze_utilization(location)
        
        return {
            "answer": result.answer,
            "analysis": {
                "reasoning": result.reasoning,
                "evidence": result.evidence,
                "insights": result.insights,
                "recommendations": result.recommendations
            },
            "confidence": result.confidence,
            "intent": intent.__dict__
        }
    
    def handle_analyze_bottlenecks(self, intent: QueryIntent) -> Dict[str, Any]:
        """Analyze bottlenecks"""
        # Combine delay and utilization analysis
        location = intent.entities.get("location", "")
        
        if not location:
            return {
                "answer": None,
                "explanation": "Please specify a location to analyze.",
                "intent": intent.__dict__
            }
        
        delay_result = self.reasoning_engine.analyze_delays(location)
        util_result = self.reasoning_engine.analyze_utilization(location)
        
        combined_insights = delay_result.insights + util_result.insights
        combined_recommendations = delay_result.recommendations + util_result.recommendations
        
        return {
            "answer": f"Bottleneck analysis for {location}: {delay_result.answer} {util_result.answer}",
            "analysis": {
                "delay_analysis": {
                    "reasoning": delay_result.reasoning,
                    "evidence": delay_result.evidence
                },
                "utilization_analysis": {
                    "reasoning": util_result.reasoning,
                    "evidence": util_result.evidence
                },
                "insights": combined_insights,
                "recommendations": list(set(combined_recommendations))
            },
            "confidence": (delay_result.confidence + util_result.confidence) / 2,
            "intent": intent.__dict__
        }
    
    def handle_analyze_general(self, intent: QueryIntent) -> Dict[str, Any]:
        """Handle general analysis questions"""
        return {
            "answer": None,
            "explanation": "Please be more specific about what you'd like to analyze.",
            "suggestions": [
                "Analyze why a door was reassigned",
                "Analyze delay patterns",
                "Analyze utilization efficiency",
                "Analyze bottlenecks"
            ],
            "intent": intent.__dict__
        }
    
    # ===== COMPARISON HANDLERS =====
    
    def handle_compare_locations(self, intent: QueryIntent) -> Dict[str, Any]:
        """Compare metrics across locations"""
        conn = self._conn()
        c = conn.cursor()
        
        locations = c.execute(
            "SELECT DISTINCT location FROM dock_doors ORDER BY location"
        ).fetchall()
        
        comparison = []
        for loc_row in locations:
            loc = loc_row[0]
            
            # Get metrics for each location
            door_count = c.execute(
                "SELECT COUNT(*) FROM dock_doors WHERE location=? AND is_active=1",
                (loc,)
            ).fetchone()[0]
            
            assignment_count = c.execute(
                "SELECT COUNT(*) FROM dock_assignments WHERE location=? AND datetime(start_utc) >= datetime('now', '-24 hours')",
                (loc,)
            ).fetchone()[0]
            
            pending_inbound = c.execute(
                "SELECT COUNT(*) FROM inbound_trucks WHERE location=? AND status IN ('scheduled', 'arriving')",
                (loc,)
            ).fetchone()[0]
            
            pending_outbound = c.execute(
                "SELECT COUNT(*) FROM outbound_loads WHERE location=? AND status IN ('planned', 'staged')",
                (loc,)
            ).fetchone()[0]
            
            comparison.append({
                "location": loc,
                "active_doors": door_count,
                "assignments_24h": assignment_count,
                "pending_inbound": pending_inbound,
                "pending_outbound": pending_outbound
            })
        
        conn.close()
        
        return {
            "answer": comparison,
            "explanation": f"Comparison of {len(comparison)} locations.",
            "intent": intent.__dict__
        }
    
    def handle_compare_doors(self, intent: QueryIntent) -> Dict[str, Any]:
        """Compare specific doors"""
        return {
            "answer": "Door comparison coming soon",
            "intent": intent.__dict__
        }
    
    def handle_compare_periods(self, intent: QueryIntent) -> Dict[str, Any]:
        """Compare metrics across time periods"""
        return {
            "answer": "Period comparison coming soon",
            "intent": intent.__dict__
        }
    
    # ===== COUNT/AGGREGATE HANDLERS =====
    
    def handle_count(self, intent: QueryIntent) -> Dict[str, Any]:
        """Handle count operations"""
        conn = self._conn()
        c = conn.cursor()
        
        # Determine what to count based on entities
        if "door" in str(intent.entities).lower() or "dock" in str(intent.entities).lower():
            count = c.execute("SELECT COUNT(*) FROM dock_doors WHERE is_active=1").fetchone()[0]
            entity = "active doors"
        elif "truck" in str(intent.entities).lower() or "inbound" in str(intent.entities).lower():
            count = c.execute("SELECT COUNT(*) FROM inbound_trucks WHERE status IN ('scheduled', 'arriving')").fetchone()[0]
            entity = "pending inbound trucks"
        elif "load" in str(intent.entities).lower() or "outbound" in str(intent.entities).lower():
            count = c.execute("SELECT COUNT(*) FROM outbound_loads WHERE status IN ('planned', 'staged')").fetchone()[0]
            entity = "pending outbound loads"
        else:
            count = c.execute("SELECT COUNT(*) FROM dock_assignments WHERE datetime(start_utc) >= datetime('now')").fetchone()[0]
            entity = "upcoming assignments"
        
        conn.close()
        
        return {
            "answer": count,
            "explanation": f"Count of {entity}: {count}",
            "intent": intent.__dict__
        }
    
    def handle_aggregate(self, intent: QueryIntent) -> Dict[str, Any]:
        """Handle aggregate operations"""
        return {
            "answer": "Aggregate operations coming soon",
            "intent": intent.__dict__
        }
    
    def handle_unknown(self, intent: QueryIntent) -> Dict[str, Any]:
        """Handle unknown intents"""
        return {
            "answer": None,
            "explanation": "I didn't understand that question about docking operations.",
            "suggestions": [
                "Ask about door schedules, availability, or status",
                "Analyze why doors were reassigned or delays occurred",
                "Compare locations or time periods",
                "Get counts or statistics"
            ],
            "intent": intent.__dict__
        }

