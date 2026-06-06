"""
NCUA 5300 Call Report ingester.

Downloads quarterly call report ZIP from NCUA, parses the main data file,
and upserts normalized records into the institutions_quarterly table.
"""

from __future__ import annotations

import io
import logging
import zipfile
from datetime import datetime, timezone
from typing import Optional

import httpx
import pandas as pd
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..database import get_engine  # adjust import path to match your project

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Column mapping: raw NCUA name → standard schema name
# Keys are lowercase; we lower-strip the raw header before matching.
# ---------------------------------------------------------------------------
COLUMN_MAP: dict[str, str] = {
    # ── Identity / balance sheet ──────────────────────────────────────────────
    "cu_number":            "charter_number",
    "charter_number":       "charter_number",
    "cu_name":              "institution_name",
    "credit_union_name":    "institution_name",
    "state_code":           "state",
    "state":                "state",
    "total_assets":         "total_assets",
    "shares_and_deposits":  "total_shares_deposits",
    "total_shares":         "total_shares_deposits",
    "total_loans":          "total_loans",
    "loans":                "total_loans",           # alternate NCUA field name
    "lnsreceivrble":        "total_loans",           # FS220 code used in some years
    "number_of_members":    "total_members",
    "total_members":        "total_members",
    "number_of_offices":    "number_of_branches",
    "num_offices":          "number_of_branches",
    "net_income":           "net_income",
    "loan_to_share_ratio":  "loan_to_share_ratio",
    "net_worth_ratio":      "net_worth_ratio",
    "roa":                  "roa",
    "return_on_assets":     "roa",
    "field_of_membership":  "field_of_membership",
    "fom_code":             "field_of_membership",

    # ── Delinquent balances ───────────────────────────────────────────────────
    # Total delinquency (all loan categories)
    "delinq_loans":             "delinq_total",
    "delinq":                   "delinq_total",
    "total_delinq":             "delinq_total",
    "delinquent_total":         "delinq_total",
    "delinqloans":              "delinq_total",
    "dlnq_total":               "delinq_total",

    # Real-estate delinquency
    "delinq_real_estate":       "delinq_real_estate",
    "delinqre":                 "delinq_real_estate",
    "dlnq_real_estate":         "delinq_real_estate",
    "delinquent_real_estate":   "delinq_real_estate",
    "delinq_1st_re":            "delinq_real_estate",

    # Auto delinquency
    "delinq_auto":              "delinq_auto",
    "delinqauto":               "delinq_auto",
    "dlnq_auto":                "delinq_auto",
    "delinquent_auto":          "delinq_auto",
    "delinq_auto_loans":        "delinq_auto",

    # Credit-card delinquency
    "delinq_credit_card":       "delinq_credit_card",
    "delinqcc":                 "delinq_credit_card",
    "dlnq_credit_card":         "delinq_credit_card",
    "delinquent_credit_card":   "delinq_credit_card",
    "delinq_cc":                "delinq_credit_card",

    # Commercial / member-business delinquency
    "delinq_commercial":        "delinq_commercial",
    "delinqcomm":               "delinq_commercial",
    "dlnq_commercial":          "delinq_commercial",
    "delinquent_commercial":    "delinq_commercial",
    "delinq_member_bus":        "delinq_commercial",
    "delinq_mbl":               "delinq_commercial",

    # 90-day delinquency
    "delinq_90day":             "delinq_90day",
    "delinq_90":                "delinq_90day",
    "dlnq_90":                  "delinq_90day",
    "delinquent_90":            "delinq_90day",
    "delinq90":                 "delinq_90day",
    "delinq_90_days":           "delinq_90day",

    # ── Per-category loan balances (denominators for delinquency rates) ───────
    "loans_real_estate":        "loans_real_estate",
    "real_estate_loans":        "loans_real_estate",
    "total_re_loans":           "loans_real_estate",
    "lns_real_estate":          "loans_real_estate",
    "first_mortgage_loans":     "loans_real_estate",

    "loans_auto":               "loans_auto",
    "auto_loans":               "loans_auto",
    "total_auto_loans":         "loans_auto",
    "lns_auto":                 "loans_auto",

    "loans_credit_card":        "loans_credit_card",
    "credit_card_loans":        "loans_credit_card",
    "total_credit_card":        "loans_credit_card",
    "cc_loans":                 "loans_credit_card",
    "lns_credit_card":          "loans_credit_card",

    "loans_commercial":         "loans_commercial",
    "commercial_loans":         "loans_commercial",
    "total_commercial":         "loans_commercial",
    "comm_loans":               "loans_commercial",
    "member_business_loans":    "loans_commercial",
    "mbl_total":                "loans_commercial",

    # ── Net charge-offs ───────────────────────────────────────────────────────
    "net_charge_offs":          "net_charge_offs",
    "total_nco":                "net_charge_offs",
    "netchargeoffs":            "net_charge_offs",
    "nco_total":                "net_charge_offs",
    "net_charge_off":           "net_charge_offs",
    "tot_charge_offs":          "net_charge_offs",

    "nco_auto":                 "nco_auto",
    "net_charge_offs_auto":     "nco_auto",
    "charge_offs_auto":         "nco_auto",

    "nco_credit_card":          "nco_credit_card",
    "nco_cc":                   "nco_credit_card",
    "net_charge_offs_cc":       "nco_credit_card",
    "charge_offs_credit_card":  "nco_credit_card",

    "nco_real_estate":          "nco_real_estate",
    "nco_re":                   "nco_real_estate",
    "net_charge_offs_re":       "nco_real_estate",
    "charge_offs_real_estate":  "nco_real_estate",

    "nco_commercial":           "nco_commercial",
    "nco_comm":                 "nco_commercial",
    "net_charge_offs_comm":     "nco_commercial",
    "charge_offs_commercial":   "nco_commercial",
    "nco_mbl":                  "nco_commercial",

    # ── Credit-quality reserves and watch items ───────────────────────────────
    "alll":                         "alll",
    "allowance_for_loan_losses":    "alll",
    "allow_loan_losses":            "alll",
    "alll_balance":                 "alll",
    "loan_loss_reserve":            "alll",
    "allowance_loan_lease_losses":  "alll",
    "alll_lns":                     "alll",

    "tdr_balance":                  "tdr_balance",
    "tdr":                          "tdr_balance",
    "troubled_debt_restructuring":  "tdr_balance",
    "total_tdr":                    "tdr_balance",
    "tdr_loans":                    "tdr_balance",

    "oreo_balance":                 "oreo_balance",
    "oreo":                         "oreo_balance",
    "other_real_estate_owned":      "oreo_balance",
    "total_oreo":                   "oreo_balance",
    "foreclosed_assets":            "oreo_balance",
}

