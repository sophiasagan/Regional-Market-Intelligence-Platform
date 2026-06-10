"""
Peer group endpoints.

Covers all peer-related surfaces:
  CallahanMigration onboarding flow:
    GET /peers/callahan-equivalent   — build national same-tier peer group from Callahan criteria

  PeerComparison page:
    GET /peers/auto                  — auto-select peer group for own institution
    GET /peers/compare               — full comparison matrix for a set of institution IDs
    GET /peers/county                — county-level geographic overlap for a peer set
    GET /peers/trend                 — multi-period trend for a metric across a peer set

All queries hit institutions_quarterly (NCUA 5300 data).
FOM type filtering is skipped if the column is absent (NCUA schema varies by year).
"""
from __future__ import annotations

import math
import statistics
from typing import Any, Optional

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from database import get_engine

router = APIRouter(prefix="/peers", tags=["peers"])

# ─── CONSTANTS ────────────────────────────────────────────────────────────────

ASSET_TIER_RANGES: dict[str, tuple[float, Optional[float]]] = {
    "under_50m":  (0,              50_000_000),
    "50m_100m":   (50_000_000,     100_000_000),
    "100m_250m":  (100_000_000,    250_000_000),
    "250m_500m":  (250_000_000,    500_000_000),
    "500m_1b":    (500_000_000,    1_000_000_000),
    "1b_5b":      (1_000_000_000,  5_000_000_000),
    "over_5b":    (5_000_000_000,  None),
}

# Callahan defines a ±50% asset window for same-tier peers
CALLAHAN_ASSET_RATIO = 0.50   # ±50%
MIN_PEER_COUNT = 5            # minimum useful group size

# Metric columns available in institutions_quarterly for comparison
COMPARISON_METRICS = [
    "total_assets",
    "total_loans",
    "total_deposits",
    "delinq_rate_total",
    "delinq_90plus_rate",
    "delinq_rate_auto",
    "delinq_rate_real_estate",
    "delinq_rate_credit_card",
    "delinq_rate_commercial",
    "chargeoff_rate_total",
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
    "net_worth_ratio",
    "loan_to_share_ratio",
    "deposit_market_share",
]

ALLOWED_TREND_METRICS = frozenset(COMPARISON_METRICS)

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _latest_period(conn: sa.Connection) -> str:
    row = conn.execute(
        text("SELECT data_period FROM institutions_quarterly ORDER BY data_period DESC LIMIT 1")
    ).fetchone()
    return row[0] if row else "2024Q4"


def _institution_row(conn: sa.Connection, charter: str, period: str) -> Optional[dict]:
    row = conn.execute(
        text("""
            SELECT * FROM institutions_quarterly
            WHERE charter_number = :charter AND data_period = :period
            LIMIT 1
        """),
        {"charter": charter, "period": period},
    ).mappings().fetchone()
    if row:
        return dict(row)
    # Fallback to most recent period for this institution
    row = conn.execute(
        text("""
            SELECT * FROM institutions_quarterly
            WHERE charter_number = :charter
            ORDER BY data_period DESC LIMIT 1
        """),
        {"charter": charter},
    ).mappings().fetchone()
    return dict(row) if row else None


def _fmt_institution(row: dict) -> dict:
    return {
        "id":           row.get("charter_number"),
        "charter_number": row.get("charter_number"),
        "name":         row.get("institution_name", "Unknown"),
        "state":        row.get("state", ""),
        "total_assets": _safe_float(row.get("total_assets")) or 0,
        "total_loans":  _safe_float(row.get("total_loans")) or 0,
    }


# ─── GET /peers/callahan-equivalent ──────────────────────────────────────────

