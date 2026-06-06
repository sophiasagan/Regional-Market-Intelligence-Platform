"""
Automated alert detection — market share movements and delinquency/credit quality.

Detection is triggered quarterly by ingestion/scheduler.py (or manually via
POST /alerts/run). Two independent detection phases run per tenant:

  Phase 1 — Market share (unchanged P76 logic, runs per monitored geography):
    own_share_change  — tenant's share moved ≥ 0.5 pp
    competitor_gain   — tracked competitor gained ≥ 1.0 pp
    new_entrant       — new institution appeared with ≥ 2 % share
    market_growth     — total market grew ≥ 5 % period-over-period

  Phase 2 — Delinquency / credit quality (runs once per own institution):
    delinq_threshold_breach  — any loan type rate exceeds configured threshold
    delinq_peer_divergence   — institution rate rose > 0.5 pp more than peer median
    alll_coverage_decline    — ALLL coverage ratio fell below 1.0x (examiner threshold)
    chargeoff_acceleration   — annualized NCO rate increased > 25 % vs prior quarter
    oreo_increase            — OREO balance grew > 20 % quarter-over-quarter

Each triggered condition calls Claude for a 2-sentence plain-English notification,
then stores the result for in-app display and optional email digest.
"""
from __future__ import annotations

import asyncio
import logging
import os
import smtplib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Optional

import anthropic
import pandas as pd
import sqlalchemy as sa
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_engine
from processing.delinquency_engine import (
    get_peer_distribution,
    get_percentile_rank,
    get_regional_peers,
)
from processing.market_share_engine import calculate_market_share

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/alerts", tags=["alerts"])

_client = anthropic.AsyncAnthropic()

# ── Market-share thresholds ───────────────────────────────────────────────────

_OWN_CHANGE_MIN      = 0.005   # |Δshare| ≥ 0.5 pp
_COMPETITOR_GAIN_MIN = 0.010   # competitor gain ≥ 1.0 pp
_NEW_ENTRANT_MIN     = 0.020   # new entrant share ≥ 2.0 %
_MARKET_GROWTH_MIN   = 0.050   # total market growth ≥ 5.0 %

# ── Delinquency threshold defaults (per CLAUDE.md) ────────────────────────────

_DELINQ_THRESHOLD_DEFAULTS: dict[str, float] = {
    "delinq_total":           0.015,   # 1.5 %
    "delinq_auto":            0.020,   # 2.0 %
    "delinq_credit_card":     0.035,   # 3.5 %
    "delinq_commercial":      0.010,   # 1.0 %
    "delinq_real_estate":     0.020,   # 2.0 %
    "delinq_90plus":          0.010,   # 1.0 %
    "peer_divergence_pp":     0.005,   # 0.5 pp above peer change
    "alll_coverage_min":      1.0,     # examiner minimum coverage ratio
    "chargeoff_acceleration": 0.25,    # 25 % QoQ increase in NCO rate
    "oreo_increase":          0.20,    # 20 % QoQ increase in OREO balance
}

# (metric_column, threshold_key, human_label)
_THRESHOLD_METRIC_MAP: list[tuple[str, str, str]] = [
    ("delinq_rate_total",       "delinq_total",       "total loan delinquency"),
    ("delinq_rate_auto",        "delinq_auto",        "auto loan delinquency"),
    ("delinq_rate_credit_card", "delinq_credit_card", "credit card delinquency"),
    ("delinq_rate_commercial",  "delinq_commercial",  "commercial loan delinquency"),
    ("delinq_rate_real_estate", "delinq_real_estate", "real estate delinquency"),
    ("delinq_90plus_rate",      "delinq_90plus",      "90+ day delinquency"),
]

_DELINQ_ALERT_TYPES = frozenset({
    "delinq_threshold_breach",
    "delinq_peer_divergence",
    "alll_coverage_decline",
    "chargeoff_acceleration",
    "oreo_increase",
})

# ── DDL ───────────────────────────────────────────────────────────────────────

_DDL_MONITORED = sa.text("""
CREATE TABLE IF NOT EXISTS monitored_geographies (
    id                    SERIAL      PRIMARY KEY,
    tenant_id             TEXT        NOT NULL,
    geography_type        TEXT        NOT NULL,
    geography_id          TEXT        NOT NULL,
    geography_label       TEXT,
    metric                TEXT        NOT NULL DEFAULT 'deposits',
    institution_types     TEXT[]      NOT NULL DEFAULT ARRAY['credit_union','bank'],
    own_institution_id    TEXT,
    direct_competitor_ids TEXT[]      NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, geography_type, geography_id, metric)
)
""")

_DDL_ALERTS = sa.text("""
CREATE TABLE IF NOT EXISTS alerts (
    id                   SERIAL      PRIMARY KEY,
    tenant_id            TEXT        NOT NULL,
    alert_type           TEXT        NOT NULL,
    geography_type       TEXT        NOT NULL,
    geography_id         TEXT        NOT NULL,
    geography_label      TEXT,
    period               TEXT        NOT NULL,
    prior_period         TEXT        NOT NULL,
    subject_institution  TEXT,
    subject_id           TEXT        NOT NULL DEFAULT '__market__',
    current_share        NUMERIC,
    prior_share          NUMERIC,
    change_pp            NUMERIC,
    metric               TEXT        NOT NULL,
    narrative            TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at      TIMESTAMPTZ,
    resolved_at          TIMESTAMPTZ,
    email_sent_at        TIMESTAMPTZ,
    peer_median_rate     NUMERIC,
    percentile_rank      NUMERIC,
    consecutive_quarters INT,
    UNIQUE (tenant_id, alert_type, geography_type, geography_id, period, subject_id, metric)
)
""")

_DDL_PREFS = sa.text("""
CREATE TABLE IF NOT EXISTS alert_preferences (
    tenant_id              TEXT    PRIMARY KEY,
    email_digest_enabled   BOOLEAN NOT NULL DEFAULT false,
    digest_email           TEXT,
    immediate_delinq_email BOOLEAN NOT NULL DEFAULT false,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
)
""")

