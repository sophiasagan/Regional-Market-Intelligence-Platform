"""
Delinquency and credit risk analytics engine.

All rate values follow the convention from ncua_ingester.py: stored as decimal
fractions, not percentages (0.02 == 2 %).

Public API
----------
    get_peer_distribution(metric, period, peer_group, engine=None) -> dict
    get_percentile_rank(institution_value, distribution) -> float
    get_regional_peers(charter_number, region_type, region_id, period, engine=None) -> list[str]
    compute_credit_risk_score(institution_metrics, peer_distribution) -> dict

Table dependencies (read-only):
    institutions_quarterly  — delinquency / charge-off / reserve metrics
    branches_annual         — branch-level geography; charter_number already resolved
                              via fdic_ncua_crosswalk during FDIC ingestion
    cbsa_county_crosswalk   — county FIPS → CBSA code for MSA peer lookups
"""
from __future__ import annotations

import logging
from typing import Optional

import numpy as np
import pandas as pd
import sqlalchemy as sa

from ..database import get_engine

logger = logging.getLogger(__name__)

# ── Valid metric names ─────────────────────────────────────────────────────────
# Every column produced by ncua_ingester._compute_derived_rates, plus the raw
# balance columns, is accepted as a distribution metric.

VALID_METRICS: frozenset[str] = frozenset({
    # Derived credit-quality rates
    "delinq_rate_total",
    "delinq_rate_auto",
    "delinq_rate_real_estate",
    "delinq_rate_credit_card",
    "delinq_rate_commercial",
    "delinq_90plus_rate",
    "chargeoff_rate_total",
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
    "tdr_to_loans_ratio",
    "oreo_to_assets_ratio",
    # Raw delinquent balances
    "delinq_total",
    "delinq_auto",
    "delinq_real_estate",
    "delinq_credit_card",
    "delinq_commercial",
    "delinq_90day",
    # Charge-off balances
    "net_charge_offs",
    "nco_auto",
    "nco_credit_card",
    "nco_real_estate",
    "nco_commercial",
    # Reserve / watch items
    "alll",
    "tdr_balance",
    "oreo_balance",
    # Core balance sheet (for secondary uses)
    "total_loans",
    "total_assets",
    "total_shares_deposits",
    "loans_real_estate",
    "loans_auto",
    "loans_credit_card",
    "loans_commercial",
})

# ── Composite risk score configuration ────────────────────────────────────────

# Metric → weight.  Weights must sum to 1.0.
RISK_WEIGHTS: dict[str, float] = {
    "delinq_rate_total":    0.35,
    "delinq_90plus_rate":   0.25,
    "chargeoff_rate_total": 0.20,
    "alll_coverage_ratio":  0.10,   # inverted — see below
    "oreo_to_assets_ratio": 0.10,
}

# For these metrics a LOWER value is WORSE (e.g. under-reserved).
# Their percentile rank is flipped to 1 − rank before weighting, so that a
# high composite score always means high risk regardless of metric direction.
INVERTED_METRICS: frozenset[str] = frozenset({"alll_coverage_ratio"})

# Composite-score → risk tier thresholds (inclusive upper bound)
_TIERS: list[tuple[float, str]] = [
    (25.0,  "green"),   # better than ~75 % of peers on weighted risk
    (50.0,  "yellow"),  # near or below peer median risk
    (75.0,  "amber"),   # above median — needs monitoring
    (100.0, "red"),     # top quartile for risk — requires attention
]

_MIN_PEERS = 5   # expand geography if fewer regional peers found

# ── get_peer_distribution ──────────────────────────────────────────────────────

