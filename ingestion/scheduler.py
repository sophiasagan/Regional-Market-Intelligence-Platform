"""
Ingestion scheduler.

Runs all data source ingesters on their publish schedules and triggers
downstream processing (peer distributions, early warning signals) after
each successful ingestion.

APScheduler docs: https://apscheduler.readthedocs.io/

Run:
    python -m ingestion.scheduler
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.blocking import BlockingScheduler

from ingestion.ncua_ingester import ingest_ncua_quarter
from processing.compute_peer_distributions import run as compute_peer_distributions

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

scheduler = BlockingScheduler(timezone="UTC")


def _current_quarter() -> tuple[int, int]:
    now = datetime.now(timezone.utc)
    return now.year, (now.month - 1) // 3 + 1


# ── NCUA 5300 ─────────────────────────────────────────────────────────────────
# Published ~60 days after quarter-end.
# Check daily; ingest_ncua_quarter is idempotent — skips if data already loaded.

@scheduler.scheduled_job("cron", hour=2, minute=0, id="ncua_ingest")
def ncua_daily_check() -> None:
    year, quarter = _current_quarter()
    logger.info("Checking for NCUA data: %dQ%d", year, quarter)
    try:
        ingest_ncua_quarter(year, quarter)
        _post_ncua_processing(f"{year}Q{quarter}")
    except Exception as exc:
        logger.error("NCUA ingestion failed: %s", exc)


def _post_ncua_processing(period: str) -> None:
    """
    Run downstream processing after a successful NCUA ingest.
    Compute peer distributions for the just-ingested period.
    """
    logger.info("Post-ingest processing for %s", period)
    try:
        compute_peer_distributions(periods=[period])
        logger.info("Peer distributions computed for %s", period)
    except Exception as exc:
        logger.error("compute_peer_distributions failed for %s: %s", period, exc)


if __name__ == "__main__":
    logger.info("Starting ingestion scheduler…")
    scheduler.start()