_DDL_THRESHOLDS = sa.text("""
CREATE TABLE IF NOT EXISTS delinquency_thresholds (
    tenant_id             TEXT    PRIMARY KEY,
    delinq_total          NUMERIC NOT NULL DEFAULT 0.015,
    delinq_auto           NUMERIC NOT NULL DEFAULT 0.020,
    delinq_credit_card    NUMERIC NOT NULL DEFAULT 0.035,
    delinq_commercial     NUMERIC NOT NULL DEFAULT 0.010,
    delinq_real_estate    NUMERIC NOT NULL DEFAULT 0.020,
    delinq_90plus         NUMERIC NOT NULL DEFAULT 0.010,
    peer_divergence_pp    NUMERIC NOT NULL DEFAULT 0.005,
    alll_coverage_min     NUMERIC NOT NULL DEFAULT 1.0,
    chargeoff_acceleration NUMERIC NOT NULL DEFAULT 0.25,
    oreo_increase         NUMERIC NOT NULL DEFAULT 0.20,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
)
""")

# Idempotent migration — adds new columns to existing deployments
_DDL_MIGRATION_ALERTS = sa.text("""
DO $$ BEGIN
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS peer_median_rate     NUMERIC;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS percentile_rank      NUMERIC;
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS consecutive_quarters INT;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
""")

_DDL_MIGRATION_PREFS = sa.text("""
DO $$ BEGIN
  ALTER TABLE alert_preferences ADD COLUMN IF NOT EXISTS immediate_delinq_email BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
""")


# ── Pydantic models ───────────────────────────────────────────────────────────

class AlertOut(BaseModel):
    id: int
    alert_type: str
    geography_type: str
    geography_id: str
    geography_label: Optional[str]
    period: str
    prior_period: str
    subject_institution: Optional[str]
    current_share_pct: Optional[float]
    prior_share_pct: Optional[float]
    change_pp: Optional[float]
    metric: str
    narrative: str
    created_at: datetime
    acknowledged_at: Optional[datetime]
    resolved_at: Optional[datetime] = None
    peer_median_rate: Optional[float] = None
    percentile_rank: Optional[float] = None
    consecutive_quarters: Optional[int] = None


class MonitoredGeoIn(BaseModel):
    geography_type: str
    geography_id: str
    geography_label: Optional[str] = None
    metric: str = "deposits"
    institution_types: list[str] = ["credit_union", "bank"]
    own_institution_id: Optional[str] = None
    direct_competitor_ids: list[str] = []


class MonitoredGeoOut(MonitoredGeoIn):
    id: int
    tenant_id: str
    created_at: datetime


class AlertPreferences(BaseModel):
    email_digest_enabled: bool = False
    digest_email: Optional[str] = None
    immediate_delinq_email: bool = False


class DelinquencyThresholds(BaseModel):
    delinq_total:           float = 0.015
    delinq_auto:            float = 0.020
    delinq_credit_card:     float = 0.035
    delinq_commercial:      float = 0.010
    delinq_real_estate:     float = 0.020
    delinq_90plus:          float = 0.010
    peer_divergence_pp:     float = 0.005
    alll_coverage_min:      float = 1.0
    chargeoff_acceleration: float = 0.25
    oreo_increase:          float = 0.20


class DetectionSummary(BaseModel):
    tenants_checked: int
    geographies_checked: int
    alerts_created: int
    alerts_skipped_duplicate: int
    delinq_checks: int


# ── Internal candidate type ───────────────────────────────────────────────────

@dataclass
class _Candidate:
    tenant_id: str
    alert_type: str
    geography_type: str
    geography_id: str
    geography_label: Optional[str]
    period: str
    prior_period: str
    subject_institution: Optional[str]
    subject_id: str
    current_share: Optional[float]
    prior_share: Optional[float]
    change_pp: Optional[float]
    metric: str
    narrative_prompt: str
    # Delinquency-specific — None for market-share candidates
    peer_median_rate: Optional[float] = field(default=None)
    percentile_rank: Optional[float] = field(default=None)
    consecutive_quarters: Optional[int] = field(default=None)


# ── Schema helpers ────────────────────────────────────────────────────────────

def _ensure_tables(engine: sa.engine.Engine) -> None:
    with engine.begin() as conn:
        for ddl in (
            _DDL_MONITORED, _DDL_ALERTS, _DDL_PREFS, _DDL_THRESHOLDS,
            _DDL_MIGRATION_ALERTS, _DDL_MIGRATION_PREFS,
        ):
            conn.execute(ddl)


def _latest_period(metric: str, engine: sa.engine.Engine) -> Optional[str]:
    with engine.connect() as conn:
        if metric == "deposits":
            row = conn.execute(sa.text("SELECT MAX(year) FROM branches_annual")).fetchone()
            return str(row[0]) if row and row[0] else None
        if metric == "mortgage_originations":
            row = conn.execute(sa.text("SELECT MAX(activity_year) FROM hmda_originations")).fetchone()
            return str(row[0]) if row and row[0] else None
        row = conn.execute(sa.text("SELECT MAX(data_period) FROM institutions_quarterly")).fetchone()
        return row[0] if row and row[0] else None


def _prior_period(period: str) -> str:
    if "Q" in period:
        year, q = int(period[:4]), int(period[5])
        return f"{year - 1}Q4" if q == 1 else f"{year}Q{q - 1}"
    return str(int(period) - 1)


def _period_label(period: str) -> str:
    return f"Q{period[5]} {period[:4]}" if "Q" in period else period


def _to_pct(v: Optional[Any]) -> Optional[float]:
    return round(float(v) * 100, 2) if v is not None else None


def _ordinal(n: int) -> str:
    names = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}
    return names.get(n, f"{n}th")


# ── Delinquency DB helpers (synchronous — call via asyncio.to_thread) ─────────

def _fetch_inst_metrics(
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
    return dict(zip(cols, row)) if row else {}


def _count_consecutive(
    charter: str, metric: str, current_period: str,
    max_look: int, engine: sa.engine.Engine,
) -> int:
    """Count consecutive quarters ending at current_period where metric increased."""
    yr, q = int(current_period[:4]), int(current_period[5])
    periods = [current_period]
    for _ in range(max_look):
        q -= 1
        if q < 1:
            q, yr = 4, yr - 1
        periods.append(f"{yr}Q{q}")
    periods.reverse()

    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(f"""
                SELECT DISTINCT ON (data_period) data_period, {metric}
                FROM   institutions_quarterly
                WHERE  charter_number = :cn
                  AND  data_period    = ANY(:periods)
                  AND  {metric}       IS NOT NULL
                ORDER  BY data_period, ingested_at DESC
            """),
            {"cn": charter, "periods": periods},
        ).fetchall()
    vals = {str(r[0]): float(r[1]) for r in rows}

    count = 0
    for i in range(len(periods) - 1, 0, -1):
        p_cur, p_prev = periods[i], periods[i - 1]
        if p_cur not in vals or p_prev not in vals:
            break
        if vals[p_cur] > vals[p_prev]:
            count += 1
        else:
            break
    return count


