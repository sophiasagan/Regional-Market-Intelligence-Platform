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

from database import get_engine

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

    # ── NCUA FS220.txt account codes (ACCT_ prefix, 2017+ format) ────────────
    # The NCUA replaced descriptive field names with account codes in 2017.
    # Codes below derived from the NCUA 5300 Call Report data dictionary.

    # Balance sheet totals
    "acct_010":   "total_assets",
    "acct_018":   "total_shares_deposits",
    "acct_025b":  "total_loans",
    "acct_083":   "total_members",
    "acct_088":   "total_loans",        # alt code seen in recent FS220 exports
    "acct_799c2": "total_loans",        # Total Loans and Leases (some years)
    "acct_799c1": "loans_real_estate",  # Real Estate loans total

    # Allowance for loan losses
    "acct_719a":  "alll",
    "acct_719":   "alll",

    # Total delinquency — ACCT_630 confirmed as "Total Delinquent Loans" in FS220.txt
    # Navy Federal (charter 5536, $134B loans) shows ACCT_630 = $790M = 0.59% rate ✓
    # All 652/655/672/733/741/742/745 range accounts = 0 for large CUs → not used
    "acct_630":   "delinq_total",

    # 90+ day delinquency bucket (where CUs report it)
    "acct_704c1": "delinq_90day",

    # Charge-offs — ACCT_794 is net charge-offs for Navy Federal ($1.35B plausible for 2024)
    "acct_794":   "net_charge_offs",
    "acct_750a":  "net_charge_offs",
    "acct_748a":  "net_charge_offs",
    "acct_748":   "net_charge_offs",

    # OREO / foreclosed assets
    "acct_716a":  "oreo_balance",
    "acct_716":   "oreo_balance",

    # TDR (troubled debt restructuring)
    "acct_387a":  "tdr_balance",
    "acct_387":   "tdr_balance",

    # Loan category balances (denominators for per-type delinquency rates)
    "acct_025a":  "loans_real_estate",
    "acct_657":   "loans_real_estate",  # Real estate loans — $34.3B for Navy Federal ✓
    "acct_704":   "loans_auto",
    "acct_671":   "loans_auto",         # Auto loans — $6B for Navy Federal (plausible)
    "acct_705":   "loans_credit_card",
    "acct_400a":  "loans_commercial",
    "acct_400b":  "loans_commercial",
}

REQUIRED_COLUMNS = {
    "charter_number",
    "institution_name",
    "state",
    "total_assets",
    "total_shares_deposits",
    "total_loans",
}

# NCUA uses the last month of the quarter in the filename (Q1=03, Q2=06, Q3=09, Q4=12).
# Multiple templates are tried in order; the first 200 response wins.
_QUARTER_TO_MONTH = {1: "03", 2: "06", 3: "09", 4: "12"}

_NCUA_URL_TEMPLATES = [
    "https://ncua.gov/files/publications/analysis/call-report-data-{year}-{month}.zip",
    "https://www.ncua.gov/files/publications/analysis/call-report-data-{year}-{month}.zip",
    "https://ncua.gov/files/publications/analysis/call-report-data-{year}-Q{quarter}.zip",
    "https://www.ncua.gov/files/publications/analysis/call-report-data-{year}-Q{quarter}.zip",
]


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

    data_period = f"{year}Q{quarter}"
    month = _QUARTER_TO_MONTH[quarter]
    urls = [t.format(year=year, quarter=quarter, month=month) for t in _NCUA_URL_TEMPLATES]
    raw_zip = _download_with_fallback(urls, data_period)

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


def _download_with_fallback(urls: list[str], data_period: str) -> bytes:
    """Try each URL in order, returning the first successful response."""
    last_exc: Exception | None = None
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        for url in urls:
            logger.info("Trying %s", url)
            try:
                response = client.get(url)
                response.raise_for_status()
                logger.info("Downloaded %s (%.1f MB)", data_period, len(response.content) / 1e6)
                return response.content
            except httpx.HTTPStatusError as exc:
                logger.warning("  → %s %s", exc.response.status_code, url)
                last_exc = exc
    raise RuntimeError(
        f"Could not download NCUA data for {data_period} — all URLs returned errors.\n"
        "Check https://www.ncua.gov/analysis/credit-union-corporate-call-report-data "
        "for the current download path and update _NCUA_URL_TEMPLATES."
    ) from last_exc


def _read_txt(zf: zipfile.ZipFile, name: str) -> pd.DataFrame:
    """Read a delimited file from the ZIP, auto-detecting comma vs tab."""
    with zf.open(name) as fh:
        sample = fh.read(4096).decode("latin-1", errors="replace")
    sep = "\t" if sample.count("\t") > sample.count(",") else ","
    with zf.open(name) as fh:
        return pd.read_csv(fh, dtype=str, low_memory=False,
                           sep=sep, encoding_errors="replace")


