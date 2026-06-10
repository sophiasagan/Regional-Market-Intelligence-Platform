"""
Peer group selection engine — P76's primary competitive differentiator.

Priority order (CLAUDE.md §Peer group logic):
    1. Same state + ±50% asset size  ≥ 10 institutions
    2. Same MSA + any size           if institution is in a major metro
    3. National same-asset-size      fallback only, labelled clearly

The *regional* peer group (all institutions in a geography, no size filter)
is P76's Callahan-exclusive feature and must never be hidden in the UI.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import sqlalchemy as sa

from database import get_engine

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

_MIN_DEFAULT_PEERS = 10   # priority-1 drops to priority-2 if below this
_MIN_MSA_CUS       = 3    # minimum CUs to treat an MSA as "major metro"

# Percentage band used in all "above / below" comparisons for signal separation.
# 10 % relative lift is required before a difference is called meaningful.
_ABOVE_THRESHOLD = 0.10

# Hard asset-tier boundaries in dollars, matching Callahan's published tiers.
ASSET_TIERS: dict[str, tuple[float, float]] = {
    "under_250M": (0,               250_000_000),
    "250M_1B":    (250_000_000,    1_000_000_000),
    "1B_5B":      (1_000_000_000,  5_000_000_000),
    "over_5B":    (5_000_000_000,  math.inf),
}

# 2-digit state FIPS → 2-letter abbreviation (branches_annual uses abbreviations)
_FIPS_TO_ABBR: dict[str, str] = {
    "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT",
    "10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL",
    "18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD",
    "25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE",
    "32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND",
    "39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD",
    "47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV",
    "55":"WI","56":"WY","72":"PR",
}


class PeerEngine:
    """
    Builds peer groups in priority order: geographic first, then asset-size.

    All public methods accept an optional *engine* so tests can pass an
    in-process SQLite/PostgreSQL engine without touching DATABASE_URL.
    """

    def __init__(self, engine: Optional[sa.engine.Engine] = None) -> None:
        self._engine = engine or get_engine()

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_default_peer_group(
        self,
        charter_number: str,
        period: str = "latest",
    ) -> dict:
        """
        Returns the default peer group for any institution.

        Priority order (CLAUDE.md §Peer group logic):
            1. Same state + ±50% asset size  — minimum 10 institutions required
            2. Same MSA + any size            — if CU is in a major metro
            3. National same-asset-size       — fallback only

        Returns
        -------
        dict
            peer_ids        list[str]   NCUA charter numbers
            peer_label      str         human-readable description shown on every chart
            peer_count      int
            geography_type  str         "state" | "msa" | "national"
            fallback        bool        True when national fallback was used
        """
        resolved    = _resolve_period(period, self._engine)
        institution = _fetch_institution(charter_number, resolved, self._engine)

        if not institution:
            logger.warning(
                "charter %s not found for period %s; returning empty peer group.",
                charter_number, resolved,
            )
            return _empty_peer_group("state")

        state        = institution["state"]
        total_assets = institution["total_assets"] or 0

        # ── Priority 1: same state + ±50% asset size ──────────────────────────
        state_peers = _peers_same_state_same_size(
            charter_number, state, total_assets, resolved, self._engine
        )
        if len(state_peers) >= _MIN_DEFAULT_PEERS:
            return {
                "peer_ids":       state_peers,
                "peer_label":     f"Same state ({state}) — similar asset size (±50%)",
                "peer_count":     len(state_peers),
                "geography_type": "state",
                "fallback":       False,
            }

        # ── Priority 2: same MSA + any size ───────────────────────────────────
        county_fips = institution.get("county_fips")
        msa_code    = _county_to_msa(county_fips, self._engine) if county_fips else None
        msa_peers: list[str] = []
        if msa_code:
            msa_peers = _peers_in_msa(
                charter_number, msa_code, resolved, self._engine
            )
        if len(msa_peers) >= _MIN_MSA_CUS:
            return {
                "peer_ids":       msa_peers,
                "peer_label":     f"Same MSA ({msa_code})",
                "peer_count":     len(msa_peers),
                "geography_type": "msa",
                "fallback":       False,
            }

        # ── Priority 3: national same-asset-size (fallback) ───────────────────
        tier         = _asset_tier(total_assets)
        national     = _peers_national_asset_tier(
            charter_number, total_assets, resolved, self._engine
        )
        tier_label   = tier.replace("_", " ")
        logger.info(
            "charter %s: state peers %d < %d, using national fallback (%s).",
            charter_number, len(state_peers), _MIN_DEFAULT_PEERS, tier_label,
        )
        return {
            "peer_ids":       national,
            "peer_label":     (
                f"National — {tier_label} asset tier "
                f"(state peers insufficient: {len(state_peers)})"
            ),
            "peer_count":     len(national),
            "geography_type": "national",
            "fallback":       True,
        }

    def get_regional_peer_group(
        self,
        charter_number: str,
        geography_type: str,
        geography_id: str,
        period: str = "latest",
    ) -> dict:
        """
        Returns all institutions with branch presence in the specified geography.

        No asset-size filter — shows every competitor in the market regardless
        of size. This is P76's Callahan-exclusive feature; never hide it.

        Parameters
        ----------
        geography_type : "county" | "msa" | "state" | "custom_region"
        geography_id :
            5-digit FIPS (county), CBSA code (msa), 2-letter abbr. or 2-digit
            FIPS (state), or UUID (custom_region).

        Returns
        -------
        dict
            peer_ids          list[str]  NCUA charter numbers (CU-only; usable in
                                         distribution analysis via delinquency_engine)
            peer_label        str
            peer_count        int        total institutions including banks
            cu_count          int        credit unions only
            bank_count        int        FDIC-insured banks in geography
            geography_type    str
            geography_id      str
        """
        if geography_type not in ("county", "msa", "state", "custom_region"):
            raise ValueError(
                f"geography_type must be county/msa/state/custom_region; "
                f"got '{geography_type}'"
            )

        _resolve_period(period, self._engine)   # validates period; result unused here

        cu_charters = _regional_cu_peers(
            charter_number, geography_type, geography_id, self._engine
        )
        bank_count  = _count_banks_in_geography(
            geography_type, geography_id, self._engine
        )

        geo_str = _geo_display(geography_type, geography_id)
        return {
            "peer_ids":       cu_charters,
            "peer_label":     f"All institutions in {geo_str} — no size filter",
            "peer_count":     len(cu_charters) + bank_count,
            "cu_count":       len(cu_charters),
            "bank_count":     bank_count,
            "geography_type": geography_type,
            "geography_id":   geography_id,
        }

    def get_callahan_style_peer_group(
        self,
        charter_number: str,
        asset_tier: str,
        period: str = "latest",
    ) -> dict:
        """
        Replicates Callahan's national asset-size peer group.

        Provided as an ALTERNATIVE view for migration and side-by-side
        comparison only; never used as the default per CLAUDE.md.

        Parameters
        ----------
        asset_tier : "under_250M" | "250M_1B" | "1B_5B" | "over_5B"
        """
        if asset_tier not in ASSET_TIERS:
            raise ValueError(
                f"asset_tier must be one of {list(ASSET_TIERS)}; got '{asset_tier}'"
            )

        resolved = _resolve_period(period, self._engine)
        lo, hi   = ASSET_TIERS[asset_tier]
        peer_ids = _national_asset_range_peers(
            charter_number, lo, hi, resolved, self._engine
        )
        label = asset_tier.replace("_", " ")
        return {
            "peer_ids":       peer_ids,
            "peer_label":     f"National — {label} (Callahan-equivalent)",
            "peer_count":     len(peer_ids),
            "geography_type": "national",
            "fallback":       False,
            "callahan_style": True,
        }

    def separate_market_vs_institution_signal(
        self,
        charter_number: str,
        metric: str,
        period: str,
        geography_id: str,
        geography_type: str = "state",
    ) -> dict:
        """
        Determines whether a metric deviation is institution-specific or regional.

        Three signal states (CLAUDE.md §Institution vs market signal separation):

            regional_pressure       institution AND region both above national median
                                    → "market condition, not isolated to your institution"

            institution_specific    institution above regional median, region near national
                                    → "warrants review of underwriting or portfolio mix"

            outperforming_market    region above national, institution below regional
                                    → "regional pressure, you are managing better than peers"

        For adverse metrics (delinquency, charge-offs) higher = worse.
        Pass rate columns from institutions_quarterly (decimal fractions, not %).

        Returns
        -------
        dict
            signal_type          str   one of the three states above, or
                                       "no_signal" | "insufficient_data"
            institution_value    float | None
            regional_median      float | None
            national_median      float | None
            interpretation_text  str   human-readable one-liner for SignalSeparator
            peer_label           str   which peer group produced the regional median
            n_regional_peers     int
            n_national_peers     int
        """
        resolved    = _resolve_period(period, self._engine)
        institution = _fetch_institution(charter_number, resolved, self._engine)
        if not institution:
            return _signal_insufficient()

        inst_val = _fetch_single_metric(
            charter_number, metric, resolved, self._engine
        )
        if inst_val is None:
            return _signal_insufficient()

        # Regional median — all CUs with branch presence in the geography
        regional_peers   = _regional_cu_peers(
            charter_number, geography_type, geography_id, self._engine
        )
        regional_median, n_reg = _compute_median(
            metric, resolved, regional_peers, self._engine
        )

        # National median — same ±50% asset-size tier (not geography-filtered)
        total_assets     = institution["total_assets"] or 0
        national_peers   = _peers_national_asset_tier(
            charter_number, total_assets, resolved, self._engine
        )
        national_median, n_nat = _compute_median(
            metric, resolved, national_peers, self._engine
        )

        if regional_median is None or national_median is None or national_median == 0:
            return _signal_insufficient()

        inst_above_regional   = inst_val  > regional_median  * (1 + _ABOVE_THRESHOLD)
        region_above_national = regional_median > national_median * (1 + _ABOVE_THRESHOLD)
        inst_below_regional   = inst_val  < regional_median  * (1 - _ABOVE_THRESHOLD)

        if inst_above_regional and region_above_national:
            signal = "regional_pressure"
            text   = (
                "Both your institution and the regional market are elevated above "
                "the national baseline — this appears to be a market condition, "
                "not isolated to your institution."
            )
        elif inst_above_regional and not region_above_national:
            signal = "institution_specific"
            text   = (
                "Your rate is above the regional median while the regional market "
                "is near the national baseline — this warrants review of "
                "underwriting practices or portfolio mix."
            )
        elif region_above_national and inst_below_regional:
            signal = "outperforming_market"
            text   = (
                "The regional market is experiencing elevated rates relative to "
                "the national baseline, but your institution is performing better "
                "than regional peers — you are managing this pressure well."
            )
        else:
            signal = "no_signal"
            text   = (
                "No significant divergence detected between your institution, "
                "the regional market, and national peers."
            )

        geo_str = _geo_display(geography_type, geography_id)
        return {
            "signal_type":         signal,
            "institution_value":   inst_val,
            "regional_median":     regional_median,
            "national_median":     national_median,
            "interpretation_text": text,
            "peer_label":          f"Regional: all CUs in {geo_str}",
            "n_regional_peers":    n_reg,
            "n_national_peers":    n_nat,
        }


# ── Private helpers ────────────────────────────────────────────────────────────

def _resolve_period(period: str, engine: sa.engine.Engine) -> str:
    if period and period.upper() not in ("LATEST", ""):
        return period
    with engine.connect() as conn:
        row = conn.execute(
            sa.text("SELECT MAX(data_period) FROM institutions_quarterly")
        ).fetchone()
    return str(row[0]) if row and row[0] else period


def _fetch_institution(
    charter_number: str,
    period: str,
    engine: sa.engine.Engine,
) -> Optional[dict]:
    """
    Fetches core institution fields for one period.

    county_fips is queried optimistically; if the column does not yet exist
    (geocoder not yet run), the row is returned without it.
    """
    with engine.connect() as conn:
        try:
            row = conn.execute(
                sa.text("""
                    SELECT DISTINCT ON (charter_number)
                           charter_number,
                           institution_name,
                           state,
                           total_assets,
                           county_fips
                    FROM   institutions_quarterly
                    WHERE  charter_number = :cn
                      AND  data_period    = :period
                    ORDER  BY charter_number, ingested_at DESC
                """),
                {"cn": charter_number, "period": period},
            ).mappings().fetchone()
        except sa.exc.ProgrammingError:
            # county_fips column absent (geocoder not yet run) — retry without it
            row = conn.execute(
                sa.text("""
                    SELECT DISTINCT ON (charter_number)
                           charter_number,
                           institution_name,
                           state,
                           total_assets
                    FROM   institutions_quarterly
                    WHERE  charter_number = :cn
                      AND  data_period    = :period
                    ORDER  BY charter_number, ingested_at DESC
                """),
                {"cn": charter_number, "period": period},
            ).mappings().fetchone()
    return dict(row) if row else None


def _fetch_single_metric(
    charter_number: str,
    metric: str,
    period: str,
    engine: sa.engine.Engine,
) -> Optional[float]:
    with engine.connect() as conn:
        try:
            row = conn.execute(
                sa.text(f"""
                    SELECT DISTINCT ON (charter_number) {metric}
                    FROM   institutions_quarterly
                    WHERE  charter_number = :cn
                      AND  data_period    = :period
                      AND  {metric}       IS NOT NULL
                    ORDER  BY charter_number, ingested_at DESC
                """),
                {"cn": charter_number, "period": period},
            ).fetchone()
        except sa.exc.ProgrammingError:
            logger.error(
                "Metric column '%s' not found in institutions_quarterly.", metric
            )
            return None
    return float(row[0]) if row and row[0] is not None else None


def _asset_tier(total_assets: float) -> str:
    for tier, (lo, hi) in ASSET_TIERS.items():
        if lo <= total_assets < hi:
            return tier
    return "over_5B"


def _peers_same_state_same_size(
    own_charter: str,
    state: str,
    total_assets: float,
    period: str,
    engine: sa.engine.Engine,
) -> list[str]:
    lo = total_assets * 0.50
    hi = total_assets * 1.50
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("""
                SELECT DISTINCT ON (charter_number) charter_number
                FROM   institutions_quarterly
                WHERE  state          = :state
                  AND  charter_number != :own
                  AND  data_period    = :period
                  AND  total_assets   IS NOT NULL
                  AND  total_assets   BETWEEN :lo AND :hi
                ORDER  BY charter_number, ingested_at DESC
            """),
            {"state": state, "own": own_charter, "period": period, "lo": lo, "hi": hi},
        ).fetchall()
    return [str(r[0]) for r in rows]


def _county_to_msa(county_fips: str, engine: sa.engine.Engine) -> Optional[str]:
    with engine.connect() as conn:
        try:
            row = conn.execute(
                sa.text("""
                    SELECT cbsa_code FROM cbsa_county_crosswalk
                    WHERE  county_fips = :fips
                    LIMIT  1
                """),
                {"fips": county_fips},
            ).fetchone()
        except sa.exc.ProgrammingError:
            return None
    return str(row[0]) if row and row[0] else None


def _peers_in_msa(
    own_charter: str,
    msa_code: str,
    period: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """CUs whose county_fips is in the MSA, any asset size."""
    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text("""
                    SELECT DISTINCT ON (q.charter_number) q.charter_number
                    FROM   institutions_quarterly q
                    JOIN   cbsa_county_crosswalk  c ON c.county_fips = q.county_fips
                    WHERE  c.cbsa_code      = :msa
                      AND  q.charter_number != :own
                      AND  q.data_period    = :period
                      AND  q.county_fips    IS NOT NULL
                    ORDER  BY q.charter_number, q.ingested_at DESC
                """),
                {"msa": msa_code, "own": own_charter, "period": period},
            ).fetchall()
        except sa.exc.ProgrammingError:
            return []
    return [str(r[0]) for r in rows]


def _peers_national_asset_tier(
    own_charter: str,
    total_assets: float,
    period: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """National peers within ±50% of own total_assets (no state/geo filter)."""
    lo = total_assets * 0.50
    hi = total_assets * 1.50
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("""
                SELECT DISTINCT ON (charter_number) charter_number
                FROM   institutions_quarterly
                WHERE  charter_number != :own
                  AND  data_period    = :period
                  AND  total_assets   IS NOT NULL
                  AND  total_assets   BETWEEN :lo AND :hi
                ORDER  BY charter_number, ingested_at DESC
            """),
            {"own": own_charter, "period": period, "lo": lo, "hi": hi},
        ).fetchall()
    return [str(r[0]) for r in rows]


def _national_asset_range_peers(
    own_charter: str,
    lo: float,
    hi: float,
    period: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """National peers in a hard asset-tier band (Callahan-style fixed brackets)."""
    clauses = [
        "charter_number != :own",
        "data_period    = :period",
        "total_assets   IS NOT NULL",
        "total_assets   >= :lo",
    ]
    params: dict = {"own": own_charter, "period": period, "lo": lo}
    if hi < math.inf:
        clauses.append("total_assets < :hi")
        params["hi"] = hi

    where = " AND ".join(clauses)
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(f"""
                SELECT DISTINCT ON (charter_number) charter_number
                FROM   institutions_quarterly
                WHERE  {where}
                ORDER  BY charter_number, ingested_at DESC
            """),
            params,
        ).fetchall()
    return [str(r[0]) for r in rows]


def _regional_cu_peers(
    own_charter: str,
    geography_type: str,
    geography_id: str,
    engine: sa.engine.Engine,
) -> list[str]:
    """
    CU charter numbers with branch presence in the geography (via branches_annual).

    branches_annual.charter_number is the NCUA charter number, populated by
    the FDIC ingester's crosswalk lookup.  Rows where charter_number IS NULL
    are bank-only branches and are intentionally excluded.
    """
    if geography_type == "county":
        geo_clause = "ba.county_fips = :gid"
        gid = geography_id
    elif geography_type == "msa":
        geo_clause = """
            ba.county_fips IN (
                SELECT county_fips FROM cbsa_county_crosswalk
                WHERE  cbsa_code = :gid
            )
        """
        gid = geography_id
    elif geography_type == "state":
        # Normalise: API sends 2-digit FIPS; branches_annual stores 2-letter abbr.
        gid = _FIPS_TO_ABBR.get(geography_id.zfill(2), geography_id)
        geo_clause = "ba.state = :gid"
    else:
        # custom_region: PostGIS polygon intersection — not yet implemented
        logger.warning(
            "custom_region geography not yet supported in PeerEngine; "
            "returning empty regional peer list."
        )
        return []

    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text(f"""
                    SELECT DISTINCT ba.charter_number
                    FROM   branches_annual ba
                    WHERE  {geo_clause}
                      AND  ba.charter_number IS NOT NULL
                      AND  ba.charter_number != :own
                """),
                {"gid": gid, "own": own_charter},
            ).fetchall()
        except sa.exc.ProgrammingError as exc:
            logger.warning(
                "Regional CU peer query failed (%s) — "
                "branches_annual or cbsa_county_crosswalk not populated.", exc
            )
            return []
    return [str(r[0]) for r in rows]


def _count_banks_in_geography(
    geography_type: str,
    geography_id: str,
    engine: sa.engine.Engine,
) -> int:
    if geography_type == "county":
        where = "county_fips = :gid"
        gid   = geography_id
    elif geography_type == "msa":
        where = """county_fips IN (
            SELECT county_fips FROM cbsa_county_crosswalk WHERE cbsa_code = :gid
        )"""
        gid = geography_id
    elif geography_type == "state":
        gid   = _FIPS_TO_ABBR.get(geography_id.zfill(2), geography_id)
        where = "state = :gid"
    else:
        return 0

    with engine.connect() as conn:
        try:
            row = conn.execute(
                sa.text(f"""
                    SELECT COUNT(DISTINCT cert_number)
                    FROM   branches_annual
                    WHERE  {where}
                      AND  COALESCE(file_type, 'bank') != 'credit_union'
                """),
                {"gid": gid},
            ).fetchone()
        except sa.exc.ProgrammingError:
            return 0
    return int(row[0]) if row and row[0] else 0


def _compute_median(
    metric: str,
    period: str,
    charter_numbers: list[str],
    engine: sa.engine.Engine,
) -> tuple[Optional[float], int]:
    """Returns (median_value, n) for *metric* across *charter_numbers*."""
    if not charter_numbers:
        return None, 0
    with engine.connect() as conn:
        try:
            rows = conn.execute(
                sa.text(f"""
                    SELECT DISTINCT ON (charter_number) {metric}
                    FROM   institutions_quarterly
                    WHERE  charter_number = ANY(:ids)
                      AND  data_period    = :period
                      AND  {metric}       IS NOT NULL
                    ORDER  BY charter_number, ingested_at DESC
                """),
                {"ids": list(charter_numbers), "period": period},
            ).fetchall()
        except sa.exc.ProgrammingError:
            return None, 0
    values = sorted(float(r[0]) for r in rows if r[0] is not None)
    n = len(values)
    if n == 0:
        return None, 0
    mid    = n // 2
    median = values[mid] if n % 2 == 1 else (values[mid - 1] + values[mid]) / 2.0
    return median, n


def _geo_display(geography_type: str, geography_id: str) -> str:
    return f"{geography_type} {geography_id}"


def _empty_peer_group(geography_type: str) -> dict:
    return {
        "peer_ids":       [],
        "peer_label":     "No peer group found",
        "peer_count":     0,
        "geography_type": geography_type,
        "fallback":       True,
    }


def _signal_insufficient() -> dict:
    return {
        "signal_type":         "insufficient_data",
        "institution_value":   None,
        "regional_median":     None,
        "national_median":     None,
        "interpretation_text": (
            "Insufficient data to compute market vs. institution signal."
        ),
        "peer_label":          "",
        "n_regional_peers":    0,
        "n_national_peers":    0,
    }