def _get_thresholds(tenant_id: str, engine: sa.engine.Engine) -> dict[str, float]:
    with engine.connect() as conn:
        row = conn.execute(
            sa.text("SELECT * FROM delinquency_thresholds WHERE tenant_id = :tid"),
            {"tid": tenant_id},
        ).mappings().fetchone()
    return dict(row) if row else dict(_DELINQ_THRESHOLD_DEFAULTS)


def _auto_resolve_delinquency(
    tenant_id: str,
    charter: str,
    current_metrics: dict[str, float],
    thresholds: dict[str, float],
    engine: sa.engine.Engine,
) -> int:
    """
    Mark open threshold_breach alerts as resolved when the metric has returned
    below threshold. ALLL coverage alerts resolve when coverage is restored above min.
    """
    resolved = 0
    # Threshold breaches that have cleared
    for col, thresh_key, _ in _THRESHOLD_METRIC_MAP:
        cur_val = current_metrics.get(col)
        threshold = thresholds.get(thresh_key)
        if cur_val is None or threshold is None or cur_val > threshold:
            continue
        with engine.begin() as conn:
            r = conn.execute(
                sa.text("""
                    UPDATE alerts
                    SET    resolved_at = now()
                    WHERE  tenant_id   = :tid
                      AND  subject_id  = :charter
                      AND  metric      = :metric
                      AND  alert_type  = 'delinq_threshold_breach'
                      AND  resolved_at IS NULL
                """),
                {"tid": tenant_id, "charter": charter, "metric": col},
            )
            resolved += r.rowcount

    # ALLL coverage restored
    alll_cov = current_metrics.get("alll_coverage_ratio")
    alll_min = thresholds.get("alll_coverage_min", 1.0)
    if alll_cov is not None and alll_cov >= alll_min:
        with engine.begin() as conn:
            r = conn.execute(
                sa.text("""
                    UPDATE alerts
                    SET    resolved_at = now()
                    WHERE  tenant_id   = :tid
                      AND  subject_id  = :charter
                      AND  alert_type  = 'alll_coverage_decline'
                      AND  resolved_at IS NULL
                """),
                {"tid": tenant_id, "charter": charter},
            )
            resolved += r.rowcount

    return resolved


# ── Market-share detection ────────────────────────────────────────────────────

def _detect(
    geo: dict[str, Any],
    current_df: pd.DataFrame,
    prior_df: pd.DataFrame,
    period: str,
    prior: str,
) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    tenant_id      = geo["tenant_id"]
    geo_type       = geo["geography_type"]
    geo_id         = geo["geography_id"]
    geo_label      = geo["geography_label"] or geo_id
    metric         = geo["metric"]
    own_id         = geo["own_institution_id"]
    competitor_ids = set(geo["direct_competitor_ids"] or [])
    plabel         = _period_label(period)
    prior_label    = _period_label(prior)

    cur_map  = current_df.set_index("charter_or_cert") if not current_df.empty else pd.DataFrame()
    prev_map = prior_df.set_index("charter_or_cert")   if not prior_df.empty   else pd.DataFrame()

    def _base(alert_type, subject_institution, subject_id,
              current_share, prior_share, change_pp, prompt):
        return _Candidate(
            tenant_id=tenant_id, alert_type=alert_type,
            geography_type=geo_type, geography_id=geo_id,
            geography_label=geo_label, period=period, prior_period=prior,
            subject_institution=subject_institution, subject_id=subject_id,
            current_share=current_share, prior_share=prior_share,
            change_pp=change_pp, metric=metric, narrative_prompt=prompt,
        )

    if own_id and own_id in cur_map.index and own_id in prev_map.index:
        cur_share  = float(cur_map.loc[own_id]["market_share"])
        prev_share = float(prev_map.loc[own_id]["market_share"])
        delta      = cur_share - prev_share
        if abs(delta) >= _OWN_CHANGE_MIN:
            name      = str(cur_map.loc[own_id]["institution_name"])
            direction = "increased" if delta > 0 else "decreased"
            candidates.append(_base(
                "own_share_change", name, own_id, cur_share, prev_share,
                round(delta * 100, 3),
                (
                    f"{name} {direction} their {geo_label} {metric} market share "
                    f"by {abs(delta) * 100:.1f} percentage points in {plabel}, "
                    f"reaching {cur_share * 100:.1f}%. "
                    f"Their share the prior period ({prior_label}) was {prev_share * 100:.1f}%."
                ),
            ))

    for comp_id in competitor_ids:
        if comp_id not in cur_map.index or comp_id not in prev_map.index:
            continue
        cur_share  = float(cur_map.loc[comp_id]["market_share"])
        prev_share = float(prev_map.loc[comp_id]["market_share"])
        delta      = cur_share - prev_share
        if delta >= _COMPETITOR_GAIN_MIN:
            name = str(cur_map.loc[comp_id]["institution_name"])
            candidates.append(_base(
                "competitor_gain", name, comp_id, cur_share, prev_share,
                round(delta * 100, 3),
                (
                    f"Competitor {name} gained {delta * 100:.1f} percentage points "
                    f"of {metric} market share in {geo_label} in {plabel}, "
                    f"reaching {cur_share * 100:.1f}% from {prev_share * 100:.1f}% "
                    f"in {prior_label}."
                ),
            ))

    if not prior_df.empty and not current_df.empty:
        for new_id in set(cur_map.index) - set(prev_map.index):
            cur_share = float(cur_map.loc[new_id]["market_share"])
            if cur_share >= _NEW_ENTRANT_MIN:
                name = str(cur_map.loc[new_id]["institution_name"])
                candidates.append(_base(
                    "new_entrant", name, new_id, cur_share, None,
                    round(cur_share * 100, 3),
                    (
                        f"{name} entered the {geo_label} {metric} market in {plabel} "
                        f"with {cur_share * 100:.1f}% share, having had no presence "
                        f"in {prior_label}. This suggests a new branch opening or acquisition."
                    ),
                ))

    if not current_df.empty and not prior_df.empty:
        cur_total  = float(current_df["metric_value"].sum())
        prev_total = float(prior_df["metric_value"].sum())
        if prev_total > 0:
            growth = (cur_total - prev_total) / prev_total
            if growth >= _MARKET_GROWTH_MIN:
                candidates.append(_base(
                    "market_growth", None, "__market__", None, None,
                    round(growth * 100, 3),
                    (
                        f"Total {metric} in {geo_label} grew {growth * 100:.1f}% "
                        f"from {prior_label} to {plabel} "
                        f"(${prev_total / 1e6:.0f}M → ${cur_total / 1e6:.0f}M). "
                        f"This signals an expanding market opportunity for all participants."
                    ),
                ))

    return candidates


