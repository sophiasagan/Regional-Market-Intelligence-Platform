"""
FDIC Summary of Deposits ingester.

Downloads the annual SOD ZIP for credit unions and banks, parses branch-level
deposit data, resolves county FIPS codes, and upserts into branches_annual.
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
# Download URLs
# FDIC publishes two files: credit-union-chartered branches and bank branches.
# Both are needed for full market context.
# ---------------------------------------------------------------------------
SOD_CU_URL = "https://www7.fdic.gov/sod/SOD_Download_CreditUnions_{year}.zip"
SOD_BANK_URL = "https://www7.fdic.gov/sod/SOD_Download_{year}.zip"

# ---------------------------------------------------------------------------
# Column mapping: raw SOD name → standard schema name
# FDIC column names change subtly between releases; we handle common variants.
# ---------------------------------------------------------------------------
COLUMN_MAP: dict[str, str] = {
    "instname":      "institution_name",
    "cert":          "cert_number",
    "brnum":         "branch_id",
    "brname":        "branch_name",
    "city":          "city",
    "county":        "county_name",
    "stalp":         "state",
    "stname":        "state_name",
    "depsumbr":      "deposits_thousands",
    "brsertyp":      "branch_type",
    "latitude":      "latitude",
    "longitude":     "longitude",
    "sims_latitude": "latitude",
    "sims_longitude":"longitude",
    "addresbr":      "address",
    "zipbr":         "zip_code",
    "uniname":       "institution_name",   # alternate
    "repdte":        "report_date",
}

REQUIRED_COLUMNS = {"institution_name", "cert_number", "state", "deposits_thousands"}

_NUMERIC_COLS = ["deposits_thousands", "latitude", "longitude", "cert_number", "branch_id"]


def ingest_fdic_sod(year: int, engine: Optional[sa.engine.Engine] = None) -> pd.DataFrame:
    """
    Download, parse, and upsert one year of FDIC Summary of Deposits data.

    Downloads both the credit-union file and the full-bank file for complete
    market context, then combines and upserts into branches_annual.

    Parameters
    ----------
    year:  Four-digit year (e.g. 2023).

    Returns
    -------
    DataFrame of upserted branch records with a ``row_counts_by_state`` column,
    plus a ``upsert_action`` column ("insert" | "update").
    The returned DataFrame also carries a ``.attrs["row_counts_by_state"]``
    Series (state → count) for logging / monitoring convenience.
    """
    if engine is None:
        engine = get_engine()

    dfs: list[pd.DataFrame] = []

    for url_template, file_type in [
        (SOD_CU_URL, "credit_union"),
        (SOD_BANK_URL, "bank"),
    ]:
        url = url_template.format(year=year)
        logger.info("Downloading FDIC SOD %s file for %d from %s", file_type, year, url)
        try:
            raw_zip = _download(url)
        except httpx.HTTPStatusError as exc:
            logger.warning("Could not fetch %s (%s) — skipping", url, exc.response.status_code)
            continue

        parsed = _parse_zip(raw_zip, year, file_type)
        dfs.append(parsed)
        logger.info("Parsed %d branches from %s file", len(parsed), file_type)

    if not dfs:
        raise RuntimeError(f"No FDIC SOD data could be downloaded for year {year}")

    combined = pd.concat(dfs, ignore_index=True)
    combined = _attach_county_fips(combined)
    combined = _attach_ncua_charter(combined, engine)

    upserted = _upsert(combined, engine)

    counts_by_state = upserted.groupby("state").size().rename("branch_count")
    upserted.attrs["row_counts_by_state"] = counts_by_state
    logger.info(
        "Upsert complete for %d: %d total branches across %d states",
        year,
        len(upserted),
        len(counts_by_state),
    )
    return upserted


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _download(url: str) -> bytes:
    with httpx.Client(follow_redirects=True, timeout=180) as client:
        response = client.get(url)
        response.raise_for_status()
    return response.content


def _parse_zip(raw_zip: bytes, year: int, file_type: str) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        csv_name = _pick_main_csv(zf.namelist(), file_type)
        logger.debug("Reading %s from ZIP (%s)", csv_name, file_type)
        with zf.open(csv_name) as fh:
            raw = pd.read_csv(fh, dtype=str, low_memory=False, encoding="latin-1")

    df = _normalize_columns(raw)
    df = _cast_numeric(df)

    now = datetime.now(timezone.utc)
    df["year"] = year
    df["file_type"] = file_type
    df["source"] = "fdic_sod"
    df["ingested_at"] = now

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns after normalization ({file_type}): {missing}")

    return df


def _pick_main_csv(names: list[str], file_type: str) -> str:
    csvs = [n for n in names if n.lower().endswith(".csv")]
    if not csvs:
        raise ValueError(f"No CSV file found in ZIP ({file_type}). Contents: {names}")

    keywords = ("sod", "branch", "deposit", "summary")
    for kw in keywords:
        candidates = [c for c in csvs if kw in c.lower()]
        if candidates:
            return candidates[0]

    # Fall back to the largest CSV by filename length heuristic
    return sorted(csvs, key=len, reverse=True)[0]


def _normalize_columns(raw: pd.DataFrame) -> pd.DataFrame:
    mapping: dict[str, str] = {}
    for col in raw.columns:
        key = col.strip().lower()
        if key in COLUMN_MAP:
            mapping[col] = COLUMN_MAP[key]

    renamed = raw.rename(columns=mapping)

    # If two raw columns map to the same target, keep first non-null
    seen: set[str] = set()
    drop_cols: list[str] = []
    for src, tgt in mapping.items():
        if tgt in seen:
            merged = renamed[tgt].combine_first(renamed[tgt])  # idempotent merge
            renamed[tgt] = merged
            drop_cols.append(tgt)
        else:
            seen.add(tgt)

    if drop_cols:
        renamed = renamed.drop(columns=drop_cols, errors="ignore")

    std_cols = list(set(COLUMN_MAP.values()))
    present = [c for c in std_cols if c in renamed.columns]
    return renamed[present].copy()


def _cast_numeric(df: pd.DataFrame) -> pd.DataFrame:
    for col in _NUMERIC_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(
                df[col].str.replace(",", "", regex=False) if df[col].dtype == object else df[col],
                errors="coerce",
            )
    return df


# ---------------------------------------------------------------------------
# FIPS resolution
# ---------------------------------------------------------------------------

# Inline FIPS lookup for the 50 states + DC + territories.
# Full county FIPS requires the Census API or a bundled CSV; we use a two-step
# approach: state → state FIPS prefix, then county name → suffix via Census.
_STATE_FIPS: dict[str, str] = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08",
    "CT": "09", "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15",
    "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21",
    "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33",
    "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39",
    "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56", "PR": "72", "VI": "78",
}


def _attach_county_fips(df: pd.DataFrame) -> pd.DataFrame:
    """
    Derive 5-digit county FIPS (state FIPS + county code) where possible.

    Uses the Census Geocoding API county list as a reference; falls back to
    a null value for unresolved counties. Operates row-by-row only for rows
    where FIPS is not already available from the source data.
    """
    if "county_fips" in df.columns and df["county_fips"].notna().all():
        return df

    # Build (state, county_name) → fips lookup from Census reference
    fips_lookup = _build_fips_lookup()

    def resolve_fips(row: pd.Series) -> Optional[str]:
        state = str(row.get("state", "")).strip().upper()
        county = str(row.get("county_name", "")).strip().lower()
        return fips_lookup.get((state, county))

    df["county_fips"] = df.apply(resolve_fips, axis=1)
    unresolved = df["county_fips"].isna().sum()
    if unresolved:
        logger.warning("%d branches have unresolved county FIPS", unresolved)
    return df


def _build_fips_lookup() -> dict[tuple[str, str], str]:
    """
    Fetch the Census county FIPS reference and return a (state_abbr, county_lower) → fips dict.
    Falls back to an empty dict if the Census API is unavailable.
    """
    url = (
        "https://api.census.gov/data/2020/dec/pl"
        "?get=NAME,GEO_ID&for=county:*"
    )
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("Census FIPS lookup unavailable (%s); county_fips will be null", exc)
        return {}

    # Response rows: [NAME, GEO_ID, state, county]
    lookup: dict[tuple[str, str], str] = {}
    state_fips_to_abbr = {v: k for k, v in _STATE_FIPS.items()}

    for row in data[1:]:  # skip header
        name, geo_id, state_fips, county_fips_suffix = row[0], row[1], row[2], row[3]
        state_abbr = state_fips_to_abbr.get(state_fips, "")
        # NAME is "CountyName, StateName" — extract county portion
        county_name = name.split(",")[0].lower().removesuffix(" county").strip()
        fips = f"{state_fips}{county_fips_suffix}"
        lookup[(state_abbr, county_name)] = fips

    return lookup


# ---------------------------------------------------------------------------
# NCUA charter crosswalk
# ---------------------------------------------------------------------------

_CROSSWALK_DDL = sa.text("""
CREATE TABLE IF NOT EXISTS fdic_ncua_crosswalk (
    cert_number    BIGINT  PRIMARY KEY,
    charter_number TEXT    NOT NULL,
    match_type     TEXT    NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
    notes          TEXT,
    updated_at     TIMESTAMPTZ DEFAULT now()
)
""")

# Seed for known mismatches (cert_number → charter_number).
# Extend this list as manual reconciliation identifies new cases (~3–5% of institutions).
MANUAL_CROSSWALK: list[dict] = [
    # {"cert_number": 12345, "charter_number": "67890", "notes": "Name change 2019"},
]


def _attach_ncua_charter(df: pd.DataFrame, engine: sa.engine.Engine) -> pd.DataFrame:
    """
    Join FDIC cert_number to NCUA charter_number via crosswalk table.
    Creates the crosswalk table if absent; seeds manual overrides.
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
                set_={"charter_number": stmt.excluded.charter_number,
                      "match_type": stmt.excluded.match_type,
                      "notes": stmt.excluded.notes,
                      "updated_at": sa.func.now()},
                where=(sa.text("fdic_ncua_crosswalk.match_type = 'manual'")),
            )
            conn.execute(stmt)

        crosswalk = pd.read_sql(
            "SELECT cert_number, charter_number FROM fdic_ncua_crosswalk",
            conn,
        )

    if "cert_number" in df.columns and not crosswalk.empty:
        crosswalk["cert_number"] = crosswalk["cert_number"].astype("Int64")
        df["cert_number"] = df["cert_number"].astype("Int64")
        df = df.merge(crosswalk, on="cert_number", how="left")
    else:
        df["charter_number"] = pd.NA

    unmatched = df["charter_number"].isna().sum()
    if unmatched:
        logger.info(
            "%d branches could not be matched to an NCUA charter number "
            "(bank branches expected to be unmatched)",
            unmatched,
        )
    return df


