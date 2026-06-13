"""
compute_peer_distributions.py

Pre-computes percentile distributions (p10/p25/median/p75/p90/mean/std_dev)
for every NCUA account code × peer group × period and upserts the results
into the peer_distributions table.

Run automatically after NCUA ingestion (ingestion/scheduler.py calls this),
or manually:

    python -m processing.compute_peer_distributions
    python -m processing.compute_peer_distributions --period 2024Q4
    python -m processing.compute_peer_distributions --period 2024Q4 --force   # recompute even if current

Typical run time: 20–40 minutes for all account codes × all peer groups × all periods.
Most of that is pandas percentile math; the database I/O is a single bulk upsert per period.

Design notes:
  - All institution data for a period is loaded once per period into memory (pandas),
    then sliced per peer group in Python — avoids N×M queries.
  - Computed ratios (charge-off rate, coverage ratio, etc.) are evaluated in pandas
    so the formula is visible and auditable, not buried in SQL.
  - Growth rates (YoY) require fetching the prior-year period; these are computed
    as a separate pass at the end.
  - peer_groups rows are seeded/upserted before any distribution computation begins.
  - All upserts use ON CONFLICT DO UPDATE so re-running is idempotent.
"""
from __future__ import annotations

import argparse
import logging
import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_engine

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

# ─────────────────────────────────────────────────────────────────────────────
# Asset tier boundaries (match ASSET_TIERS in processing/peer_engine.py)
# ─────────────────────────────────────────────────────────────────────────────

ASSET_TIER_RANGES: dict[str, tuple[float, float]] = {
    "under_250M": (0,               250_000_000),
    "250M_1B":    (250_000_000,   1_000_000_000),
    "1B_5B":      (1_000_000_000, 5_000_000_000),
    "over_5B":    (5_000_000_000, math.inf),
}

ASSET_TIER_LABELS: dict[str, str] = {
    "under_250M": "Under $250M",
    "250M_1B":    "$250M – $1B",
    "1B_5B":      "$1B – $5B",
    "over_5B":    "Over $5B",
}


# ─────────────────────────────────────────────────────────────────────────────
# Direct account codes — columns that already exist in institutions_quarterly
# ─────────────────────────────────────────────────────────────────────────────

DIRECT_ACCOUNTS: list[str] = [
    # Asset quality — delinquency rates
    "delinq_rate_total",
    "delinq_90plus_rate",
    "delinq_rate_auto",
    "delinq_rate_real_estate",
    "delinq_rate_first_mortgage",
    "delinq_rate_credit_card",
    "delinq_rate_commercial",
    "delinq_rate_indirect",
    # Asset quality — coverage
    "alll_coverage_ratio",
    "alll_to_loans_ratio",
    # Balance sheet ratios
    "net_worth_ratio",
    "loan_to_share_ratio",
    # Volume metrics
    "total_assets",
    "total_loans",
    "total_deposits",
    "total_members",
    # Earnings (stored if available — may be null for many institutions)
    "return_on_assets",
    "net_interest_margin",
    "operating_expense_ratio",
    "efficiency_ratio",
    "risk_based_capital",
]

# ─────────────────────────────────────────────────────────────────────────────
# Computed ratio definitions
# Each entry defines how to derive the metric from raw balance columns.
# formula_str is stored in peer_distributions.ratio_formula for transparency.
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ComputedRatio:
    account_code: str
    formula_str: str                           # human-readable; stored in DB
    raw_cols: list[str]                        # columns that must be fetched
    fn: object = field(compare=False)          # callable(row: pd.Series) → float|None

    def compute_series(self, df: pd.DataFrame) -> pd.Series:
        """Apply formula to every row in df; returns a float Series."""
        missing = [c for c in self.raw_cols if c not in df.columns]
        if missing:
            return pd.Series(dtype=float, index=df.index)
        try:
            return df.apply(self.fn, axis=1).astype(float)
        except Exception:
            return pd.Series(dtype=float, index=df.index)