# ── Delinquency detection ─────────────────────────────────────────────────────

_DELINQ_METRIC_COLS = [
    "institution_name",
    "delinq_rate_total", "delinq_rate_auto", "delinq_rate_real_estate",
    "delinq_rate_credit_card", "delinq_rate_commercial", "delinq_90plus_rate",
    "chargeoff_rate_total",
    "alll_coverage_ratio",
    "oreo_balance",
]


async def _detect_delinquency(
    tenant_id: str,
    charter: str,
    period: str,
    prior: str,
    thresholds: dict[str, float],
    geography: tuple[str, str, str],   # (type, id, label)
    engine: sa.engine.Engine,
) -> list[_Candidate]:
    """
    Evaluate five delinquency alert conditions for one institution.
    Returns candidate alerts; caller generates narratives and persists.
    """
    geo_type, geo_id, geo_label = geography
    period_label = _period_label(period)

    current_row, prior_row = await asyncio.gather(
        asyncio.to_thread(_fetch_inst_metrics, charter, period, _DELINQ_METRIC_COLS, engine),
        asyncio.to_thread(_fetch_inst_metrics, charter, prior,  _DELINQ_METRIC_COLS, engine),
    )
    if not current_row.get("institution_name"):
        logger.debug("No delinquency data for charter=%s period=%s", charter, period)
        return []

    inst_name = str(current_row["institution_name"])
    candidates: list[_Candidate] = []

    def _base(alert_type: str, metric: str, cur: Optional[float], prv: Optional[float],
              change: Optional[float], prompt: str,
              peer_med: Optional[float] = None, pct_rank: Optional[float] = None,
              consec: Optional[int] = None) -> _Candidate:
        return _Candidate(
            tenant_id=tenant_id, alert_type=alert_type,
            geography_type=geo_type, geography_id=geo_id, geography_label=geo_label,
            period=period, prior_period=prior,
            subject_institution=inst_name, subject_id=charter,
            current_share=cur, prior_share=prv, change_pp=change,
            metric=metric, narrative_prompt=prompt,
            peer_median_rate=peer_med, percentile_rank=pct_rank,
            consecutive_quarters=consec if consec and consec >= 1 else None,
        )

    # Resolve peer group once — used for all peer comparisons this run
    peers = await asyncio.to_thread(get_regional_peers, charter, geo_type, geo_id, period, engine)

    # ── 1. Threshold breaches ──────────────────────────────────────────────────
    breach_specs = [
        (col, thresh_key, label)
        for col, thresh_key, label in _THRESHOLD_METRIC_MAP
        if current_row.get(col) is not None
        and float(current_row[col]) > thresholds.get(thresh_key, 9999.0)
    ]

    if breach_specs:
        metrics = [col for col, _, _ in breach_specs]
        dist_results, consec_results = await asyncio.gather(
            asyncio.gather(*[
                asyncio.to_thread(get_peer_distribution, col, period, peers, engine)
                for col in metrics
            ]),
            asyncio.gather(*[
                asyncio.to_thread(_count_consecutive, charter, col, period, 4, engine)
                for col in metrics
            ]),
        )
        for (col, thresh_key, label), dist, consec in zip(breach_specs, dist_results, consec_results):
            cur_val  = float(current_row[col])
            prior_val = float(prior_row[col]) if prior_row.get(col) is not None else None
            threshold = thresholds[thresh_key]
            pct_rank  = get_percentile_rank(cur_val, dist)
            rank_str  = f"{round(pct_rank * 100)}th percentile" if pct_rank else "unknown percentile"
            peer_med  = dist.get("median")

            prompt = (
                f"{inst_name} {label} rate reached {cur_val * 100:.2f}% in {period_label}, "
                f"exceeding the configured threshold of {threshold * 100:.1f}%"
                + (f" and placing them at the {rank_str} among regional peers" if pct_rank else "")
                + ". "
            )
            if consec >= 2:
                prompt += f"This is the {_ordinal(consec)} consecutive quarter of increase — a trend worth reviewing with the relevant lending team."
            elif prior_val is not None:
                direction = "rose" if cur_val > prior_val else "fell"
                prompt += f"The rate {direction} {abs(cur_val - prior_val) * 100:.2f} percentage points from the prior quarter."

            candidates.append(_base(
                "delinq_threshold_breach", col, cur_val, prior_val,
                round((cur_val - prior_val) * 100, 3) if prior_val is not None else None,
                prompt, peer_med, pct_rank, consec,
            ))

    # ── 2. Peer divergence ────────────────────────────────────────────────────
    cur_total  = current_row.get("delinq_rate_total")
    prior_total = prior_row.get("delinq_rate_total")
    if cur_total is not None and prior_total is not None and peers:
        cur_dist, prior_dist = await asyncio.gather(
            asyncio.to_thread(get_peer_distribution, "delinq_rate_total", period, peers, engine),
            asyncio.to_thread(get_peer_distribution, "delinq_rate_total", prior,  peers, engine),
        )
        cur_med   = cur_dist.get("median") or 0.0
        prior_med = prior_dist.get("median") or 0.0
        own_chg   = float(cur_total) - float(prior_total)
        peer_chg  = cur_med - prior_med
        divergence = own_chg - peer_chg

        if divergence > thresholds.get("peer_divergence_pp", 0.005):
            pct_rank = get_percentile_rank(float(cur_total), cur_dist)
            rank_str = f"{round(pct_rank * 100)}th" if pct_rank else "unknown"
            prompt = (
                f"{inst_name} total delinquency rose {own_chg * 100:.2f} pp in {period_label} "
                f"to {float(cur_total) * 100:.2f}%, while the regional peer median rose only "
                f"{peer_chg * 100:.2f} pp ({prior_med * 100:.2f}% → {cur_med * 100:.2f}%), "
                f"representing {divergence * 100:.2f} pp of institution-specific divergence. "
                f"Their rate is now at the {rank_str} percentile among regional peers."
            )
            candidates.append(_base(
                "delinq_peer_divergence", "delinq_rate_total",
                float(cur_total), float(prior_total),
                round(divergence * 100, 3),
                prompt, cur_med, pct_rank,
            ))

    # ── 3. ALLL coverage decline ──────────────────────────────────────────────
    alll_cov  = current_row.get("alll_coverage_ratio")
    prior_cov = prior_row.get("alll_coverage_ratio")
    if alll_cov is not None and float(alll_cov) < thresholds.get("alll_coverage_min", 1.0):
        alll_dist = await asyncio.to_thread(
            get_peer_distribution, "alll_coverage_ratio", period, peers, engine
        ) if peers else {}
        peer_med  = alll_dist.get("median")
        pct_rank  = get_percentile_rank(float(alll_cov), alll_dist) if alll_dist else None
        prompt = (
            f"{inst_name} ALLL coverage ratio fell to {float(alll_cov):.2f}x in {period_label}, "
            f"below the examiner-watch threshold of 1.0x"
            + (f" (prior quarter: {float(prior_cov):.2f}x)" if prior_cov else "")
            + (f"; peer median coverage is {peer_med:.2f}x" if peer_med else "")
            + ". "
            + "Reserves are insufficient to cover the current delinquent balance — "
            + "review ALLL adequacy methodology and consider provisioning before the next exam."
        )
        candidates.append(_base(
            "alll_coverage_decline", "alll_coverage_ratio",
            float(alll_cov),
            float(prior_cov) if prior_cov else None,
            round((float(alll_cov) - float(prior_cov)) * 100, 3) if prior_cov else None,
            prompt, peer_med, pct_rank,
        ))

    # ── 4. Charge-off acceleration ────────────────────────────────────────────
    co       = current_row.get("chargeoff_rate_total")
    prior_co = prior_row.get("chargeoff_rate_total")
    if co is not None and prior_co is not None and float(prior_co) > 0:
        accel = (float(co) - float(prior_co)) / float(prior_co)
        if accel > thresholds.get("chargeoff_acceleration", 0.25):
            co_dist  = await asyncio.to_thread(
                get_peer_distribution, "chargeoff_rate_total", period, peers, engine
            ) if peers else {}
            peer_med = co_dist.get("median")
            pct_rank = get_percentile_rank(float(co), co_dist) if co_dist else None
            prompt = (
                f"{inst_name} annualized net charge-off rate increased {accel * 100:.0f}% "
                f"quarter-over-quarter in {period_label}, "
                f"from {float(prior_co) * 100:.2f}% to {float(co) * 100:.2f}% (annualized). "
                + (f"The regional peer median NCO rate is {peer_med * 100:.2f}%." if peer_med else "")
            )
            candidates.append(_base(
                "chargeoff_acceleration", "chargeoff_rate_total",
                float(co), float(prior_co),
                round(accel * 100, 3),
                prompt, peer_med, pct_rank,
            ))

    # ── 5. OREO increase ──────────────────────────────────────────────────────
    oreo       = current_row.get("oreo_balance")
    prior_oreo = prior_row.get("oreo_balance")
    if oreo is not None and prior_oreo is not None and float(prior_oreo) > 0:
        oreo_chg = (float(oreo) - float(prior_oreo)) / float(prior_oreo)
        if oreo_chg > thresholds.get("oreo_increase", 0.20):
            prompt = (
                f"{inst_name} OREO balance grew {oreo_chg * 100:.0f}% quarter-over-quarter "
                f"in {period_label}, from ${float(prior_oreo) / 1_000:.0f}K "
                f"to ${float(oreo) / 1_000:.0f}K. "
                f"Rising OREO typically signals increased mortgage foreclosure activity "
                f"and may lead to further charge-offs in subsequent quarters."
            )
            candidates.append(_base(
                "oreo_increase", "oreo_balance",
                float(oreo), float(prior_oreo),
                round(oreo_chg * 100, 3),
                prompt,
            ))

    return candidates