REQUIRED_COLUMNS = {
    "charter_number",
    "institution_name",
    "state",
    "total_assets",
    "total_shares_deposits",
    "total_loans",
}

NCUA_BASE_URL = "https://www.ncua.gov/files/publications/analysis/call-report-data-{year}-Q{quarter}.zip"


def ingest_ncua_quarter(year: int, quarter: int, engine: Optional[sa.engine.Engine] = None) -> pd.DataFrame:
    """
    Download, parse, and upsert one quarter of NCUA 5300 call report data.

    Parameters
    ----------
    year:     Four-digit year (e.g. 2024).
    quarter:  Quarter number 1–4.

    Returns
    -------
    DataFrame of the records that were inserted or updated this run,
    with a ``upsert_action`` column ("insert" | "update").
    """
    if quarter not in (1, 2, 3, 4):
        raise ValueError(f"quarter must be 1–4, got {quarter}")

    url = NCUA_BASE_URL.format(year=year, quarter=quarter)
    data_period = f"{year}Q{quarter}"

    logger.info("Downloading NCUA 5300 data for %s from %s", data_period, url)
    raw_zip = _download(url)

    df = _parse_zip(raw_zip, data_period)
    logger.info("Parsed %d records for %s", len(df), data_period)

    if engine is None:
        engine = get_engine()

    upserted = _upsert(df, engine)
    logger.info(
        "Upsert complete for %s: %d inserted, %d updated",
        data_period,
        (upserted["upsert_action"] == "insert").sum(),
        (upserted["upsert_action"] == "update").sum(),
    )
    return upserted


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _download(url: str) -> bytes:
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        response = client.get(url)
        response.raise_for_status()
    return response.content


