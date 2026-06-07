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

    Falls back gracefully:
    1. Exact match (institution_id + period)
    2. Institution's most recent available period (if future period requested)
    3. Largest institution in the requested period
    4. Largest institution in the most recent available period
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

        # Institution exists but not in this period — use most recent period
        row = conn.execute(
            text("""
                SELECT * FROM institutions_quarterly
                WHERE charter_number = :id AND total_loans > 0
                ORDER BY data_period DESC
                LIMIT 1
            """),
            {"id": institution_id},
        ).mappings().fetchone()
        if row:
            return dict(row)

    # No institution_id — largest institution in requested period
    row = conn.execute(
        text("""
            SELECT * FROM institutions_quarterly
            WHERE data_period = :period AND total_loans > 0
            ORDER BY total_loans DESC
            LIMIT 1
        """),
        {"period": period},
    ).mappings().fetchone()
    if row:
        return dict(row)

    # Final fallback: largest institution in most recent available period
    row = conn.execute(
        text("""
            SELECT * FROM institutions_quarterly
            WHERE total_loans > 0
            ORDER BY data_period DESC, total_loans DESC
            LIMIT 1
        """),
    ).mappings().fetchone()

    return dict(row) if row else {}


_PEER_SELECT = """
    SELECT charter_number, institution_name, state,
           total_assets, total_loans,
           delinq_rate_total, delinq_rate_real_estate, delinq_rate_auto,
           delinq_rate_credit_card, delinq_rate_commercial, delinq_90plus_rate,
           chargeoff_rate_total, alll_coverage_ratio, alll_to_loans_ratio
    FROM institutions_quarterly
"""
_MIN_PEERS = 8  # minimum useful peer group size