def get_peer_distribution(
    metric: str,
    period: str,
    peer_group: list[str],
    engine: Optional[sa.engine.Engine] = None,
) -> dict:
    """
    Compute summary statistics for *metric* across *peer_group* for *period*.

    Parameters
    ----------
    metric :
        Column name in institutions_quarterly (e.g. ``"delinq_rate_total"``).
    period :
        Data period — ``"YYYYQN"`` (e.g. ``"2024Q4"``) or ``"YYYY"``.
    peer_group :
        Charter numbers of the comparison institutions.  The querying
        institution may be included; it will not bias the computation.
    engine :
        SQLAlchemy engine; created from DATABASE_URL if omitted.

    Returns
    -------
    dict
        ``p10, p25, median, p75, p90, mean, std, n_institutions``
        plus ``_values`` (sorted list of raw values) for exact
        percentile-rank computation by get_percentile_rank.

        When fewer than 2 peers have data, returns an ``_empty`` sentinel
        (``n_institutions`` < 2, all percentile fields are nan) so callers
        can detect unusable distributions without raising.
    """
    if metric not in VALID_METRICS:
        raise ValueError(
            f"Unknown metric '{metric}'. Valid choices: {sorted(VALID_METRICS)}"
        )
    if not peer_group:
        return _empty_distribution(metric, period)

    if engine is None:
        engine = get_engine()

    values = _fetch_metric_values(metric, period, peer_group, engine)

    if len(values) < 2:
        logger.warning(
            "Only %d peer(s) have data for metric='%s' period='%s'; "
            "distribution statistics will be unreliable.",
            len(values), metric, period,
        )
        return _empty_distribution(metric, period, values)

    arr = np.asarray(values, dtype=float)

    return {
        "metric":          metric,
        "period":          period,
        "p10":             float(np.percentile(arr, 10)),
        "p25":             float(np.percentile(arr, 25)),
        "median":          float(np.percentile(arr, 50)),
        "p75":             float(np.percentile(arr, 75)),
        "p90":             float(np.percentile(arr, 90)),
        "mean":            float(np.mean(arr)),
        "std":             float(np.std(arr, ddof=1)),
        "n_institutions":  len(arr),
        "_values":         sorted(values),
    }


def _fetch_metric_values(
    metric: str,
    period: str,
    charter_numbers: list[str],
    engine: sa.engine.Engine,
) -> list[float]:
    """Return non-null metric values for the specified institutions and period."""
    with engine.connect() as conn:
        try:
            rows = conn.execute(
                # DISTINCT ON handles duplicate ingestion runs for the same period
                sa.text(f"""
                    SELECT DISTINCT ON (charter_number) {metric}
                    FROM   institutions_quarterly
                    WHERE  charter_number = ANY(:ids)
                      AND  data_period    = :period
                      AND  {metric}       IS NOT NULL
                    ORDER  BY charter_number, ingested_at DESC
                """),
                {"ids": list(charter_numbers), "period": period},
            ).fetchall()
        except sa.exc.ProgrammingError as exc:
            # Column may not exist on a pre-migration table
            logger.error(
                "Column '%s' missing from institutions_quarterly "
                "(run ncua_ingester to apply the latest DDL migration): %s",
                metric, exc,
            )
            return []
    return [float(row[0]) for row in rows if row[0] is not None]


def _empty_distribution(
    metric: str, period: str, values: list[float] | None = None,
) -> dict:
    n   = len(values) if values else 0
    val = float(values[0]) if n == 1 else float("nan")
    return {
        "metric": metric, "period": period,
        "p10": val, "p25": val, "median": val, "p75": val, "p90": val,
        "mean": val, "std": 0.0, "n_institutions": n,
        "_values": sorted(values) if values else [],
    }

# ── get_percentile_rank ────────────────────────────────────────────────────────

