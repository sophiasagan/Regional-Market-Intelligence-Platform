"""
Natural-language query endpoint — market share and delinquency/credit quality.

POST /ask  →  two-turn Claude pattern:
  Turn 1: tool selection and parameter extraction
  Turn 2: narrative synthesis over tool results (delinquency only)

Market-share questions return structured QueryResult (raw data, no narrative).
Delinquency questions return DelinquencyQueryResult (narrative + structured data).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import anthropic
import sqlalchemy as sa
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_engine
from processing.delinquency_engine import (
    get_peer_distribution,
    get_percentile_rank,
    get_regional_peers,
)
from processing.market_share_engine import (
    VALID_GEOGRAPHY_TYPES,
    VALID_INSTITUTION_TYPES,
    VALID_METRICS,
    calculate_market_share,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ask", tags=["query"])

_client = anthropic.AsyncAnthropic()

# ── Metric sets exposed to Claude ─────────────────────────────────────────────

_DELINQ_RATE_METRICS = [
    "delinq_rate_total",
    "delinq_rate_auto",
    "delinq_rate_real_estate",
    "delinq_rate_credit_card",
    "delinq_rate_commercial",
    "delinq_90plus_rate",
]

_CHARGEOFF_LOAN_TYPES = ["total", "auto", "credit_card", "real_estate", "commercial"]

_ALL_DELINQ_METRICS = _DELINQ_RATE_METRICS + [
    "chargeoff_rate_total",
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
    "tdr_to_loans_ratio",
    "oreo_to_assets_ratio",
]

_LOAN_BREAKDOWN_PAIRS = [
    ("real_estate",  "delinq_rate_real_estate",  "Real Estate"),
    ("auto",         "delinq_rate_auto",          "Auto"),
    ("credit_card",  "delinq_rate_credit_card",   "Credit Card"),
    ("commercial",   "delinq_rate_commercial",    "Commercial"),
]

# ── Tool definitions ──────────────────────────────────────────────────────────

_QUERY_TOOL: dict[str, Any] = {
    "name": "run_market_share_query",
    "description": (
        "Execute a market share query. Use for questions about deposit share, "
        "loan share, market presence, competitive position, or branch footprint. "
        "Call once you have identified the geography, period, metric, and institution types."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "geography_type": {
                "type": "string",
                "enum": sorted(VALID_GEOGRAPHY_TYPES),
                "description": "county | msa | state | custom_region",
            },
            "geography_id": {
                "type": "string",
                "description": (
                    "5-digit FIPS for county; CBSA code for msa; "
                    "2-letter abbreviation for state; name for custom_region"
                ),
            },
            "period": {
                "type": "string",
                "description": "YYYYQ# for loans/members; YYYY for deposits. Default '2023'.",
            },
            "metric": {
                "type": "string",
                "enum": sorted(VALID_METRICS),
            },
            "institution_types": {
                "type": "array",
                "items": {"type": "string", "enum": sorted(VALID_INSTITUTION_TYPES)},
                "minItems": 1,
            },
            "natural_language_summary": {
                "type": "string",
                "description": "One sentence describing the query in plain English.",
            },
        },
        "required": [
            "geography_type", "geography_id", "period",
            "metric", "institution_types", "natural_language_summary",
        ],
    },
}

_DELINQUENCY_COMPARISON_TOOL: dict[str, Any] = {
    "name": "get_delinquency_comparison",
    "description": (
        "Get an institution's delinquency rate for a specific metric, compared to peers. "
        "Use for questions like 'Is our auto loan delinquency a problem?', "
        "'How does our 90-day rate compare?', or 'Are we above average on charge-offs?'. "
        "Returns: own rate, peer median, percentile rank, 4-quarter trend."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "charter": {
                "type": "string",
                "description": "NCUA charter number. Use own_charter from context for 'our' questions.",
            },
            "metric": {
                "type": "string",
                "enum": _ALL_DELINQ_METRICS,
                "description": "Delinquency metric to compare.",
            },
            "period": {
                "type": "string",
                "description": "Reporting period: YYYYQ# (e.g. 2024Q4).",
            },
            "peer_group_type": {
                "type": "string",
                "enum": ["regional", "national"],
                "description": (
                    "regional = institutions with branch presence in same county/MSA; "
                    "national = same-state institutions within ±50% of asset size"
                ),
            },
        },
        "required": ["charter", "metric", "period", "peer_group_type"],
    },
}

_DELINQUENCY_TREND_TOOL: dict[str, Any] = {
    "name": "get_delinquency_trend",
    "description": (
        "Get quarterly trend data for a delinquency metric, with peer median at each point. "
        "Use when the question asks about direction, trajectory, getting better/worse, "
        "or compares performance over time."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "charter": {"type": "string"},
            "metric": {"type": "string", "enum": _ALL_DELINQ_METRICS},
            "n_quarters": {
                "type": "integer",
                "minimum": 2,
                "maximum": 12,
                "description": "Number of quarters to include. Default 8.",
            },
        },
        "required": ["charter", "metric", "n_quarters"],
    },
}

_REGIONAL_DELINQUENCY_TOOL: dict[str, Any] = {
    "name": "get_regional_delinquency",
    "description": (
        "Get delinquency rates for all credit unions in a geography, sorted ascending. "
        "Use for questions like 'How do we compare to other CUs in Palm Beach County?', "
        "'Where do we rank in our market?', or 'Is delinquency rising across our market?'. "
        "Distinguishes institution-specific from market-wide trends."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "geography_type": {"type": "string", "enum": ["county", "msa", "state"]},
            "geography_id": {
                "type": "string",
                "description": "5-digit FIPS for county; CBSA code for msa; 2-letter abbreviation for state.",
            },
            "metric": {"type": "string", "enum": _DELINQ_RATE_METRICS},
            "period": {"type": "string", "description": "YYYYQ# (e.g. 2024Q4)"},
        },
        "required": ["geography_type", "geography_id", "metric", "period"],
    },
}

_LOAN_TYPE_BREAKDOWN_TOOL: dict[str, Any] = {
    "name": "get_loan_type_breakdown",
    "description": (
        "Get delinquency rates for all loan types (real estate, auto, credit card, commercial) "
        "with peer medians and percentile ranks for each. "
        "Use for questions like 'Which loan type is our biggest concern?', "
        "'Where is our delinquency concentrated?', or 'Which portfolio has the most pressure?'."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "charter": {"type": "string"},
            "period": {"type": "string"},
        },
        "required": ["charter", "period"],
    },
}

_CHARGE_OFF_ANALYSIS_TOOL: dict[str, Any] = {
    "name": "get_charge_off_analysis",
    "description": (
        "Get charge-off rate for a loan type, peer comparison, and ALLL reserve adequacy assessment. "
        "Use for questions about actual losses, write-offs, charge-offs, or reserve adequacy."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "charter": {"type": "string"},
            "loan_type": {
                "type": "string",
                "enum": _CHARGEOFF_LOAN_TYPES,
                "description": "'total' for all loans combined.",
            },
            "period": {"type": "string"},
        },
        "required": ["charter", "loan_type", "period"],
    },
}

_ALL_TOOLS = [
    _QUERY_TOOL,
    _DELINQUENCY_COMPARISON_TOOL,
    _DELINQUENCY_TREND_TOOL,
    _REGIONAL_DELINQUENCY_TOOL,
    _LOAN_TYPE_BREAKDOWN_TOOL,
    _CHARGE_OFF_ANALYSIS_TOOL,
]

# ── System prompts ────────────────────────────────────────────────────────────

def _build_system_prompt(context: dict[str, Any]) -> str:
    own_charter  = context.get("own_charter", "(unknown — ask if needed)")
    own_county   = context.get("primary_county", "(unknown)")
    own_msa      = context.get("primary_msa", "(unknown)")
    own_state    = context.get("own_state", "(unknown)")
    return f"""\
