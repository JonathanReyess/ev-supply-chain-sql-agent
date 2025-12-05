"""
Advanced NLP Engine for Docking Operations
Handles any type of natural language query about docking operations with semantic understanding.
"""
import os, json, re, time
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass, field

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


@dataclass
class QueryIntent:
    """Structured representation of user intent"""
    primary_intent: str  # main action: query, allocate, optimize, analyze, explain
    sub_intent: str  # specific operation
    entities: Dict[str, Any] = field(default_factory=dict)  # extracted entities
    temporal: Optional[Dict[str, Any]] = None  # time-related info
    confidence: float = 0.0
    reasoning: str = ""  # why this intent was chosen


@dataclass
class QueryContext:
    """Context for understanding queries"""
    location: Optional[str] = None
    time_range: Optional[Tuple[datetime, datetime]] = None
    filters: Dict[str, Any] = field(default_factory=dict)
    aggregations: List[str] = field(default_factory=list)
    comparison_type: Optional[str] = None  # for comparative queries


class AdvancedNLPEngine:
    """
    Advanced NLP engine that can understand any docking-related question.
    Uses pattern matching, semantic analysis, and LLM routing.
    """
    
    def __init__(self):
        self.provider = os.getenv("LLM_PROVIDER", "gemini").lower()
        self.use_llm = os.getenv("USE_LLM_ROUTER", "false").lower() == "true"
        self.model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        
        # Intent categories
        self.intent_categories = {
            "query": ["what", "show", "list", "display", "get", "find", "which", "who"],
            "allocate": ["assign", "allocate", "schedule", "book", "reserve", "propose"],
            "optimize": ["optimize", "reallocate", "replan", "reorganize", "improve"],
            "analyze": ["why", "how", "analyze", "explain", "reason", "cause"],
            "status": ["status", "state", "condition", "current"],
            "compare": ["compare", "difference", "versus", "vs", "better", "worse"],
            "predict": ["predict", "forecast", "estimate", "expect", "will"],
            "count": ["count", "how many", "number of", "total"],
            "aggregate": ["average", "sum", "total", "maximum", "minimum", "mean"]
        }
        
        # Entity patterns
        self.entity_patterns = {
            "door": re.compile(r"(?:door|dock|gate)\s*(?:#|num|number)?\s*([A-Za-z0-9\-]+)", re.I),
            "truck": re.compile(r"truck\s*(?:#|id)?\s*([A-Za-z0-9\-]+)", re.I),
            "load": re.compile(r"load\s*(?:#|id)?\s*([A-Za-z0-9\-]+)", re.I),
            "location": re.compile(r"(?:at|in|for|location)\s+([A-Za-z\s]+?)(?:\s+(?:on|at|during|with)|$)", re.I),
            "priority": re.compile(r"priority\s+(\d+)", re.I),
            "time": re.compile(r"(\d{1,2}:\d{2}(?:\s*[AP]M)?|\d{4}-\d{2}-\d{2})", re.I),
            "duration": re.compile(r"(\d+)\s*(?:min|minute|hour|hr)s?", re.I),
        }
        
        # Temporal expressions
        self.temporal_patterns = {
            "today": (0, 1),
            "tomorrow": (1, 2),
            "yesterday": (-1, 0),
            "this week": (0, 7),
            "next week": (7, 14),
            "this month": (0, 30),
            "now": (0, 0),
            "upcoming": (0, 7),
            "recent": (-7, 0),
            "past": (-30, 0),
        }
    
    def parse_query(self, query: str, context: Dict[str, Any] = None) -> QueryIntent:
        """
        Parse any natural language query about docking operations.
        Returns structured intent with high confidence.
        
        Args:
            query: Natural language question
            context: Optional context from orchestrator for LLM routing
        """
        query = query.strip()
        
        # Try LLM first if enabled
        if self.use_llm:
            llm_intent = self._llm_parse(query, context)
            if llm_intent and llm_intent.confidence > 0.7:
                return llm_intent
        
        # Pattern-based parsing with semantic understanding
        intent = self._pattern_parse(query)
        
        # Fallback to LLM if pattern matching has low confidence
        if intent.confidence < 0.6 and self.use_llm:
            llm_intent = self._llm_parse(query, context)
            if llm_intent and llm_intent.confidence > intent.confidence:
                return llm_intent
        
        return intent
    
    def _pattern_parse(self, query: str) -> QueryIntent:
        """Pattern-based parsing with semantic analysis"""
        query_lower = query.lower()
        
        # Determine primary intent
        primary_intent = self._detect_primary_intent(query_lower)
        
        # Extract entities
        entities = self._extract_entities(query)
        
        # Extract temporal information
        temporal = self._extract_temporal(query_lower)
        
        # Determine sub-intent based on primary intent and entities
        sub_intent, confidence = self._determine_sub_intent(
            primary_intent, query_lower, entities
        )
        
        reasoning = f"Pattern-based: detected {primary_intent}/{sub_intent}"
        
        return QueryIntent(
            primary_intent=primary_intent,
            sub_intent=sub_intent,
            entities=entities,
            temporal=temporal,
            confidence=confidence,
            reasoning=reasoning
        )
    
    def _detect_primary_intent(self, query: str) -> str:
        """Detect the primary intent from query"""
        scores = {}
        for intent, keywords in self.intent_categories.items():
            score = sum(1 for kw in keywords if kw in query)
            if score > 0:
                scores[intent] = score
        
        if not scores:
            return "query"  # default
        
        return max(scores.items(), key=lambda x: x[1])[0]
    
    def _extract_entities(self, query: str) -> Dict[str, Any]:
        """Extract entities from query"""
        entities = {}
        
        for entity_type, pattern in self.entity_patterns.items():
            match = pattern.search(query)
            if match:
                entities[entity_type] = match.group(1).strip()
        
        return entities
    
    def _extract_temporal(self, query: str) -> Optional[Dict[str, Any]]:
        """Extract temporal information"""
        for expr, (start_days, end_days) in self.temporal_patterns.items():
            if expr in query:
                now = datetime.utcnow()
                return {
                    "expression": expr,
                    "start": now + timedelta(days=start_days),
                    "end": now + timedelta(days=end_days)
                }
        return None
    
    def _determine_sub_intent(
        self, primary_intent: str, query: str, entities: Dict[str, Any]
    ) -> Tuple[str, float]:
        """Determine specific sub-intent"""
        
        # Query intents
        if primary_intent == "query":
            if "schedule" in query or "timetable" in query or "calendar" in query:
                return "door_schedule", 0.9
            elif "eta" in query or "arrival" in query or "arrive" in query:
                return "earliest_eta", 0.9
            elif "available" in query or "free" in query or "open" in query:
                return "availability", 0.9
            elif "utilization" in query or "usage" in query or "busy" in query:
                return "utilization", 0.85
            elif "queue" in query or "waiting" in query or "yard" in query:
                return "yard_status", 0.85
            elif "assignment" in query:
                return "assignments", 0.9
            elif "resource" in query or "crew" in query or "forklift" in query:
                return "resources", 0.85
            else:
                return "general_query", 0.7
        
        # Allocate intents
        elif primary_intent == "allocate":
            if "inbound" in query or "truck" in query or "unload" in query:
                return "allocate_inbound", 0.9
            elif "outbound" in query or "load" in query or "ship" in query:
                return "allocate_outbound", 0.9
            else:
                return "allocate_generic", 0.75
        
        # Optimize intents
        elif primary_intent == "optimize":
            if "batch" in query or "all" in query or "entire" in query:
                return "optimize_batch", 0.9
            elif "reallocate" in query or "reassign" in query:
                return "optimize_reallocate", 0.9
            else:
                return "optimize_generic", 0.8
        
        # Analyze intents (why/how questions)
        elif primary_intent == "analyze":
            if "reassign" in query or "changed" in query or "moved" in query:
                return "analyze_reassignment", 0.9
            elif "delay" in query or "late" in query or "wait" in query:
                return "analyze_delays", 0.9
            elif "conflict" in query or "overlap" in query or "double" in query:
                return "analyze_conflicts", 0.85
            elif "utilization" in query or "efficiency" in query:
                return "analyze_utilization", 0.85
            elif "bottleneck" in query or "problem" in query or "issue" in query:
                return "analyze_bottlenecks", 0.85
            else:
                return "analyze_general", 0.7
        
        # Status intents
        elif primary_intent == "status":
            if "door" in query or "dock" in query:
                return "door_status", 0.9
            elif "truck" in query or "inbound" in query:
                return "truck_status", 0.9
            elif "load" in query or "outbound" in query:
                return "load_status", 0.9
            else:
                return "general_status", 0.75
        
        # Compare intents
        elif primary_intent == "compare":
            if "location" in query or "site" in query:
                return "compare_locations", 0.85
            elif "door" in query or "dock" in query:
                return "compare_doors", 0.85
            elif "time" in query or "period" in query:
                return "compare_periods", 0.85
            else:
                return "compare_general", 0.7
        
        # Count/aggregate intents
        elif primary_intent in ["count", "aggregate"]:
            return f"{primary_intent}_operation", 0.85
        
        return "unknown", 0.5
    
    def _llm_parse(self, query: str, context: Dict[str, Any] = None) -> Optional[QueryIntent]:
        """Use LLM for advanced query understanding with optional context"""
        try:
            if self.provider == "gemini":
                return self._gemini_parse(query, context)
            elif self.provider == "openai":
                return self._openai_parse(query, context)
        except Exception as e:
            print(f"LLM parse error: {e}")
            return None
    
    def _gemini_parse(self, query: str, context: Dict[str, Any] = None) -> Optional[QueryIntent]:
        """Parse using Gemini with optional orchestrator context"""
        import google.generativeai as genai
        
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or os.getenv("LLM_API_KEY")
        if not api_key:
            return None
        
        genai.configure(api_key=api_key)
        
        context_str = ""
        if context:
            context_str = "\n\nContext from orchestrator:\n" + "\n".join(f"- {k}: {v}" for k, v in context.items())
        
        prompt = f"""Analyze this docking operations query and extract structured information.

Query: "{query}"{context_str}

Return JSON with:
{{
  "primary_intent": "query|allocate|optimize|analyze|status|compare|count|aggregate",
  "sub_intent": "specific operation type",
  "entities": {{"entity_type": "value", ...}},
  "temporal": {{"expression": "time reference", "relative_days_start": 0, "relative_days_end": 7}},
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}}

Entity types: door, truck, load, location, priority, time, duration
Primary intents:
- query: asking for information (what, show, list)
- allocate: requesting assignment (assign, schedule, book)
- optimize: requesting optimization (optimize, reallocate)
- analyze: asking why/how (explain, reason, cause)
- status: checking current state
- compare: comparing entities or time periods
- count/aggregate: counting or aggregating data

Be specific with sub_intent based on the query context."""

        generation_config = {
            "temperature": 0,
            "max_output_tokens": 500,
            "response_mime_type": "application/json",
        }
        
        model = genai.GenerativeModel(
            model_name=self.model,
            generation_config=generation_config
        )
        
        response = model.generate_content(prompt)
        
        # Extract text safely
        txt = ""
        try:
            if response and hasattr(response, "candidates") and response.candidates:
                cand = response.candidates[0]
                if hasattr(cand, "content") and cand.content.parts:
                    part = cand.content.parts[0]
                    if hasattr(part, "text"):
                        txt = part.text
        except Exception:
            pass
        
        if not txt:
            return None
        
        data = json.loads(txt)
        
        # Parse temporal if present
        temporal = None
        if data.get("temporal"):
            t = data["temporal"]
            now = datetime.utcnow()
            temporal = {
                "expression": t.get("expression", ""),
                "start": now + timedelta(days=t.get("relative_days_start", 0)),
                "end": now + timedelta(days=t.get("relative_days_end", 0))
            }
        
        return QueryIntent(
            primary_intent=data.get("primary_intent", "query"),
            sub_intent=data.get("sub_intent", "unknown"),
            entities=data.get("entities", {}),
            temporal=temporal,
            confidence=float(data.get("confidence", 0.7)),
            reasoning=data.get("reasoning", "LLM-based parsing")
        )
    
    def _openai_parse(self, query: str, context: Dict[str, Any] = None) -> Optional[QueryIntent]:
        """Parse using OpenAI"""
        from openai import OpenAI
        
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None
        
        client = OpenAI(api_key=api_key)
        
        prompt = f"""Analyze this docking operations query and extract structured information.

Query: "{query}"

Return JSON with:
{{
  "primary_intent": "query|allocate|optimize|analyze|status|compare|count|aggregate",
  "sub_intent": "specific operation type",
  "entities": {{"entity_type": "value", ...}},
  "temporal": {{"expression": "time reference", "relative_days_start": 0, "relative_days_end": 7}},
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}}"""

        response = client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"}
        )
        
        txt = response.choices[0].message.content or "{}"
        data = json.loads(txt)
        
        # Parse temporal if present
        temporal = None
        if data.get("temporal"):
            t = data["temporal"]
            now = datetime.utcnow()
            temporal = {
                "expression": t.get("expression", ""),
                "start": now + timedelta(days=t.get("relative_days_start", 0)),
                "end": now + timedelta(days=t.get("relative_days_end", 0))
            }
        
        return QueryIntent(
            primary_intent=data.get("primary_intent", "query"),
            sub_intent=data.get("sub_intent", "unknown"),
            entities=data.get("entities", {}),
            temporal=temporal,
            confidence=float(data.get("confidence", 0.7)),
            reasoning=data.get("reasoning", "LLM-based parsing")
        )