def get_percentile_rank(
    institution_value: float,
    distribution: dict,
) -> float:
    """
    Return the fraction of peers at or below *institution_value*.

    Interpretation by metric direction
    -----------------------------------
    Delinquency / charge-off / OREO metrics:
        HIGHER percentile rank = WORSE relative performance.
        e.g. rank 0.90 means 90 % of peers are equal or lower (more delinquent).

    Coverage / reserve metrics (alll_coverage_ratio):
        HIGHER percentile rank = BETTER (more reserve than peers).
        compute_credit_risk_score inverts this automatically via INVERTED_METRICS.

    Parameters
    ----------
    institution_value :
        The institution's value for the metric (same units as the distribution).
    distribution :
        Dict returned by get_peer_distribution.

    Returns
    -------
    float in [0.0, 1.0], or nan if the distribution is empty / unusable.
    """
    if not distribution or distribution.get("n_institutions", 0) == 0:
        return float("nan")

    if np.isnan(institution_value):
        return float("nan")

    # ── Exact empirical CDF from stored raw values ───────────────────────────
    raw_values = distribution.get("_values")
    if raw_values:
        arr  = np.asarray(raw_values, dtype=float)
        rank = int(np.searchsorted(arr, institution_value, side="right"))
        return rank / len(arr)

    # ── Fallback: linear interpolation between stored percentile anchors ──────
    # Used when the distribution was serialised without _values (e.g. from cache).
    anchors = [
        (distribution.get("p10"), 0.10),
        (distribution.get("p25"), 0.25),
        (distribution.get("median"), 0.50),
        (distribution.get("p75"), 0.75),
        (distribution.get("p90"), 0.90),
    ]
    # Drop anchors with NaN values (sparse distributions)
    anchors = [(v, p) for v, p in anchors if v is not None and not np.isnan(v)]
    if not anchors:
        return float("nan")

    if institution_value <= anchors[0][0]:
        return anchors[0][1]
    if institution_value >= anchors[-1][0]:
        return anchors[-1][1]

    for i in range(len(anchors) - 1):
        v_lo, p_lo = anchors[i]
        v_hi, p_hi = anchors[i + 1]
        if v_lo <= institution_value <= v_hi:
            span = v_hi - v_lo
            if span == 0:
                return (p_lo + p_hi) / 2.0
            t = (institution_value - v_lo) / span
            return p_lo + t * (p_hi - p_lo)

    return 0.50  # unreachable

# ── get_regional_peers ─────────────────────────────────────────────────────────

def get_regional_peers(
    charter_number: str,
    region_type: str,
    region_id: str,
    period: str = "latest",
    engine: Optional[sa.engine.Engine] = None,
) -> list[str]:
    """
    Return NCUA charter numbers for institutions with branch presence in the
    same geography as *charter_number*.

    This produces a market-relevant peer group — institutions that actually
    compete for deposits and loans in the same county, MSA, or state — as
    opposed to national asset-size peers which may face different local conditions.

    Geography resolution
    --------------------
    county   — ``region_id`` is a 5-digit FIPS code (e.g. ``"12086"``).
    msa      — ``region_id`` is a CBSA/MSA code (e.g. ``"33100"``);
               resolved through ``cbsa_county_crosswalk``.
    state    — ``region_id`` is a two-letter state abbreviation (e.g. ``"FL"``).

    Expansion rule
    --------------
    If fewer than ``_MIN_PEERS`` institutions are found for the requested
    geography, the function automatically expands to the institution's home
    state and merges the two sets. A warning is logged when expansion occurs.

    Parameters
    ----------
    charter_number :
        Querying institution — excluded from the returned list.
    region_type :
        ``"county"`` | ``"msa"`` | ``"state"``.
    region_id :
        Geography identifier matching the chosen region_type.
    period :
        Used for the state-fallback query (``"YYYYQN"`` or ``"latest"``).
    """
    if region_type not in ("county", "msa", "state"):
        raise ValueError(
            f"region_type must be 'county', 'msa', or 'state'; got '{region_type}'"
        )
    if engine is None:
        engine = get_engine()

    resolved_period = _resolve_latest_period(period, engine)

    peers = _peers_from_branches(charter_number, region_type, region_id, engine)

    if len(peers) < _MIN_PEERS and region_type != "state":
        state = _institution_state(charter_number, resolved_period, engine)
        if state:
            logger.info(
                "Only %d peer(s) found for %s in %s '%s'; expanding to state '%s'.",
                len(peers), charter_number, region_type, region_id, state,
            )
            state_peers = _peers_from_iq_state(
                charter_number, state, resolved_period, engine
            )
            # Merge without duplicates, preserving regional-peer ordering
            seen = set(peers)
            for p in state_peers:
                if p not in seen:
                    peers.append(p)
                    seen.add(p)

    if len(peers) < _MIN_PEERS:
        logger.warning(
            "Peer group for charter %s contains only %d institution(s) "
            "(minimum %d). Consider using a broader geography.",
            charter_number, len(peers), _MIN_PEERS,
        )

    return peers