def _peer_rows(conn: sa.Connection, own: dict, period: str, peer_type: str = "state") -> list[dict]:
    """
    Return peer institutions using a progressive fallback strategy so that
    very large or very small CUs always get a meaningful peer group.

    Pass 1: same state + same asset tier (±4x own assets)
    Pass 2: same state only (no asset filter)
    Pass 3: national + same asset tier
    Pass 4: national, no filter (full dataset)
    """
    own_assets = _safe_float(own.get("total_assets")) or 0
    own_state = own.get("state") or ""
    own_charter = own.get("charter_number", "")

    lo = own_assets * 0.25 if own_assets > 0 else 0
    hi = own_assets * 4.0  if own_assets > 0 else 1e15

    def _fetch(where: str, params: dict) -> list[dict]:
        rows = conn.execute(
            text(f"{_PEER_SELECT} WHERE {where} ORDER BY total_assets DESC LIMIT 200"),
            params,
        ).mappings().fetchall()
        return [dict(r) for r in rows]

    use_national = peer_type not in ("state", "regional")

    if not use_national:
        # Pass 1: state + asset tier
        rows = _fetch(
            "data_period = :period AND state = :state AND total_assets BETWEEN :lo AND :hi",
            {"period": period, "state": own_state, "lo": lo, "hi": hi},
        )
        if len(rows) >= _MIN_PEERS:
            return rows

        # Pass 2: state only
        rows = _fetch(
            "data_period = :period AND state = :state",
            {"period": period, "state": own_state},
        )
        if len(rows) >= _MIN_PEERS:
            return rows

    # Pass 3: national + asset tier
    if own_assets > 0:
        rows = _fetch(
            "data_period = :period AND total_assets BETWEEN :lo AND :hi",
            {"period": period, "lo": lo, "hi": hi},
        )
        if len(rows) >= _MIN_PEERS:
            return rows

    # Pass 4: full national dataset
    rows = _fetch("data_period = :period", {"period": period})
    return rows


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
        "n_institutions": len(v),
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
        # CECL institutions report no ALLL — show null rather than misleading 0.00x
        if is_coverage and own_val == 0.0 and _safe_float(own.get("alll")) == 0.0:
            own_val = None
        prior_val = _safe_float(prior.get(key)) if prior else None
        if is_coverage and prior_val == 0.0 and _safe_float((prior or {}).get("alll")) == 0.0:
            prior_val = None
        peer_vals = [_safe_float(p.get(key)) for p in peers]
        # Exclude CECL peers (alll=0) from coverage distribution
        if is_coverage:
            peer_vals = [
                v for v, p in zip(peer_vals, peers)
                if v is not None and v > 0 and (_safe_float(p.get("alll")) or 0) > 0
            ]
        else:
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

    own_state = own.get("state") or ""
    return {
        "institution_name": own.get("institution_name"),
        "charter_number": own.get("charter_number"),
        "period": period,
        "prior_period": prior_period,
        "state": own_state,
        "total_loans": _safe_float(own.get("total_loans")),
        "total_assets": _safe_float(own.get("total_assets")),
        "confidence": "measured",
        "primary_geography": {"type": "state", "id": own_state, "label": f"{own_state} State"},
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
    period: str = Query(default=""),
    metric: str = Query(default="delinq_rate_total"),
    n_periods: int = Query(default=8, ge=2, le=20),
):
    if metric not in ALLOWED_METRICS:
        raise HTTPException(400, f"metric must be one of: {sorted(ALLOWED_METRICS)}")

    # Resolve the end period: requested period if data exists, else latest available
    engine = get_engine()
    with engine.connect() as conn:
        latest_row = conn.execute(
            text("""
                SELECT data_period FROM institutions_quarterly
                WHERE total_loans > 0
                ORDER BY data_period DESC LIMIT 1
            """)
        ).fetchone()
        latest_available = latest_row[0] if latest_row else "2024Q4"

        if period:
            has_period = conn.execute(
                text("SELECT 1 FROM institutions_quarterly WHERE data_period = :p LIMIT 1"),
                {"p": period},
            ).fetchone()
            latest_period = period if has_period else latest_available
        else:
            latest_period = latest_available

    periods = _recent_periods(latest_period, n_periods)

    # Build safe IN-clause: :p0, :p1, ... :pN
    p_keys = [f"p{i}" for i in range(len(periods))]
    p_placeholders = ", ".join(f":{k}" for k in p_keys)
    p_params = {k: v for k, v in zip(p_keys, periods)}

    engine = get_engine()
    with engine.connect() as conn:
        # Own institution data across periods
        own_rows_raw = conn.execute(
            text(f"""
                SELECT data_period, {metric}, charter_number, state, total_assets
                FROM institutions_quarterly
                WHERE data_period IN ({p_placeholders})
                  AND (:cid = '' OR charter_number = :cid)
                ORDER BY data_period ASC
            """),
            {**p_params, "cid": institution_id},
        ).mappings().fetchall()

        if not own_rows_raw and not institution_id:
            # Fallback: pick largest institution in most recent available period
            fallback = conn.execute(
                text("""
                    SELECT charter_number, state, total_assets
                    FROM institutions_quarterly
                    WHERE total_loans > 0
                    ORDER BY data_period DESC, total_loans DESC LIMIT 1
                """),
            ).mappings().fetchone()
            if fallback:
                own_rows_raw = conn.execute(
                    text(f"""
                        SELECT data_period, {metric}, charter_number, state, total_assets
                        FROM institutions_quarterly
                        WHERE charter_number = :cid
                        ORDER BY data_period ASC
                        LIMIT :n
                    """),
                    {"cid": fallback["charter_number"], "n": n_periods},
                ).mappings().fetchall()

        own_rows = {r["data_period"]: r for r in own_rows_raw}

        # Use state/assets from latest available row for peer matching
        ref_row = (list(own_rows.values()) or [{}])[-1]
        ref_state = ref_row.get("state") or ""
        ref_assets = _safe_float(ref_row.get("total_assets")) or 0

        lo = ref_assets * 0.25 if ref_assets > 0 else 0
        hi = ref_assets * 4.0 if ref_assets > 0 else 1e15

        # Actual periods that have own data — query peer stats for those
        actual_periods = list(own_rows.keys()) or periods
        ap_keys = [f"ap{i}" for i in range(len(actual_periods))]
        ap_placeholders = ", ".join(f":{k}" for k in ap_keys)
        ap_params = {k: v for k, v in zip(ap_keys, actual_periods)}

        peer_stats_raw = conn.execute(
            text(f"""
                SELECT data_period,
                       percentile_cont(0.25) WITHIN GROUP (ORDER BY {metric}) AS p25,
                       percentile_cont(0.50) WITHIN GROUP (ORDER BY {metric}) AS median,
                       percentile_cont(0.75) WITHIN GROUP (ORDER BY {metric}) AS p75
                FROM institutions_quarterly
                WHERE data_period IN ({ap_placeholders})
                  AND {metric} IS NOT NULL
                  AND {metric} > 0
                  AND (:state = '' OR state = :state)
                  AND (:lo = 0 OR total_assets BETWEEN :lo AND :hi)
                GROUP BY data_period
                ORDER BY data_period ASC
            """),
            {**ap_params, "state": ref_state, "lo": lo, "hi": hi},
        ).mappings().fetchall()

    peer_by_period = {r["data_period"]: r for r in peer_stats_raw}

    display_periods = actual_periods if own_rows else periods
    own_values = [_safe_float((own_rows.get(p) or {}).get(metric)) for p in display_periods]
    peer_median = [_safe_float((peer_by_period.get(p) or {}).get("median")) for p in display_periods]
    peer_p25    = [_safe_float((peer_by_period.get(p) or {}).get("p25")) for p in display_periods]
    peer_p75    = [_safe_float((peer_by_period.get(p) or {}).get("p75")) for p in display_periods]

    return {
        "periods": display_periods,
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

        # Use the actual period that data was found in (may differ from requested period)
        resolved_period = own.get("data_period", period)
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
            {"period": resolved_period, "state": own_state},
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


# ---------------------------------------------------------------------------
# GET /delinquency/regional/context
# ---------------------------------------------------------------------------
# NOTE: This route must be defined BEFORE /regional to avoid FastAPI treating
# "context" as a path parameter on the /regional/{something} route pattern.
# (We use the explicit /regional/context path and it works fine as a sibling
# of /regional because FastAPI matches exact segments first.)
@router.get("/regional/context")
async def regional_context(
    institution_id: str = Query(default=""),
    geography_type: str = Query(default="state"),
    geography_id: str = Query(default=""),
    period: str = Query(default="2024Q4"),
):
    """
    Regional delinquency context for RegionalContextPanel.

    Returns all credit unions in the same state as the resolved institution,
    with 3-quarter trend direction, summary statistics, and a rule-based
    interpretation (regional stress vs institution-specific vs healthy).

    Bank data is not included (no FDIC call report ingested yet) — institution_type
    is always 'credit_union' and bank_median is always null.
    """
    import datetime

    engine = get_engine()
    with engine.connect() as conn:
        own = _resolve_institution(conn, institution_id, period)
        if not own:
            raise HTTPException(404, f"No data for period {period}")

        resolved_period = own.get("data_period", period)
        own_state = own.get("state") or ""
        own_charter = own.get("charter_number", "")

        # Build 3-quarter window for trend calculation
        p0 = resolved_period
        p1 = _prior_period(p0)
        p2 = _prior_period(p1)
        trend_periods = [p2, p1, p0]

        tp_keys = [f"tp{i}" for i in range(len(trend_periods))]
        tp_placeholders = ", ".join(f":{k}" for k in tp_keys)
        tp_params = {k: v for k, v in zip(tp_keys, trend_periods)}

        # Fetch delinquency rates for all state CUs across 3 periods
        trend_rows = conn.execute(
            text(f"""
                SELECT charter_number, institution_name, data_period, delinq_rate_total
                FROM institutions_quarterly
                WHERE data_period IN ({tp_placeholders})
                  AND state = :state
                  AND delinq_rate_total IS NOT NULL
                ORDER BY charter_number, data_period
            """),
            {**tp_params, "state": own_state},
        ).mappings().fetchall()

        # Current-period institutions for the base list
        current_rows = conn.execute(
            text("""
                SELECT charter_number, institution_name, total_loans, delinq_rate_total
                FROM institutions_quarterly
                WHERE data_period = :period
                  AND state = :state
                  AND delinq_rate_total IS NOT NULL
                ORDER BY total_loans DESC NULLS LAST
                LIMIT 60
            """),
            {"period": resolved_period, "state": own_state},
        ).mappings().fetchall()

    # Build trend map: charter → {period: rate}
    trend_map: dict[str, dict[str, Optional[float]]] = {}
    for r in trend_rows:
        c = r["charter_number"]
        if c not in trend_map:
            trend_map[c] = {}
        trend_map[c][r["data_period"]] = _safe_float(r["delinq_rate_total"])

    def _trend_direction(charter: str) -> str:
        rates_by_period = trend_map.get(charter, {})
        earliest = _safe_float(rates_by_period.get(p2))
        latest   = _safe_float(rates_by_period.get(p0))
        if earliest is None or latest is None:
            return "stable"
        delta = latest - earliest
        if delta > 0.001:   # >0.1pp rise
            return "rising"
        if delta < -0.001:
            return "falling"
        return "stable"

    # Build institution list for response
    institutions = []
    for r in current_rows:
        charter = r["charter_number"]
        institutions.append({
            "charter_or_cert": charter,
            "name": r["institution_name"],
            "institution_type": "credit_union",
            "is_own": charter == own_charter,
            "delinq_rate": _safe_float(r["delinq_rate_total"]),
            "trend": _trend_direction(charter),
        })

    # Summary statistics
    all_rates = [i["delinq_rate"] for i in institutions if i["delinq_rate"] is not None]
    cu_rates  = [i["delinq_rate"] for i in institutions if i["delinq_rate"] is not None and i["institution_type"] == "credit_union"]
    stats = _distribution_stats(all_rates)
    cu_stats = _distribution_stats(cu_rates)

    n_total   = len(institutions)
    n_rising  = sum(1 for i in institutions if i["trend"] == "rising")
    own_rate  = next((i["delinq_rate"] for i in institutions if i["is_own"]), None)

    # Own institution's prior rates (3-quarter sparkline)
    own_prior_rates = [
        _safe_float((trend_map.get(own_charter) or {}).get(p))
        for p in trend_periods
    ]
    own_prior_rates = [v for v in own_prior_rates if v is not None]

    # Rule-based interpretation
    majority_rising = n_rising > n_total * 0.5 if n_total > 0 else False
    own_above_median = own_rate is not None and stats["median"] is not None and own_rate > stats["median"] * 1.3
    market_rate_elevated = stats["median"] is not None and stats["median"] > 0.015

    if majority_rising and market_rate_elevated:
        interp_type = "regional_stress"
        narrative = (
            f"{n_rising} of {n_total} credit unions in {own_state} show rising delinquency over the past "
            f"3 quarters, with a market median of {stats['median']*100:.2f}%. "
            "This pattern is consistent with regional economic headwinds rather than institution-specific credit issues. "
            "Consider peer benchmarking to distinguish macro-driven from portfolio-management factors."
        )
    elif own_above_median and not majority_rising:
        interp_type = "institution_specific"
        narrative = (
            f"Most credit unions in {own_state} show stable delinquency ({stats['median']*100:.2f}% median), "
            f"but your institution's rate is elevated relative to the regional market. "
            "This institution-specific pattern warrants a portfolio review — underwriting criteria, "
            "concentration risk, or collection effectiveness may be contributing factors."
        )
    elif not majority_rising and (stats["median"] is None or stats["median"] < 0.01):
        interp_type = "healthy"
        median_str = f"{stats['median']*100:.2f}%" if stats["median"] is not None else "—"
        narrative = (
            f"Credit union delinquency in {own_state} is broadly healthy. "
            f"The regional median is {median_str} with only {n_rising} of {n_total} institutions "
            "showing a rising trend. No widespread regional stress is evident from current NCUA data."
        )
    else:
        interp_type = "mixed"
        narrative = (
            f"{n_rising} of {n_total} credit unions in {own_state} are trending upward. "
            f"Regional median delinquency is {(stats['median'] or 0)*100:.2f}%. "
            "The picture is mixed — monitor for acceleration over the next 1–2 quarters before drawing conclusions."
        )

    return {
        "period": resolved_period,
        "geography_label": f"{own_state} State",
        "geography_type": geography_type or "state",
        "geography_id": geography_id or own_state,
        "institution_median": stats["median"],
        "cu_median": cu_stats["median"],
        "bank_median": None,  # FDIC data not yet ingested
        "own_rate": own_rate,
        "own_prior_rates": own_prior_rates,
        "n_rising_3q": n_rising,
        "n_total": n_total,
        "institutions": institutions,
        "interpretation": {
            "type": interp_type,
            "narrative": narrative,
            "refreshed_at": datetime.datetime.utcnow().isoformat() + "Z",
        },
        "economy_signals": {
            "available": False,
        },
    }