def _safe_div(num: float | None, den: float | None) -> Optional[float]:
    if num is None or den is None or den == 0:
        return None
    v = num / den
    return v if math.isfinite(v) else None


COMPUTED_RATIOS: list[ComputedRatio] = [

    ComputedRatio(
        account_code="chargeoff_rate_total",
        formula_str="net_charge_offs / NULLIF(total_loans,0) * 4",
        raw_cols=["net_charge_offs", "total_loans"],
        fn=lambda r: _safe_div(r.get("net_charge_offs"), r.get("total_loans"))
                     and (r["net_charge_offs"] / r["total_loans"]) * 4
                     if r.get("total_loans") else None,
    ),

    ComputedRatio(
        account_code="tdr_to_loans_ratio",
        formula_str="tdr_balance / NULLIF(total_loans,0)",
        raw_cols=["tdr_balance", "total_loans"],
        fn=lambda r: _safe_div(r.get("tdr_balance"), r.get("total_loans")),
    ),

    ComputedRatio(
        account_code="oreo_to_assets_ratio",
        formula_str="oreo_balance / NULLIF(total_assets,0)",
        raw_cols=["oreo_balance", "total_assets"],
        fn=lambda r: _safe_div(r.get("oreo_balance"), r.get("total_assets")),
    ),

    ComputedRatio(
        account_code="borrowings_to_assets",
        formula_str="total_borrowings / NULLIF(total_assets,0)",
        raw_cols=["total_borrowings", "total_assets"],
        fn=lambda r: _safe_div(r.get("total_borrowings"), r.get("total_assets")),
    ),

    ComputedRatio(
        account_code="fee_income_ratio",
        formula_str="non_interest_income / NULLIF(total_assets,0) * 4",
        raw_cols=["non_interest_income", "total_assets"],
        fn=lambda r: (_safe_div(r.get("non_interest_income"), r.get("total_assets")) or 0) * 4
                     if r.get("total_assets") else None,
    ),

    ComputedRatio(
        account_code="yield_on_loans",
        formula_str="interest_income_loans / NULLIF(total_loans,0) * 4",
        raw_cols=["interest_income_loans", "total_loans"],
        fn=lambda r: (_safe_div(r.get("interest_income_loans"), r.get("total_loans")) or 0) * 4
                     if r.get("total_loans") else None,
    ),

    ComputedRatio(
        account_code="cost_of_funds",
        formula_str="interest_expense / NULLIF(total_deposits + total_borrowings, 0) * 4",
        raw_cols=["interest_expense", "total_deposits", "total_borrowings"],
        fn=lambda r: _safe_div(
            r.get("interest_expense"),
            (r.get("total_deposits") or 0) + (r.get("total_borrowings") or 0),
        ) and (r.get("interest_expense") / max(
            (r.get("total_deposits") or 0) + (r.get("total_borrowings") or 0), 1
        )) * 4,
    ),

    ComputedRatio(
        account_code="interest_rate_spread",
        formula_str="yield_on_loans - cost_of_funds  (derived, not direct subtraction)",
        raw_cols=["interest_income_loans", "total_loans",
                  "interest_expense", "total_deposits", "total_borrowings"],
        fn=lambda r: (
            (_safe_div(r.get("interest_income_loans"), r.get("total_loans")) or 0) * 4
            - (_safe_div(r.get("interest_expense"),
               (r.get("total_deposits") or 0) + (r.get("total_borrowings") or 0)) or 0) * 4
        ) or None if r.get("total_loans") and r.get("total_deposits") else None,
    ),

    ComputedRatio(
        account_code="credit_loss_expense_to_loans",
        formula_str="provision_for_loan_losses / NULLIF(total_loans,0) * 4",
        raw_cols=["provision_for_loan_losses", "total_loans"],
        fn=lambda r: (_safe_div(r.get("provision_for_loan_losses"), r.get("total_loans")) or 0) * 4
                     if r.get("total_loans") else None,
    ),

    ComputedRatio(
        account_code="short_term_investments",
        formula_str="investments_short_term / NULLIF(total_assets,0)",
        raw_cols=["investments_short_term", "total_assets"],
        fn=lambda r: _safe_div(r.get("investments_short_term"), r.get("total_assets")),
    ),

    ComputedRatio(
        account_code="cash_to_assets",
        formula_str="cash_and_equivalents / NULLIF(total_assets,0)",
        raw_cols=["cash_and_equivalents", "total_assets"],
        fn=lambda r: _safe_div(r.get("cash_and_equivalents"), r.get("total_assets")),
    ),
]