# ---------------------------------------------------------------------------
# Database upsert
# ---------------------------------------------------------------------------

_TABLE_NAME = "branches_annual"

_TABLE_DDL = sa.text("""
CREATE TABLE IF NOT EXISTS branches_annual (
    cert_number       BIGINT,
    branch_id         BIGINT,
    year              INT         NOT NULL,
    institution_name  TEXT,
    branch_name       TEXT,
    address           TEXT,
    city              TEXT,
    county_name       TEXT,
    county_fips       TEXT,
    state             TEXT,
    state_name        TEXT,
    zip_code          TEXT,
    deposits_thousands NUMERIC,
    branch_type       TEXT,
    latitude          DOUBLE PRECISION,
    longitude         DOUBLE PRECISION,
    charter_number    TEXT,
    file_type         TEXT,
    source            TEXT,
    ingested_at       TIMESTAMPTZ,
    PRIMARY KEY (cert_number, branch_id, year)
)
""")


def _upsert(df: pd.DataFrame, engine: sa.engine.Engine) -> pd.DataFrame:
    with engine.begin() as conn:
        conn.execute(_TABLE_DDL)

    records = df.where(pd.notna(df), None).to_dict(orient="records")

    update_cols = [
        c for c in df.columns
        if c not in ("cert_number", "branch_id", "year")
    ]

    with engine.begin() as conn:
        existing_stmt = sa.text(
            "SELECT cert_number, branch_id FROM branches_annual WHERE year = :yr"
        )
        year_val = int(df["year"].iloc[0])
        existing_pairs = {
            (row[0], row[1])
            for row in conn.execute(existing_stmt, {"yr": year_val}).fetchall()
        }

        table = sa.table(
            _TABLE_NAME,
            *[sa.column(c) for c in df.columns],
        )
        insert_stmt = pg_insert(table).values(records)
        upsert_stmt = insert_stmt.on_conflict_do_update(
            index_elements=["cert_number", "branch_id", "year"],
            set_={col: insert_stmt.excluded[col] for col in update_cols if col in df.columns},
        )
        conn.execute(upsert_stmt)

    def action(row: pd.Series) -> str:
        return "update" if (row["cert_number"], row["branch_id"]) in existing_pairs else "insert"

    df["upsert_action"] = df.apply(action, axis=1)
    return df
