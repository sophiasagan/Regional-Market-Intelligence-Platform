"""
Market Share Engine.

Computes institution-level market share within a specified geography, period,
and metric.  Reads from three confidence tiers (highest to lowest):

  measured  — direct FDIC SOD branch deposits, or HMDA origination records
  modeled   — pre-computed county-level allocation written by estimation_model.py
  estimated — institution total from institutions_quarterly scaled by branch-count
              ratio (fallback when estimation_model.py has not been run yet)

Table dependencies (all read-only here):
  branches_annual          — written by fdic_ingester.py
  institutions_quarterly   — written by ncua_ingester.py
  metric_allocations       — written by estimation_model.py (gracefully absent)
  hmda_originations        — written by hmda_ingester.py   (gracefully absent)
  cbsa_county_crosswalk    — seed from Census delineation files for MSA geography
  custom_regions           — (region_name TEXT, county_fips TEXT) — user-managed
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

import pandas as pd
import sqlalchemy as sa

from ..database import get_engine

logger = logging.getLogger(__name__)

__all__ = ["calculate_market_share"]

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

VALID_GEOGRAPHY_TYPES = frozenset({"county", "msa", "state", "custom_region"})
VALID_METRICS = frozenset({"deposits", "loans", "members", "mortgage_originations"})
VALID_INSTITUTION_TYPES = frozenset({"credit_union", "bank"})

# Lower rank = higher data quality.  Used when deduplicating multi-source rows.
CONFIDENCE_RANK: dict[str, int] = {"measured": 0, "modeled": 1, "estimated": 2}

OUTPUT_COLUMNS = [
    "charter_or_cert",
    "institution_name",
    "institution_type",
    "metric_value",
    "market_share",
    "share_change_prior_period",
    "share_change_yoy",
    "confidence",
    "data_period",
]

_QUARTERLY_RE = re.compile(r"^(\d{4})Q([1-4])$")
_ANNUAL_RE = re.compile(r"^(\d{4})$")


# ──────────────────────────────────────────────────────────────────────────────
# Period arithmetic
# ──────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Period:
    raw: str
    year: int
    quarter: Optional[int]  # None for annual periods

    @classmethod
    def parse(cls, s: str) -> "_Period":
        m = _QUARTERLY_RE.match(s)
        if m:
            return cls(raw=s, year=int(m.group(1)), quarter=int(m.group(2)))
        m = _ANNUAL_RE.match(s)
        if m:
            return cls(raw=s, year=int(s), quarter=None)
        raise ValueError(f"Invalid period {s!r}; expected YYYYQ# or YYYY")

    @property
    def is_quarterly(self) -> bool:
        return self.quarter is not None

    def prior(self) -> "_Period":
        """One step back: prior quarter, or prior year for annual periods."""
        if self.is_quarterly:
            if self.quarter == 1:
                return _Period(f"{self.year - 1}Q4", self.year - 1, 4)
            return _Period(f"{self.year}Q{self.quarter - 1}", self.year, self.quarter - 1)
        return _Period(str(self.year - 1), self.year - 1, None)

    def yoy(self) -> "_Period":
        """Same quarter one year earlier (or prior year for annual)."""
        if self.is_quarterly:
            return _Period(f"{self.year - 1}Q{self.quarter}", self.year - 1, self.quarter)
        return _Period(str(self.year - 1), self.year - 1, None)


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def calculate_market_share(
    geography_type: str,
    geography_id: str,
    period: str,
    metric: str,
    institution_types: list[str],
    engine: Optional[sa.engine.Engine] = None,
) -> pd.DataFrame:
    """
    Calculate institution-level market share for a geography, period, and metric.

    Parameters
    ----------
    geography_type:
        "county" | "msa" | "state" | "custom_region"
    geography_id:
        5-digit county FIPS; CBSA code for MSA; 2-letter state abbreviation
        (or 2-digit state FIPS prefix) for state; region name for custom_region.
    period:
        "YYYYQ#" for quarterly data (NCUA-aligned).
        "YYYY"   for annual data  (FDIC-aligned).
        Note: FDIC deposit data is annual; quarterly periods use the matching
        annual FDIC snapshot for deposits.  Use estimation_model.py for
        intra-year interpolation when quarterly deposit deltas are required.
    metric:
        "deposits" | "loans" | "members" | "mortgage_originations"
    institution_types:
        ["credit_union"] | ["bank"] | ["credit_union", "bank"]

    Returns
    -------
    DataFrame sorted by market_share descending with columns:
        charter_or_cert, institution_name, institution_type, metric_value,
        market_share, share_change_prior_period, share_change_yoy,
        confidence, data_period.

    market_share and share_change columns are expressed as fractions (0–1).
    Returns an empty DataFrame (correct schema) when no data is found.
    """
    _validate_inputs(geography_type, metric, institution_types)
    parsed = _Period.parse(period)

    if engine is None:
        engine = get_engine()

    fips_list = _resolve_geography(geography_type, geography_id, engine)
    if not fips_list:
        logger.warning("No counties resolved for %s=%r", geography_type, geography_id)
        return _empty_result()

    current = _fetch_metric_data(fips_list, parsed, metric, institution_types, engine)
    if current.empty:
        logger.warning(
            "No data: period=%s metric=%s geography=%s/%r",
            period, metric, geography_type, geography_id,
        )
        return _empty_result()

    prior_df = _fetch_metric_data(fips_list, parsed.prior(), metric, institution_types, engine)
    yoy_df   = _fetch_metric_data(fips_list, parsed.yoy(),   metric, institution_types, engine)

    total_market = current["metric_value"].sum()
    current = current.copy()
    current["market_share"] = (
        (current["metric_value"] / total_market).round(6) if total_market > 0 else 0.0
    )

    result = _attach_changes(current, prior_df, yoy_df)
    result["data_period"] = period

    return (
        result[OUTPUT_COLUMNS]
        .sort_values("market_share", ascending=False)
        .reset_index(drop=True)
    )


# ──────────────────────────────────────────────────────────────────────────────
# Validation
# ──────────────────────────────────────────────────────────────────────────────

def _validate_inputs(
    geography_type: str, metric: str, institution_types: list[str]
) -> None:
    if geography_type not in VALID_GEOGRAPHY_TYPES:
        raise ValueError(
            f"geography_type={geography_type!r}; "
            f"must be one of {sorted(VALID_GEOGRAPHY_TYPES)}"
        )
    if metric not in VALID_METRICS:
        raise ValueError(
            f"metric={metric!r}; must be one of {sorted(VALID_METRICS)}"
        )
    if not institution_types:
        raise ValueError("institution_types must not be empty")
    invalid = set(institution_types) - VALID_INSTITUTION_TYPES
    if invalid:
        raise ValueError(f"Unknown institution_types: {invalid}")


# ──────────────────────────────────────────────────────────────────────────────
# Geography resolution  →  list[county_fips]
# ──────────────────────────────────────────────────────────────────────────────

def _resolve_geography(
    geography_type: str, geography_id: str, engine: sa.engine.Engine
) -> list[str]:
    """Translate a geography specifier to a list of 5-digit county FIPS codes."""
    if geography_type == "county":
        return [geography_id]
    if geography_type == "state":
        return _state_to_fips(geography_id, engine)
    if geography_type == "msa":
        return _cbsa_to_fips(geography_id, engine)
    if geography_type == "custom_region":
        return _custom_region_fips(geography_id, engine)
    return []  # unreachable after _validate_inputs


def _state_to_fips(state_id: str, engine: sa.engine.Engine) -> list[str]:
    """
    Returns distinct county FIPS for a state.
    state_id: "CA" (abbreviation) or "06" (FIPS prefix).
    """
    with engine.connect() as conn:
        if re.match(r"^[A-Za-z]{2}$", state_id):
            sql = sa.text(
                "SELECT DISTINCT county_fips FROM branches_annual "
                "WHERE state = :s AND county_fips IS NOT NULL"
            )
            rows = conn.execute(sql, {"s": state_id.upper()}).fetchall()
        else:
            sql = sa.text(
                "SELECT DISTINCT county_fips FROM branches_annual "
                "WHERE county_fips LIKE :prefix AND county_fips IS NOT NULL"
            )
            rows = conn.execute(sql, {"prefix": f"{state_id}%"}).fetchall()
    return [r[0] for r in rows]


def _cbsa_to_fips(cbsa_code: str, engine: sa.engine.Engine) -> list[str]:
    """
    Returns county FIPS codes for a CBSA code.

    Reads from cbsa_county_crosswalk, which must be seeded from the Census
    Bureau's CBSA delineation files:
    https://www.census.gov/geographies/reference-files/time-series/demo/metro-micro/delineation-files.html

    Raises RuntimeError with setup instructions if the table is absent.
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                sa.text(
                    "SELECT county_fips FROM cbsa_county_crosswalk "
                    "WHERE cbsa_code = :cbsa"
                ),
                {"cbsa": str(cbsa_code)},
            ).fetchall()
        if not rows:
            logger.warning("CBSA code %r returned no counties from cbsa_county_crosswalk", cbsa_code)
        return [r[0] for r in rows]
    except sa.exc.ProgrammingError:
        raise RuntimeError(
            "cbsa_county_crosswalk table not found. "
            "Create it with columns (cbsa_code TEXT, cbsa_name TEXT, county_fips TEXT) "
            "and load the Census Bureau CBSA delineation file before using MSA geography."
        )