def _parse_zip(raw_zip: bytes, data_period: str) -> pd.DataFrame:
    """
    Extract and merge FOICU.txt (identity) + FS220.txt (financials) from the ZIP.
    FOICU holds charter number, name, state; FS220 holds balance-sheet data.
    """
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        names = zf.namelist()
        logger.info("ZIP contents: %s", names)

        # ── Identity: FOICU.txt ───────────────────────────────────────────────
        foicu_name = next((n for n in names if "foicu" in n.lower() and
                           n.lower().endswith((".txt", ".csv"))), None)
        if foicu_name:
            foicu = _read_txt(zf, foicu_name)
            logger.info("FOICU columns: %s", list(foicu.columns))
            foicu = _normalize_columns(foicu)
        else:
            foicu = pd.DataFrame()

        # ── Financials: FS220.txt ─────────────────────────────────────────────
        fs220_name = _pick_main_csv(names)
        logger.info("Reading financials from %s", fs220_name)
        fin = _read_txt(zf, fs220_name)
        logger.info("FS220 columns: %s", list(fin.columns))
        fin = _normalize_columns(fin)

    # Merge identity into financials when FOICU is available
    if not foicu.empty and "charter_number" in foicu.columns:
        id_cols = [c for c in ("charter_number", "institution_name", "state")
                   if c in foicu.columns]
        fin = fin.merge(foicu[id_cols], on="charter_number", how="left",
                        suffixes=("", "_foicu"))
        for col in id_cols:
            foicu_col = f"{col}_foicu"
            if foicu_col in fin.columns:
                fin[col] = fin[col].combine_first(fin.pop(foicu_col))
    elif not foicu.empty and "charter_number" in fin.columns:
        pass  # charter_number already in fin; FOICU merge skipped

    df = _cast_numeric(fin)
    df = _compute_derived_rates(df)

    now = datetime.now(timezone.utc)
    df["data_period"] = data_period
    df["source"] = "ncua_5300"
    df["ingested_at"] = now

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        logger.warning(
            "Could not map columns: %s — these will be NULL in the database. "
            "Update COLUMN_MAP if the NCUA changed field names.", missing
        )

    return df


def _pick_main_csv(names: list[str]) -> str:
    """
    NCUA ZIPs may contain .csv or .txt files depending on the year.
    Priority: FS220.txt (main 5300 schedule) → any file matching data keywords → first tabular file.
    """
    # Exact match for the primary 5300 schedule (current NCUA format)
    for exact in ("FS220.txt", "fs220.txt", "FS220.TXT"):
        if exact in names:
            return exact

    tabular = [n for n in names if n.lower().endswith((".csv", ".txt"))
               and not any(skip in n.lower() for skip in ("readme", "codebook", "foicu", "atm", "tradename", "acctdesc"))]

    data_keywords = ("5300", "call", "data", "fs220")
    for kw in data_keywords:
        candidates = [c for c in tabular if kw in c.lower()]
        if candidates:
            return candidates[0]

    if tabular:
        return tabular[0]

    raise ValueError(f"No tabular data file found in ZIP. Contents: {names}")


def _normalize_columns(raw: pd.DataFrame) -> pd.DataFrame:
    """
    Map raw headers to standard schema names, keeping only mapped columns.
    When multiple raw columns map to the same target, coalesce to first non-null.
    """
    # Build target → [raw_col, ...] mapping
    target_to_raws: dict[str, list[str]] = {}
    for col in raw.columns:
        key = col.strip().lower().replace(" ", "_")
        target = COLUMN_MAP.get(key)
        if target:
            target_to_raws.setdefault(target, []).append(col)

    out: dict[str, pd.Series] = {}
    for target, raw_cols in target_to_raws.items():
        series = raw[raw_cols[0]]
        for extra in raw_cols[1:]:
            series = series.combine_first(raw[extra])
        out[target] = series

    return pd.DataFrame(out, index=raw.index)


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
    """Divide two columns. Returns NULL when denominator is zero or absent."""
    null = pd.Series(pd.NA, index=df.index, dtype="Float64")
    if num_col not in df.columns or denom_col not in df.columns:
        return null
    num   = pd.to_numeric(df[num_col],   errors="coerce")
    denom = pd.to_numeric(df[denom_col], errors="coerce")
    # Where denom is zero or null, result is NULL (not NaN or infinity)
    return (num / denom.where(denom > 0)).where(denom > 0, other=pd.NA)


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


if __name__ == "__main__":
    import argparse
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )

    parser = argparse.ArgumentParser(description="Ingest one quarter of NCUA 5300 data.")
    parser.add_argument("--year",    type=int, required=True, help="Four-digit year, e.g. 2024")
    parser.add_argument("--quarter", type=int, required=True, choices=[1, 2, 3, 4])
    args = parser.parse_args()

    result = ingest_ncua_quarter(year=args.year, quarter=args.quarter)
    inserted = (result["upsert_action"] == "insert").sum()
    updated  = (result["upsert_action"] == "update").sum()
    print(f"Done — {inserted} inserted, {updated} updated.")
    sys.exit(0)
