"""
Market share endpoints.

Data sources (in priority order):
  1. branches_annual (FDIC SOD) — branch-level deposit data, precise county geography
  2. institutions_quarterly (NCUA 5300) — institution-level, uses HQ county_fips

While branches_annual is empty the endpoints fall back to institutions_quarterly
using each institution's HQ county.  Accuracy note shown in confidence field.

Endpoints:
  GET /market-share/periods          → available period strings
  GET /market-share/county-map       → {fips5: share} for choropleth
  GET /market-share                  → ranked institution list for a geography
"""
from __future__ import annotations

import math
from typing import Any, Optional

from fastapi import APIRouter, Query
from sqlalchemy import text

from database import get_engine

router = APIRouter(prefix="/market-share", tags=["market-share"])

# ---------------------------------------------------------------------------
# State FIPS → abbreviation (MarketMap sends 2-digit FIPS; DB stores abbr)
# ---------------------------------------------------------------------------
_STATE_FIPS: dict[str, str] = {
    "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT",
    "10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL",
    "18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD",
    "25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE",
    "32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND",
    "39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD",
    "47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV",
    "55":"WI","56":"WY","72":"PR","78":"VI",
}

def _fips_to_abbr(geo_id: str) -> str:
    """Convert '51' → 'VA'. Pass-through if already an abbreviation."""
    return _STATE_FIPS.get(geo_id.zfill(2), geo_id)

# ---------------------------------------------------------------------------
# Metric → column mappings
# ---------------------------------------------------------------------------
_IQ_METRICS: dict[str, str] = {
    "deposits":             "total_shares_deposits",
    "loans":                "total_loans",
    "members":              "total_members",
    "mortgage_originations":"loans_real_estate",
}

_BA_METRIC = "deposits_thousands"   # branches_annual only has deposits


def _safe(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f) or f < 0) else f
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# GET /market-share/periods
# ---------------------------------------------------------------------------
@router.get("/periods")
async def periods(metric: str = Query(default="deposits")):
    """
    Return available periods.
    FDIC SOD years (e.g. '2024') from branches_annual if populated;
    NCUA quarters (e.g. '2024Q4') from institutions_quarterly always.
    """
    engine = get_engine()
    with engine.connect() as conn:
        # NCUA quarters
        ncua_rows = conn.execute(
            text("SELECT DISTINCT data_period FROM institutions_quarterly ORDER BY data_period DESC LIMIT 20")
        ).fetchall()
        ncua_periods = [r[0] for r in ncua_rows if r[0]]

        # FDIC years (only if branches_annual has data)
        fdic_rows = conn.execute(
            text("SELECT DISTINCT year::text FROM branches_annual ORDER BY year DESC LIMIT 10")
        ).fetchall()
        fdic_periods = [r[0] for r in fdic_rows if r[0]]

    # Prefer FDIC for deposits; NCUA for everything else
    if metric == "deposits" and fdic_periods:
        return fdic_periods
    return ncua_periods if ncua_periods else fdic_periods


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _has_fdic_data(conn) -> bool:
    row = conn.execute(text("SELECT 1 FROM branches_annual LIMIT 1")).fetchone()
    return row is not None


def _resolve_ncua_period(conn, period: str, col: str) -> str:
    """Return the most recent period that has non-NULL data for `col`.

    Falls back when `period` is 'latest', empty, or has no matching rows.
    """
    if period and period.upper() not in ("LATEST", ""):
        has = conn.execute(
            text(f"SELECT 1 FROM institutions_quarterly WHERE data_period = :p AND {col} IS NOT NULL LIMIT 1"),
            {"p": period},
        ).fetchone()
        if has:
            return period
    row = conn.execute(
        text(f"SELECT data_period FROM institutions_quarterly WHERE {col} IS NOT NULL ORDER BY data_period DESC LIMIT 1")
    ).fetchone()
    return row[0] if row else period


def _period_is_annual(period: str) -> bool:
    """'2023' → True (FDIC annual).  '2024Q4' → False (NCUA quarterly)."""
    return len(period) == 4 and period.isdigit()