# ── Claude narrative generation ───────────────────────────────────────────────

_NARRATIVE_SYSTEM = (
    "You write 2-sentence market intelligence alert notifications for credit union "
    "executives. The first sentence states the key fact with specific numbers. "
    "The second adds competitive context or significance — no generic filler. "
    "Be direct, professional, and data-specific. Return only the 2 sentences."
)

_DELINQ_NARRATIVE_SYSTEM = (
    "You write 2-sentence credit quality alert notifications for credit union executives. "
    "The first sentence states the specific metric name, the current rate as a percentage, "
    "the configured threshold or 1.0x minimum, and the percentile rank among peers if available. "
    "The second sentence adds trend context: consecutive quarters of increase, peer divergence, "
    "or examiner significance. Use exact numbers. Do not hedge. "
    "Return only the 2 sentences."
)


async def _generate_narrative(prompt: str, semaphore: asyncio.Semaphore) -> str:
    async with semaphore:
        response = await _client.messages.create(
            model="claude-opus-4-8",
            max_tokens=150,
            thinking={"type": "adaptive"},
            system=_NARRATIVE_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
    text_blocks = [b for b in response.content if b.type == "text"]
    return text_blocks[-1].text.strip() if text_blocks else prompt


async def _generate_delinq_narrative(prompt: str, semaphore: asyncio.Semaphore) -> str:
    async with semaphore:
        response = await _client.messages.create(
            model="claude-opus-4-8",
            max_tokens=180,
            thinking={"type": "adaptive"},
            system=_DELINQ_NARRATIVE_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
    text_blocks = [b for b in response.content if b.type == "text"]
    return text_blocks[-1].text.strip() if text_blocks else prompt


# ── DB write ──────────────────────────────────────────────────────────────────

def _insert_alert(c: _Candidate, narrative: str, engine: sa.engine.Engine) -> bool:
    """Insert alert; return True if new, False if duplicate (unique constraint)."""
    record = {
        "tenant_id":           c.tenant_id,
        "alert_type":          c.alert_type,
        "geography_type":      c.geography_type,
        "geography_id":        c.geography_id,
        "geography_label":     c.geography_label,
        "period":              c.period,
        "prior_period":        c.prior_period,
        "subject_institution": c.subject_institution,
        "subject_id":          c.subject_id,
        "current_share":       c.current_share,
        "prior_share":         c.prior_share,
        "change_pp":           c.change_pp,
        "metric":              c.metric,
        "narrative":           narrative,
        "peer_median_rate":    c.peer_median_rate,
        "percentile_rank":     c.percentile_rank,
        "consecutive_quarters": c.consecutive_quarters,
    }
    table = sa.table("alerts", *[sa.column(k) for k in record])
    stmt = (
        pg_insert(table)
        .values([record])
        .on_conflict_do_nothing(
            index_elements=[
                "tenant_id", "alert_type", "geography_type",
                "geography_id", "period", "subject_id", "metric",
            ]
        )
    )
    with engine.begin() as conn:
        return conn.execute(stmt).rowcount > 0


# ── Main detection orchestrator ───────────────────────────────────────────────

async def run_detection(
    tenant_id_filter: Optional[str] = None,
    engine: Optional[sa.engine.Engine] = None,
) -> DetectionSummary:
    """
    Run the full detection cycle: market-share phase + delinquency phase.
    Called quarterly by the scheduler or via POST /alerts/run.
    """
    if engine is None:
        engine = get_engine()

    _ensure_tables(engine)

    query  = "SELECT * FROM monitored_geographies"
    params: dict[str, Any] = {}
    if tenant_id_filter:
        query += " WHERE tenant_id = :tid"
        params["tid"] = tenant_id_filter

    with engine.connect() as conn:
        rows = conn.execute(sa.text(query), params).mappings().fetchall()

    geos       = [dict(r) for r in rows]
    tenant_ids = {g["tenant_id"] for g in geos}
    created = skipped = delinq_checks = 0

    semaphore = asyncio.Semaphore(5)

    # ── Phase 1: market-share detection ──────────────────────────────────────
    for geo in geos:
        metric = geo["metric"]
        period = await asyncio.to_thread(_latest_period, metric, engine)
        if not period:
            continue
        prior = _prior_period(period)

        try:
            current_df, prior_df = await asyncio.gather(
                asyncio.to_thread(
                    calculate_market_share,
                    geo["geography_type"], geo["geography_id"],
                    period, metric, list(geo["institution_types"]), engine,
                ),
                asyncio.to_thread(
                    calculate_market_share,
                    geo["geography_type"], geo["geography_id"],
                    prior, metric, list(geo["institution_types"]), engine,
                ),
            )
        except (ValueError, RuntimeError) as exc:
            logger.warning("Market share query failed for %s: %s", geo["geography_id"], exc)
            continue

        candidates = _detect(geo, current_df, prior_df, period, prior)
        if not candidates:
            continue

        narratives = await asyncio.gather(
            *[_generate_narrative(c.narrative_prompt, semaphore) for c in candidates]
        )
        for candidate, narrative in zip(candidates, narratives):
            inserted = await asyncio.to_thread(_insert_alert, candidate, narrative, engine)
            if inserted:
                created += 1
            else:
                skipped += 1

    # ── Phase 2: delinquency detection (once per unique own institution) ──────
    seen_charters: set[tuple[str, str]] = set()

    for geo in geos:
        charter = geo.get("own_institution_id")
        if not charter:
            continue
        key = (geo["tenant_id"], charter)
        if key in seen_charters:
            continue
        seen_charters.add(key)
        delinq_checks += 1

        delinq_period = await asyncio.to_thread(_latest_period, "loans", engine)
        if not delinq_period:
            continue
        prior_delinq = _prior_period(delinq_period)
        thresholds   = await asyncio.to_thread(_get_thresholds, geo["tenant_id"], engine)

        delinq_candidates = await _detect_delinquency(
            tenant_id=geo["tenant_id"],
            charter=charter,
            period=delinq_period,
            prior=prior_delinq,
            thresholds=thresholds,
            geography=(
                geo["geography_type"],
                geo["geography_id"],
                geo["geography_label"] or geo["geography_id"],
            ),
            engine=engine,
        )

        if delinq_candidates:
            delinq_narratives = await asyncio.gather(
                *[_generate_delinq_narrative(c.narrative_prompt, semaphore)
                  for c in delinq_candidates]
            )
            for c, narrative in zip(delinq_candidates, delinq_narratives):
                inserted = await asyncio.to_thread(_insert_alert, c, narrative, engine)
                if inserted:
                    created += 1
                    # Send immediate email for high-severity delinquency alerts
                    if c.alert_type in ("alll_coverage_decline",):
                        await asyncio.to_thread(
                            _maybe_send_immediate_delinq, geo["tenant_id"], c, narrative, engine
                        )
                else:
                    skipped += 1

        # Auto-resolve cleared threshold alerts
        if delinq_candidates or True:   # always check resolution, even if no new alerts
            current_metrics = await asyncio.to_thread(
                _fetch_inst_metrics, charter, delinq_period, _DELINQ_METRIC_COLS, engine
            )
            await asyncio.to_thread(
                _auto_resolve_delinquency,
                geo["tenant_id"], charter, current_metrics, thresholds, engine,
            )

    await _send_email_digests(tenant_ids, engine)

    return DetectionSummary(
        tenants_checked=len(tenant_ids),
        geographies_checked=len(geos),
        alerts_created=created,
        alerts_skipped_duplicate=skipped,
        delinq_checks=delinq_checks,
    )


# ── Email delivery ────────────────────────────────────────────────────────────

def _maybe_send_immediate_delinq(
    tenant_id: str, c: _Candidate, narrative: str, engine: sa.engine.Engine,
) -> None:
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(
                "SELECT digest_email, immediate_delinq_email FROM alert_preferences "
                "WHERE tenant_id = :tid AND immediate_delinq_email = true "
                "AND digest_email IS NOT NULL"
            ),
            {"tid": tenant_id},
        ).fetchone()
    if not row:
        return
    _, email = row
    _send_smtp(
        email,
        f"Immediate Alert: {c.alert_type.replace('_', ' ').title()} — {c.geography_label}",
        f"<p>{narrative}</p>"
        f"<p><small>{c.metric} · {c.period}</small></p>",
    )


async def _send_email_digests(
    tenant_ids: set[str], engine: sa.engine.Engine,
) -> None:
    if not tenant_ids:
        return

    placeholders = ", ".join(f":tid_{i}" for i in range(len(tenant_ids)))
    tid_params   = {f"tid_{i}": t for i, t in enumerate(tenant_ids)}

    with engine.connect() as conn:
        pref_rows = conn.execute(
            sa.text(
                f"SELECT tenant_id, digest_email FROM alert_preferences "
                f"WHERE email_digest_enabled = true AND digest_email IS NOT NULL "
                f"AND tenant_id IN ({placeholders})"
            ),
            tid_params,
        ).fetchall()

    for tenant_id, digest_email in pref_rows:
        with engine.connect() as conn:
            unsent = conn.execute(
                sa.text(
                    "SELECT id, narrative, alert_type, geography_label, period "
                    "FROM alerts "
                    "WHERE tenant_id = :tid AND email_sent_at IS NULL "
                    "ORDER BY created_at DESC"
                ),
                {"tid": tenant_id},
            ).fetchall()

        if not unsent:
            continue

        # Split into market-share and delinquency sections
        ms_items = [a for a in unsent if a.alert_type not in _DELINQ_ALERT_TYPES]
        dq_items = [a for a in unsent if a.alert_type in _DELINQ_ALERT_TYPES]

        def _li(a: Any) -> str:
            return (
                f"<li><strong>{a.geography_label} ({a.period})</strong> "
                f"&mdash; {a.narrative}</li>"
            )

        sections = ""
        if ms_items:
            sections += (
                "<h3 style='color:#1e3a8a'>Market Share Intelligence</h3>"
                f"<ul>{''.join(_li(a) for a in ms_items)}</ul>"
            )
        if dq_items:
            sections += (
                "<h3 style='color:#92400e'>Portfolio Credit Quality</h3>"
                f"<ul>{''.join(_li(a) for a in dq_items)}</ul>"
            )

        date_str  = datetime.now(timezone.utc).strftime("%B %d, %Y")
        html_body = (
            f"<h2>Market Intelligence Digest — {date_str}</h2>"
            f"{sections}"
        )

        await asyncio.to_thread(
            _send_smtp, digest_email, "Weekly Market Intelligence Digest", html_body
        )

        id_placeholders = ", ".join(f":aid_{i}" for i in range(len(unsent)))
        id_params       = {f"aid_{i}": a.id for i, a in enumerate(unsent)}
        with engine.begin() as conn:
            conn.execute(
                sa.text(
                    f"UPDATE alerts SET email_sent_at = now() "
                    f"WHERE id IN ({id_placeholders})"
                ),
                id_params,
            )
        logger.info(
            "Sent digest to %s (%d market-share, %d delinquency alerts)",
            digest_email, len(ms_items), len(dq_items),
        )


def _send_smtp(to: str, subject: str, html_body: str) -> None:
    smtp_host = os.getenv("SMTP_HOST", "")
    if not smtp_host:
        logger.info("SMTP_HOST not configured — skipping email to %s", to)
        return

    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    from_addr = os.getenv("SMTP_FROM", smtp_user)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = from_addr
    msg["To"]      = to
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as srv:
            srv.ehlo(); srv.starttls()
            if smtp_user:
                srv.login(smtp_user, smtp_pass)
            srv.sendmail(from_addr, to, msg.as_string())
    except smtplib.SMTPException as exc:
        logger.error("Failed to send email to %s: %s", to, exc)


# ── FastAPI endpoints ─────────────────────────────────────────────────────────

@router.get("/", response_model=list[AlertOut])
async def list_alerts(
    tenant_id: str,
    include_resolved: bool = False,
    alert_category: Optional[str] = None,   # 'market_share' | 'delinquency'
) -> list[AlertOut]:
    """Return alerts for the tenant, newest first. Excludes acknowledged and resolved by default."""
    engine = get_engine()
    _ensure_tables(engine)

    where = ["tenant_id = :tid", "acknowledged_at IS NULL"]
    params: dict[str, Any] = {"tid": tenant_id}

    if not include_resolved:
        where.append("resolved_at IS NULL")
    if alert_category == "delinquency":
        where.append("alert_type = ANY(:types)")
        params["types"] = sorted(_DELINQ_ALERT_TYPES)
    elif alert_category == "market_share":
        where.append("alert_type != ALL(:types)")
        params["types"] = sorted(_DELINQ_ALERT_TYPES)

    sql = f"SELECT * FROM alerts WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT 200"

    with engine.connect() as conn:
        rows = conn.execute(sa.text(sql), params).mappings().fetchall()

    return [
        AlertOut(
            id=r["id"],
            alert_type=r["alert_type"],
            geography_type=r["geography_type"],
            geography_id=r["geography_id"],
            geography_label=r["geography_label"],
            period=r["period"],
            prior_period=r["prior_period"],
            subject_institution=r["subject_institution"],
            current_share_pct=_to_pct(r["current_share"]),
            prior_share_pct=_to_pct(r["prior_share"]),
            change_pp=float(r["change_pp"]) if r["change_pp"] is not None else None,
            metric=r["metric"],
            narrative=r["narrative"],
            created_at=r["created_at"],
            acknowledged_at=r["acknowledged_at"],
            resolved_at=r.get("resolved_at"),
            peer_median_rate=float(r["peer_median_rate"]) if r.get("peer_median_rate") else None,
            percentile_rank=float(r["percentile_rank"]) if r.get("percentile_rank") else None,
            consecutive_quarters=r.get("consecutive_quarters"),
        )
        for r in rows
    ]


@router.post("/{alert_id}/acknowledge", status_code=204)
async def acknowledge_alert(alert_id: int, tenant_id: str) -> None:
    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.text(
                "UPDATE alerts SET acknowledged_at = now() "
                "WHERE id = :id AND tenant_id = :tid AND acknowledged_at IS NULL"
            ),
            {"id": alert_id, "tid": tenant_id},
        )
    if result.rowcount == 0:
        raise HTTPException(404, "Alert not found or already acknowledged")


