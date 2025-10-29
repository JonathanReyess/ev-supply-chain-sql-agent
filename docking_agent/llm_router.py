import os, json, time
from typing import Tuple, Dict, Any

PROVIDER = os.getenv("LLM_PROVIDER", "openai").lower()
USE_LLM = os.getenv("USE_LLM_ROUTER", "false").lower() == "true"
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
BUDGET_MS = int(os.getenv("LLM_LATENCY_MS", "400"))

ALLOWED_INTENTS = [
  "earliest_eta_part",   # slots: part, location
  "why_reassigned",      # slots: door
  "door_schedule"        # slots: location
]

SCHEMA_CARD = {
  "locations_examples": ["Fremont CA","Austin TX","Shanghai","Berlin","Nevada Gigafactory","Raleigh Service Center"],
  "entities": {
    "part": "componentid like C00015, or component name tokens",
    "door": "dock numeric like 4 or full code like FRE-D04"
  }
}

def _get_api_key() -> str:
    """Return a generic API key for the configured provider.

    Priority:
    1) LLM_API_KEY (provider-agnostic)
    2) Provider-specific env var when known
    """
    generic = os.getenv("LLM_API_KEY")
    if generic:
        return generic

    env_var_by_provider = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        # Common other providers if adopted later
        "cohere": "COHERE_API_KEY",
        "groq": "GROQ_API_KEY",
        "google": "GOOGLE_API_KEY",   # Gemini via Google
        "gemini": "GOOGLE_API_KEY",
    }
    env_name = env_var_by_provider.get(PROVIDER, "")
    return os.getenv(env_name) if env_name else None

def _openai_client():
    from openai import OpenAI
    return OpenAI(api_key=_get_api_key())

def _anthropic_client():
    import anthropic
    return anthropic.Anthropic(api_key=_get_api_key())

def _gemini_client():
    import google.generativeai as genai
    from google.generativeai.types import HarmCategory, HarmBlockThreshold
    api_key = _get_api_key()
    genai.configure(api_key=api_key)
    return genai, HarmCategory, HarmBlockThreshold

SYSTEM = (
  "You are an intent router. Return only JSON with: intent, slots (object), confidence (0-1)."
)

USER_TMPL = """Question: {q}

Intents: earliest_eta_part (needs part, location), why_reassigned (needs door), door_schedule (needs location).

Schema: {schema}

Rules: Extract part/location/door. If not dock-related, use intent="unknown".

Return only valid JSON."""