def _resolve_latest_period(period: str, engine: sa.engine.Engine) -> str:
    if period != "latest":
        return period
    with engine.connect() as conn:
        row = conn.execute(
            sa.text("SELECT MAX(data_period) FROM institutions_quarterly")
        ).fetchone()
    return str(row[0]) if row and row[0] else period


def _peers_from_branches(
    own_charter: str,
    region_type: str,
    region_id: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """
    Query branches_annual for institutions in the geography.

    branches_annual.charter_number is already the NCUA charter number — it is
    populated via fdic_ncua_crosswalk during FDIC SOD ingestion.  Rows where
    charter_number IS NULL are bank branches without a matched CU charter and
    are intentionally excluded so the returned list contains only credit unions
    that can be joined against institutions_quarterly.
    """
    if region_type == "county":
        geo_clause = "ba.county_fips = :region_id"
        params: dict = {"region_id": region_id, "own": own_charter}
    elif region_type == "msa":
        # Join county FIPS to CBSA via crosswalk; cbsa_county_crosswalk is
        # seeded from the Census CBSA delineation file.
        geo_clause = """
            ba.county_fips IN (
                SELECT county_fips
                FROM   cbsa_county_crosswalk
                WHERE  cbsa_code = :region_id
            )
        """
        params = {"region_id": region_id, "own": own_charter}
    else:  # state
        geo_clause = "ba.state = :region_id"
        params = {"region_id": region_id, "own": own_charter}

    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text(f"""
                    SELECT DISTINCT ba.charter_number
                    FROM   branches_annual ba
                    WHERE  {geo_clause}
                      AND  ba.charter_number IS NOT NULL
                      AND  ba.charter_number != :own
                """),
                params,
            ).fetchall()
        except sa.exc.ProgrammingError as exc:
            # branches_annual or cbsa_county_crosswalk not yet populated
            logger.warning(
                "Branch-presence query failed (%s); "
                "returning empty list for %s/%s.",
                exc, region_type, region_id,
            )
            return []

    return [str(row[0]) for row in rows]


def _institution_state(
    charter_number: str,
    period: str,
    engine: sa.engine.Engine,
) -> Optional[str]:
    with engine.connect() as conn:
        row = conn.execute(
            sa.text("""
                SELECT state FROM institutions_quarterly
                WHERE  charter_number = :cn
                  AND  data_period    = :period
                LIMIT  1
            """),
            {"cn": charter_number, "period": period},
        ).fetchone()
    return str(row[0]).strip() if row and row[0] else None


def _peers_from_iq_state(
    own_charter: str,
    state: str,
    period: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """All credit-union charter numbers in the same state for the given period."""
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("""
                SELECT DISTINCT ON (charter_number) charter_number
                FROM   institutions_quarterly
                WHERE  state          = :state
                  AND  charter_number != :own
                  AND  data_period    = :period
                ORDER  BY charter_number, ingested_at DESC
            """),
            {"state": state, "own": own_charter, "period": period},
        ).fetchall()
    return [str(row[0]) for row in rows]

# ── compute_credit_risk_score ──────────────────────────────────────────────────