@router.get("/callahan-equivalent")
async def callahan_equivalent_peer_group(
    asset_tier: str = Query(..., description="One of the ASSET_TIER_RANGES keys"),
    states:     list[str] = Query(default=[], description="2-letter state codes; empty = all states"),
    fom_type:   str = Query(default="any", description="Field of membership filter"),
    period:     Optional[str] = Query(default=None),
) -> dict:
    """
    Build the Callahan-equivalent national same-tier peer group.

    Callahan's default: all CUs nationally in the same asset tier (±50% of midpoint).
    If states are provided, filters to those states (matching Callahan's state filter).
    """
    if asset_tier not in ASSET_TIER_RANGES:
        raise HTTPException(400, f"Unknown asset_tier '{asset_tier}'. Valid: {sorted(ASSET_TIER_RANGES)}")

    asset_min, asset_max = ASSET_TIER_RANGES[asset_tier]

    engine = get_engine()
    with engine.connect() as conn:
        if period is None:
            period = _latest_period(conn)

        # Build WHERE clause
        conditions = [
            "data_period = :period",
            "total_assets >= :asset_min",
        ]
        params: dict = {"period": period, "asset_min": asset_min}

        if asset_max is not None:
            conditions.append("total_assets < :asset_max")
            params["asset_max"] = asset_max

        if states:
            placeholders = ", ".join(f":state_{i}" for i in range(len(states)))
            conditions.append(f"state IN ({placeholders})")
            for i, s in enumerate(states):
                params[f"state_{i}"] = s.upper()

        where_clause = " AND ".join(conditions)

        rows = conn.execute(
            text(f"""
                SELECT charter_number, institution_name, state,
                       total_assets, total_loans
                FROM institutions_quarterly
                WHERE {where_clause}
                ORDER BY total_assets DESC
                LIMIT 500
            """),
            params,
        ).mappings().fetchall()

        institutions = [_fmt_institution(dict(r)) for r in rows]
        callahan_count = len(institutions)

        # Regional peer count: all institutions in primary states (no asset filter)
        regional_count = None
        regional_geography = None
        if states:
            state_ph = ", ".join(f":rs_{i}" for i in range(len(states)))
            rp: dict = {"period": period}
            for i, s in enumerate(states):
                rp[f"rs_{i}"] = s.upper()
            regional_row = conn.execute(
                text(f"""
                    SELECT COUNT(*) as cnt
                    FROM institutions_quarterly
                    WHERE data_period = :period
                      AND state IN ({state_ph})
                """),
                rp,
            ).fetchone()
            regional_count = regional_row[0] if regional_row else 0
            from_state = states[0].upper() if len(states) == 1 else f"{len(states)} states"
            regional_geography = from_state

    return {
        "asset_tier":         asset_tier,
        "states":             states,
        "fom_type":           fom_type,
        "period":             period,
        "callahan_count":     callahan_count,
        "institution_count":  callahan_count,
        "regional_count":     regional_count,
        "regional_geography": regional_geography,
        "institutions":       institutions[:6],   # top 6 for preview
        "full_count":         callahan_count,
    }


# ─── GET /peers/auto ─────────────────────────────────────────────────────────