@router.post("/{alert_id}/resolve", status_code=204)
async def resolve_alert(alert_id: int, tenant_id: str) -> None:
    """
    Mark an alert as manually resolved — e.g. after taking corrective action.
    Distinct from acknowledged (read): resolved means the underlying issue
    has been addressed.
    """
    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.text(
                "UPDATE alerts SET resolved_at = now() "
                "WHERE id = :id AND tenant_id = :tid AND resolved_at IS NULL"
            ),
            {"id": alert_id, "tid": tenant_id},
        )
    if result.rowcount == 0:
        raise HTTPException(404, "Alert not found or already resolved")


@router.post("/run", response_model=DetectionSummary)
async def trigger_detection(tenant_id_filter: Optional[str] = None) -> DetectionSummary:
    """Run both detection phases immediately. Restrict to admin roles in auth middleware."""
    return await run_detection(tenant_id_filter=tenant_id_filter)


# ── Monitored geography management ───────────────────────────────────────────

@router.get("/monitored", response_model=list[MonitoredGeoOut])
async def list_monitored(tenant_id: str) -> list[MonitoredGeoOut]:
    engine = get_engine()
    _ensure_tables(engine)
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT * FROM monitored_geographies WHERE tenant_id = :tid ORDER BY id"),
            {"tid": tenant_id},
        ).mappings().fetchall()
    return [MonitoredGeoOut(**dict(r)) for r in rows]