def _ncua_col(metric: str) -> str:
    return _IQ_METRICS.get(metric, "total_loans")


# ---------------------------------------------------------------------------
# GET /market-share/county-map
# ---------------------------------------------------------------------------
@router.get("/county-map")
async def county_map(
    period: str = Query(default="2024Q4"),
    metric: str = Query(default="deposits"),
    institution_types: str = Query(default="all"),
    institution_id: str = Query(default=""),
):
    """
    Returns {fips5: share} for the choropleth.

    'share' is the fraction (0-1) of the target institution's metric in each
    geography.  When institution_id is blank, uses the largest institution in
    the period.

    Source priority:
      FDIC branches_annual when available (deposits only, annual period)
      NCUA institutions_quarterly otherwise (HQ county, may under-count multi-branch CUs)
    """
    engine = get_engine()
    with engine.connect() as conn:
        use_fdic = _has_fdic_data(conn) and metric == "deposits" and _period_is_annual(period)

        if use_fdic:
            result = _county_map_fdic(conn, period, institution_id)
        else:
            result = _county_map_ncua(conn, period, metric, institution_id, institution_types)

    return result


def _county_map_fdic(conn, period: str, institution_id: str) -> dict:
    year = int(period)

    # Resolve institution cert from institution_id (charter → cert via crosswalk)
    cert = None
    if institution_id:
        row = conn.execute(
            text("""
                SELECT cert_number FROM fdic_ncua_crosswalk
                WHERE charter_number = :cid LIMIT 1
            """),
            {"cid": institution_id},
        ).fetchone()
        if row:
            cert = row[0]

    if not cert:
        # Largest institution in branches_annual for this year
        row = conn.execute(
            text("""
                SELECT cert_number FROM branches_annual
                WHERE year = :yr
                GROUP BY cert_number
                ORDER BY SUM(deposits_thousands) DESC NULLS LAST
                LIMIT 1
            """),
            {"yr": year},
        ).fetchone()
        cert = row[0] if row else None

    if not cert:
        return {}

    # Own deposits by county
    own_rows = conn.execute(
        text("""
            SELECT county_fips, SUM(deposits_thousands) AS dep
            FROM branches_annual
            WHERE year = :yr AND cert_number = :cert AND county_fips IS NOT NULL
            GROUP BY county_fips
        """),
        {"yr": year, "cert": cert},
    ).fetchall()

    # Total deposits by county
    total_rows = conn.execute(
        text("""
            SELECT county_fips, SUM(deposits_thousands) AS dep
            FROM branches_annual
            WHERE year = :yr AND county_fips IS NOT NULL
            GROUP BY county_fips
        """),
        {"yr": year},
    ).fetchall()

    totals = {r[0]: float(r[1]) for r in total_rows if r[1]}
    result = {}
    for r in own_rows:
        fips = r[0]
        own = float(r[1]) if r[1] else 0
        tot = totals.get(fips, 0)
        if tot > 0:
            result[fips] = own / tot
    return result


