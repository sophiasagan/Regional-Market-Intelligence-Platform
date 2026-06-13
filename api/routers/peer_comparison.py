"""
Peer comparison router — line-by-line NCUA schedule benchmarking.

GET /peer-comparison/{charter_number}
  ?period=2024Q4
  &schedule=asset_quality   (asset_quality | earnings | capital | liquidity | growth | balance_sheet)
  &peer_group_id=<id>        optional — defaults to same-state same-asset-tier live computation

For each line item in the requested schedule:
  1. Fetch institution value from institutions_quarterly
  2. Fetch peer p10/p25/median/p75/p90 from peer_distributions (pre-computed) or
     compute live via percentile_cont on institutions_quarterly (fallback)
  3. Interpolate percentile rank from the 5-point distribution
  4. Apply Callahan color/star convention:
       Adverse metrics (delinquency, charge-offs, expenses):
         value <= p10  → green  (best performers)
         value >= p90  → red    (worst performers)
       Positive metrics (ROA, net worth, NIM):
         value >= p90  → green
         value <= p10  → red
  5. Stars: 1-5 Callahan scale derived from direction-adjusted percentile rank

Column names interpolated into SQL are validated against ALLOWED_COLUMNS
(derived from schedule definitions) before use — no free-form user input
reaches the query string.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from database import get_engine

router = APIRouter(prefix="/peer-comparison", tags=["peer-comparison"])


# ── Line item definition ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class LineItem:
    account_code: str        # column name in institutions_quarterly
    line_item: str           # Callahan-compatible display label
    display_format: str      # "dollar" | "percent" | "ratio" | "count" | "bp"
    is_adverse: bool         # True = high value = worse = lower stars
    threshold: Optional[float] = None  # examiner / regulatory threshold, same units


# ── Schedule definitions ──────────────────────────────────────────────────────
# Mirrors Callahan FPR folder structure so analysts feel immediately at home.

SCHEDULES: dict[str, list[LineItem]] = {

    # ── Asset Quality ─────────────────────────────────────────────────────────
    "asset_quality": [
        LineItem("delinq_rate_total",           "Delinquency Ratio",                        "percent", is_adverse=True,  threshold=0.015),
        LineItem("delinq_90plus_rate",          "Total Delinquency 90+ Days",               "percent", is_adverse=True),
        LineItem("delinq_rate_auto",            "Total Auto Loan Delinquency",              "percent", is_adverse=True,  threshold=0.020),
        LineItem("delinq_rate_real_estate",     "Real Estate Delinquency",                  "percent", is_adverse=True),
        LineItem("delinq_rate_first_mortgage",  "1st Mortgage Delinquency",                 "percent", is_adverse=True),
        LineItem("delinq_rate_credit_card",     "Credit Card Loan Delinquency",             "percent", is_adverse=True,  threshold=0.035),
        LineItem("delinq_rate_commercial",      "Commercial Loan Delinquency",              "percent", is_adverse=True,  threshold=0.010),
        LineItem("delinq_rate_indirect",        "Indirect Loan Delinquency",                "percent", is_adverse=True),
        LineItem("chargeoff_rate_total",        "Net Charge-Off Ratio",                     "percent", is_adverse=True),
        LineItem("alll_coverage_ratio",         "Allowance for Loan Losses / Delinquency",  "ratio",   is_adverse=False, threshold=1.0),
        LineItem("alll_to_loans_ratio",         "Allowance for Loan Losses to Total Loans", "percent", is_adverse=False),
        LineItem("tdr_to_loans_ratio",          "TDR to Total Loans",                       "percent", is_adverse=True),
        LineItem("oreo_to_assets_ratio",        "OREO to Total Assets",                     "percent", is_adverse=True),
    ],

    # ── Earnings ──────────────────────────────────────────────────────────────
    "earnings": [
        LineItem("return_on_assets",            "Return on Average Assets (ROA)",           "bp",      is_adverse=False),
        LineItem("net_interest_margin",         "Net Interest Margin (NIM)",                "percent", is_adverse=False),
        LineItem("operating_expense_ratio",     "Operating Expense Ratio",                  "percent", is_adverse=True),
        LineItem("efficiency_ratio",            "Efficiency Ratio",                         "percent", is_adverse=True),
        LineItem("fee_income_ratio",            "Fee Income to Average Assets",             "percent", is_adverse=False),
        LineItem("yield_on_loans",              "Yield on Loans",                           "percent", is_adverse=False),
        LineItem("cost_of_funds",               "Cost of Funds",                            "percent", is_adverse=True),
        LineItem("interest_rate_spread",        "Interest Rate Spread",                     "percent", is_adverse=False),
        LineItem("credit_loss_expense_to_loans","Credit Loss Expense to Avg Loans",         "percent", is_adverse=True),
    ],

    # ── Capital ───────────────────────────────────────────────────────────────
    "capital": [
        LineItem("net_worth_ratio",             "Net Worth Ratio",                          "percent", is_adverse=False, threshold=0.07),
        LineItem("risk_based_capital",          "Risk-Based Capital Ratio",                 "percent", is_adverse=False, threshold=0.10),
        LineItem("total_assets",                "Total Assets",                             "dollar",  is_adverse=False),
        LineItem("total_loans",                 "Total Loans",                              "dollar",  is_adverse=False),
        LineItem("total_deposits",              "Total Shares / Deposits",                  "dollar",  is_adverse=False),
    ],

    # ── Liquidity ─────────────────────────────────────────────────────────────
    "liquidity": [
        LineItem("loan_to_share_ratio",         "Loans to Shares",                          "percent", is_adverse=False),
        LineItem("borrowings_to_assets",        "Borrowings to Total Assets",               "percent", is_adverse=True),
        LineItem("short_term_investments",      "Short-Term Investments / Assets",          "percent", is_adverse=False),
        LineItem("cash_to_assets",              "Cash and Equivalents / Assets",            "percent", is_adverse=False),
    ],

    # ── Growth ────────────────────────────────────────────────────────────────
    "growth": [
        LineItem("member_growth_rate",          "Member Growth",                            "percent", is_adverse=False),
        LineItem("loan_growth_rate",            "Loan Growth",                              "percent", is_adverse=False),
        LineItem("deposit_growth_rate",         "Share / Deposit Growth",                   "percent", is_adverse=False),
        LineItem("asset_growth_rate",           "Asset Growth",                             "percent", is_adverse=False),
    ],

    # ── Balance Sheet ─────────────────────────────────────────────────────────
    "balance_sheet": [
        LineItem("total_assets",                "Total Assets",                             "dollar",  is_adverse=False),
        LineItem("total_loans",                 "Total Loans",                              "dollar",  is_adverse=False),
        LineItem("total_deposits",              "Total Shares / Deposits",                  "dollar",  is_adverse=False),
        LineItem("net_worth_ratio",             "Net Worth Ratio",                          "percent", is_adverse=False, threshold=0.07),
        LineItem("loan_to_share_ratio",         "Loans to Shares",                          "percent", is_adverse=False),
        LineItem("total_members",               "Total Members",                            "count",   is_adverse=False),
    ],
}

# ── Metric classification sets ────────────────────────────────────────────────
# These override the per-LineItem is_adverse flag when a column name appears
# in either set (schedule definition wins for columns not listed here).

ADVERSE_METRICS: frozenset[str] = frozenset({
    # Delinquency
    "delinq_rate_total", "delinq_90plus_rate",
    "delinq_rate_auto", "delinq_rate_real_estate", "delinq_rate_first_mortgage",
    "delinq_rate_credit_card", "delinq_rate_commercial", "delinq_rate_indirect",
    "delinq_rate_new_auto", "delinq_rate_used_auto",
    # Charge-offs
    "chargeoff_rate_total", "nco_to_prior_delinquency",
    # Credit quality
    "tdr_to_loans_ratio", "oreo_to_assets_ratio", "non_accrual_rate",
    # Expense / efficiency
    "operating_expense_ratio", "efficiency_ratio", "credit_loss_expense_to_loans",
    "cost_of_funds",
    # Balance sheet risk
    "borrowings_to_assets",
})

POSITIVE_METRICS: frozenset[str] = frozenset({
    "return_on_assets", "return_on_equity",
    "net_interest_margin", "interest_rate_spread", "yield_on_loans",
    "net_worth_ratio", "risk_based_capital",
    "alll_coverage_ratio", "alll_to_loans_ratio",
    "fee_income_ratio",
    "short_term_investments", "cash_to_assets",
    "loan_to_share_ratio",
    "member_growth_rate", "loan_growth_rate", "deposit_growth_rate", "asset_growth_rate",
})

# Allowlist of safe column names for SQL interpolation.
# Derived directly from schedule definitions — no user input ever reaches the query string.
ALLOWED_COLUMNS: frozenset[str] = frozenset(
    li.account_code for items in SCHEDULES.values() for li in items
)


# ── Pure helpers ──────────────────────────────────────────────────────────────

def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _percentile_rank(
    value: Optional[float],
    p10: Optional[float],
    p25: Optional[float],
    median: Optional[float],
    p75: Optional[float],
    p90: Optional[float],
) -> Optional[float]:
    """
    Interpolate a 0–1 raw percentile rank from the 5-point distribution.
    0.0 = at or below the p10 (lowest observed); 1.0 = at or above p90.
    Direction-neutral: higher rank means higher value (not better or worse).
    Callers apply the adverse/positive direction adjustment when deriving stars.
    """
    if value is None:
        return None

    pts = [
        (p10, 0.10), (p25, 0.25), (median, 0.50), (p75, 0.75), (p90, 0.90),
    ]
    pts = [(v, p) for v, p in pts if v is not None]
    if not pts:
        return None

    # Clamp to known range
    if value <= pts[0][0]:
        lo_v, lo_p = pts[0]
        return max(0.0, lo_p * (value / lo_v)) if lo_v > 0 else 0.0
    if value >= pts[-1][0]:
        hi_v, hi_p = pts[-1]
        excess = (value - hi_v) / (hi_v or 1e-9)
        return min(1.0, hi_p + (1.0 - hi_p) * min(excess, 1.0))

    # Linear interpolation between bracketing band points
    for i in range(len(pts) - 1):
        lo_v, lo_p = pts[i]
        hi_v, hi_p = pts[i + 1]
        if lo_v <= value <= hi_v:
            span = hi_v - lo_v
            return lo_p + (hi_p - lo_p) * ((value - lo_v) / span) if span > 1e-12 else (lo_p + hi_p) / 2

    return None


def _is_adverse(account_code: str, li: LineItem) -> bool:
    """Metric classification sets take precedence over the per-LineItem flag."""
    if account_code in ADVERSE_METRICS:
        return True
    if account_code in POSITIVE_METRICS:
        return False
    return li.is_adverse


def _color_flag(
    value: Optional[float],
    p10: Optional[float],
    p90: Optional[float],
    adverse: bool,
) -> Optional[str]:
    """
    Callahan color convention — top decile = green, bottom decile = red.
    For adverse metrics (delinquency etc.): p10 threshold is green (best performers).
    For positive metrics (ROA etc.): p90 threshold is green.
    """
    if value is None or p10 is None or p90 is None:
        return None
    if adverse:
        if value <= p10:
            return "green"
        if value >= p90:
            return "red"
    else:
        if value >= p90:
            return "green"
        if value <= p10:
            return "red"
    return "white"


def _stars(percentile_rank: Optional[float], adverse: bool) -> Optional[int]:
    """
    Callahan 1–5 star scale (1 star = bottom <10%, 5 stars = top ≥90%).
    For adverse metrics the goodness direction is inverted before mapping.
    """
    if percentile_rank is None:
        return None
    # goodness: 1.0 = best possible performer
    goodness = (1.0 - percentile_rank) if adverse else percentile_rank
    if goodness >= 0.90:
        return 5
    if goodness >= 0.75:
        return 4
    if goodness >= 0.50:
        return 3
    if goodness >= 0.25:
        return 2
    return 1


# ── Live peer-distribution computation ───────────────────────────────────────

def _live_dist(
    conn,
    account_code: str,
    period: str,
    own_state: str,
    own_assets: float,
    own_charter: str,
) -> dict:
    """
    Compute p10/p25/median/p75/p90 on-the-fly from institutions_quarterly.
    Peer scope: same state, assets between 50% and 150% of own — progressive
    fallback to national same-asset-tier if state peers < 8.
    """
    lo = own_assets * 0.50 if own_assets > 0 else 0
    hi = own_assets * 1.50 if own_assets > 0 else 1e15
    MIN = 8

    def _q(state_filter: bool) -> Optional[dict]:
        where = f"""
            data_period = :period
            AND {account_code} IS NOT NULL
            AND {account_code} > 0
            AND charter_number != :charter
            AND (:lo = 0 OR total_assets BETWEEN :lo AND :hi)
            {"AND state = :state" if state_filter else ""}
        """
        params: dict = {
            "period": period, "charter": own_charter, "lo": lo, "hi": hi,
        }
        if state_filter:
            params["state"] = own_state
        row = conn.execute(
            text(f"""
                SELECT
                    COUNT(*)                                                 AS n,
                    percentile_cont(0.10) WITHIN GROUP (ORDER BY {account_code}) AS p10,
                    percentile_cont(0.25) WITHIN GROUP (ORDER BY {account_code}) AS p25,
                    percentile_cont(0.50) WITHIN GROUP (ORDER BY {account_code}) AS median,
                    percentile_cont(0.75) WITHIN GROUP (ORDER BY {account_code}) AS p75,
                    percentile_cont(0.90) WITHIN GROUP (ORDER BY {account_code}) AS p90
                FROM institutions_quarterly
                WHERE {where}
            """),
            params,
        ).mappings().fetchone()
        if row and int(row.get("n") or 0) >= MIN:
            return dict(row)
        return None

    result = _q(state_filter=True) or _q(state_filter=False)
    return result or {}


# ── Main endpoint ─────────────────────────────────────────────────────────────

@router.get("/{charter_number}")
async def peer_comparison(
    charter_number: str,
    period: str = Query(default=""),
    schedule: str = Query(default="asset_quality"),
    peer_group_id: Optional[str] = Query(default=None),
) -> dict:
    """
    Line-by-line NCUA schedule benchmarking for one institution.

    For each metric in the schedule:
    - Fetches institution value from institutions_quarterly
    - Fetches peer distribution from peer_distributions (pre-computed) if
      peer_group_id is supplied and the row exists; otherwise computes live
      via percentile_cont on institutions_quarterly (same-state + same-tier)
    - Returns percentile rank, Callahan color flag, and 1–5 star rating

    Percentile rank note (adverse metrics): lower percentile = better.
    A delinquency ratio at the 73rd percentile means 73% of peers have a
    LOWER rate — that is worse, not better. Stars invert this automatically.
    """
    if schedule not in SCHEDULES:
        raise HTTPException(
            400,
            f"Unknown schedule '{schedule}'. Valid schedules: {sorted(SCHEDULES)}",
        )

    line_items = SCHEDULES[schedule]
    # Validate all account codes against allowlist before any SQL use
    for li in line_items:
        if li.account_code not in ALLOWED_COLUMNS:
            raise HTTPException(500, f"Internal: unregistered column '{li.account_code}'")

    engine = get_engine()
    with engine.connect() as conn:

        # ── Resolve period ────────────────────────────────────────────────
        if not period:
            row = conn.execute(
                text("""
                    SELECT data_period FROM institutions_quarterly
                    WHERE total_loans > 0
                    ORDER BY data_period DESC LIMIT 1
                """)
            ).fetchone()
            period = row[0] if row else "2024Q4"

        # ── Fetch institution row ─────────────────────────────────────────
        inst_row = conn.execute(
            text("""
                SELECT * FROM institutions_quarterly
                WHERE charter_number = :charter AND data_period = :period
                LIMIT 1
            """),
            {"charter": charter_number, "period": period},
        ).mappings().fetchone()

        if inst_row is None:
            # Fallback: most recent period for this institution
            inst_row = conn.execute(
                text("""
                    SELECT * FROM institutions_quarterly
                    WHERE charter_number = :charter AND total_loans > 0
                    ORDER BY data_period DESC LIMIT 1
                """),
                {"charter": charter_number},
            ).mappings().fetchone()
            if inst_row is None:
                raise HTTPException(404, f"No data found for charter '{charter_number}'")
            period = inst_row["data_period"]

        inst        = dict(inst_row)
        own_assets  = _safe_float(inst.get("total_assets")) or 0
        own_state   = inst.get("state") or ""
        own_charter = inst.get("charter_number", charter_number)

        # ── Peer group metadata ───────────────────────────────────────────
        peer_group_label: str = f"{own_state} state peers (similar asset size)"
        n_peers_meta: Optional[int] = None

        if peer_group_id:
            try:
                pg = conn.execute(
                    text("SELECT label, n_peers FROM peer_groups WHERE id = :id LIMIT 1"),
                    {"id": peer_group_id},
                ).mappings().fetchone()
                if pg:
                    peer_group_label = pg["label"]
                    n_peers_meta = int(pg.get("n_peers") or 0) or None
            except Exception:
                pass  # peer_groups table may not exist yet

        # ── Fetch pre-computed peer distributions ─────────────────────────
        dist_by_code: dict[str, dict] = {}

        if peer_group_id:
            codes = [li.account_code for li in line_items]
            ac_ph = ", ".join(f":ac_{i}" for i in range(len(codes)))
            ac_params: dict = {"period": period, "pgid": peer_group_id}
            for i, ac in enumerate(codes):
                ac_params[f"ac_{i}"] = ac
            try:
                dist_rows = conn.execute(
                    text(f"""
                        SELECT account_code, p10, p25, median, p75, p90, n_peers
                        FROM peer_distributions
                        WHERE period       = :period
                          AND peer_group_id = :pgid
                          AND account_code  IN ({ac_ph})
                    """),
                    ac_params,
                ).mappings().fetchall()
                for r in dist_rows:
                    dist_by_code[r["account_code"]] = dict(r)
                    if n_peers_meta is None and r.get("n_peers"):
                        n_peers_meta = int(r["n_peers"])
            except Exception:
                pass  # peer_distributions not yet populated

        # ── Live fallback for any codes missing from peer_distributions ────
        for li in line_items:
            ac = li.account_code
            if ac in dist_by_code:
                continue
            try:
                d = _live_dist(conn, ac, period, own_state, own_assets, own_charter)
                if d:
                    dist_by_code[ac] = d
                    if n_peers_meta is None and d.get("n"):
                        n_peers_meta = int(d["n"])
            except Exception:
                pass  # column absent in this schema version — row will show nulls

    # ── Build response rows ───────────────────────────────────────────────────
    rows = []
    for li in line_items:
        ac        = li.account_code
        inst_val  = _safe_float(inst.get(ac))
        dist      = dist_by_code.get(ac) or {}

        p10    = _safe_float(dist.get("p10"))
        p25    = _safe_float(dist.get("p25"))
        median = _safe_float(dist.get("median"))
        p75    = _safe_float(dist.get("p75"))
        p90    = _safe_float(dist.get("p90"))
        n_p    = int(dist.get("n_peers") or dist.get("n") or n_peers_meta or 0)

        rank    = _percentile_rank(inst_val, p10, p25, median, p75, p90)
        adverse = _is_adverse(ac, li)
        color   = _color_flag(inst_val, p10, p90, adverse)
        star    = _stars(rank, adverse)
        is_rate = li.display_format in ("percent", "bp")

        rows.append({
            "line_item":         li.line_item,
            "account_code":      ac,
            "institution_value": inst_val,
            "peer_p10":          p10,
            "peer_p25":          p25,
            "peer_median":       median,
            "peer_p75":          p75,
            "peer_p90":          p90,
            "n_peers":           n_p,
            "percentile_rank":   rank,
            "color_flag":        color,
            "stars":             star,
            "is_rate":           is_rate,
            "display_format":    li.display_format,
            "is_adverse":        adverse,
            "threshold":         li.threshold,
        })

    return {
        "schedule": schedule,
        "period":   period,
        "peer_group": {
            "id":      peer_group_id,
            "label":   peer_group_label,
            "n_peers": n_peers_meta or 0,
        },
        "institution": {
            "charter_number": own_charter,
            "name":           inst.get("institution_name", ""),
            "state":          own_state,
            "total_assets":   _safe_float(inst.get("total_assets")),
        },
        "rows": rows,
    }


# ── Schedule metadata endpoint ────────────────────────────────────────────────

@router.get("/schedules/list")
async def list_schedules() -> dict:
    """List all available schedules and their line items."""
    return {
        name: [
            {
                "account_code":   li.account_code,
                "line_item":      li.line_item,
                "display_format": li.display_format,
                "is_adverse":     li.is_adverse,
                "threshold":      li.threshold,
            }
            for li in items
        ]
        for name, items in SCHEDULES.items()
    }
