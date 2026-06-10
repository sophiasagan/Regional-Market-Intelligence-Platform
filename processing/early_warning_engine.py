"""
Early warning engine for credit quality trend analysis.

Implements three signal types (CLAUDE.md §Early warning engine):

  Acceleration   — recent 2-quarter avg change vs prior 6-quarter avg change
                   acceleration_ratio > 2.0 AND adverse direction = alert

  Peer divergence — institution QoQ change vs peer median QoQ change
                   cumulative 4-quarter adverse divergence > 0.5 pp = diverging alert

  Threshold projection — linear extrapolation to examiner threshold
                   Only if trajectory adverse AND threshold not yet breached
                   Always includes disclaimer: "Linear projection only"

Alert levels:  watch (amber) | alert (orange) | urgent (red)
Panel default: collapsed when no alerts, auto-expands on any alert.

All metric values are stored as decimal fractions (0.018 == 1.8 %).
"""
from __future__ import annotations

import argparse
import logging
import math
from typing import Optional

import numpy as np
import sqlalchemy as sa

from database import get_engine

logger = logging.getLogger(__name__)

# ── Metric adversity direction ─────────────────────────────────────────────────
# Metrics where a HIGHER value means worse performance.
_ADVERSE_HIGH: frozenset[str] = frozenset({
    "delinq_rate_total", "delinq_rate_auto", "delinq_rate_real_estate",
    "delinq_rate_first_mortgage", "delinq_rate_credit_card",
    "delinq_rate_commercial", "delinq_rate_indirect",
    "delinq_rate_new_auto", "delinq_rate_used_auto",
    "delinq_90plus_rate", "chargeoff_rate_total",
    "tdr_to_loans_ratio", "oreo_to_assets_ratio",
    "delinq_total", "delinq_auto", "delinq_real_estate",
    "delinq_credit_card", "delinq_commercial", "delinq_90day",
    "net_charge_offs", "nco_auto", "nco_credit_card",
    "nco_real_estate", "nco_commercial", "tdr_balance", "oreo_balance",
})

# Metrics where a LOWER value means worse performance.
_ADVERSE_LOW: frozenset[str] = frozenset({
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
    "alll",
})

_EPS = 1e-12  # near-zero guard


def _is_adverse(metric: str, change: float) -> bool:
    """True when the change moves the metric toward worse performance."""
    if change == 0.0:
        return False
    if metric in _ADVERSE_LOW:
        return change < 0
    return change > 0  # default: higher = adverse (conservative)


# ── Alert-level thresholds ─────────────────────────────────────────────────────

# Acceleration: ratio of recent avg change to historical avg change
_ACCEL_WATCH  = 1.50
_ACCEL_ALERT  = 2.00
_ACCEL_URGENT = 3.00

# Peer divergence: cumulative 4-quarter adverse divergence (decimal fraction)
_DIV_WATCH  = 0.003   # 0.3 pp
_DIV_ALERT  = 0.005   # 0.5 pp  (spec threshold)
_DIV_URGENT = 0.010   # 1.0 pp

# Threshold projection: quarters remaining
_PROJ_URGENT = 4
_PROJ_ALERT  = 8
_PROJ_WATCH  = 12


def _accel_alert(ratio: float) -> str:
    if ratio >= _ACCEL_URGENT: return "urgent"
    if ratio >= _ACCEL_ALERT:  return "alert"
    if ratio >= _ACCEL_WATCH:  return "watch"
    return "none"


def _div_alert(score: float) -> str:
    a = abs(score)
    if a >= _DIV_URGENT: return "urgent"
    if a >= _DIV_ALERT:  return "alert"
    if a >= _DIV_WATCH:  return "watch"
    return "none"


def _proj_alert(quarters: float) -> str:
    if quarters < _PROJ_URGENT: return "urgent"
    if quarters < _PROJ_ALERT:  return "alert"
    if quarters < _PROJ_WATCH:  return "watch"
    return "none"


# ── Database helpers ───────────────────────────────────────────────────────────