def _custom_region_fips(region_name: str, engine: sa.engine.Engine) -> list[str]:
    """
    Returns county FIPS codes for a named custom region.
    Reads from custom_regions(region_name TEXT, county_fips TEXT).
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                sa.text(
                    "SELECT county_fips FROM custom_regions WHERE region_name = :rn"
                ),
                {"rn": region_name},
            ).fetchall()
        if not rows:
            logger.warning("Custom region %r returned no counties", region_name)
        return [r[0] for r in rows]
    except sa.exc.ProgrammingError:
        raise RuntimeError(
            "custom_regions table not found. "
            "Create it with columns (region_name TEXT, county_fips TEXT) "
            "and insert your region definitions."
        )


# ──────────────────────────────────────────────────────────────────────────────
# Metric fetching — top-level dispatcher
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_metric_data(
    fips_list: list[str],
    period: _Period,
    metric: str,
    institution_types: list[str],
    engine: sa.engine.Engine,
) -> pd.DataFrame:
    """
    Return per-institution metric values for the given geography and period.

    Source routing:
      deposits             → branches_annual (FDIC SOD)              [measured]
      mortgage_originations → hmda_originations                      [measured]
      loans / members      → metric_allocations (if populated)       [modeled]
                           → institutions_quarterly + branch scaling  [estimated]

    When metric_allocations is populated for a given period, it wins for
    loans/members.  The estimated fallback fires only for institutions
    present in branches_annual but absent from metric_allocations.
    """
    if metric == "deposits":
        # FDIC SOD is the canonical source; skip allocations to avoid double-counting
        return _fetch_fdic_deposits(fips_list, period, institution_types, engine)

    if metric == "mortgage_originations":
        return _fetch_hmda_originations(fips_list, period, institution_types, engine)

    # loans / members: allocations first, then estimated fallback
    frames: list[pd.DataFrame] = []

    alloc = _fetch_allocations(fips_list, period, metric, institution_types, engine)
    if not alloc.empty:
        frames.append(alloc)

    if "credit_union" in institution_types:
        est = _fetch_ncua_estimated(fips_list, period, metric, engine)
        if not est.empty:
            # Only keep estimated rows for CUs not already covered by allocations
            if not alloc.empty:
                covered = set(alloc["charter_or_cert"])
                est = est[~est["charter_or_cert"].isin(covered)]
            if not est.empty:
                frames.append(est)

    if not frames:
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    return _keep_best_confidence(combined)


# ──────────────────────────────────────────────────────────────────────────────
# Individual data-source fetchers
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_fdic_deposits(
    fips_list: list[str],
    period: _Period,
    institution_types: list[str],
    engine: sa.engine.Engine,
) -> pd.DataFrame:
    """
    Branch-level deposit aggregation from branches_annual.
    Covers both bank and credit union branches (FDIC SOD collects all
    depository institutions, including CUs, for deposit data).

    FDIC SOD is annual.  For quarterly periods, year is extracted from the
    period — all quarters within a year read the same annual snapshot.
    """
    file_types: list[str] = []
    if "credit_union" in institution_types:
        file_types.append("credit_union")
    if "bank" in institution_types:
        file_types.append("bank")

    fips_sql,  fips_params  = _in_params("b.county_fips", fips_list,  "fips")
    ftype_sql, ftype_params = _in_params("b.file_type",   file_types, "ft")

    sql = sa.text(f"""
        SELECT
            CASE b.file_type
                WHEN 'credit_union' THEN COALESCE(b.charter_number, b.cert_number::text)
                ELSE b.cert_number::text
            END                                         AS charter_or_cert,
            b.institution_name,
            CASE b.file_type
                WHEN 'credit_union' THEN 'credit_union'
                ELSE 'bank'
            END                                         AS institution_type,
            SUM(b.deposits_thousands * 1000.0)          AS metric_value,
            'measured'                                  AS confidence
        FROM branches_annual b
        WHERE {fips_sql}
          AND b.year = :year
          AND {ftype_sql}
          AND b.deposits_thousands IS NOT NULL
        GROUP BY
            CASE b.file_type
                WHEN 'credit_union' THEN COALESCE(b.charter_number, b.cert_number::text)
                ELSE b.cert_number::text
            END,
            b.institution_name,
            b.file_type
        HAVING SUM(b.deposits_thousands) > 0
    """)

    params = {**fips_params, **ftype_params, "year": period.year}
    return _query(engine, sql, params)


def _fetch_hmda_originations(
    fips_list: list[str],
    period: _Period,
    institution_types: list[str],
    engine: sa.engine.Engine,
) -> pd.DataFrame:
    """
    HMDA mortgage origination totals (action_taken = 1, home purchase + refi).
    Returns empty DataFrame if hmda_originations table has not been loaded yet.
    """
    fips_sql,  fips_params  = _in_params("h.county_fips",      fips_list,         "fips")
    itype_sql, itype_params = _in_params("h.institution_type",  institution_types, "itype")

    sql = sa.text(f"""
        SELECT
            COALESCE(h.lei, h.respondent_id)          AS charter_or_cert,
            h.institution_name,
            h.institution_type,
            SUM(h.loan_amount_thousands * 1000.0)     AS metric_value,
            'measured'                                 AS confidence
        FROM hmda_originations h
        WHERE {fips_sql}
          AND h.activity_year = :year
          AND h.action_taken  = 1
          AND h.loan_purpose  IN (1, 31)
          AND {itype_sql}
        GROUP BY
            COALESCE(h.lei, h.respondent_id),
            h.institution_name,
            h.institution_type
        HAVING SUM(h.loan_amount_thousands) > 0
    """)

    params = {**fips_params, **itype_params, "year": period.year}
    return _query(engine, sql, params, missing_table_ok=True)


def _fetch_allocations(
    fips_list: list[str],
    period: _Period,
    metric: str,
    institution_types: list[str],
    engine: sa.engine.Engine,
) -> pd.DataFrame:
    """
    Query pre-computed county-level allocations from estimation_model.py.

    metric_allocations stores one row per (institution × county × period × metric).
    We SUM across counties to get geography totals.  When a mix of confidence
    levels exists across counties for one institution, the aggregate inherits
    the worst (lowest-quality) confidence so callers are never over-confident.

    Returns empty DataFrame if metric_allocations does not exist yet.
    """
    fips_sql,  fips_params  = _in_params("ma.geography_id",      fips_list,         "fips")
    itype_sql, itype_params = _in_params("ma.institution_type",   institution_types, "itype")

    sql = sa.text(f"""
        SELECT
            ma.charter_or_cert,
            ma.institution_name,
            ma.institution_type,
            SUM(ma.allocated_value)   AS metric_value,
            CASE MAX(
                CASE ma.confidence
                    WHEN 'measured'  THEN 0
                    WHEN 'modeled'   THEN 1
                    ELSE                  2
                END
            )
                WHEN 0 THEN 'measured'
                WHEN 1 THEN 'modeled'
                ELSE        'estimated'
            END                       AS confidence
        FROM metric_allocations ma
        WHERE {fips_sql}
          AND ma.geography_type = 'county'
          AND ma.period         = :period
          AND ma.metric         = :metric
          AND {itype_sql}
        GROUP BY ma.charter_or_cert, ma.institution_name, ma.institution_type
        HAVING SUM(ma.allocated_value) > 0
    """)

    params = {**fips_params, **itype_params, "period": period.raw, "metric": metric}
    return _query(engine, sql, params, missing_table_ok=True)


def _fetch_ncua_estimated(
    fips_list: list[str],
    period: _Period,
    metric: str,
    engine: sa.engine.Engine,
) -> pd.DataFrame:
    """
    Estimated fallback for credit union loans and members.

    Allocates each CU's institution-level total from institutions_quarterly
    to the target geography in proportion to its branch count there:

        allocated = institution_total × (geo_branches / all_branches)

    Requires:
      • branches_annual to have the matching year (for branch counts)
      • institutions_quarterly to have the matching quarterly period

    Only meaningful for quarterly periods (institutions_quarterly granularity).
    Returns empty DataFrame for annual-only periods.
    """
    if not period.is_quarterly:
        return pd.DataFrame()

    if metric not in ("loans", "members"):
        return pd.DataFrame()

    metric_col = "iq.total_loans" if metric == "loans" else "iq.total_members"

    fips_sql, fips_params = _in_params("b_geo.county_fips", fips_list, "fips_geo")

    sql = sa.text(f"""
        WITH branches_in_geo AS (
            SELECT  b_geo.charter_number,
                    COUNT(DISTINCT b_geo.branch_id) AS geo_branches
            FROM    branches_annual b_geo
            WHERE   {fips_sql}
              AND   b_geo.year         = :year
              AND   b_geo.file_type    = 'credit_union'
              AND   b_geo.charter_number IS NOT NULL
            GROUP BY b_geo.charter_number
        ),
        total_branches AS (
            SELECT  b_all.charter_number,
                    COUNT(DISTINCT b_all.branch_id) AS all_branches
            FROM    branches_annual b_all
            WHERE   b_all.year      = :year
              AND   b_all.file_type = 'credit_union'
              AND   b_all.charter_number IS NOT NULL
            GROUP BY b_all.charter_number
        )
        SELECT
            n.charter_number                                                AS charter_or_cert,
            n.institution_name,
            'credit_union'                                                  AS institution_type,
            n.institution_total
                * (g.geo_branches::numeric / t.all_branches::numeric)      AS metric_value,
            'estimated'                                                     AS confidence
        FROM (
            SELECT iq.charter_number,
                   iq.institution_name,
                   {metric_col} AS institution_total
            FROM   institutions_quarterly iq
            WHERE  iq.data_period      = :period
              AND  {metric_col} IS NOT NULL
              AND  {metric_col}         > 0
        ) n
        JOIN branches_in_geo g ON g.charter_number = n.charter_number
        JOIN total_branches  t ON t.charter_number = n.charter_number
        WHERE t.all_branches > 0
    """)

    params = {**fips_params, "year": period.year, "period": period.raw}
    return _query(engine, sql, params, missing_table_ok=True)


# ──────────────────────────────────────────────────────────────────────────────
# Period-over-period change computation
# ──────────────────────────────────────────────────────────────────────────────

def _attach_changes(
    current: pd.DataFrame,
    prior: pd.DataFrame,
    yoy: pd.DataFrame,
) -> pd.DataFrame:
    """
    Join prior-period and year-over-year market shares onto current and
    compute share changes in percentage-point terms.

    share_change_prior_period = current_share − prior_share
    share_change_yoy          = current_share − yoy_share

    Rows with no comparison data get NaN (not 0) to distinguish "no change"
    from "no prior data available".
    """
    key = "charter_or_cert"

    def _market_shares(df: pd.DataFrame, col_name: str) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame(columns=[key, col_name])
        total = df["metric_value"].sum()
        out = df[[key, "metric_value"]].copy()
        out[col_name] = (
            (out["metric_value"] / total).round(6) if total > 0 else 0.0
        )
        return out[[key, col_name]]

    prior_shares = _market_shares(prior, "_share_prior")
    yoy_shares   = _market_shares(yoy,   "_share_yoy")

    result = current.merge(prior_shares, on=key, how="left")
    result = result.merge(yoy_shares,   on=key, how="left")

    result["share_change_prior_period"] = (
        (result["market_share"] - result["_share_prior"]).round(6)
    )
    result["share_change_yoy"] = (
        (result["market_share"] - result["_share_yoy"]).round(6)
    )

    return result.drop(columns=["_share_prior", "_share_yoy"], errors="ignore")


# ──────────────────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────────────────

def _keep_best_confidence(df: pd.DataFrame) -> pd.DataFrame:
    """
    When an institution appears in multiple source DataFrames, keep only the
    row from the highest-quality (lowest CONFIDENCE_RANK) source.
    metric_value is taken from that winning source row, not summed across sources.
    """
    if df.empty:
        return df
    df = df.copy()
    df["_rank"] = df["confidence"].map(CONFIDENCE_RANK).fillna(99)
    best = (
        df.sort_values("_rank")
        .groupby("charter_or_cert", as_index=False)
        .first()
        .drop(columns=["_rank"])
    )
    return best.reset_index(drop=True)


def _query(
    engine: sa.engine.Engine,
    sql: sa.TextClause,
    params: dict,
    missing_table_ok: bool = False,
) -> pd.DataFrame:
    """Execute a text query and return a DataFrame; handle absent tables gracefully."""
    try:
        with engine.connect() as conn:
            result = conn.execute(sql, params)
            rows = result.fetchall()
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=list(result.keys()))
    except sa.exc.ProgrammingError as exc:
        if missing_table_ok and "does not exist" in str(exc).lower():
            logger.debug("Table not found (skipping): %s", exc)
            return pd.DataFrame()
        raise


def _in_params(column: str, values: list, prefix: str) -> tuple[str, dict]:
    """
    Build a portable parameterized IN clause for an arbitrary-length value list.

    Returns (sql_fragment, params_dict), e.g.:
        ("b.county_fips IN (:fips_0, :fips_1)", {"fips_0": "01001", "fips_1": "01003"})

    Returns a never-matching fragment when values is empty, so callers don't
    need to guard against empty lists.
    """
    if not values:
        return "1 = 0", {}
    placeholders = ", ".join(f":{prefix}_{i}" for i in range(len(values)))
    params = {f"{prefix}_{i}": v for i, v in enumerate(values)}
    return f"{column} IN ({placeholders})", params


def _empty_result() -> pd.DataFrame:
    """Return an empty DataFrame with the correct output schema."""
    return pd.DataFrame(columns=OUTPUT_COLUMNS)