def _county_map_ncua(conn, period: str, metric: str, institution_id: str, institution_types: str) -> dict:
    col = _ncua_col(metric)
    period = _resolve_ncua_period(conn, period, col)

    # Resolve institution
    if institution_id:
        own_row = conn.execute(
            text(f"""
                SELECT charter_number, county_fips, {col}
                FROM institutions_quarterly
                WHERE charter_number = :id AND data_period = :p
                LIMIT 1
            """),
            {"id": institution_id, "p": period},
        ).mappings().fetchone()
    else:
        own_row = None

    if not own_row:
        # largest institution in period
        own_row = conn.execute(
            text(f"""
                SELECT charter_number, county_fips, {col}
                FROM institutions_quarterly
                WHERE data_period = :p AND {col} IS NOT NULL
                ORDER BY {col} DESC LIMIT 1
            """),
            {"p": period},
        ).mappings().fetchone()

    if not own_row:
        return {}

    own_charter = own_row["charter_number"]

    # Total metric by county across all institutions
    type_filter = ""
    if institution_types == "credit_unions":
        type_filter = ""  # all IQ rows are CUs
    # (banks in IQ is not applicable — IQ is NCUA only)

    totals_rows = conn.execute(
        text(f"""
            SELECT county_fips, SUM({col}) AS total
            FROM institutions_quarterly
            WHERE data_period = :p AND county_fips IS NOT NULL AND {col} IS NOT NULL
            GROUP BY county_fips
        """),
        {"p": period},
    ).fetchall()
    totals = {r[0]: float(r[1]) for r in totals_rows if r[1]}

    # Own institution's metric by county (only HQ county known without FDIC)
    own_fips = own_row.get("county_fips")
    own_val  = _safe(own_row.get(col))

    result = {}
    if own_fips and own_val and own_fips in totals and totals[own_fips] > 0:
        result[own_fips] = own_val / totals[own_fips]

    return result


# ---------------------------------------------------------------------------
# GET /market-share
# ---------------------------------------------------------------------------
@router.get("")
async def market_share(
    geography_type: str = Query(default="county"),
    geography_id: str   = Query(default=""),
    period: str         = Query(default="2024Q4"),
    metric: str         = Query(default="deposits"),
    institution_types: str = Query(default="all"),
    institution_id: str = Query(default=""),
):
    """
    Ranked institution list for a selected geography.

    Returns rows with: charter_or_cert, institution_name, institution_type,
    market_share, share_change_prior_period, value, confidence.
    """
    engine = get_engine()
    with engine.connect() as conn:
        use_fdic = (
            _has_fdic_data(conn)
            and metric == "deposits"
            and _period_is_annual(period)
            and geography_type in ("county", "state")
        )

        if use_fdic:
            # FDIC SOD only covers FDIC-insured institutions (banks/thrifts).
            # Credit unions are NCUA-insured and absent or incomplete in FDIC data.
            # Merge FDIC bank deposits + NCUA CU deposits for a complete picture.
            rows = _ms_deposits_combined(conn, geography_type, geography_id, period)
            if not rows:
                # Last-resort fallback: NCUA-only with estimated confidence.
                # Ensures we always show something per CLAUDE.md confidence rules.
                rows = _ms_ncua(conn, geography_type, geography_id, period, metric, institution_types)
                for r in rows:
                    r["confidence"] = "estimated"
        else:
            rows = _ms_ncua(conn, geography_type, geography_id, period, metric, institution_types)

    return rows


def _prior_period_ncua(period: str) -> str:
    try:
        year, q = int(period[:4]), int(period[5])
        return f"{year - 1}Q4" if q == 1 else f"{year}Q{q - 1}"
    except Exception:
        return period