def _fetch_series(
    charter_number: str,
    metric: str,
    n: int,
    engine: sa.engine.Engine,
) -> list[tuple[str, float]]:
    """
    Returns up to n most-recent (period, value) pairs for one institution,
    sorted oldest-first. Uses DISTINCT ON to deduplicate re-ingested periods.
    """
    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text(f"""
                    SELECT data_period, {metric}
                    FROM (
                        SELECT DISTINCT ON (data_period)
                               data_period, {metric}
                        FROM institutions_quarterly
                        WHERE charter_number = :cn
                          AND {metric}       IS NOT NULL
                          AND data_period    IS NOT NULL
                        ORDER BY data_period DESC, ingested_at DESC
                    ) t
                    ORDER BY data_period ASC
                """),
                {"cn": charter_number},
            ).fetchall()
        except sa.exc.ProgrammingError:
            logger.warning("Metric '%s' column not found in institutions_quarterly.", metric)
            return []

    series = [(str(r[0]), float(r[1])) for r in rows if r[0] is not None and r[1] is not None]
    return series[-n:] if len(series) > n else series


def _fetch_peer_series(
    metric: str,
    charter_numbers: list[str],
    period_keys: list[str],
    engine: sa.engine.Engine,
) -> dict[str, dict[str, float]]:
    """
    Returns {charter_number: {period: value}} for all peers across the given periods.
    """
    if not charter_numbers or not period_keys:
        return {}
    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text(f"""
                    SELECT DISTINCT ON (charter_number, data_period)
                           charter_number, data_period, {metric}
                    FROM institutions_quarterly
                    WHERE charter_number = ANY(:ids)
                      AND data_period    = ANY(:periods)
                      AND {metric}       IS NOT NULL
                    ORDER BY charter_number, data_period, ingested_at DESC
                """),
                {"ids": list(charter_numbers), "periods": list(period_keys)},
            ).fetchall()
        except sa.exc.ProgrammingError:
            return {}

    result: dict[str, dict[str, float]] = {}
    for row in rows:
        cn  = str(row[0])
        per = str(row[1])
        val = float(row[2])
        result.setdefault(cn, {})[per] = val
    return result


def _qoq_changes(series: list[tuple[str, float]]) -> list[float]:
    """Period-over-period changes from a sorted series of (period, value) pairs."""
    return [b - a for (_, a), (_, b) in zip(series[:-1], series[1:])]


# ── Engine ─────────────────────────────────────────────────────────────────────

