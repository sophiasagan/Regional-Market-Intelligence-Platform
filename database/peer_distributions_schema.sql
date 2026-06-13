-- ─────────────────────────────────────────────────────────────────────────────
-- P76 Regional Market Intelligence Platform
-- Migration: peer_groups + peer_distributions tables
--
-- Run once against the target database:
--   psql $DATABASE_URL -f database/peer_distributions_schema.sql
--
-- peer_groups:       static criteria records (one row per group type/state/tier)
-- peer_distributions: pre-computed percentile stats per account × period × group
-- ─────────────────────────────────────────────────────────────────────────────

-- ── peer_groups ───────────────────────────────────────────────────────────────
-- Stores the definition of each peer group (what the criteria are), not membership.
-- Membership is evaluated dynamically at compute time by filtering institutions_quarterly.

CREATE TABLE IF NOT EXISTS peer_groups (
    id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    label       TEXT    NOT NULL,
    group_type  TEXT    NOT NULL,
        -- 'national_all'  — all credit unions, no size or state filter
        -- 'national_tier' — all credit unions in one asset tier nationally
        -- 'state_all'     — all credit unions in one state, any size
        -- 'state_tier'    — credit unions in one state in one asset tier
        -- 'callahan'      — alias for national_tier (Callahan-equivalent label)
        -- 'custom'        — tenant-defined custom region (future)
    state       TEXT,               -- 2-letter abbreviation; NULL for national groups
    asset_tier  TEXT,               -- tier key (see ASSET_TIER_RANGES); NULL = all sizes
    description TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

    UNIQUE (group_type, state, asset_tier)
);

COMMENT ON TABLE peer_groups IS
    'Static peer group definitions. Membership is computed from institutions_quarterly at run time.';

COMMENT ON COLUMN peer_groups.group_type IS
    'national_all | national_tier | state_all | state_tier | callahan | custom';


-- ── peer_distributions ────────────────────────────────────────────────────────
-- Stores pre-computed percentile distributions.
-- One row per (account_code, period, peer_group_id).
-- Recomputed quarterly after NCUA ingestion by compute_peer_distributions.py.

CREATE TABLE IF NOT EXISTS peer_distributions (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    account_code      TEXT        NOT NULL,
        -- Column name in institutions_quarterly, or key for a computed ratio.
        -- e.g. "delinq_rate_total", "chargeoff_rate_total", "return_on_assets"

    is_computed_ratio BOOLEAN     NOT NULL DEFAULT FALSE,
        -- TRUE when the value is derived from a formula over raw balances
        -- rather than read directly from a stored column.

    ratio_formula     TEXT,
        -- Human-readable SQL expression used to derive this metric.
        -- Stored for transparency and audit. e.g.:
        --   "net_charge_offs / NULLIF(total_loans,0) * 4"
        -- NULL when is_computed_ratio = FALSE.

    period            TEXT        NOT NULL,
        -- NCUA quarter key, e.g. "2024Q4"

    peer_group_id     UUID        NOT NULL REFERENCES peer_groups(id) ON DELETE CASCADE,

    n_peers           INTEGER,    -- institutions included in this distribution

    p10               DECIMAL(18, 8),
    p25               DECIMAL(18, 8),
    median            DECIMAL(18, 8),
    p75               DECIMAL(18, 8),
    p90               DECIMAL(18, 8),
    mean              DECIMAL(18, 8),
    std_dev           DECIMAL(18, 8),

    computed_at       TIMESTAMP   NOT NULL DEFAULT NOW(),

    UNIQUE (account_code, period, peer_group_id)
);

COMMENT ON TABLE peer_distributions IS
    'Pre-computed percentile distributions for each metric × period × peer group. '
    'Populated by processing/compute_peer_distributions.py after each NCUA ingestion.';

COMMENT ON COLUMN peer_distributions.ratio_formula IS
    'SQL expression used to derive computed ratios. Null for direct column reads.';


-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Primary lookup pattern: account_code + period + peer_group_id (point lookup)
-- Secondary pattern: scan all distributions for a period (recompute checks)

CREATE INDEX IF NOT EXISTS idx_peer_dist_lookup
    ON peer_distributions (account_code, period, peer_group_id);

CREATE INDEX IF NOT EXISTS idx_peer_dist_period
    ON peer_distributions (period);

CREATE INDEX IF NOT EXISTS idx_peer_dist_group
    ON peer_distributions (peer_group_id, period);