def _ms_deposits_combined(conn, geo_type: str, geo_id: str, period: str) -> list[dict]:
    """
    Merge FDIC bank deposits + NCUA credit union deposits into one ranked list.

    FDIC SOD is authoritative for banks; NCUA 5300 is authoritative for credit
    unions (CUs are NCUA-insured and largely absent from FDIC SOD).
    Market shares are calculated against the combined deposit total.
    """
    col      = "total_shares_deposits"
    fdic_year = int(period)
    ncua_p   = _resolve_ncua_period(conn, "latest", col)

    # Geography filter — same translation needed for both sources
    if geo_type == "state":
        state_abbr = _fips_to_abbr(geo_id)
        fdic_geo   = "AND b.state = :sa"
        ncua_geo   = "AND q.state = :sa"
        geo_p: dict = {"sa": state_abbr}
    elif geo_type == "county":
        fdic_geo   = "AND b.county_fips = :fips"
        ncua_geo   = "AND q.county_fips = :fips"
        geo_p = {"fips": geo_id}
    else:
        fdic_geo = ncua_geo = ""
        geo_p = {}

    # FDIC: all non-CU institutions (banks, thrifts, NULL file_type).
    # We exclude credit_union to avoid double-counting with NCUA below.
    bank_rows = conn.execute(
        text(f"""
            SELECT cert_number::text AS id, institution_name AS name,
                   SUM(deposits_thousands) AS dep
            FROM branches_annual b
            WHERE year = :yr AND COALESCE(file_type, 'bank') != 'credit_union' {fdic_geo}
            GROUP BY cert_number, institution_name
        """),
        {"yr": fdic_year, **geo_p},
    ).mappings().fetchall()

    # NCUA: credit unions (authoritative source for CU deposits)
    cu_rows = conn.execute(
        text(f"""
            SELECT charter_number::text AS id, institution_name AS name,
                   {col} AS dep
            FROM institutions_quarterly q
            WHERE data_period = :p AND {col} IS NOT NULL AND {col} > 0 {ncua_geo}
        """),
        {"p": ncua_p, **geo_p},
    ).mappings().fetchall()

    has_banks = any(float(r["dep"] or 0) > 0 for r in bank_rows)
    has_cus   = any(float(r["dep"] or 0) > 0 for r in cu_rows)

    if not has_banks and not has_cus:
        return []

    # When FDIC bank data is absent for this geography, still show NCUA CU data
    # with "estimated" confidence (per CLAUDE.md: always display with a confidence badge).
    cu_conf = "measured" if has_banks else "estimated"

    items = (
        [{"id": r["id"], "name": r["name"], "type": "bank",         "dep": float(r["dep"] or 0), "conf": "measured"} for r in bank_rows if float(r["dep"] or 0) > 0] +
        [{"id": r["id"], "name": r["name"], "type": "credit_union", "dep": float(r["dep"] or 0), "conf": cu_conf}     for r in cu_rows   if float(r["dep"] or 0) > 0]
    )
    total = sum(x["dep"] for x in items)
    if total == 0:
        return []

    return [
        {
            "charter_or_cert":           x["id"],
            "institution_name":          x["name"],
            "institution_type":          x["type"],
            "market_share":              x["dep"] / total,
            "value":                     x["dep"],
            "share_change_prior_period": None,
            "confidence":                x["conf"],
        }
        for x in sorted(items, key=lambda r: r["dep"], reverse=True)[:50]
    ]


def _ms_fdic(conn, geo_type: str, geo_id: str, period: str, institution_types: str) -> list[dict]:
    year = int(period)
    prior_year = year - 1

    type_filter = ""
    if institution_types == "credit_unions":
        type_filter = "AND file_type = 'credit_union'"
    elif institution_types == "banks":
        type_filter = "AND file_type = 'bank'"

    if geo_type == "county":
        geo_filter = "AND county_fips = :geo_id"
        params: dict = {"yr": year, "pyr": prior_year, "geo_id": geo_id}
    elif geo_type == "state":
        state_abbr = _fips_to_abbr(geo_id)
        geo_filter = "AND state = :state_abbr"
        params = {"yr": year, "pyr": prior_year, "state_abbr": state_abbr}
    else:
        geo_filter = ""
        params = {"yr": year, "pyr": prior_year}

    rows = conn.execute(
        text(f"""
            WITH cur AS (
                SELECT cert_number, institution_name, file_type,
                       SUM(deposits_thousands) AS dep
                FROM branches_annual
                WHERE year = :yr {geo_filter} {type_filter}
                GROUP BY cert_number, institution_name, file_type
            ),
            prior AS (
                SELECT cert_number, SUM(deposits_thousands) AS dep
                FROM branches_annual
                WHERE year = :pyr {geo_filter}
                GROUP BY cert_number
            ),
            totals AS (SELECT SUM(dep) AS total FROM cur)
            SELECT c.cert_number, c.institution_name, c.file_type,
                   c.dep, p.dep AS prior_dep,
                   t.total
            FROM cur c
            CROSS JOIN totals t
            LEFT JOIN prior p ON p.cert_number = c.cert_number
            WHERE t.total > 0
            ORDER BY c.dep DESC NULLS LAST
            LIMIT 50
        """),
        params,
    ).mappings().fetchall()

    result = []
    for r in rows:
        total   = float(r["total"]) or 1
        dep     = float(r["dep"] or 0)
        pdep    = float(r["prior_dep"] or 0)
        share   = dep / total
        pshare  = pdep / total if pdep and total else None
        change  = (share - pshare) if pshare is not None else None
        result.append({
            "charter_or_cert":         str(r["cert_number"]),
            "institution_name":        r["institution_name"],
            "institution_type":        r["file_type"] or "bank",
            "market_share":            share,
            "value":                   dep,
            "share_change_prior_period": change,
            "confidence":              "measured",
        })
    return result