class EarlyWarningEngine:
    """
    Three-signal early warning system for credit quality trends.

    Parameters
    ----------
    engine : optional SQLAlchemy engine (tests pass in-process engines without
             touching DATABASE_URL)
    """

    def __init__(self, engine: Optional[sa.engine.Engine] = None) -> None:
        self._engine = engine or get_engine()

    # ── Signal 1: Acceleration ─────────────────────────────────────────────────

    def detect_acceleration(
        self,
        charter_number: str,
        metric: str,
        lookback_quarters: int = 8,
    ) -> dict:
        """
        Compare the recent 2-quarter average QoQ change to the prior 6-quarter
        average.  Triggers when the ratio > 2.0 AND the direction is adverse.

        Returns
        -------
        {
            trend_status          : "accelerating" | "decelerating" | "stable"
                                    | "improving" | "insufficient_data"
            acceleration_ratio    : float  (recent_avg / historical_avg)
            recent_avg_change     : float
            historical_avg_change : float
            alert_level           : "watch" | "alert" | "urgent" | "none"
            quarters_of_data      : int    (number of QoQ changes available)
            is_adverse            : bool
            series                : list[{period, value}]
        }
        """
        # Need lookback_quarters + 1 data points to get lookback_quarters changes.
        series = _fetch_series(charter_number, metric, lookback_quarters + 1, self._engine)

        if len(series) < 3:
            return {
                "trend_status":          "insufficient_data",
                "acceleration_ratio":    None,
                "recent_avg_change":     None,
                "historical_avg_change": None,
                "alert_level":           "none",
                "quarters_of_data":      max(0, len(series) - 1),
                "is_adverse":            False,
                "series":                [{"period": p, "value": v} for p, v in series],
            }

        changes    = _qoq_changes(series)
        n_changes  = len(changes)
        recent     = changes[-min(2, n_changes):]
        historical = changes[:max(0, n_changes - 2)]

        recent_avg = float(np.mean(recent))
        hist_avg   = float(np.mean(historical)) if historical else 0.0

        current_adverse = _is_adverse(metric, recent_avg)

        # Compute the acceleration ratio, guarding against near-zero denominator.
        if abs(hist_avg) > _EPS:
            ratio = recent_avg / hist_avg
        elif current_adverse and abs(recent_avg) > _EPS:
            ratio = 5.0   # was flat, now worsening → high acceleration
        elif (not current_adverse) and abs(recent_avg) > _EPS:
            ratio = 0.1   # was flat, now improving
        else:
            ratio = 1.0

        ratio = float(np.clip(ratio, -20.0, 20.0))

        # Classify status
        if not current_adverse:
            status      = "improving" if abs(recent_avg) > _EPS else "stable"
            alert_level = "none"
        elif ratio < 0:
            # Direction reversal: was improving, now worsening
            status      = "accelerating"
            alert_level = "watch"
        elif ratio >= _ACCEL_ALERT:
            status      = "accelerating"
            alert_level = _accel_alert(ratio)
        elif ratio <= 0.50:
            status      = "decelerating"   # still adverse but slowing
            alert_level = "none"
        elif ratio >= _ACCEL_WATCH:
            status      = "accelerating"
            alert_level = "watch"
        else:
            status      = "stable"
            alert_level = "none"

        return {
            "trend_status":          status,
            "acceleration_ratio":    round(ratio, 3),
            "recent_avg_change":     round(recent_avg, 6),
            "historical_avg_change": round(hist_avg, 6),
            "alert_level":           alert_level,
            "quarters_of_data":      n_changes,
            "is_adverse":            current_adverse,
            "series":                [{"period": p, "value": v} for p, v in series],
        }

    # ── Signal 2: Peer divergence ──────────────────────────────────────────────

    def compute_peer_divergence(
        self,
        charter_number: str,
        metric: str,
        peer_group: list[str],
        periods: int = 4,
    ) -> dict:
        """
        Compare institution QoQ changes to peer median QoQ changes per quarter.
        Cumulative 4-quarter adverse divergence > 0.5 pp triggers a diverging alert.

        Parameters
        ----------
        peer_group : list of charter_numbers to compare against

        Returns
        -------
        {
            divergence_score   : float  (cumulative institution − peer divergence)
            institution_trend  : list[{period, change}]
            peer_trend         : list[{period, change}]
            divergence_pattern : "converging" | "stable" | "diverging"
                                 | "insufficient_data" | "insufficient_peer_data"
            alert_level        : "watch" | "alert" | "urgent" | "none"
            periods_analyzed   : int
            n_peers_with_data  : int
        }
        """
        # Need periods + 1 data points for periods QoQ changes.
        n_needed    = periods + 1
        inst_series = _fetch_series(charter_number, metric, n_needed, self._engine)

        if len(inst_series) < 2:
            return {
                "divergence_score":    None,
                "institution_trend":   [],
                "peer_trend":          [],
                "divergence_pattern":  "insufficient_data",
                "alert_level":         "none",
                "periods_analyzed":    0,
                "n_peers_with_data":   0,
            }

        period_keys = [p for p, _ in inst_series]
        peer_data   = _fetch_peer_series(metric, peer_group, period_keys, self._engine)

        if not peer_data:
            return {
                "divergence_score":    None,
                "institution_trend":   [],
                "peer_trend":          [],
                "divergence_pattern":  "insufficient_peer_data",
                "alert_level":         "none",
                "periods_analyzed":    0,
                "n_peers_with_data":   0,
            }

        inst_changes = _qoq_changes(inst_series)

        # For each consecutive (prior_period, curr_period) pair, compute peer
        # median change across all peers that have both data points.
        peer_median_by_period: dict[str, float] = {}
        for prior_p, curr_p in zip(period_keys[:-1], period_keys[1:]):
            peer_changes = []
            for cn_series in peer_data.values():
                prior_v = cn_series.get(prior_p)
                curr_v  = cn_series.get(curr_p)
                if prior_v is not None and curr_v is not None:
                    peer_changes.append(curr_v - prior_v)
            if len(peer_changes) >= 2:
                peer_median_by_period[curr_p] = float(np.median(peer_changes))

        n_peers_with_data = sum(
            1 for s in peer_data.values()
            if len(s) >= 2
        )

        if not peer_median_by_period:
            return {
                "divergence_score":    None,
                "institution_trend":   [],
                "peer_trend":          [],
                "divergence_pattern":  "insufficient_peer_data",
                "alert_level":         "none",
                "periods_analyzed":    0,
                "n_peers_with_data":   n_peers_with_data,
            }

        # Align institution and peer changes by period.
        aligned_periods = [p for p, _ in inst_series[1:]]
        inst_trend: list[dict]  = []
        peer_trend: list[dict]  = []
        divergences: list[float] = []

        for i, period in enumerate(aligned_periods):
            if i < len(inst_changes) and period in peer_median_by_period:
                ic = inst_changes[i]
                pc = peer_median_by_period[period]
                inst_trend.append({"period": period, "change": round(ic, 6)})
                peer_trend.append({"period": period, "change": round(pc, 6)})
                divergences.append(ic - pc)

        if not divergences:
            return {
                "divergence_score":    0.0,
                "institution_trend":   inst_trend,
                "peer_trend":          peer_trend,
                "divergence_pattern":  "stable",
                "alert_level":         "none",
                "periods_analyzed":    0,
                "n_peers_with_data":   n_peers_with_data,
            }

        cumulative = sum(divergences)

        # Determine if the cumulative divergence is in the adverse direction.
        inst_avg = float(np.mean([d["change"] for d in inst_trend]))
        adverse_cumulative = cumulative if _is_adverse(metric, inst_avg) else -cumulative

        alert_level = _div_alert(adverse_cumulative)
        if alert_level != "none":
            pattern = "diverging"
        elif adverse_cumulative <= -_DIV_WATCH:
            pattern = "converging"   # institution improving relative to peers
        else:
            pattern = "stable"

        return {
            "divergence_score":    round(cumulative, 6),
            "institution_trend":   inst_trend,
            "peer_trend":          peer_trend,
            "divergence_pattern":  pattern,
            "alert_level":         alert_level,
            "periods_analyzed":    len(divergences),
            "n_peers_with_data":   n_peers_with_data,
        }

    # ── Signal 3: Threshold projection ────────────────────────────────────────

    def estimate_quarters_to_threshold(
        self,
        charter_number: str,
        metric: str,
        threshold: float,
    ) -> dict:
        """
        Linear extrapolation of the last 4 quarters to estimate when the
        institution will breach an examiner threshold.

        Only returns a projection when:
          - the trend is adverse AND
          - the threshold has not yet been breached

        Returns
        -------
        {
            quarters_estimated         : float | None
            confidence                 : "low" | "medium" | "high"
            based_on_n_quarters        : int
            r_squared                  : float | None
            slope_per_quarter          : float | None
            current_value              : float | None
            threshold                  : float
            trending_toward_threshold  : bool
            already_breached           : bool
            alert_level                : "watch" | "alert" | "urgent" | "none"
            disclaimer_text            : str
        }
        """
        _disclaimer = "Linear projection only — actual outcomes depend on many factors"

        # Use last 5 data points → 4 QoQ intervals for the trend.
        series = _fetch_series(charter_number, metric, 5, self._engine)

        if len(series) < 2:
            return {
                "quarters_estimated":        None,
                "confidence":                "low",
                "based_on_n_quarters":       0,
                "r_squared":                 None,
                "slope_per_quarter":         None,
                "current_value":             None,
                "threshold":                 threshold,
                "trending_toward_threshold": False,
                "already_breached":          False,
                "alert_level":               "none",
                "disclaimer_text":           _disclaimer,
            }

        current_value = series[-1][1]
        n_data        = len(series)

        # Check whether the threshold has already been breached.
        already_breached = (
            (metric not in _ADVERSE_LOW and current_value >= threshold) or
            (metric in _ADVERSE_LOW     and current_value <= threshold)
        )

        if already_breached:
            return {
                "quarters_estimated":        0,
                "confidence":                "high",
                "based_on_n_quarters":       n_data - 1,
                "r_squared":                 None,
                "slope_per_quarter":         None,
                "current_value":             current_value,
                "threshold":                 threshold,
                "trending_toward_threshold": True,
                "already_breached":          True,
                "alert_level":               "urgent",
                "disclaimer_text":           _disclaimer,
            }

        # Fit a linear trend over available data points.
        values = np.array([v for _, v in series], dtype=float)
        x      = np.arange(len(values), dtype=float)
        coeffs = np.polyfit(x, values, 1)
        slope  = float(coeffs[0])

        # R-squared for confidence assessment.
        predicted = np.polyval(coeffs, x)
        ss_res    = float(np.sum((values - predicted) ** 2))
        ss_tot    = float(np.sum((values - np.mean(values)) ** 2))
        r_squared = float(1.0 - ss_res / ss_tot) if ss_tot > _EPS else 0.0

        # Only project if the slope is adverse.
        trending_adverse = _is_adverse(metric, slope)

        if not trending_adverse or abs(slope) < _EPS:
            return {
                "quarters_estimated":        None,
                "confidence":                "low",
                "based_on_n_quarters":       n_data - 1,
                "r_squared":                 round(r_squared, 3),
                "slope_per_quarter":         round(slope, 6),
                "current_value":             current_value,
                "threshold":                 threshold,
                "trending_toward_threshold": False,
                "already_breached":          False,
                "alert_level":               "none",
                "disclaimer_text":           _disclaimer,
            }

        # quarters = (threshold − current) / slope
        quarters = (threshold - current_value) / slope

        if not math.isfinite(quarters) or quarters <= 0:
            return {
                "quarters_estimated":        None,
                "confidence":                "low",
                "based_on_n_quarters":       n_data - 1,
                "r_squared":                 round(r_squared, 3),
                "slope_per_quarter":         round(slope, 6),
                "current_value":             current_value,
                "threshold":                 threshold,
                "trending_toward_threshold": True,
                "already_breached":          False,
                "alert_level":               "none",
                "disclaimer_text":           _disclaimer,
            }

        # Confidence: driven by number of data points and trend consistency.
        if n_data >= 5 and r_squared >= 0.70:
            confidence = "high"
        elif n_data >= 3 and r_squared >= 0.40:
            confidence = "medium"
        else:
            confidence = "low"

        return {
            "quarters_estimated":        round(quarters, 1),
            "confidence":                confidence,
            "based_on_n_quarters":       n_data - 1,
            "r_squared":                 round(r_squared, 3),
            "slope_per_quarter":         round(slope, 6),
            "current_value":             current_value,
            "threshold":                 threshold,
            "trending_toward_threshold": True,
            "already_breached":          False,
            "alert_level":               _proj_alert(quarters),
            "disclaimer_text":           _disclaimer,
        }

    # ── Convenience: run all three signals ────────────────────────────────────

    def run_all_signals(
        self,
        charter_number: str,
        metric: str,
        peer_group: list[str],
        threshold: Optional[float] = None,
    ) -> dict:
        """
        Run all three early warning signals and return a combined result with
        the highest alert level across all active signals.

        Used by EarlyWarningPanel.jsx: panel auto-expands if any_alert is True.
        """
        acceleration = self.detect_acceleration(charter_number, metric)
        divergence   = self.compute_peer_divergence(charter_number, metric, peer_group)
        projection   = (
            self.estimate_quarters_to_threshold(charter_number, metric, threshold)
            if threshold is not None
            else {"alert_level": "none", "quarters_estimated": None}
        )

        _rank = {"none": 0, "watch": 1, "alert": 2, "urgent": 3}
        levels = [
            acceleration.get("alert_level", "none"),
            divergence.get("alert_level",   "none"),
            projection.get("alert_level",   "none"),
        ]
        max_level = max(levels, key=lambda lvl: _rank.get(lvl, 0))

        return {
            "acceleration": acceleration,
            "divergence":   divergence,
            "projection":   projection,
            "max_alert_level": max_level,
            "any_alert":    max_level != "none",
        }


