from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from datetime import datetime

class RequestInboundSlot(BaseModel):
    task_id: str
    location: str
    truck_id: str
    eta_utc: datetime
    unload_min: int
    priority: int = 0
    window_min: int = 60

class RequestOutboundSlot(BaseModel):
    task_id: str
    location: str
    load_id: str
    cutoff_utc: datetime
    load_min: int
    priority: int = 0
    window_min: int = 60

class Proposal(BaseModel):
    task_id: str
    proposal_id: str
    job_type: Literal["inbound","outbound"]
    ref_id: str
    location: str
    door_id: str
    start_utc: datetime
    end_utc: datetime
    local_cost: float
    lateness_min: int
    feasibility: dict = Field(default_factory=dict)

class Decision(BaseModel):
    decision_id: str
    accepted_proposals: List[Proposal]
    confidence: float
    why: List[str] = []