def _parse_zip(raw_zip: bytes, data_period: str) -> pd.DataFrame:
    """Extract the main CSV from the ZIP and return a normalized DataFrame."""
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        csv_name = _pick_main_csv(zf.namelist())
        logger.debug("Reading %s from ZIP", csv_name)
        with zf.open(csv_name) as fh:
            raw = pd.read_csv(fh, dtype=str, low_memory=False)

    df = _normalize_columns(raw)
    df = _cast_numeric(df)
    df = _compute_derived_rates(df)

    now = datetime.now(timezone.utc)
    df["data_period"] = data_period
    df["source"] = "ncua_5300"
    df["ingested_at"] = now

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns after normalization: {missing}")

    return df


def _pick_main_csv(names: list[str]) -> str:
    """
    NCUA ZIPs typically contain one primary data file plus a README or codebook.
    Heuristic: pick the largest .csv file (by name length as tie-break).
    """
    csvs = [n for n in names if n.lower().endswith(".csv")]
    if not csvs:
        raise ValueError(f"No CSV file found in ZIP. Contents: {names}")

    # Prefer files whose name contains recognizable data keywords
    data_keywords = ("5300", "call", "data", "fs220")
    for kw in data_keywords:
        candidates = [c for c in csvs if kw in c.lower()]
        if candidates:
            return candidates[0]

    return csvs[0]


def _normalize_columns(raw: pd.DataFrame) -> pd.DataFrame:
    """Map raw headers to standard schema names, keeping only mapped columns."""
    # Build a mapping from the actual headers present
    mapping = {}
    for col in raw.columns:
        key = col.strip().lower().replace(" ", "_")
        if key in COLUMN_MAP:
            mapping[col] = COLUMN_MAP[key]

    renamed = raw.rename(columns=mapping)

    # Deduplicate: if two raw columns map to the same target, keep the first non-null
    seen: dict[str, str] = {}
    drop_cols: list[str] = []
    for orig_col, std_col in mapping.items():
        if std_col in seen:
            merged = renamed[seen[std_col]].combine_first(renamed[std_col])
            renamed[seen[std_col]] = merged
            drop_cols.append(std_col)
        else:
            seen[std_col] = std_col

    if drop_cols:
        renamed = renamed.drop(columns=drop_cols, errors="ignore")

    std_cols = list(set(COLUMN_MAP.values()))
    present = [c for c in std_cols if c in renamed.columns]
    return renamed[present].copy()


_NUMERIC_COLS = [
    # Core balance-sheet fields
    "total_assets",
    "total_shares_deposits",
    "total_loans",
    "total_members",
    "number_of_branches",
    "net_income",
    "loan_to_share_ratio",
    "net_worth_ratio",
    "roa",
    # Delinquent balances
    "delinq_total",
    "delinq_real_estate",
    "delinq_auto",
    "delinq_credit_card",
    "delinq_commercial",
    "delinq_90day",
    # Per-category loan balances
    "loans_real_estate",
    "loans_auto",
    "loans_credit_card",
    "loans_commercial",
    # Charge-offs
    "net_charge_offs",
    "nco_auto",
    "nco_credit_card",
    "nco_real_estate",
    "nco_commercial",
    # Reserves and watch items
    "alll",
    "tdr_balance",
    "oreo_balance",
]

# ── Delinquency rate computation ──────────────────────────────────────────────

# (numerator_col, denominator_col, output_col)
# All denominators are raw balance fields cast in _cast_numeric above.
_RATE_PAIRS: list[tuple[str, str, str]] = [
    ("delinq_total",       "total_loans",         "delinq_rate_total"),
    ("delinq_auto",        "loans_auto",           "delinq_rate_auto"),
    ("delinq_real_estate", "loans_real_estate",    "delinq_rate_real_estate"),
    ("delinq_credit_card", "loans_credit_card",    "delinq_rate_credit_card"),
    ("delinq_commercial",  "loans_commercial",     "delinq_rate_commercial"),
    ("delinq_90day",       "total_loans",          "delinq_90plus_rate"),
    ("alll",               "delinq_total",         "alll_coverage_ratio"),
    ("alll",               "total_loans",          "alll_to_loans_ratio"),
    ("tdr_balance",        "total_loans",          "tdr_to_loans_ratio"),
    ("oreo_balance",       "total_assets",         "oreo_to_assets_ratio"),
]