@router.post("/monitored", response_model=MonitoredGeoOut, status_code=201)
async def add_monitored(body: MonitoredGeoIn, tenant_id: str) -> MonitoredGeoOut:
    engine = get_engine()
    _ensure_tables(engine)
    record = {"tenant_id": tenant_id, **body.model_dump()}
    table  = sa.table("monitored_geographies", *[sa.column(k) for k in record])
    upsert_cols = ["geography_label", "institution_types", "own_institution_id", "direct_competitor_ids"]
    stmt = (
        pg_insert(table).values([record])
        .on_conflict_do_update(
            index_elements=["tenant_id", "geography_type", "geography_id", "metric"],
            set_={c: pg_insert(table).excluded[c] for c in upsert_cols},
        )
    )
    with engine.begin() as conn:
        conn.execute(stmt)
        row = conn.execute(
            sa.text(
                "SELECT * FROM monitored_geographies "
                "WHERE tenant_id = :tid AND geography_type = :gt "
                "AND geography_id = :gid AND metric = :m"
            ),
            {"tid": tenant_id, "gt": body.geography_type,
             "gid": body.geography_id, "m": body.metric},
        ).mappings().fetchone()
    return MonitoredGeoOut(**dict(row))


@router.delete("/monitored/{geo_id}", status_code=204)
async def remove_monitored(geo_id: int, tenant_id: str) -> None:
    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            sa.text("DELETE FROM monitored_geographies WHERE id = :id AND tenant_id = :tid"),
            {"id": geo_id, "tid": tenant_id},
        )
    if result.rowcount == 0:
        raise HTTPException(404, "Monitored geography not found")