# Growth rate accounts — computed via YoY comparison (handled separately)
GROWTH_ACCOUNTS: list[str] = [
    "member_growth_rate",
    "loan_growth_rate",
    "deposit_growth_rate",
    "asset_growth_rate",
]

GROWTH_ACCOUNT_COLS: dict[str, str] = {
    "member_growth_rate":  "total_members",
    "loan_growth_rate":    "total_loans",
    "deposit_growth_rate": "total_deposits",
    "asset_growth_rate":   "total_assets",
}

# All account codes that will have rows in peer_distributions
ALL_ACCOUNTS: list[str] = (
    DIRECT_ACCOUNTS
    + [cr.account_code for cr in COMPUTED_RATIOS]
    + GROWTH_ACCOUNTS
)

# All raw columns we need to fetch for the full account list
_COMPUTED_RAW_COLS: set[str] = {
    col for cr in COMPUTED_RATIOS for col in cr.raw_cols
}
_FETCH_COLUMNS: set[str] = (
    {"charter_number", "state", "total_assets"}
    | set(DIRECT_ACCOUNTS)
    | _COMPUTED_RAW_COLS
    | set(GROWTH_ACCOUNT_COLS.values())
)


# ─────────────────────────────────────────────────────────────────────────────
# Peer group definitions
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PeerGroupDef:
    group_type: str
    state: Optional[str]
    asset_tier: Optional[str]
    label: str
    description: str = ""
    db_id: Optional[str] = None   # filled in after seeding peer_groups table


def _standard_peer_groups() -> list[PeerGroupDef]:
    groups: list[PeerGroupDef] = []

    # 1. National all
    groups.append(PeerGroupDef(
        group_type="national_all",
        state=None,
        asset_tier=None,
        label="National — All Credit Unions",
        description="All NCUA-insured credit unions, any state and asset size.",
    ))

    # 2. National by asset tier (one per tier)
    for tier_key, tier_label in ASSET_TIER_LABELS.items():
        groups.append(PeerGroupDef(
            group_type="national_tier",
            state=None,
            asset_tier=tier_key,
            label=f"National — {tier_label}",
            description=f"All credit unions nationally in the {tier_label} asset tier.",
        ))

    # 3. State all (each of the 50 states + DC/PR/territories)
    _states = [
        "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID",
        "IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO",
        "MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
        "PR","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
    ]
    for st in _states:
        groups.append(PeerGroupDef(
            group_type="state_all",
            state=st,
            asset_tier=None,
            label=f"{st} — All Credit Unions",
            description=f"All credit unions chartered or headquartered in {st}.",
        ))

    # 4. State × tier (generated at compute time; only written if n_peers >= MIN_PEERS)
    for st in _states:
        for tier_key, tier_label in ASSET_TIER_LABELS.items():
            groups.append(PeerGroupDef(
                group_type="state_tier",
                state=st,
                asset_tier=tier_key,
                label=f"{st} — {tier_label}",
                description=f"Credit unions in {st} with assets in the {tier_label} range.",
            ))

    return groups


# ─────────────────────────────────────────────────────────────────────────────
# Percentile statistics (pure Python / numpy — no DB percentile_cont needed)
# ─────────────────────────────────────────────────────────────────────────────