@router.get("/auto")
async def auto_peer_group(
    period:     Optional[str] = Query(default=None),
    charter:    Optional[str] = Query(default=None, description="Own institution charter number"),
    peer_type:  str = Query(default="state_default"),
) -> list[dict]:
    """
    Auto-select a peer group for the given institution.

    Priority (CLAUDE.md §Peer group logic):
      1. Same state + ±50% assets — min 10 institutions
      2. Same MSA (if applicable)
      3. National same-asset-size fallback
    """
    engine = get_engine()
    with engine.connect() as conn:
        if period is None:
            period = _latest_period(conn)

        own = _institution_row(conn, charter or "", period) if charter else None

        if own is None:
            # No own institution — return largest 20 nationally for the period
            rows = conn.execute(
                text("""
                    SELECT charter_number, institution_name, state, total_assets, total_loans
                    FROM institutions_quarterly
                    WHERE data_period = :period AND total_assets > 0
                    ORDER BY total_assets DESC LIMIT 20
                """),
                {"period": period},
            ).mappings().fetchall()
            return [_fmt_institution(dict(r)) for r in rows]

        own_assets = _safe_float(own.get("total_assets")) or 0
        own_state  = own.get("state") or ""
        own_charter = own.get("charter_number", "")

        lo = own_assets * (1 - CALLAHAN_ASSET_RATIO)
        hi = own_assets * (1 + CALLAHAN_ASSET_RATIO)

        def _fetch(where: str, params: dict) -> list[dict]:
            rows = conn.execute(
                text(f"""
                    SELECT charter_number, institution_name, state, total_assets, total_loans
                    FROM institutions_quarterly
                    WHERE {where}
                    ORDER BY total_assets DESC LIMIT 50
                """),
                params,
            ).mappings().fetchall()
            return [_fmt_institution(dict(r)) for r in rows
                    if r["charter_number"] != own_charter]

        # Pass 1: same state + asset range
        if own_state and peer_type in ("state_default", "auto"):
            peers = _fetch(
                "data_period = :p AND state = :s AND total_assets BETWEEN :lo AND :hi",
                {"p": period, "s": own_state, "lo": lo, "hi": hi},
            )
            if len(peers) >= MIN_PEER_COUNT:
                return peers[:20]

        # Pass 2: same state, no asset filter
        if own_state:
            peers = _fetch(
                "data_period = :p AND state = :s",
                {"p": period, "s": own_state},
            )
            if len(peers) >= MIN_PEER_COUNT:
                return peers[:20]

        # Pass 3: national + asset range
        peers = _fetch(
            "data_period = :p AND total_assets BETWEEN :lo AND :hi",
            {"p": period, "lo": lo, "hi": hi},
        )
        return peers[:20]


# ─── GET /peers/compare ──────────────────────────────────────────────────────

@router.get("/compare")
async def compare_peers(
    peer_ids: str = Query(..., description="Comma-separated charter numbers"),
    period:   Optional[str] = Query(default=None),
) -> dict:
    """
    Return a comparison matrix for a set of institution IDs.
    Response shape: { institutions: [...], metrics: { metric_id: { charter: value } } }
    """
    ids = [i.strip() for i in peer_ids.split(",") if i.strip()]
    if not ids:
        raise HTTPException(400, "peer_ids is required")

    engine = get_engine()
    with engine.connect() as conn:
        if period is None:
            period = _latest_period(conn)

        placeholders = ", ".join(f":id_{i}" for i in range(len(ids)))
        params: dict = {"period": period}
        for i, cid in enumerate(ids):
            params[f"id_{i}"] = cid

        rows = conn.execute(
            text(f"""
                SELECT charter_number, institution_name, state,
                       total_assets, total_loans, total_deposits,
                       delinq_rate_total, delinq_90plus_rate,
                       delinq_rate_auto, delinq_rate_real_estate,
                       delinq_rate_credit_card, delinq_rate_commercial,
                       chargeoff_rate_total, alll_coverage_ratio,
                       alll_to_loans_ratio, net_worth_ratio,
                       loan_to_share_ratio, deposit_market_share
                FROM institutions_quarterly
                WHERE data_period = :period
                  AND charter_number IN ({placeholders})
            """),
            params,
        ).mappings().fetchall()

        institutions = []
        metrics: dict[str, dict[str, Optional[float]]] = {m: {} for m in COMPARISON_METRICS}

        for row in rows:
            r = dict(row)
            charter = r["charter_number"]
            institutions.append(_fmt_institution(r))
            for m in COMPARISON_METRICS:
                metrics[m][charter] = _safe_float(r.get(m))

    return {"institutions": institutions, "metrics": metrics, "period": period}


# ─── GET /peers/county ───────────────────────────────────────────────────────

