import os
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Tuple, Dict, Any

# Load env from local .env before importing router (so it sees flags like USE_LLM_ROUTER)
try:
    from dotenv import load_dotenv
    here = os.path.dirname(__file__)
    load_dotenv(os.path.join(here, ".env"))
    load_dotenv()  # also load project/root .env if present
except Exception:
    # dotenv is optional; continue if not installed
    pass

from . import llm_router

app = FastAPI(title="Docking Agent API")

class QARequest(BaseModel):
    question: str

def parse_question(question: str) -> Tuple[str, Dict[str, Any], float, str]:
    """Parse a natural-language question into an intent and slots.

    Uses the LLM router when enabled; otherwise returns unknown intent.
    Returns: (intent, slots, confidence, source)
    """
    try:
        intent, meta, conf = llm_router.llm_route(question)
        slots = meta.get("slots", {}) if isinstance(meta, dict) else {}
        source = "llm" if intent not in ("disabled", "unknown") else "router"
        if intent == "disabled":
            return "unknown", {}, 0.0, "disabled"
        return intent, slots, float(conf or 0.0), source
    except Exception:
        return "unknown", {}, 0.0, "error"

def handle_earliest_eta_part(part: str, location: str) -> Dict[str, Any]:
    # Placeholder implementation. Integrate with your DB/logic as needed.
    return {
        "answer": None,
        "explanation": "ETA lookup not yet implemented",
        "inputs": {"part": part, "location": location}
    }

def handle_why_reassigned(door: str) -> Dict[str, Any]:
    return {
        "answer": None,
        "explanation": "Reassignment rationale not yet implemented",
        "inputs": {"door": door}
    }

def handle_door_schedule(location: str) -> Dict[str, Any]:
    return {
        "answer": None,
        "explanation": "Door schedule retrieval not yet implemented",
        "inputs": {"location": location}
    }

@app.post("/qa")
def qa(req: QARequest):
    intent, slots, conf, source = parse_question(req.question)
    if intent == "earliest_eta_part":
        out = handle_earliest_eta_part(slots.get("part",""), slots.get("location",""))
    elif intent == "why_reassigned":
        out = handle_why_reassigned(slots.get("door",""))
    elif intent == "door_schedule":
        out = handle_door_schedule(slots.get("location",""))
    else:
        out = {"answer": None, "explanation":"Unrecognized dock question."}
    out["router"] = {"source": source, "confidence": conf}
    return out