def _compute_stats(values: pd.Series) -> Optional[dict]:
    """
    Returns p10/p25/median/p75/p90/mean/std_dev for a Series of floats.
    Returns None if there are fewer than MIN_PEERS valid values.
    """
    MIN_PEERS = 5
    clean = values.dropna().replace([math.inf, -math.inf], pd.NA).dropna()
    if len(clean) < MIN_PEERS:
        return None
    arr = clean.astype(float).values
    return {
        "n_peers": int(len(arr)),
        "p10":     float(np.percentile(arr, 10)),
        "p25":     float(np.percentile(arr, 25)),
        "median":  float(np.percentile(arr, 50)),
        "p75":     float(np.percentile(arr, 75)),
        "p90":     float(np.percentile(arr, 90)),
        "mean":    float(np.mean(arr)),
        "std_dev": float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Database helpers
# ─────────────────────────────────────────────────────────────────────────────

def ensure_schema(engine: sa.engine.Engine) -> None:
    """Create tables if they don't exist. Safe to call on every run."""
    ddl = """
    CREATE TABLE IF NOT EXISTS peer_groups (
        id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        label       TEXT    NOT NULL,
        group_type  TEXT    NOT NULL,
        state       TEXT,
        asset_tier  TEXT,
        description TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (group_type, state, asset_tier)
    );

    CREATE TABLE IF NOT EXISTS peer_distributions (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        account_code      TEXT        NOT NULL,
        is_computed_ratio BOOLEAN     NOT NULL DEFAULT FALSE,
        ratio_formula     TEXT,
        period            TEXT        NOT NULL,
        peer_group_id     UUID        NOT NULL REFERENCES peer_groups(id) ON DELETE CASCADE,
        n_peers           INTEGER,
        p10               DECIMAL(18,8),
        p25               DECIMAL(18,8),
        median            DECIMAL(18,8),
        p75               DECIMAL(18,8),
        p90               DECIMAL(18,8),
        mean              DECIMAL(18,8),
        std_dev           DECIMAL(18,8),
        computed_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
        UNIQUE (account_code, period, peer_group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_peer_dist_lookup
        ON peer_distributions (account_code, period, peer_group_id);
    CREATE INDEX IF NOT EXISTS idx_peer_dist_period
        ON peer_distributions (period);
    CREATE INDEX IF NOT EXISTS idx_peer_dist_group
        ON peer_distributions (peer_group_id, period);
    """
    with engine.begin() as conn:
        conn.execute(text(ddl))
    logger.info("Schema ensured.")


def seed_peer_groups(
    groups: list[PeerGroupDef],
    engine: sa.engine.Engine,
) -> dict[tuple, str]:
    """
    Upsert the standard peer group definitions and return a mapping of
    (group_type, state, asset_tier) → UUID string.
    """
    rows = [
        {
            "label":       g.label,
            "group_type":  g.group_type,
            "state":       g.state,
            "asset_tier":  g.asset_tier,
            "description": g.description,
        }
        for g in groups
    ]

    with engine.begin() as conn:
        stmt = text("""
            INSERT INTO peer_groups (label, group_type, state, asset_tier, description)
            VALUES (:label, :group_type, :state, :asset_tier, :description)
            ON CONFLICT (group_type, state, asset_tier)
            DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
            RETURNING id, group_type, state, asset_tier
        """)
        result = conn.execute(stmt, rows)
        key_to_id: dict[tuple, str] = {
            (r.group_type, r.state, r.asset_tier): str(r.id)
            for r in result
        }

    logger.info("Seeded/updated %d peer group definitions.", len(key_to_id))
    return key_to_id


def get_available_periods(engine: sa.engine.Engine) -> list[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT DISTINCT data_period FROM institutions_quarterly ORDER BY data_period")
        ).fetchall()
    return [r[0] for r in rows]


def get_computed_periods(
    engine: sa.engine.Engine,
    account_code: str = "delinq_rate_total",
) -> set[str]:
    """Periods that already have at least one distribution row for this account."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT DISTINCT period FROM peer_distributions
                WHERE account_code = :ac
            """),
            {"ac": account_code},
        ).fetchall()
    return {r[0] for r in rows}