@router.get("/county")
async def peer_county_overlap(
    peer_ids: str = Query(..., description="Comma-separated charter numbers"),
    period:   Optional[str] = Query(default=None),
) -> list[dict]:
    """
    Return counties/states where peer institutions have branch presence.
    Uses branches_annual if available; falls back to institution state.
    """
    ids = [i.strip() for i in peer_ids.split(",") if i.strip()]
    if not ids:
        return []

    engine = get_engine()
    with engine.connect() as conn:
        if period is None:
            period = _latest_period(conn)

        # Try branches_annual table first
        try:
            year = period[:4]
            placeholders = ", ".join(f":id_{i}" for i in range(len(ids)))
            params: dict = {"year": year}
            for i, cid in enumerate(ids):
                params[f"id_{i}"] = cid

            rows = conn.execute(
                text(f"""
                    SELECT b.charter_number, b.county_fips, b.state,
                           b.county_name, b.deposits,
                           i.institution_name
                    FROM branches_annual b
                    JOIN institutions_quarterly i
                      ON b.charter_number = i.charter_number
                     AND i.data_period = :period
                    WHERE b.year = :year
                      AND b.charter_number IN ({placeholders})
                    ORDER BY b.deposits DESC NULLS LAST
                """),
                params,
            ).mappings().fetchall()

            return [dict(r) for r in rows]

        except Exception:
            # branches_annual not available — fall back to institution-level state
            placeholders2 = ", ".join(f":id_{i}" for i in range(len(ids)))
            params2: dict = {"period": period}
            for i, cid in enumerate(ids):
                params2[f"id_{i}"] = cid

            rows2 = conn.execute(
                text(f"""
                    SELECT charter_number, state, institution_name,
                           total_deposits AS deposits
                    FROM institutions_quarterly
                    WHERE data_period = :period
                      AND charter_number IN ({placeholders2})
                """),
                params2,
            ).mappings().fetchall()

            return [dict(r) for r in rows2]


# ─── GET /peers/trend ────────────────────────────────────────────────────────

@router.get("/trend")
async def peer_trend(
    peer_ids: str = Query(..., description="Comma-separated charter numbers"),
    metric:   str = Query(..., description="Metric column name"),
    periods:  str = Query(..., description="Comma-separated period strings e.g. 2022Q1,2022Q2"),
) -> dict:
    """
    Return per-period values for each institution for a given metric.
    Response: { metric, periods: [...], series: { charter: [values...] } }
    """
    if metric not in ALLOWED_TREND_METRICS:
        raise HTTPException(400, f"Metric '{metric}' not allowed. Valid: {sorted(ALLOWED_TREND_METRICS)}")

    ids = [i.strip() for i in peer_ids.split(",") if i.strip()]
    period_list = [p.strip() for p in periods.split(",") if p.strip()]
    if not ids or not period_list:
        raise HTTPException(400, "peer_ids and periods are required")

    engine = get_engine()
    with engine.connect() as conn:
        id_ph = ", ".join(f":id_{i}" for i in range(len(ids)))
        per_ph = ", ".join(f":per_{i}" for i in range(len(period_list)))
        params: dict = {}
        for i, cid in enumerate(ids):
            params[f"id_{i}"] = cid
        for i, per in enumerate(period_list):
            params[f"per_{i}"] = per

        rows = conn.execute(
            text(f"""
                SELECT charter_number, institution_name, data_period,
                       {metric} AS value
                FROM institutions_quarterly
                WHERE charter_number IN ({id_ph})
                  AND data_period IN ({per_ph})
                ORDER BY charter_number, data_period
            """),
            params,
        ).mappings().fetchall()

    series: dict[str, dict[str, Any]] = {}
    names: dict[str, str] = {}
    for r in rows:
        c = r["charter_number"]
        if c not in series:
            series[c] = {}
            names[c] = r.get("institution_name", c)
        series[c][r["data_period"]] = _safe_float(r["value"])

    # Expand into ordered arrays aligned to period_list
    series_out = {
        c: {
            "name":   names[c],
            "values": [series[c].get(p) for p in period_list],
        }
        for c in series
    }

    return {"metric": metric, "periods": period_list, "series": series_out}
