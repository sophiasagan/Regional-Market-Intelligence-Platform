"""
FDIC Summary of Deposits ingester.

Downloads branch-level deposit data via the FDIC BankFind API and upserts
into branches_annual.  The FDIC retired the legacy ZIP download URLs circa
2024 — all data now flows through the REST API at:
  https://banks.data.fdic.gov/api/sod  (redirects to api.fdic.gov/banks/sod)

Key API fields used:
  CERT        → cert_number          (FDIC certificate number)
  BRNUM       → branch_id
  NAMEFULL    → institution_name
  NAMEBR      → branch_name
  ADDRESS     → address
  CITY        → city
  STALP       → state
  STNAME      → state_name
  STCNTY      → county_fips          (5-digit FIPS — no Census geocoding needed)
  ZIP         → zip_code
  DEPSUMBR    → deposits_thousands   (already in $thousands)
  BRSERTYP    → branch_type
  SIMS_LATITUDE / SIMS_LONGITUDE → lat/lon
  CHRTAGNT    → 'NCUA' for credit unions; used to set file_type
  YEAR        → year
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
import pandas as pd
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_engine

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FDIC API
# ---------------------------------------------------------------------------
FDIC_SOD_API = "https://banks.data.fdic.gov/api/sod"
_API_LIMIT    = 10_000   # max records per request (FDIC hard cap)
_RETRY_PAUSE  = 3        # seconds between retries

_API_FIELDS = ",".join([
    "CERT", "BRNUM", "NAMEFULL", "NAMEBR",
    "ADDRESS", "CITY", "STALP", "STNAME", "STCNTY", "ZIP",
    "DEPSUMBR", "BRSERTYP",
    "SIMS_LATITUDE", "SIMS_LONGITUDE",
    "CHRTAGNT", "YEAR",
])

# ---------------------------------------------------------------------------
# Column mapping: FDIC API field → standard schema name
# ---------------------------------------------------------------------------
COLUMN_MAP: dict[str, str] = {
    "cert":           "cert_number",
    "brnum":          "branch_id",
    "namefull":       "institution_name",
    "namebr":         "branch_name",
    "address":        "address",
    "city":           "city",
    "stalp":          "state",
    "stname":         "state_name",
    "stcnty":         "county_fips",
    "zip":            "zip_code",
    "depsumbr":       "deposits_thousands",
    "brsertyp":       "branch_type",
    "sims_latitude":  "latitude",
    "sims_longitude": "longitude",
    "chrtagnt":       "chartering_agent",
    "year":           "year",
}

REQUIRED_COLUMNS = {"institution_name", "cert_number", "state", "deposits_thousands"}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def ingest_fdic_sod(year: int, engine: Optional[sa.engine.Engine] = None) -> pd.DataFrame:
    """
    Fetch all FDIC SOD branch records for *year* via the FDIC API and upsert
    into branches_annual.

    Parameters
    ----------
    year:  Four-digit year (e.g. 2024).  SOD data reflects June 30 of that year.

    Returns
    -------
    DataFrame of upserted rows with an 'upsert_action' column ("insert"|"update").
    Carries a .attrs["row_counts_by_state"] Series for logging convenience.
    """
    if engine is None:
        engine = get_engine()

    logger.info("Fetching FDIC SOD %d via FDIC API (paginated)...", year)

    records = _fetch_all(year)
    if not records:
        raise RuntimeError(f"No FDIC SOD data returned for year {year}")

    df = pd.DataFrame(records)
    df = _normalize_columns(df)
    df = _cast_numeric(df)

    # Classify institution type from chartering agent
    if "chartering_agent" in df.columns:
        df["file_type"] = df["chartering_agent"].str.upper().apply(
            lambda x: "credit_union" if x == "NCUA" else "bank"
        )
        df = df.drop(columns=["chartering_agent"])
    else:
        df["file_type"] = "bank"

    now = datetime.now(timezone.utc)
    df["source"]      = "fdic_sod"
    df["ingested_at"] = now

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns after normalization: {missing}")

    df = _attach_ncua_charter(df, engine)
    upserted = _upsert(df, engine)

    counts_by_state = upserted.groupby("state").size().rename("branch_count")
    upserted.attrs["row_counts_by_state"] = counts_by_state
    logger.info(
        "Upsert complete for %d: %d total branches across %d states",
        year, len(upserted), len(counts_by_state),
    )
    return upserted


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _fetch_all(year: int) -> list[dict]:
    """Paginate through all SOD records for the given year."""
    all_records: list[dict] = []
    offset = 0

    with httpx.Client(follow_redirects=True, timeout=120) as client:
        # Get total count first
        total = _api_count(client, year)
        logger.info("FDIC SOD %d: %d total branch records to fetch", year, total)

        while offset < total:
            batch = _api_page(client, year, offset)
            if not batch:
                break
            all_records.extend(batch)
            offset += len(batch)
            logger.info("  fetched %d / %d", offset, total)

    return all_records


def _api_count(client: httpx.Client, year: int) -> int:
    params = {
        "filters": f"YEAR:{year}",
        "limit":   1,
        "offset":  0,
        "fields":  "CERT",
        "output":  "json",
    }
    resp = client.get(FDIC_SOD_API, params=params)
    resp.raise_for_status()
    data = resp.json()
    return data.get("meta", {}).get("total", 0)


def _api_page(client: httpx.Client, year: int, offset: int, retries: int = 3) -> list[dict]:
    params = {
        "filters": f"YEAR:{year}",
        "fields":  _API_FIELDS,
        "limit":   _API_LIMIT,
        "offset":  offset,
        "output":  "json",
        "sort_by": "CERT",
        "sort_order": "ASC",
    }
    for attempt in range(1, retries + 1):
        try:
            resp = client.get(FDIC_SOD_API, params=params)
            resp.raise_for_status()
            data = resp.json()
            # FDIC API wraps rows in {"data": [{"data": {...}}, ...]}
            raw = data.get("data", [])
            return [r["data"] if isinstance(r, dict) and "data" in r else r for r in raw]
        except Exception as exc:
            if attempt == retries:
                raise
            logger.warning("API page fetch failed (attempt %d): %s — retrying in %ds", attempt, exc, _RETRY_PAUSE)
            time.sleep(_RETRY_PAUSE)
    return []


# ---------------------------------------------------------------------------
# Column normalization and casting
# ---------------------------------------------------------------------------

def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    mapping = {col: COLUMN_MAP[col.lower()] for col in df.columns if col.lower() in COLUMN_MAP}
    df = df.rename(columns=mapping)
    target_cols = list(set(COLUMN_MAP.values()) - {"chartering_agent"})
    keep = [c for c in target_cols if c in df.columns]
    # Re-add chartering_agent if present (dropped after use)
    if "chartering_agent" in df.columns:
        keep.append("chartering_agent")
    return df[keep].copy()


_NUMERIC_COLS = ["deposits_thousands", "latitude", "longitude", "cert_number", "branch_id"]


def _cast_numeric(df: pd.DataFrame) -> pd.DataFrame:
    for col in _NUMERIC_COLS:
        if col in df.columns:
            series = df[col]
            if series.dtype == object:
                series = series.str.replace(",", "", regex=False)
            df[col] = pd.to_numeric(series, errors="coerce")
    return df


# ---------------------------------------------------------------------------
# NCUA charter crosswalk
# ---------------------------------------------------------------------------

_CROSSWALK_DDL = sa.text("""
CREATE TABLE IF NOT EXISTS fdic_ncua_crosswalk (
    cert_number    BIGINT  PRIMARY KEY,
    charter_number TEXT    NOT NULL,
    match_type     TEXT    NOT NULL DEFAULT 'auto',
    notes          TEXT,
    updated_at     TIMESTAMPTZ DEFAULT now()
)
""")

MANUAL_CROSSWALK: list[dict] = [
    # {"cert_number": 12345, "charter_number": "67890", "notes": "Name change 2019"},
]


def _attach_ncua_charter(df: pd.DataFrame, engine: sa.engine.Engine) -> pd.DataFrame:
    """
    Join FDIC cert_number → NCUA charter_number via crosswalk table.
    Creates the table if absent; seeds manual overrides.
    Unmatched rows (bank branches) will have charter_number = NULL.
    """
    with engine.begin() as conn:
        conn.execute(_CROSSWALK_DDL)
        if MANUAL_CROSSWALK:
            manual_df = pd.DataFrame(MANUAL_CROSSWALK)
            manual_df["match_type"] = "manual"
            table = sa.table(
                "fdic_ncua_crosswalk",
                sa.column("cert_number"),
                sa.column("charter_number"),
                sa.column("match_type"),
                sa.column("notes"),
            )
            stmt = pg_insert(table).values(manual_df.to_dict(orient="records"))
            stmt = stmt.on_conflict_do_update(
                index_elements=["cert_number"],
                set_={
                    "charter_number": stmt.excluded.charter_number,
                    "match_type":     stmt.excluded.match_type,
                    "notes":          stmt.excluded.notes,
                    "updated_at":     sa.func.now(),
                },
                where=sa.text("fdic_ncua_crosswalk.match_type = 'manual'"),
            )
            conn.execute(stmt)

        crosswalk = pd.read_sql(
            "SELECT cert_number, charter_number FROM fdic_ncua_crosswalk", conn
        )

    if "cert_number" in df.columns and not crosswalk.empty:
        crosswalk["cert_number"] = crosswalk["cert_number"].astype("Int64")
        df["cert_number"] = df["cert_number"].astype("Int64")
        df = df.merge(crosswalk, on="cert_number", how="left")
    else:
        df["charter_number"] = pd.NA

    unmatched = df["charter_number"].isna().sum()
    logger.info(
        "%d branches have no NCUA charter match (bank branches expected to be unmatched)",
        unmatched,
    )
    return df


# ---------------------------------------------------------------------------
# Database upsert
# ---------------------------------------------------------------------------

_TABLE_NAME = "branches_annual"

_TABLE_DDL = sa.text("""
CREATE TABLE IF NOT EXISTS branches_annual (
    cert_number        BIGINT,
    branch_id          BIGINT,
    year               INT              NOT NULL,
    institution_name   TEXT,
    branch_name        TEXT,
    address            TEXT,
    city               TEXT,
    county_name        TEXT,
    county_fips        TEXT,
    state              TEXT,
    state_name         TEXT,
    zip_code           TEXT,
    deposits_thousands NUMERIC,
    branch_type        TEXT,
    latitude           DOUBLE PRECISION,
    longitude          DOUBLE PRECISION,
    charter_number     TEXT,
    file_type          TEXT,
    source             TEXT,
    ingested_at        TIMESTAMPTZ,
    PRIMARY KEY (cert_number, branch_id, year)
)
""")


def _upsert(df: pd.DataFrame, engine: sa.engine.Engine) -> pd.DataFrame:
    with engine.begin() as conn:
        conn.execute(_TABLE_DDL)

    # Align df columns to match table; fill missing with None
    table_cols = [
        "cert_number", "branch_id", "year", "institution_name", "branch_name",
        "address", "city", "county_name", "county_fips", "state", "state_name",
        "zip_code", "deposits_thousands", "branch_type", "latitude", "longitude",
        "charter_number", "file_type", "source", "ingested_at",
    ]
    for col in table_cols:
        if col not in df.columns:
            df[col] = None
    df = df[table_cols].copy()

    records = df.where(pd.notna(df), None).to_dict(orient="records")
    update_cols = [c for c in table_cols if c not in ("cert_number", "branch_id", "year")]

    with engine.begin() as conn:
        year_val = int(df["year"].iloc[0])
        existing_pairs = {
            (row[0], row[1])
            for row in conn.execute(
                sa.text("SELECT cert_number, branch_id FROM branches_annual WHERE year = :yr"),
                {"yr": year_val},
            ).fetchall()
        }

        table = sa.table(_TABLE_NAME, *[sa.column(c) for c in table_cols])
        insert_stmt = pg_insert(table).values(records)
        upsert_stmt = insert_stmt.on_conflict_do_update(
            index_elements=["cert_number", "branch_id", "year"],
            set_={col: insert_stmt.excluded[col] for col in update_cols},
        )
        conn.execute(upsert_stmt)

    df["upsert_action"] = df.apply(
        lambda row: "update" if (row["cert_number"], row["branch_id"]) in existing_pairs else "insert",
        axis=1,
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

    parser = argparse.ArgumentParser(description="Ingest one year of FDIC Summary of Deposits.")
    parser.add_argument("--year", type=int, required=True, help="Four-digit year, e.g. 2024")
    args = parser.parse_args()

    result = ingest_fdic_sod(year=args.year)
    inserted = (result["upsert_action"] == "insert").sum()
    updated  = (result["upsert_action"] == "update").sum()
    print(f"Done — {inserted} inserted, {updated} updated.")
    sys.exit(0)
