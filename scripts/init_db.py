"""
Database initialisation script.

Creates all tables if they do not already exist (idempotent — safe to re-run).
Run from Railway console or locally:

    python -m scripts.init_db

Requires DATABASE_URL in environment (set automatically by Railway when
the Postgres plugin is attached to the service).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running as `python scripts/init_db.py` from the repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlalchemy as sa
from sqlalchemy import text as sa_text

from database import get_engine  # noqa: E402

DDL_STATEMENTS = [
    # ── Reference / crosswalk tables ─────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS cbsa_county_crosswalk (
        county_fips  CHAR(5)  NOT NULL,
        cbsa_code    CHAR(5)  NOT NULL,
        cbsa_title   TEXT,
        PRIMARY KEY (county_fips, cbsa_code)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS custom_regions (
        id           SERIAL   PRIMARY KEY,
        tenant_id    TEXT     NOT NULL,
        region_name  TEXT     NOT NULL,
        county_fips  TEXT     NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, region_name, county_fips)
    )
    """,
    # ── Core data tables ──────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS institutions_quarterly (
        charter_number              TEXT        NOT NULL,
        institution_name            TEXT,
        state                       TEXT,
        county_fips                 CHAR(5),
        data_period                 TEXT        NOT NULL,  -- e.g. '2024Q4'

        -- Asset / liability totals
        total_assets                NUMERIC,
        total_shares_deposits       NUMERIC,
        total_loans                 NUMERIC,
        member_count                NUMERIC,

        -- Raw delinquency balances (from NCUA 5300)
        delinq_balance_total        NUMERIC,
        delinq_balance_30_59_days   NUMERIC,
        delinq_balance_60_89_days   NUMERIC,
        delinq_balance_90plus_days  NUMERIC,
        delinq_balance_real_estate  NUMERIC,
        delinq_balance_auto         NUMERIC,
        delinq_balance_credit_card  NUMERIC,
        delinq_balance_commercial   NUMERIC,
        delinq_balance_student      NUMERIC,
        delinq_balance_other        NUMERIC,

        -- Loan balances by type (denominators for rate calculations)
        loans_real_estate           NUMERIC,
        loans_auto                  NUMERIC,
        loans_credit_card           NUMERIC,
        loans_commercial            NUMERIC,
        loans_student               NUMERIC,

        -- Charge-offs (net, quarterly — annualised ×4 in computed rates)
        net_charge_offs_total       NUMERIC,
        net_charge_offs_auto        NUMERIC,
        net_charge_offs_credit_card NUMERIC,
        net_charge_offs_real_estate NUMERIC,
        net_charge_offs_commercial  NUMERIC,

        -- Allowance and reserves
        allowance_for_loan_losses   NUMERIC,

        -- Troubled debt and OREO
        tdr_balance_total           NUMERIC,
        oreo_balance_total          NUMERIC,
        non_accrual_balance         NUMERIC,

        -- Computed delinquency rates (decimal fractions, e.g. 0.018 = 1.8%)
        delinq_rate_total           NUMERIC,
        delinq_rate_real_estate     NUMERIC,
        delinq_rate_auto            NUMERIC,
        delinq_rate_credit_card     NUMERIC,
        delinq_rate_commercial      NUMERIC,
        delinq_rate_student         NUMERIC,
        delinq_90plus_rate          NUMERIC,

        -- Computed charge-off rates (annualised)
        chargeoff_rate_total        NUMERIC,
        chargeoff_rate_auto         NUMERIC,
        chargeoff_rate_credit_card  NUMERIC,
        chargeoff_rate_real_estate  NUMERIC,
        chargeoff_rate_commercial   NUMERIC,

        -- Coverage and allowance ratios
        alll_coverage_ratio         NUMERIC,
        alll_to_loans_ratio         NUMERIC,

        -- Derived TDR and OREO ratios
        tdr_to_loans_ratio          NUMERIC,
        oreo_to_assets_ratio        NUMERIC,

        -- Credit risk composite (computed by delinquency_engine.py)
        credit_risk_score           NUMERIC,
        credit_risk_tier            TEXT,

        ingested_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (charter_number, data_period)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_iq_period
        ON institutions_quarterly (data_period)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_iq_county
        ON institutions_quarterly (county_fips)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_iq_state
        ON institutions_quarterly (state)
    """,
    """
    CREATE TABLE IF NOT EXISTS branches_annual (
        id                  SERIAL  PRIMARY KEY,
        cert_number         TEXT    NOT NULL,  -- FDIC certificate number
        charter_number      TEXT,              -- NCUA charter (via crosswalk)
        institution_name    TEXT,
        branch_name         TEXT,
        county_fips         CHAR(5),
        state_fips          CHAR(2),
        cbsa_code           CHAR(5),
        deposits            NUMERIC,
        year                INT     NOT NULL,
        institution_type    TEXT    NOT NULL DEFAULT 'bank',  -- 'bank' | 'credit_union'
        ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (cert_number, year, county_fips)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_ba_county_year
        ON branches_annual (county_fips, year)
    """,
    """
    CREATE TABLE IF NOT EXISTS metric_allocations (
        id               SERIAL  PRIMARY KEY,
        cert_number      TEXT    NOT NULL,
        county_fips      CHAR(5) NOT NULL,
        period           TEXT    NOT NULL,
        metric           TEXT    NOT NULL,
        allocated_value  NUMERIC NOT NULL,
        confidence       TEXT    NOT NULL DEFAULT 'modeled',
        model_version    TEXT,
        computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (cert_number, county_fips, period, metric)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS hmda_originations (
        id               SERIAL  PRIMARY KEY,
        lei              TEXT    NOT NULL,
        institution_name TEXT,
        county_fips      CHAR(5) NOT NULL,
        year             INT     NOT NULL,
        loan_type        TEXT,
        loan_purpose     TEXT,
        origination_count INT    NOT NULL DEFAULT 0,
        origination_amount NUMERIC,
        ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (lei, county_fips, year, loan_type, loan_purpose)
    )
    """,
    # ── Alert / application tables (mirrors DDL in api/routers/alerts.py) ─────
    """
    CREATE TABLE IF NOT EXISTS monitored_geographies (
        id                    SERIAL      PRIMARY KEY,
        tenant_id             TEXT        NOT NULL,
        geography_type        TEXT        NOT NULL,
        geography_label       TEXT,
        geography_id          TEXT        NOT NULL,
        metric                TEXT        NOT NULL DEFAULT 'deposits',
        institution_types     TEXT[]      NOT NULL DEFAULT ARRAY['credit_union','bank'],
        own_institution_id    TEXT,
        direct_competitor_ids TEXT[]      NOT NULL DEFAULT '{}',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, geography_type, geography_id, metric)
    )
    """,
    """
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
        UNIQUE (tenant_id, alert_type, geography_type, geography_id,
                period, subject_id, metric)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS alert_preferences (
        tenant_id              TEXT    PRIMARY KEY,
        email_digest_enabled   BOOLEAN NOT NULL DEFAULT false,
        digest_email           TEXT,
        immediate_delinq_email BOOLEAN NOT NULL DEFAULT false,
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS delinquency_thresholds (
        tenant_id              TEXT    PRIMARY KEY,
        delinq_total           NUMERIC NOT NULL DEFAULT 0.015,
        delinq_auto            NUMERIC NOT NULL DEFAULT 0.020,
        delinq_credit_card     NUMERIC NOT NULL DEFAULT 0.035,
        delinq_commercial      NUMERIC NOT NULL DEFAULT 0.010,
        delinq_real_estate     NUMERIC NOT NULL DEFAULT 0.020,
        delinq_90plus          NUMERIC NOT NULL DEFAULT 0.010,
        peer_divergence_pp     NUMERIC NOT NULL DEFAULT 0.005,
        alll_coverage_min      NUMERIC NOT NULL DEFAULT 1.0,
        chargeoff_acceleration NUMERIC NOT NULL DEFAULT 0.25,
        oreo_increase          NUMERIC NOT NULL DEFAULT 0.20,
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
]


def init_db() -> None:
    engine = get_engine()
    with engine.begin() as conn:
        for ddl in DDL_STATEMENTS:
            conn.execute(sa_text(ddl))
    print(f"✓ Schema initialised — {len(DDL_STATEMENTS)} statements executed.")


if __name__ == "__main__":
    init_db()