You are a market intelligence and credit quality analyst for a credit union. \
Translate competitive and portfolio-quality questions into precise tool calls. \
Never respond in plain text — always call exactly one tool.

Own institution:
  NCUA charter:   {own_charter}
  Primary county: {own_county}   (5-digit FIPS)
  Primary MSA:    {own_msa}      (CBSA code)
  State:          {own_state}

Tool selection guide:
  Deposit / loan market share, competitive position, branch footprint
    → run_market_share_query
  Delinquency rate for one metric vs peers
    → get_delinquency_comparison  (peer_group_type: regional preferred)
  Trend over time for a delinquency metric
    → get_delinquency_trend
  All institutions in a geography ranked by delinquency
    → get_regional_delinquency  (use primary_county or primary_msa)
  Which loan type has the most pressure
    → get_loan_type_breakdown
  Charge-offs, actual losses, reserve adequacy
    → get_charge_off_analysis

Geography IDs:
  county: 5-digit FIPS (e.g. "12099" = Palm Beach, FL)
  state:  2-letter abbreviation (e.g. "FL")
  msa:    CBSA code (e.g. "33100" = Miami-Fort Lauderdale)

Periods: YYYYQ# for delinquency/loan questions (e.g. "2024Q4"). \
Default to the most recent quarter when unspecified.\
"""


_SYNTHESIS_PROMPT = """\
You are a financial analyst for a credit union. Synthesize the retrieved data \
into a direct, quantified response.