def _ms_ncua(conn, geo_type: str, geo_id: str, period: str, metric: str, institution_types: str) -> list[dict]:
    col    = _ncua_col(metric)
    period = _resolve_ncua_period(conn, period, col)
    prior_p = _prior_period_ncua(period)

    # Translate state FIPS → abbreviation for state and county queries
    state_abbr = None
    effective_geo_type = geo_type
    confidence = "measured"

    if geo_type == "state":
        state_abbr = _fips_to_abbr(geo_id)
        geo_filter = "AND state = :state_abbr"
        params: dict = {"p": period, "pp": prior_p, "state_abbr": state_abbr}

    elif geo_type == "county":
        # county_fips is only populated for a small fraction of NCUA records
        # (geocoder hasn't run).  Check if there's enough county data;
        # if not, fall back to the state that owns this county.
        county_count = conn.execute(
            text(f"""
                SELECT COUNT(*) FROM institutions_quarterly
                WHERE data_period = :p AND county_fips = :geo_id AND {col} IS NOT NULL
            """),
            {"p": period, "geo_id": geo_id},
        ).scalar()

        if county_count and county_count >= 2:
            geo_filter = "AND county_fips = :geo_id"
            params = {"p": period, "pp": prior_p, "geo_id": geo_id}
            confidence = "modeled"
        else:
            # Fall back: use the state from the 2-digit county FIPS prefix
            state_fips_prefix = str(geo_id).zfill(5)[:2]
            state_abbr = _fips_to_abbr(state_fips_prefix)
            geo_filter = "AND state = :state_abbr"
            params = {"p": period, "pp": prior_p, "state_abbr": state_abbr}
            effective_geo_type = "state"
            confidence = "modeled"  # showing state as proxy for county

    else:
        geo_filter = ""
        params = {"p": period, "pp": prior_p}

    rows = conn.execute(
        text(f"""
            WITH cur AS (
                SELECT charter_number, institution_name,
                       {col} AS val
                FROM institutions_quarterly
                WHERE data_period = :p {geo_filter}
                  AND {col} IS NOT NULL AND {col} > 0
            ),
            prior AS (
                SELECT charter_number, {col} AS val
                FROM institutions_quarterly
                WHERE data_period = :pp {geo_filter}
                  AND {col} IS NOT NULL
            ),
            totals AS (SELECT SUM(val) AS total FROM cur)
            SELECT c.charter_number, c.institution_name,
                   c.val, p.val AS prior_val, t.total
            FROM cur c
            CROSS JOIN totals t
            LEFT JOIN prior p ON p.charter_number = c.charter_number
            WHERE t.total > 0
            ORDER BY c.val DESC NULLS LAST
            LIMIT 50
        """),
        params,
    ).mappings().fetchall()

    result = []
    for r in rows:
        total  = float(r["total"]) or 1
        val    = float(r["val"] or 0)
        pval   = float(r["prior_val"] or 0)
        share  = val / total
        pshare = pval / total if pval and total else None
        change = (share - pshare) if pshare is not None else None
        result.append({
            "charter_or_cert":           r["charter_number"],
            "institution_name":          r["institution_name"],
            "institution_type":          "credit_union",
            "market_share":              share,
            "value":                     val,
            "share_change_prior_period": change,
            "confidence":                confidence,
        })
    return result