# ── Alert preferences ─────────────────────────────────────────────────────────

@router.get("/preferences", response_model=AlertPreferences)
async def get_preferences(tenant_id: str) -> AlertPreferences:
    engine = get_engine()
    _ensure_tables(engine)
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(
                "SELECT email_digest_enabled, digest_email, immediate_delinq_email "
                "FROM alert_preferences WHERE tenant_id = :tid"
            ),
            {"tid": tenant_id},
        ).fetchone()
    if not row:
        return AlertPreferences()
    return AlertPreferences(
        email_digest_enabled=row[0],
        digest_email=row[1],
        immediate_delinq_email=row[2] if len(row) > 2 else False,
    )


@router.put("/preferences", response_model=AlertPreferences)
async def update_preferences(body: AlertPreferences, tenant_id: str) -> AlertPreferences:
    engine = get_engine()
    _ensure_tables(engine)
    table = sa.table(
        "alert_preferences",
        sa.column("tenant_id"), sa.column("email_digest_enabled"),
        sa.column("digest_email"), sa.column("immediate_delinq_email"),
        sa.column("updated_at"),
    )
    record = {
        "tenant_id":              tenant_id,
        "email_digest_enabled":   body.email_digest_enabled,
        "digest_email":           body.digest_email,
        "immediate_delinq_email": body.immediate_delinq_email,
        "updated_at":             datetime.now(timezone.utc),
    }
    stmt = (
        pg_insert(table).values([record])
        .on_conflict_do_update(
            index_elements=["tenant_id"],
            set_={k: record[k] for k in record if k != "tenant_id"},
        )
    )
    with engine.begin() as conn:
        conn.execute(stmt)
    return body


# ── Delinquency threshold management ─────────────────────────────────────────

@router.get("/delinquency-thresholds", response_model=DelinquencyThresholds)
async def get_delinquency_thresholds(tenant_id: str) -> DelinquencyThresholds:
    """Return current delinquency alert thresholds for the tenant (defaults if not configured)."""
    engine = get_engine()
    _ensure_tables(engine)
    thresholds = await asyncio.to_thread(_get_thresholds, tenant_id, engine)
    return DelinquencyThresholds(**{
        k: v for k, v in thresholds.items()
        if k in DelinquencyThresholds.model_fields
    })


@router.put("/delinquency-thresholds", response_model=DelinquencyThresholds)
async def update_delinquency_thresholds(
    body: DelinquencyThresholds, tenant_id: str,
) -> DelinquencyThresholds:
    """
    Update delinquency alert thresholds for the tenant.
    Thresholds are expressed as decimal fractions (0.015 = 1.5 %).
    """
    engine = get_engine()
    _ensure_tables(engine)
    record = {"tenant_id": tenant_id, **body.model_dump(), "updated_at": datetime.now(timezone.utc)}
    table  = sa.table("delinquency_thresholds", *[sa.column(k) for k in record])
    stmt = (
        pg_insert(table).values([record])
        .on_conflict_do_update(
            index_elements=["tenant_id"],
            set_={k: record[k] for k in record if k != "tenant_id"},
        )
    )
    with engine.begin() as conn:
        conn.execute(stmt)
    return body