Rules:
- All rate values in the data are decimal fractions — multiply by 100 for percentages \
  (0.018 → 1.8%)
- State specific numbers: "1.8%" not "elevated"; "71st percentile" not "above average"
- Explain percentile rank in plain terms: "71st percentile means 71% of comparable \
  institutions have a lower rate"
- Flag concern when rate exceeds peer 75th percentile; note if it is above 90th
- When trend data is available: note whether the institution's rate is rising faster \
  or slower than the peer median — this identifies institution-specific vs market-wide pressure
- For ALLL coverage below 1.0x: state this is below the examiner alert threshold
- Concise: 2–4 sentences for comparisons; up to 6 for breakdowns or complex analyses
- End with a concrete next-step only when a metric is at or above the peer 75th percentile
- Do not hedge with "may" or "might" when you have actual numbers — state what the data shows\
"""

# ── Request / Response models ─────────────────────────────────────────────────

class AskRequest(BaseModel):
    question: str
    context: dict[str, Any] = {}


class QueryResult(BaseModel):
    question: str
    summary: str
    geography_type: str
    geography_id: str
    period: str
    metric: str
    institution_types: list[str]
    results: list[dict[str, Any]]
    confidence_distribution: dict[str, int]


class DelinquencyQueryResult(BaseModel):
    question: str
    query_type: str
    narrative: str
    data: dict[str, Any]


# ── Utilities ─────────────────────────────────────────────────────────────────

def _prior_quarters(from_period: str, n: int) -> list[str]:
    """Return n quarter strings ending at from_period (inclusive), oldest-first."""
    yr, q = int(from_period[:4]), int(from_period[5])
    out: list[str] = []
    for _ in range(n):
        out.append(f"{yr}Q{q}")
        q -= 1
        if q < 1:
            q, yr = 4, yr - 1
    return list(reversed(out))


def _resolve_charter(args: dict[str, Any], context: dict[str, Any]) -> str:
    charter = args.get("charter") or context.get("own_charter", "")
    if not charter:
        raise HTTPException(422, "No NCUA charter number available. Pass own_charter in context.")
    return charter

# ── Synchronous DB helpers (called via asyncio.to_thread) ─────────────────────

def _db_fetch_row(
    charter: str, period: str, cols: list[str], engine: sa.engine.Engine,
) -> dict[str, Any]:
    col_sql = ", ".join(cols)
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(f"""
                SELECT DISTINCT ON (charter_number) {col_sql}
                FROM   institutions_quarterly
                WHERE  charter_number = :cn
                  AND  data_period    = :period
                ORDER  BY charter_number, ingested_at DESC
                LIMIT  1
            """),
            {"cn": charter, "period": period},
        ).fetchone()
    return dict(zip(cols, row)) if row else {c: None for c in cols}


def _db_fetch_series(
    charter: str, metric: str, periods: list[str], engine: sa.engine.Engine,
) -> dict[str, float | None]:
    """Return {period: value} for the requested quarters."""
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(f"""
                SELECT DISTINCT ON (data_period) data_period, {metric}
                FROM   institutions_quarterly
                WHERE  charter_number = :cn
                  AND  data_period    = ANY(:periods)
                ORDER  BY data_period, ingested_at DESC
            """),
            {"cn": charter, "periods": periods},
        ).fetchall()
    return {str(r[0]): r[1] for r in rows}


def _db_geo_institutions(
    geography_type: str, geography_id: str, metric: str,
    period: str, engine: sa.engine.Engine,
) -> list[dict[str, Any]]:
    """All credit unions in a geography with their metric values."""
    year = int(period[:4])

    if geography_type == "county":
        geo_cte = "SELECT DISTINCT ba.charter_number FROM branches_annual ba WHERE ba.county_fips = :geo_id AND ba.year = :year AND ba.charter_number IS NOT NULL"
    elif geography_type == "msa":
        geo_cte = """
            SELECT DISTINCT ba.charter_number
            FROM   branches_annual ba
            JOIN   cbsa_county_crosswalk c ON c.county_fips = ba.county_fips
            WHERE  c.cbsa_code = :geo_id AND ba.year = :year AND ba.charter_number IS NOT NULL
        """
    else:  # state — fall back to institutions_quarterly.state
        geo_cte = "SELECT DISTINCT charter_number FROM institutions_quarterly WHERE state = :geo_id AND data_period = :period"

    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(f"""
                WITH geo_cus AS ({geo_cte})
                SELECT DISTINCT ON (iq.charter_number)
                    iq.charter_number,
                    iq.institution_name,
                    iq.{metric}
                FROM   institutions_quarterly iq
                JOIN   geo_cus g ON iq.charter_number = g.charter_number
                WHERE  iq.data_period = :period
                  AND  iq.{metric}   IS NOT NULL
                ORDER  BY iq.charter_number, iq.ingested_at DESC
            """),
            {"geo_id": geography_id, "period": period, "year": year},
        ).fetchall()
    return [{"charter_number": r[0], "institution_name": r[1], "rate": r[2]} for r in rows]


def _db_national_peers(
    charter: str, period: str, own_assets: float, engine: sa.engine.Engine,
) -> list[str]:
    lo, hi = own_assets * 0.5, own_assets * 2.0
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("""
                SELECT DISTINCT ON (charter_number) charter_number
                FROM   institutions_quarterly
                WHERE  total_assets BETWEEN :lo AND :hi
                  AND  charter_number != :cn
                  AND  data_period    = :period
                ORDER  BY charter_number, ingested_at DESC
                LIMIT  150
            """),
            {"lo": lo, "hi": hi, "cn": charter, "period": period},
        ).fetchall()
    return [str(r[0]) for r in rows]

# ── Peer group resolver ───────────────────────────────────────────────────────

async def _resolve_peers(
    charter: str, peer_group_type: str, period: str,
    context: dict[str, Any], engine: sa.engine.Engine,
) -> list[str]:
    if peer_group_type == "national":
        row = await asyncio.to_thread(_db_fetch_row, charter, period, ["total_assets"], engine)
        assets = row.get("total_assets")
        if assets:
            return await asyncio.to_thread(_db_national_peers, charter, period, float(assets), engine)

    # Regional: use primary geography from context, fall back to state
    region_id   = context.get("primary_county") or context.get("primary_msa")
    region_type = "county" if context.get("primary_county") else "msa" if context.get("primary_msa") else "state"
    return await asyncio.to_thread(get_regional_peers, charter, region_type, region_id or context.get("own_state", ""), period, engine)

# ── Tool executors ────────────────────────────────────────────────────────────

async def _exec_comparison(
    args: dict[str, Any], context: dict[str, Any], engine: sa.engine.Engine,
) -> dict[str, Any]:
    charter = _resolve_charter(args, context)
    metric  = args["metric"]
    period  = args["period"]

    own_row, peers = await asyncio.gather(
        asyncio.to_thread(_db_fetch_row, charter, period, [metric, "total_assets"], engine),
        _resolve_peers(charter, args.get("peer_group_type", "regional"), period, context, engine),
    )
    own_value = own_row.get(metric)

    dist = await asyncio.to_thread(get_peer_distribution, metric, period, peers, engine)
    pct_rank = get_percentile_rank(own_value, dist) if own_value is not None else None

    # 4-quarter trend
    trend_periods = _prior_quarters(period, 4)
    series = await asyncio.to_thread(_db_fetch_series, charter, metric, trend_periods, engine)

    trend_medians: dict[str, float | None] = {}
    async def _period_median(p: str) -> None:
        d = await asyncio.to_thread(get_peer_distribution, metric, p, peers, engine)
        trend_medians[p] = d.get("median")

    await asyncio.gather(*[_period_median(p) for p in trend_periods])

    trend = [
        {"period": p, "own_rate": series.get(p), "peer_median": trend_medians.get(p)}
        for p in trend_periods
    ]

    return {
        "charter": charter,
        "metric": metric,
        "period": period,
        "own_rate": own_value,
        "peer_median": dist.get("median"),
        "peer_p25": dist.get("p25"),
        "peer_p75": dist.get("p75"),
        "peer_p90": dist.get("p90"),
        "percentile_rank": pct_rank,
        "n_peers": dist.get("n_institutions"),
        "peer_group_type": args.get("peer_group_type", "regional"),
        "trend": trend,
    }


async def _exec_trend(
    args: dict[str, Any], context: dict[str, Any], engine: sa.engine.Engine,
) -> dict[str, Any]:
    charter    = _resolve_charter(args, context)
    metric     = args["metric"]
    n_quarters = int(args.get("n_quarters", 8))
    latest     = context.get("latest_period", "2024Q4")
    periods    = _prior_quarters(latest, n_quarters)

    peers  = await _resolve_peers(charter, "regional", periods[-1], context, engine)
    series = await asyncio.to_thread(_db_fetch_series, charter, metric, periods, engine)

    async def _peer_median(p: str) -> tuple[str, float | None]:
        d = await asyncio.to_thread(get_peer_distribution, metric, p, peers, engine)
        return p, d.get("median")

    medians_list = await asyncio.gather(*[_peer_median(p) for p in periods])
    peer_medians = dict(medians_list)

    return {
        "charter": charter,
        "metric": metric,
        "periods": periods,
        "own_values": [series.get(p) for p in periods],
        "peer_medians": [peer_medians.get(p) for p in periods],
        "n_peers": len(peers),
    }


async def _exec_regional(
    args: dict[str, Any], context: dict[str, Any], engine: sa.engine.Engine,
) -> dict[str, Any]:
    geo_type   = args["geography_type"]
    geo_id     = args["geography_id"]
    metric     = args["metric"]
    period     = args["period"]
    own_charter = context.get("own_charter", "")

    institutions = await asyncio.to_thread(
        _db_geo_institutions, geo_type, geo_id, metric, period, engine
    )

    if not institutions:
        return {
            "geography_type": geo_type, "geography_id": geo_id,
            "metric": metric, "period": period,
            "institutions": [], "market_median": None, "n_rising": 0,
        }

    rates     = [i["rate"] for i in institutions if i["rate"] is not None]
    median    = sorted(rates)[len(rates) // 2] if rates else None

    # Tag own institution and compute 3-quarter trend direction
    prev_periods = _prior_quarters(period, 3)[:-1]  # 2 prior quarters
    trend_counts: dict[str, int] = {}
    if prev_periods and own_charter:
        own_series = await asyncio.to_thread(_db_fetch_series, own_charter, metric, [period] + prev_periods, engine)
        vals = [own_series.get(p) for p in sorted(own_series)]
        if len(vals) >= 2 and all(v is not None for v in vals):
            trend_counts["own_trend"] = "rising" if vals[-1] > vals[0] else "falling" if vals[-1] < vals[0] else "stable"

    result_insts = sorted(
        [
            {
                "charter_number": i["charter_number"],
                "institution_name": i["institution_name"],
                "rate": i["rate"],
                "is_own": i["charter_number"] == own_charter,
            }
            for i in institutions
        ],
        key=lambda x: x["rate"] or 0,
    )

    return {
        "geography_type": geo_type,
        "geography_id": geo_id,
        "metric": metric,
        "period": period,
        "market_median": median,
        "n_institutions": len(result_insts),
        "institutions": result_insts,
        **trend_counts,
    }


async def _exec_loan_breakdown(
    args: dict[str, Any], context: dict[str, Any], engine: sa.engine.Engine,
) -> dict[str, Any]:
    charter = _resolve_charter(args, context)
    period  = args["period"]

    metrics = [m for _, m, _ in _LOAN_BREAKDOWN_PAIRS]
    own_row, peers = await asyncio.gather(
        asyncio.to_thread(_db_fetch_row, charter, period, metrics, engine),
        _resolve_peers(charter, "regional", period, context, engine),
    )

    async def _type_entry(loan_type: str, metric: str, label: str) -> dict[str, Any]:
        own_rate = own_row.get(metric)
        dist     = await asyncio.to_thread(get_peer_distribution, metric, period, peers, engine)
        pct_rank = get_percentile_rank(own_rate, dist) if own_rate is not None else None
        return {
            "loan_type":       loan_type,
            "label":           label,
            "metric":          metric,
            "own_rate":        own_rate,
            "peer_median":     dist.get("median"),
            "peer_p75":        dist.get("p75"),
            "peer_p90":        dist.get("p90"),
            "percentile_rank": pct_rank,
            "n_peers":         dist.get("n_institutions"),
        }

    entries = await asyncio.gather(*[_type_entry(*t) for t in _LOAN_BREAKDOWN_PAIRS])
    sorted_entries = sorted(
        [e for e in entries if e["percentile_rank"] is not None],
        key=lambda x: x["percentile_rank"],
        reverse=True,
    )

    return {
        "charter": charter,
        "period": period,
        "loan_types": sorted_entries,
        "worst_type": sorted_entries[0]["loan_type"] if sorted_entries else None,
    }


async def _exec_chargeoff(
    args: dict[str, Any], context: dict[str, Any], engine: sa.engine.Engine,
) -> dict[str, Any]:
    charter   = _resolve_charter(args, context)
    loan_type = args["loan_type"]
    period    = args["period"]

    co_metric    = "chargeoff_rate_total" if loan_type == "total" else f"chargeoff_rate_{loan_type}"
    fetch_cols   = [co_metric, "alll_coverage_ratio", "alll_to_loans_ratio"]

    own_row, peers = await asyncio.gather(
        asyncio.to_thread(_db_fetch_row, charter, period, fetch_cols, engine),
        _resolve_peers(charter, "regional", period, context, engine),
    )

    co_rate   = own_row.get(co_metric)
    alll_cov  = own_row.get("alll_coverage_ratio")

    co_dist, alll_dist = await asyncio.gather(
        asyncio.to_thread(get_peer_distribution, co_metric, period, peers, engine),
        asyncio.to_thread(get_peer_distribution, "alll_coverage_ratio", period, peers, engine),
    )

    co_rank   = get_percentile_rank(co_rate,  co_dist)   if co_rate  is not None else None
    alll_rank = get_percentile_rank(alll_cov, alll_dist) if alll_cov is not None else None

    # ALLL adequacy thresholds from CLAUDE.md: 1.0x = examiner minimum
    if alll_cov is None:
        alll_adequacy = "unknown"
    elif alll_cov < 1.0:
        alll_adequacy = "inadequate"  # below examiner alert threshold
    elif alll_cov < 1.5:
        alll_adequacy = "watch"
    else:
        alll_adequacy = "adequate"

    return {
        "charter": charter,
        "loan_type": loan_type,
        "period": period,
        "chargeoff_rate": co_rate,
        "chargeoff_peer_median": co_dist.get("median"),
        "chargeoff_peer_p75": co_dist.get("p75"),
        "chargeoff_percentile_rank": co_rank,
        "alll_coverage_ratio": alll_cov,
        "alll_peer_median": alll_dist.get("median"),
        "alll_percentile_rank": alll_rank,
        "alll_adequacy": alll_adequacy,
        "n_peers": co_dist.get("n_institutions"),
    }


_DISPATCH = {
    "get_delinquency_comparison": _exec_comparison,
    "get_delinquency_trend":      _exec_trend,
    "get_regional_delinquency":   _exec_regional,
    "get_loan_type_breakdown":    _exec_loan_breakdown,
    "get_charge_off_analysis":    _exec_chargeoff,
}

# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/")
async def ask(body: AskRequest) -> dict[str, Any]:
    """
    Translate a natural-language question into a structured query and execute it.

    Market-share questions: single-tool extraction + calculate_market_share.
    Delinquency questions:  tool extraction + executor + Claude narrative synthesis.
    """
    tool_name, tool_args = await _first_turn(body.question, body.context)

    if tool_name == "run_market_share_query":
        summary = tool_args.pop("natural_language_summary")
        try:
            df = calculate_market_share(**tool_args)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return QueryResult(
            question=body.question,
            summary=summary,
            results=df.to_dict(orient="records"),
            confidence_distribution=df["confidence"].value_counts().to_dict() if not df.empty else {},
            **tool_args,
        ).model_dump()

    if tool_name not in _DISPATCH:
        logger.error("Unknown tool returned by Claude: %s", tool_name)
        raise HTTPException(502, f"Unrecognised tool: {tool_name}")

    engine   = get_engine()
    executor = _DISPATCH[tool_name]
    try:
        data = await executor(tool_args, body.context, engine)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Delinquency executor '%s' failed", tool_name)
        raise HTTPException(502, f"Data retrieval failed: {exc}") from exc

    narrative = await _synthesize(body.question, tool_name, data)

    return DelinquencyQueryResult(
        question=body.question,
        query_type=tool_name,
        narrative=narrative,
        data=data,
    ).model_dump()


# ── Claude helpers ────────────────────────────────────────────────────────────

async def _first_turn(
    question: str, context: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Turn 1: identify which tool to call and extract its parameters."""
    user_content = question
    if context:
        user_content += f"\n\nContext: {json.dumps(context)}"

    response = await _client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1024,
        thinking={"type": "adaptive"},
        system=_build_system_prompt(context),
        messages=[{"role": "user", "content": user_content}],
        tools=_ALL_TOOLS,
        tool_choice={"type": "any"},
    )

    for block in response.content:
        if block.type == "tool_use":
            return block.name, dict(block.input)

    logger.error("Claude did not call a tool; content: %s", response.content)
    raise HTTPException(502, "Query parsing failed: no structured parameters returned.")


async def _synthesize(question: str, tool_name: str, data: dict[str, Any]) -> str:
    """Turn 2: produce a concise natural-language narrative from tool results."""
    user_content = (
        f"The user asked: {question}\n\n"
        f"Data retrieved via {tool_name}:\n"
        f"{json.dumps(data, indent=2, default=str)}\n\n"
        "Write a concise analytical response per the system prompt guidelines."
    )
    response = await _client.messages.create(
        model="claude-opus-4-8",
        max_tokens=600,
        thinking={"type": "adaptive"},
        system=_SYNTHESIS_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    return "".join(
        block.text for block in response.content if hasattr(block, "text")
    ).strip()