def _safe_div(df: pd.DataFrame, num_col: str, denom_col: str) -> pd.Series:
    """Divide two columns, returning NaN wherever the denominator is zero or absent."""
    nan = pd.Series(float("nan"), index=df.index)
    if num_col not in df.columns or denom_col not in df.columns:
        return nan
    num   = pd.to_numeric(df[num_col],   errors="coerce")
    denom = pd.to_numeric(df[denom_col], errors="coerce")
    return num / denom.where(denom > 0)


def _compute_derived_rates(df: pd.DataFrame) -> pd.DataFrame:
    """
    Append all credit-quality rate columns to *df* in-place and return it.

    Rates are stored as decimal fractions (0.02 = 2%).  Any division by zero
    or missing operand produces NaN rather than raising.
    """
    for num_col, denom_col, out_col in _RATE_PAIRS:
        df[out_col] = _safe_div(df, num_col, denom_col)

    # chargeoff_rate_total: annualise a single-quarter charge-off figure by ×4
    if "net_charge_offs" in df.columns and "total_loans" in df.columns:
        nco   = pd.to_numeric(df["net_charge_offs"], errors="coerce")
        loans = pd.to_numeric(df["total_loans"],     errors="coerce")
        df["chargeoff_rate_total"] = (nco * 4) / loans.where(loans > 0)
    else:
        df["chargeoff_rate_total"] = float("nan")

    return df


def _cast_numeric(df: pd.DataFrame) -> pd.DataFrame:
    for col in _NUMERIC_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col].str.replace(",", "", regex=False) if df[col].dtype == object else df[col],
                errors="coerce",
            )
    if "charter_number" in df.columns:
        df["charter_number"] = df["charter_number"].str.strip().str.lstrip("0")
    return df


# ---------------------------------------------------------------------------
# Database upsert
# ---------------------------------------------------------------------------

_TABLE_NAME = "institutions_quarterly"

_TABLE_DDL = sa.text("""
CREATE TABLE IF NOT EXISTS institutions_quarterly (
    charter_number        TEXT        NOT NULL,
    data_period           TEXT        NOT NULL,
    institution_name      TEXT,
    state                 TEXT,
    total_assets          NUMERIC,
    total_shares_deposits NUMERIC,
    total_loans           NUMERIC,
    total_members         BIGINT,
    number_of_branches    INT,
    net_income            NUMERIC,
    loan_to_share_ratio   NUMERIC,
    net_worth_ratio       NUMERIC,
    roa                   NUMERIC,
    field_of_membership   TEXT,
    -- Delinquent balances
    delinq_total          NUMERIC,
    delinq_real_estate    NUMERIC,
    delinq_auto           NUMERIC,
    delinq_credit_card    NUMERIC,
    delinq_commercial     NUMERIC,
    delinq_90day          NUMERIC,
    -- Per-category loan balances
    loans_real_estate     NUMERIC,
    loans_auto            NUMERIC,
    loans_credit_card     NUMERIC,
    loans_commercial      NUMERIC,
    -- Net charge-offs
    net_charge_offs       NUMERIC,
    nco_auto              NUMERIC,
    nco_credit_card       NUMERIC,
    nco_real_estate       NUMERIC,
    nco_commercial        NUMERIC,
    -- Reserves and watch items
    alll                  NUMERIC,
    tdr_balance           NUMERIC,
    oreo_balance          NUMERIC,
    -- Derived credit-quality rates (stored as fractions: 0.02 = 2%)
    delinq_rate_total         NUMERIC,
    delinq_rate_auto          NUMERIC,
    delinq_rate_real_estate   NUMERIC,
    delinq_rate_credit_card   NUMERIC,
    delinq_rate_commercial    NUMERIC,
    delinq_90plus_rate        NUMERIC,
    chargeoff_rate_total      NUMERIC,
    alll_coverage_ratio       NUMERIC,
    alll_to_loans_ratio       NUMERIC,
    tdr_to_loans_ratio        NUMERIC,
    oreo_to_assets_ratio      NUMERIC,
    source                TEXT,
    ingested_at           TIMESTAMPTZ,
    PRIMARY KEY (charter_number, data_period)
)
""")