def llm_route(question: str) -> Tuple[str, Dict[str, Any], float]:
    if not USE_LLM:
        return "disabled", {}, 0.0
    t0 = time.time()
    payload = USER_TMPL.format(q=question, schema=json.dumps(SCHEMA_CARD))
    try:
        if PROVIDER == "openai":
            client = _openai_client()
            resp = client.chat.completions.create(
                model=MODEL,
                temperature=0,
                max_tokens=150,
                messages=[
                    {"role":"system","content":SYSTEM},
                    {"role":"user","content":payload}
                ],
                timeout=BUDGET_MS/1000.0,
            )
            txt = resp.choices[0].message.content
        elif PROVIDER in ("gemini", "google"):
            genai, HarmCategory, HarmBlockThreshold = _gemini_client()
            # Try gemini-pro-latest as it may have better safety handling
            model_name = MODEL if MODEL else "gemini-pro-latest"
            # Ensure model name has 'models/' prefix for Gemini
            if not model_name.startswith("models/"):
                model_name = f"models/{model_name}"
            # Configure safety settings to avoid blocking (for router use case)
            safety_settings = [
                {"category": HarmCategory.HARM_CATEGORY_HARASSMENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_HATE_SPEECH, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
            ]
            # Create model with safety settings configured
            model = genai.GenerativeModel(
                model_name,
                safety_settings=safety_settings
            )
            # Combine system and user prompt for Gemini (it doesn't have separate system messages)
            full_prompt = f"{SYSTEM}\n\n{payload}"
            resp = model.generate_content(
                full_prompt,
                generation_config=genai.GenerationConfig(
                    temperature=0,
                    max_output_tokens=200,
                )
            )
            # Handle response - check finish_reason first
            if not resp.candidates:
                raise Exception("No candidates in response")
            finish_reason = resp.candidates[0].finish_reason
            if finish_reason == 2:  # SAFETY/BLOCKED
                raise Exception(f"Content blocked by safety filter (finish_reason={finish_reason})")
            elif finish_reason != 1:  # 1 = STOP (normal completion)
                raise Exception(f"Unexpected finish_reason: {finish_reason}")
            # Try to get text - handle both .text property and manual extraction
            try:
                txt = resp.text
            except Exception:
                # Fallback if .text property fails
                if resp.candidates[0].content and resp.candidates[0].content.parts:
                    txt = "".join(part.text for part in resp.candidates[0].content.parts if hasattr(part, 'text'))
                else:
                    raise Exception("No content parts found in response")
        else:
            client = _anthropic_client()
            resp = client.messages.create(
                model=MODEL,
                max_tokens=200,
                temperature=0,
                system=SYSTEM,
                messages=[{"role":"user","content":payload}],
                timeout=BUDGET_MS/1000.0,
            )
            # anthropic returns a list of content blocks
            txt = "".join(block.text for block in resp.content if getattr(block,"text",None))

        # Try to extract JSON from response (Gemini sometimes wraps it in markdown code blocks)
        import re
        # Remove markdown code block markers if present
        txt = re.sub(r'```json\s*', '', txt)
        txt = re.sub(r'```\s*', '', txt)
        # Try to find JSON object
        json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*"intent"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', txt, re.DOTALL)
        if json_match:
            txt = json_match.group(0)

        parsed = json.loads(txt)
        intent = parsed.get("intent","unknown")
        slots  = parsed.get("slots",{}) or {}
        conf   = float(parsed.get("confidence",0))
        dt_ms  = int((time.time()-t0)*1000)
        return intent, {"slots":slots, "confidence":conf, "latency_ms":dt_ms}, conf
    except Exception as e:
        dt_ms = int((time.time()-t0)*1000)
        # Log error for debugging
        if os.getenv("DEBUG_LLM_ROUTER", "false").lower() == "true":
            import sys
            print(f"LLM Router Error: {e}", file=sys.stderr)
            print(f"Response text: {txt if 'txt' in locals() else 'N/A'}", file=sys.stderr)
        return "unknown", {"slots":{}, "confidence":0.0, "latency_ms":dt_ms}, 0.0

# Best-effort variant that must choose the closest intent even if slots are incomplete
BEST_EFFORT_SYSTEM = (
  "You are an intent router. Always choose the closest intent among: earliest_eta_part, why_reassigned, door_schedule. "
  "Return JSON only with keys: intent, slots (object), confidence (0-1). If a slot is unknown, omit it."
)

def llm_route_best_effort(question: str) -> Tuple[str, Dict[str, Any], float]:
    t0 = time.time()
    payload = USER_TMPL.format(q=question, schema=json.dumps(SCHEMA_CARD))
    try:
        if PROVIDER == "openai":
            client = _openai_client()
            resp = client.chat.completions.create(
                model=MODEL,
                temperature=0,
                max_tokens=150,
                messages=[
                    {"role":"system","content":BEST_EFFORT_SYSTEM},
                    {"role":"user","content":payload}
                ],
                timeout=BUDGET_MS/1000.0,
            )
            txt = resp.choices[0].message.content
        elif PROVIDER in ("gemini","google"):
            genai, HarmCategory, HarmBlockThreshold = _gemini_client()
            model_name = MODEL if MODEL else "gemini-pro-latest"
            if not model_name.startswith("models/"):
                model_name = f"models/{model_name}"
            safety_settings = [
                {"category": HarmCategory.HARM_CATEGORY_HARASSMENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_HATE_SPEECH, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, "threshold": HarmBlockThreshold.BLOCK_NONE},
                {"category": HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
            ]
            model = genai.GenerativeModel(model_name, safety_settings=safety_settings)
            full_prompt = f"{BEST_EFFORT_SYSTEM}\n\n{payload}"
            resp = model.generate_content(
                full_prompt,
                generation_config=genai.GenerationConfig(temperature=0, max_output_tokens=200)
            )
            if not resp.candidates:
                raise Exception("No candidates")
            if resp.candidates[0].finish_reason == 2:
                raise Exception("Blocked")
            try:
                txt = resp.text
            except Exception:
                if resp.candidates[0].content and resp.candidates[0].content.parts:
                    txt = "".join(part.text for part in resp.candidates[0].content.parts if hasattr(part,'text'))
                else:
                    raise Exception("No parts")
        else:
            client = _anthropic_client()
            resp = client.messages.create(
                model=MODEL,
                max_tokens=200,
                temperature=0,
                system=BEST_EFFORT_SYSTEM,
                messages=[{"role":"user","content":payload}],
                timeout=BUDGET_MS/1000.0,
            )
            txt = "".join(block.text for block in resp.content if getattr(block,"text",None))

        # Clean and parse
        import re
        txt = re.sub(r"```json\s*","", txt)
        txt = re.sub(r"```\s*","", txt)
        parsed = json.loads(txt)
        intent = parsed.get("intent","unknown")
        slots  = parsed.get("slots",{}) or {}
        conf   = float(parsed.get("confidence",0))
        dt_ms  = int((time.time()-t0)*1000)
        # Ensure a valid intent is always returned
        if intent not in ("earliest_eta_part","why_reassigned","door_schedule"):
            intent = "door_schedule"
        return intent, {"slots":slots, "confidence":conf, "latency_ms":dt_ms}, conf
    except Exception:
        dt_ms = int((time.time()-t0)*1000)
        # On error, default to door_schedule with empty slots
        return "door_schedule", {"slots":{}, "confidence":0.0, "latency_ms":dt_ms}, 0.0
