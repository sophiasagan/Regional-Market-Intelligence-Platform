"""
Delinquency analytics endpoints.

All data sourced from NCUA 5300 Call Report (institutions_quarterly table).
Confidence level is always 'measured' — no geographic allocation required.

Endpoints:
  GET /delinquency/summary           → KPI cards for current period
  GET /delinquency/trend             → Multi-period trend for one metric
  GET /delinquency/peer-distribution → Box-plot distribution across peers
  GET /delinquency/loan-breakdown    → Per-loan-type delinquency rates
  GET /delinquency/regional          → All institutions in same state/region
"""
from __future__ import annotations

import math
from typing import Any, Optional

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from database import get_engine

router = APIRouter(prefix="/delinquency", tags=["delinquency"])

# ---------------------------------------------------------------------------
# Allowed metric columns (prevents SQL injection via metric= param)
# ---------------------------------------------------------------------------
ALLOWED_METRICS = {
    "delinq_rate_total",
    "delinq_rate_real_estate",
    "delinq_rate_auto",
    "delinq_rate_credit_card",
    "delinq_rate_commercial",
    "delinq_90plus_rate",
    "chargeoff_rate_total",
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
}


def _prior_period(period: str) -> str:
    """Return the period one quarter before the given period string (e.g. 2024Q1 → 2023Q4)."""
    try:
        year = int(period[:4])
        q = int(period[5])
        if q == 1:
            return f"{year - 1}Q4"
        return f"{year}Q{q - 1}"
    except Exception:
        return period


def _recent_periods(from_period: str, n: int) -> list[str]:
    """Return n consecutive periods ending at from_period, oldest first."""
    periods = [from_period]
    p = from_period
    for _ in range(n - 1):
        p = _prior_period(p)
        periods.append(p)
    return list(reversed(periods))