def fetch_period_data(period: str, engine: sa.engine.Engine) -> pd.DataFrame:
    """
    Load all columns needed for distribution computation for one period.
    Returns a DataFrame with one row per institution.
    Missing columns in the DB return as NaN without error.
    """
    # Build SELECT: only the columns that exist in the table
    with engine.connect() as conn:
        existing_cols_raw = conn.execute(
            text("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'institutions_quarterly'
            """)
        ).fetchall()
    existing_cols = {r[0] for r in existing_cols_raw}

    cols_to_fetch = sorted(c for c in _FETCH_COLUMNS if c in existing_cols)
    # Always include the key columns
    for required in ("charter_number", "state", "total_assets"):
        if required not in cols_to_fetch and required in existing_cols:
            cols_to_fetch.append(required)

    select_expr = ", ".join(cols_to_fetch)
    with engine.connect() as conn:
        df = pd.read_sql(
            text(f"SELECT {select_expr} FROM institutions_quarterly WHERE data_period = :p"),
            conn,
            params={"p": period},
        )
    logger.info("Loaded %d institutions for period %s (%d columns).", len(df), period, len(df.columns))
    return df


def fetch_prior_year_data(period: str, engine: sa.engine.Engine) -> Optional[pd.DataFrame]:
    """Fetch the same-quarter prior-year data for growth rate computation."""
    try:
        year = int(period[:4]) - 1
        q    = period[4:]
        prior_period = f"{year}{q}"
        growth_cols  = list(GROWTH_ACCOUNT_COLS.values()) + ["charter_number"]
        with engine.connect() as conn:
            existing_cols_raw = conn.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name='institutions_quarterly'")
            ).fetchall()
        existing = {r[0] for r in existing_cols_raw}
        cols = [c for c in growth_cols if c in existing]
        with engine.connect() as conn:
            return pd.read_sql(
                text(f"SELECT {', '.join(cols)} FROM institutions_quarterly WHERE data_period = :p"),
                conn,
                params={"p": prior_period},
            )
    except Exception as exc:
        logger.warning("Could not fetch prior-year data: %s", exc)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Distribution computation
# ─────────────────────────────────────────────────────────────────────────────

def _filter_to_peer_group(
    df: pd.DataFrame,
    group: PeerGroupDef,
) -> pd.DataFrame:
    """Slice the full-period DataFrame to only this peer group's members."""
    mask = pd.Series(True, index=df.index)

    if group.state:
        mask &= df["state"] == group.state

    if group.asset_tier and group.asset_tier in ASSET_TIER_RANGES:
        lo, hi = ASSET_TIER_RANGES[group.asset_tier]
        ta = df["total_assets"].astype(float).fillna(0)
        mask &= (ta >= lo) & (ta < hi)

    return df[mask].copy()


def compute_distributions_for_period(
    period: str,
    df: pd.DataFrame,
    df_prior: Optional[pd.DataFrame],
    groups: list[PeerGroupDef],
    key_to_id: dict[tuple, str],
    computed_ratio_map: dict[str, ComputedRatio],
) -> list[dict]:
    """
    Compute all distributions for one period across all peer groups.
    Returns a list of dicts ready for bulk upsert into peer_distributions.
    """
    rows: list[dict] = []

    # Pre-compute ratio series on the full DataFrame once
    ratio_series: dict[str, pd.Series] = {}
    for cr in COMPUTED_RATIOS:
        ratio_series[cr.account_code] = cr.compute_series(df)

    # Growth rates: merge current + prior year on charter_number
    growth_series: dict[str, pd.Series] = {}
    if df_prior is not None and not df_prior.empty:
        merged = df.set_index("charter_number").join(
            df_prior.set_index("charter_number"),
            rsuffix="_prior",
            how="left",
        )
        for acc, col in GROWTH_ACCOUNT_COLS.items():
            prior_col = f"{col}_prior"
            if col in merged.columns and prior_col in merged.columns:
                cur   = merged[col].astype(float)
                prior = merged[prior_col].astype(float)
                growth_series[acc] = ((cur - prior) / prior.abs().replace(0, pd.NA)).reindex(df["charter_number"]).values
            else:
                growth_series[acc] = pd.Series(dtype=float, index=df.index)

    for group in groups:
        peer_key = (group.group_type, group.state, group.asset_tier)
        pg_id = key_to_id.get(peer_key)
        if not pg_id:
            continue

        peer_df = _filter_to_peer_group(df, group)
        if len(peer_df) < 5:
            continue  # skip groups with fewer than 5 members

        # Direct columns
        for ac in DIRECT_ACCOUNTS:
            if ac not in peer_df.columns:
                continue
            stats = _compute_stats(peer_df[ac].astype(float))
            if not stats:
                continue
            rows.append({
                "account_code":      ac,
                "is_computed_ratio": False,
                "ratio_formula":     None,
                "period":            period,
                "peer_group_id":     pg_id,
                **stats,
            })

        # Computed ratios
        for cr in COMPUTED_RATIOS:
            s = ratio_series[cr.account_code]
            # Align to peer_df index
            peer_vals = s.loc[peer_df.index] if hasattr(s, "loc") else s[peer_df.index]
            stats = _compute_stats(peer_vals.astype(float))
            if not stats:
                continue
            rows.append({
                "account_code":      cr.account_code,
                "is_computed_ratio": True,
                "ratio_formula":     cr.formula_str,
                "period":            period,
                "peer_group_id":     pg_id,
                **stats,
            })

        # Growth rates
        for acc in GROWTH_ACCOUNTS:
            s = growth_series.get(acc)
            if s is None:
                continue
            peer_vals = pd.Series(s, index=df.index).loc[peer_df.index]
            stats = _compute_stats(peer_vals.astype(float))
            if not stats:
                continue
            rows.append({
                "account_code":      acc,
                "is_computed_ratio": True,
                "ratio_formula":     f"({GROWTH_ACCOUNT_COLS[acc]}_current - {GROWTH_ACCOUNT_COLS[acc]}_prior_year) / {GROWTH_ACCOUNT_COLS[acc]}_prior_year",
                "period":            period,
                "peer_group_id":     pg_id,
                **stats,
            })

    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Bulk upsert
# ─────────────────────────────────────────────────────────────────────────────

_UPSERT_CHUNK = 500   # rows per INSERT statement


def upsert_distributions(rows: list[dict], engine: sa.engine.Engine) -> int:
    """
    Bulk upsert computed distribution rows into peer_distributions.
    Uses INSERT ... ON CONFLICT DO UPDATE so re-runs are idempotent.
    Returns the number of rows written.
    """
    if not rows:
        return 0

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for r in rows:
        r.setdefault("computed_at", now)

    inserted = 0
    table = sa.table(
        "peer_distributions",
        sa.column("account_code"),
        sa.column("is_computed_ratio"),
        sa.column("ratio_formula"),
        sa.column("period"),
        sa.column("peer_group_id"),
        sa.column("n_peers"),
        sa.column("p10"), sa.column("p25"), sa.column("median"),
        sa.column("p75"), sa.column("p90"),
        sa.column("mean"), sa.column("std_dev"),
        sa.column("computed_at"),
    )

    for i in range(0, len(rows), _UPSERT_CHUNK):
        chunk = rows[i : i + _UPSERT_CHUNK]
        stmt = pg_insert(table).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["account_code", "period", "peer_group_id"],
            set_={
                "n_peers":           stmt.excluded.n_peers,
                "p10":               stmt.excluded.p10,
                "p25":               stmt.excluded.p25,
                "median":            stmt.excluded.median,
                "p75":               stmt.excluded.p75,
                "p90":               stmt.excluded.p90,
                "mean":              stmt.excluded.mean,
                "std_dev":           stmt.excluded.std_dev,
                "is_computed_ratio": stmt.excluded.is_computed_ratio,
                "ratio_formula":     stmt.excluded.ratio_formula,
                "computed_at":       stmt.excluded.computed_at,
            },
        )
        with engine.begin() as conn:
            conn.execute(stmt)
        inserted += len(chunk)

    return inserted


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────

def run(
    periods: Optional[list[str]] = None,
    force: bool = False,
    engine: Optional[sa.engine.Engine] = None,
) -> None:
    """
    Full computation run.

    Parameters
    ----------
    periods:  List of period strings to process. None = all available.
    force:    If True, recompute periods that already have distributions.
    engine:   SQLAlchemy engine. None = use default from database.py.
    """
    t0 = time.monotonic()
    engine = engine or get_engine()

    # 1. Ensure tables exist
    ensure_schema(engine)

    # 2. Seed/refresh peer group definitions
    groups = _standard_peer_groups()
    key_to_id = seed_peer_groups(groups, engine)

    # 3. Determine which periods to compute
    available = get_available_periods(engine)
    if not available:
        logger.warning("No periods found in institutions_quarterly. Nothing to compute.")
        return

    if periods:
        targets = [p for p in periods if p in available]
        skipped = [p for p in periods if p not in available]
        if skipped:
            logger.warning("Periods not in DB (skipping): %s", skipped)
    else:
        targets = available

    if not force:
        already_done = get_computed_periods(engine)
        targets = [p for p in targets if p not in already_done]

    if not targets:
        logger.info("All requested periods already computed. Use --force to recompute.")
        return

    logger.info("Computing distributions for %d period(s): %s", len(targets), targets)

    computed_ratio_map = {cr.account_code: cr for cr in COMPUTED_RATIOS}
    total_rows = 0

    for period in sorted(targets):
        tp = time.monotonic()
        logger.info("── Period %s ──────────────────────────────────────────────", period)

        df = fetch_period_data(period, engine)
        if df.empty:
            logger.warning("No data for period %s; skipping.", period)
            continue

        df_prior = fetch_prior_year_data(period, engine)

        rows = compute_distributions_for_period(
            period=period,
            df=df,
            df_prior=df_prior,
            groups=groups,
            key_to_id=key_to_id,
            computed_ratio_map=computed_ratio_map,
        )

        n = upsert_distributions(rows, engine)
        total_rows += n
        logger.info(
            "Period %s complete: %d distribution rows in %.1fs.",
            period, n, time.monotonic() - tp,
        )

    elapsed = time.monotonic() - t0
    logger.info(
        "compute_peer_distributions finished. %d total rows in %.1f min.",
        total_rows, elapsed / 60,
    )


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Pre-compute peer distributions for all NCUA account codes."
    )
    p.add_argument(
        "--period",
        metavar="YYYYQ#",
        help="Compute only this period (e.g. 2024Q4). Repeatable.",
        action="append",
        dest="periods",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Recompute even if distributions already exist for the period.",
    )
    p.add_argument(
        "--list-accounts",
        action="store_true",
        help="Print all account codes that will be computed and exit.",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    if args.list_accounts:
        print("\nDirect columns:")
        for ac in DIRECT_ACCOUNTS:
            print(f"  {ac}")
        print("\nComputed ratios:")
        for cr in COMPUTED_RATIOS:
            print(f"  {cr.account_code:40s}  {cr.formula_str}")
        print("\nGrowth rates (YoY):")
        for ac in GROWTH_ACCOUNTS:
            print(f"  {ac}")
        raise SystemExit(0)

    run(periods=args.periods, force=args.force)