# ── CLI entry point ────────────────────────────────────────────────────────────
# python -m processing.early_warning_engine --run-all

def _run_all(args: argparse.Namespace) -> None:
    """
    Batch run: for each charter in the DB, compute acceleration for each key
    metric and print any active alerts.  Intended for cron / daily batch runs.
    """
    engine = get_engine()
    ew     = EarlyWarningEngine(engine)

    key_metrics = [
        "delinq_rate_total",
        "delinq_rate_auto",
        "delinq_rate_credit_card",
        "chargeoff_rate_total",
        "alll_coverage_ratio",
    ]

    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("""
                SELECT DISTINCT charter_number, institution_name
                FROM institutions_quarterly
                WHERE data_period = (
                    SELECT MAX(data_period) FROM institutions_quarterly
                )
                ORDER BY institution_name
            """)
        ).fetchall()

    logger.info("Running early warning batch for %d institutions.", len(rows))
    alerts_found = 0

    for cn, name in rows:
        charter = str(cn)
        for metric in key_metrics:
            result = ew.detect_acceleration(charter, metric)
            level  = result.get("alert_level", "none")
            if level != "none":
                alerts_found += 1
                logger.warning(
                    "[%s] %s | %s | %s | ratio=%.2f",
                    level.upper(), name, charter, metric,
                    result.get("acceleration_ratio") or 0,
                )

    logger.info("Batch complete. %d alert(s) found.", alerts_found)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Early warning engine")
    parser.add_argument("--run-all", action="store_true",
                        help="Run acceleration scan for all institutions")
    _args = parser.parse_args()

    if _args.run_all:
        _run_all(_args)
    else:
        parser.print_help()
