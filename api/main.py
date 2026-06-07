"""
FastAPI application entry point.

Start locally:
    uvicorn api.main:app --reload

Start on Railway (via Procfile / railway.toml):
    python -m uvicorn api.main:app --host 0.0.0.0 --port $PORT
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routers import alerts, delinquency, query, reports

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Regional Market Intelligence API",
    description=(
        "NCUA + FDIC + HMDA + Census → market share by county/MSA/state, "
        "delinquency analytics, NL query, and automated reports."
    ),
    version="0.1.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
_allowed_origins = os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(alerts.router)
app.include_router(delinquency.router)
app.include_router(query.router)
app.include_router(reports.router)


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"message": "Regional Market Intelligence API — see /docs"}