# Applied once to any pre-existing deployment that lacks the new columns.
# ADD COLUMN IF NOT EXISTS is idempotent so running this on a fresh table is harmless.
_MIGRATION_DDL = sa.text("""
ALTER TABLE institutions_quarterly
    ADD COLUMN IF NOT EXISTS delinq_total          NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_real_estate    NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_auto           NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_credit_card    NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_commercial     NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_90day          NUMERIC,
    ADD COLUMN IF NOT EXISTS loans_real_estate     NUMERIC,
    ADD COLUMN IF NOT EXISTS loans_auto            NUMERIC,
    ADD COLUMN IF NOT EXISTS loans_credit_card     NUMERIC,
    ADD COLUMN IF NOT EXISTS loans_commercial      NUMERIC,
    ADD COLUMN IF NOT EXISTS net_charge_offs       NUMERIC,
    ADD COLUMN IF NOT EXISTS nco_auto              NUMERIC,
    ADD COLUMN IF NOT EXISTS nco_credit_card       NUMERIC,
    ADD COLUMN IF NOT EXISTS nco_real_estate       NUMERIC,
    ADD COLUMN IF NOT EXISTS nco_commercial        NUMERIC,
    ADD COLUMN IF NOT EXISTS alll                  NUMERIC,
    ADD COLUMN IF NOT EXISTS tdr_balance           NUMERIC,
    ADD COLUMN IF NOT EXISTS oreo_balance          NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_rate_total         NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_rate_auto          NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_rate_real_estate   NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_rate_credit_card   NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_rate_commercial    NUMERIC,
    ADD COLUMN IF NOT EXISTS delinq_90plus_rate        NUMERIC,
    ADD COLUMN IF NOT EXISTS chargeoff_rate_total      NUMERIC,
    ADD COLUMN IF NOT EXISTS alll_coverage_ratio       NUMERIC,
    ADD COLUMN IF NOT EXISTS alll_to_loans_ratio       NUMERIC,
    ADD COLUMN IF NOT EXISTS tdr_to_loans_ratio        NUMERIC,
    ADD COLUMN IF NOT EXISTS oreo_to_assets_ratio      NUMERIC
""")


def _upsert(df: pd.DataFrame, engine: sa.engine.Engine) -> pd.DataFrame:
    with engine.begin() as conn:
        conn.execute(_TABLE_DDL)
        conn.execute(_MIGRATION_DDL)

    records = df.where(pd.notna(df), None).to_dict(orient="records")

    update_cols = [
        # Core
        "institution_name", "state", "total_assets", "total_shares_deposits",
        "total_loans", "total_members", "number_of_branches", "net_income",
        "loan_to_share_ratio", "net_worth_ratio", "roa", "field_of_membership",
        # Delinquent balances
        "delinq_total", "delinq_real_estate", "delinq_auto",
        "delinq_credit_card", "delinq_commercial", "delinq_90day",
        # Per-category loan balances
        "loans_real_estate", "loans_auto", "loans_credit_card", "loans_commercial",
        # Charge-offs
        "net_charge_offs", "nco_auto", "nco_credit_card",
        "nco_real_estate", "nco_commercial",
        # Reserves and watch items
        "alll", "tdr_balance", "oreo_balance",
        # Derived rates
        "delinq_rate_total", "delinq_rate_auto", "delinq_rate_real_estate",
        "delinq_rate_credit_card", "delinq_rate_commercial", "delinq_90plus_rate",
        "chargeoff_rate_total", "alll_coverage_ratio", "alll_to_loans_ratio",
        "tdr_to_loans_ratio", "oreo_to_assets_ratio",
        # Metadata
        "source", "ingested_at",
    ]

    with engine.begin() as conn:
        # Determine which (charter_number, data_period) pairs already exist
        stmt = sa.text(
            "SELECT charter_number, data_period FROM institutions_quarterly "
            "WHERE data_period = :dp"
        )
        existing = {
            row[0]
            for row in conn.execute(stmt, {"dp": df["data_period"].iloc[0]}).fetchall()
        }

        table = sa.table(
            _TABLE_NAME,
            *[sa.column(c) for c in df.columns],
        )
        insert_stmt = pg_insert(table).values(records)
        upsert_stmt = insert_stmt.on_conflict_do_update(
            index_elements=["charter_number", "data_period"],
            set_={col: insert_stmt.excluded[col] for col in update_cols if col in df.columns},
        )
        conn.execute(upsert_stmt)

    df["upsert_action"] = df["charter_number"].apply(
        lambda cn: "update" if cn in existing else "insert"
    )
    return df