def _safe_float(v: Any) -> Optional[float]:
    """Convert to float, returning None for NaN/None/inf."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _resolve_institution(conn: sa.Connection, institution_id: str, period: str) -> dict:
    """
    Return the row for the given institution / period.
    Falls back to the largest institution in that period if institution_id is blank.
    """
    if institution_id:
        row = conn.execute(
            text("""
                SELECT * FROM institutions_quarterly
                WHERE charter_number = :id AND data_period = :period
                LIMIT 1
            """),
            {"id": institution_id, "period": period},
        ).mappings().fetchone()
        if row:
            return dict(row)

    # Fallback: largest institution by total_loans in period
    row = conn.execute(
        text("""
            SELECT * FROM institutions_quarterly
            WHERE data_period = :period AND total_loans > 0
            ORDER BY total_loans DESC
            LIMIT 1
        """),
        {"period": period},
    ).mappings().fetchone()

    return dict(row) if row else {}


def _peer_rows(conn: sa.Connection, own: dict, period: str, peer_type: str = "state") -> list[dict]:
    """
    Return peer institutions for the given institution.

    peer_type='state'  → same state, total_assets within ±75 % of own
    peer_type='national' → total_assets within ±50 % of own, any state
    peer_type='regional' → same state (alias kept for frontend compat)
    """
    own_assets = _safe_float(own.get("total_assets")) or 0
    own_state = own.get("state") or ""

    if own_assets > 0:
        lo = own_assets * 0.25
        hi = own_assets * 4.0
        asset_filter = "AND total_assets BETWEEN :lo AND :hi"
        asset_params: dict = {"lo": lo, "hi": hi}
    else:
        asset_filter = ""
        asset_params = {}

    if peer_type in ("state", "regional"):
        where = "WHERE data_period = :period AND state = :state " + asset_filter
        params = {"period": period, "state": own_state, **asset_params}
    else:
        where = "WHERE data_period = :period " + asset_filter
        params = {"period": period, **asset_params}

    rows = conn.execute(
        text(f"""
            SELECT charter_number, institution_name, state,
                   total_assets, total_loans,
                   delinq_rate_total, delinq_rate_real_estate, delinq_rate_auto,
                   delinq_rate_credit_card, delinq_rate_commercial, delinq_90plus_rate,
                   chargeoff_rate_total, alll_coverage_ratio, alll_to_loans_ratio
            FROM institutions_quarterly
            {where}
            ORDER BY total_assets DESC
            LIMIT 200
        """),
        params,
    ).mappings().fetchall()
    return [dict(r) for r in rows]


def _distribution_stats(values: list[float]) -> dict:
    """Compute p10/p25/median/p75/p90 from a sorted list of floats."""
    v = sorted(x for x in values if x is not None and not math.isnan(x))
    if not v:
        return {"p10": None, "p25": None, "median": None, "p75": None, "p90": None}

    def pct(p: float) -> float:
        idx = p * (len(v) - 1)
        lo, hi = int(idx), min(int(idx) + 1, len(v) - 1)
        return v[lo] + (v[hi] - v[lo]) * (idx - lo)

    return {
        "p10": pct(0.10),
        "p25": pct(0.25),
        "median": pct(0.50),
        "p75": pct(0.75),
        "p90": pct(0.90),
    }


def _percentile_rank(own_value: Optional[float], peers_values: list[float]) -> Optional[float]:
    if own_value is None:
        return None
    v = sorted(x for x in peers_values if x is not None and not math.isnan(x))
    if not v:
        return None
    below = sum(1 for x in v if x < own_value)
    return below / len(v)


# ---------------------------------------------------------------------------
# GET /delinquency/summary
# ---------------------------------------------------------------------------
@router.get("/summary")
async def summary(
    institution_id: str = Query(default=""),
    period: str = Query(default="2024Q4"),
):
    engine = get_engine()
    with engine.connect() as conn:
        own = _resolve_institution(conn, institution_id, period)
        if not own:
            raise HTTPException(404, f"No data found for period {period}")

        prior_period = _prior_period(period)
        prior = _resolve_institution(conn, own.get("charter_number", ""), prior_period)

        peers = _peer_rows(conn, own, period)

    def metric_summary(key: str, is_coverage: bool = False) -> dict:
        own_val = _safe_float(own.get(key))
        prior_val = _safe_float(prior.get(key)) if prior else None
        peer_vals = [_safe_float(p.get(key)) for p in peers]
        peer_vals = [v for v in peer_vals if v is not None]
        stats = _distribution_stats(peer_vals)
        rank = _percentile_rank(own_val, peer_vals)
        return {
            "value": own_val,
            "prior_value": prior_val,
            "peer_median": stats["median"],
            "peer_p25": stats["p25"],
            "peer_p75": stats["p75"],
            "percentile_rank": rank,
        }

    return {
        "institution_name": own.get("institution_name"),
        "charter_number": own.get("charter_number"),
        "period": period,
        "prior_period": prior_period,
        "state": own.get("state"),
        "total_loans": _safe_float(own.get("total_loans")),
        "total_assets": _safe_float(own.get("total_assets")),
        "confidence": "measured",
        "metrics": {
            "delinq_rate_total":    metric_summary("delinq_rate_total"),
            "delinq_90plus_rate":   metric_summary("delinq_90plus_rate"),
            "alll_coverage_ratio":  metric_summary("alll_coverage_ratio", is_coverage=True),
            "chargeoff_rate_total": metric_summary("chargeoff_rate_total"),
        },
    }


# ---------------------------------------------------------------------------
# GET /delinquency/trend
# ---------------------------------------------------------------------------
@router.get("/trend")
async def trend(
    institution_id: str = Query(default=""),
    metric: str = Query(default="delinq_rate_total"),
    n_periods: int = Query(default=8, ge=2, le=20),
):
    if metric not in ALLOWED_METRICS:
        raise HTTPException(400, f"metric must be one of: {sorted(ALLOWED_METRICS)}")

    latest_period = "2024Q4"
    periods = _recent_periods(latest_period, n_periods)

    engine = get_engine()
    with engine.connect() as conn:
        # Own institution data across periods
        own_rows_raw = conn.execute(
            text(f"""
                SELECT data_period, {metric}, charter_number, state, total_assets
                FROM institutions_quarterly
                WHERE data_period = ANY(:periods)
                  AND (:cid = '' OR charter_number = :cid)
                ORDER BY data_period ASC
            """),
            {"periods": periods, "cid": institution_id},
        ).mappings().fetchall()

        if not own_rows_raw and not institution_id:
            # Fallback: pick largest institution and use its periods
            fallback = conn.execute(
                text("""
                    SELECT charter_number, state, total_assets
                    FROM institutions_quarterly
                    WHERE data_period = :p AND total_loans > 0
                    ORDER BY total_loans DESC LIMIT 1
                """),
                {"p": latest_period},
            ).mappings().fetchone()
            if fallback:
                own_rows_raw = conn.execute(
                    text(f"""
                        SELECT data_period, {metric}, charter_number, state, total_assets
                        FROM institutions_quarterly
                        WHERE data_period = ANY(:periods) AND charter_number = :cid
                        ORDER BY data_period ASC
                    """),
                    {"periods": periods, "cid": fallback["charter_number"]},
                ).mappings().fetchall()

        own_rows = {r["data_period"]: r for r in own_rows_raw}

        # Use state/assets from latest available row for peer matching
        ref_row = own_rows.get(latest_period) or (list(own_rows.values())[-1] if own_rows else {})
        ref_state = ref_row.get("state") or ""
        ref_assets = _safe_float(ref_row.get("total_assets")) or 0

        lo = ref_assets * 0.25 if ref_assets > 0 else 0
        hi = ref_assets * 4.0 if ref_assets > 0 else 1e15

        # Peer percentiles per period
        peer_stats_raw = conn.execute(
            text(f"""
                SELECT data_period,
                       percentile_cont(0.25) WITHIN GROUP (ORDER BY {metric}) AS p25,
                       percentile_cont(0.50) WITHIN GROUP (ORDER BY {metric}) AS median,
                       percentile_cont(0.75) WITHIN GROUP (ORDER BY {metric}) AS p75
                FROM institutions_quarterly
                WHERE data_period = ANY(:periods)
                  AND {metric} IS NOT NULL
                  AND {metric} > 0
                  AND (:state = '' OR state = :state)
                  AND (:lo = 0 OR total_assets BETWEEN :lo AND :hi)
                GROUP BY data_period
                ORDER BY data_period ASC
            """),
            {"periods": periods, "state": ref_state, "lo": lo, "hi": hi},
        ).mappings().fetchall()

    peer_by_period = {r["data_period"]: r for r in peer_stats_raw}

    own_values = [_safe_float((own_rows.get(p) or {}).get(metric)) for p in periods]
    peer_median = [_safe_float((peer_by_period.get(p) or {}).get("median")) for p in periods]
    peer_p25    = [_safe_float((peer_by_period.get(p) or {}).get("p25")) for p in periods]
    peer_p75    = [_safe_float((peer_by_period.get(p) or {}).get("p75")) for p in periods]

    return {
        "periods": periods,
        "metric": metric,
        "own_values": own_values,
        "peer_median": peer_median,
        "peer_p25": peer_p25,
        "peer_p75": peer_p75,
    }


# ---------------------------------------------------------------------------
# GET /delinquency/peer-distribution
# ---------------------------------------------------------------------------
@router.get("/peer-distribution")
async def peer_distribution(
    institution_id: str = Query(default=""),
    period: str = Query(default="2024Q4"),
    metric: str = Query(default="delinq_rate_total"),
    peer_type: str = Query(default="state"),
):
    if metric not in ALLOWED_METRICS:
        raise HTTPException(400, f"metric must be one of: {sorted(ALLOWED_METRICS)}")

    engine = get_engine()
    with engine.connect() as conn:
        own = _resolve_institution(conn, institution_id, period)
        peers = _peer_rows(conn, own, period, peer_type)

    own_val = _safe_float(own.get(metric))
    peer_values = [_safe_float(p.get(metric)) for p in peers]
    peer_values_clean = [v for v in peer_values if v is not None]

    stats = _distribution_stats(peer_values_clean)
    rank = _percentile_rank(own_val, peer_values_clean)

    own_charter = own.get("charter_number", "")
    peer_list = [
        {
            "charter_number": p.get("charter_number"),
            "name": p.get("institution_name"),
            "value": _safe_float(p.get(metric)),
            "is_own": p.get("charter_number") == own_charter,
        }
        for p in peers
        if _safe_float(p.get(metric)) is not None
    ]
    peer_list.sort(key=lambda x: x["value"] or 0)

    return {
        "period": period,
        "metric": metric,
        "peer_type": peer_type,
        "distribution": stats,
        "own_value": own_val,
        "own_percentile_rank": rank,
        "peers": peer_list[:50],  # cap for response size
    }


# ---------------------------------------------------------------------------
# GET /delinquency/loan-breakdown
# ---------------------------------------------------------------------------
@router.get("/loan-breakdown")
async def loan_breakdown(
    institution_id: str = Query(default=""),
    period: str = Query(default="2024Q4"),
):
    engine = get_engine()
    with engine.connect() as conn:
        own = _resolve_institution(conn, institution_id, period)
        peers = _peer_rows(conn, own, period)

    loan_type_map = [
        ("real_estate", "Real Estate",  "delinq_rate_real_estate"),
        ("auto",        "Auto",         "delinq_rate_auto"),
        ("credit_card", "Credit Card",  "delinq_rate_credit_card"),
        ("commercial",  "Commercial",   "delinq_rate_commercial"),
    ]

    result = []
    for key, label, rate_col in loan_type_map:
        own_rate = _safe_float(own.get(rate_col))
        peer_rates = [_safe_float(p.get(rate_col)) for p in peers]
        peer_rates_clean = [v for v in peer_rates if v is not None and v > 0]
        stats = _distribution_stats(peer_rates_clean)
        result.append({
            "key": key,
            "label": label,
            "own_rate": own_rate,
            "peer_median": stats["median"],
            "peer_p25": stats["p25"],
            "peer_p75": stats["p75"],
        })

    return {
        "period": period,
        "institution_name": own.get("institution_name"),
        "loan_types": result,
    }


# ---------------------------------------------------------------------------
# GET /delinquency/regional
# ---------------------------------------------------------------------------
@router.get("/regional")
async def regional(
    institution_id: str = Query(default=""),
    period: str = Query(default="2024Q4"),
):
    engine = get_engine()
    with engine.connect() as conn:
        own = _resolve_institution(conn, institution_id, period)
        if not own:
            raise HTTPException(404, f"No data for period {period}")

        own_state = own.get("state") or ""
        own_charter = own.get("charter_number", "")

        state_rows = conn.execute(
            text("""
                SELECT charter_number, institution_name, state,
                       total_loans, delinq_rate_total
                FROM institutions_quarterly
                WHERE data_period = :period
                  AND state = :state
                  AND delinq_rate_total IS NOT NULL
                  AND delinq_rate_total > 0
                ORDER BY total_loans DESC
                LIMIT 60
            """),
            {"period": period, "state": own_state},
        ).mappings().fetchall()

    rows = [dict(r) for r in state_rows]
    rates = [_safe_float(r.get("delinq_rate_total")) for r in rows]
    rates_clean = [v for v in rates if v is not None]
    stats = _distribution_stats(rates_clean)

    return {
        "period": period,
        "geography_label": f"{own_state} State",
        "market_median": stats["median"],
        "institutions": [
            {
                "charter_number": r.get("charter_number"),
                "name": r.get("institution_name"),
                "state": r.get("state"),
                "delinq_rate": _safe_float(r.get("delinq_rate_total")),
                "total_loans": _safe_float(r.get("total_loans")),
                "is_own": r.get("charter_number") == own_charter,
            }
            for r in rows
        ],
    }