def compute_credit_risk_score(
    institution_metrics: dict,
    peer_distribution: dict,
) -> dict:
    """
    Produce a weighted composite risk score placing the institution within its
    peer distribution.

    Score semantics
    ---------------
    0–100; higher == more risk relative to peers.

        0–25   green   — well below peer median risk; no near-term concern
       25–50   yellow  — near or below median; routine monitoring adequate
       50–75   amber   — above peer median; proactive review warranted
       75–100  red     — top quartile for risk; board-level attention indicated

    Weights
    -------
    delinq_rate_total      35 %   broadest delinquency signal
    delinq_90plus_rate     25 %   severe delinquency; correlated with loss
    chargeoff_rate_total   20 %   realised loss; backward-looking confirmation
    alll_coverage_ratio    10 %   INVERTED — lower coverage = higher risk
    oreo_to_assets_ratio   10 %   seized collateral; lagging risk indicator

    If a metric is absent from institution_metrics or its distribution has fewer
    than 2 peers, that component is excluded and the remaining weights are
    normalised so they still sum to 1.0.

    Parameters
    ----------
    institution_metrics :
        ``{metric_name: float}`` for the institution being scored.  Use the
        rate columns from institutions_quarterly (decimal fractions, not %).
    peer_distribution :
        ``{metric_name: distribution_dict}`` — one entry per metric listed in
        RISK_WEIGHTS, as returned by get_peer_distribution.

    Returns
    -------
    dict
        score               float 0–100
        tier                "green" | "yellow" | "amber" | "red" | "unknown"
        component_scores    per-metric breakdown (see below)
        missing_components  metrics excluded due to missing data
        weights_used        effective weights after redistribution
        n_peers_min         smallest peer count across used metrics

    component_scores[metric] keys
        value                   institution's raw metric value
        percentile_rank         fraction of peers at or below (0–1)
        risk_rank               percentile_rank, inverted for INVERTED_METRICS
        effective_weight        normalised weight actually applied
        weighted_contribution   risk_rank × effective_weight × 100
        inverted                True if metric direction was flipped
        peer_median             p50 from the peer distribution
        n_peers                 number of peers with data for this metric
    """
    # ── Partition available vs missing metrics ────────────────────────────────
    available: dict[str, float] = {}
    missing: list[str] = []

    for metric, weight in RISK_WEIGHTS.items():
        raw_val = institution_metrics.get(metric)
        dist    = peer_distribution.get(metric)

        if (
            raw_val is None
            or (isinstance(raw_val, float) and np.isnan(raw_val))
            or dist is None
            or dist.get("n_institutions", 0) < 2
        ):
            missing.append(metric)
        else:
            available[metric] = weight

    if not available:
        return {
            "score":              float("nan"),
            "tier":               "unknown",
            "component_scores":   {},
            "missing_components": missing,
            "weights_used":       {},
            "n_peers_min":        0,
        }

    # ── Normalise weights for available metrics ───────────────────────────────
    total_weight  = sum(available.values())
    eff_weights   = {m: w / total_weight for m, w in available.items()}

    # ── Per-component scoring ─────────────────────────────────────────────────
    component_scores: dict[str, dict] = {}
    composite: float = 0.0
    peer_counts: list[int] = []

    for metric, eff_w in eff_weights.items():
        value    = float(institution_metrics[metric])
        dist     = peer_distribution[metric]
        pct_rank = get_percentile_rank(value, dist)
        inverted = metric in INVERTED_METRICS

        # Higher composite score = more risk, regardless of metric direction
        risk_rank = (1.0 - pct_rank) if inverted else pct_rank
        contrib   = risk_rank * eff_w * 100.0
        composite += contrib

        peer_counts.append(dist.get("n_institutions", 0))
        component_scores[metric] = {
            "value":                value,
            "percentile_rank":      round(pct_rank,  4),
            "risk_rank":            round(risk_rank, 4),
            "effective_weight":     round(eff_w,     4),
            "weighted_contribution":round(contrib,   2),
            "inverted":             inverted,
            "peer_median":          dist.get("median"),
            "n_peers":              dist.get("n_institutions"),
        }

    return {
        "score":              round(composite, 2),
        "tier":               _score_to_tier(composite),
        "component_scores":   component_scores,
        "missing_components": missing,
        "weights_used":       {m: round(w, 4) for m, w in eff_weights.items()},
        "n_peers_min":        min(peer_counts) if peer_counts else 0,
    }


def _score_to_tier(score: float) -> str:
    for upper_bound, label in _TIERS:
        if score <= upper_bound:
            return label
    return "red"
