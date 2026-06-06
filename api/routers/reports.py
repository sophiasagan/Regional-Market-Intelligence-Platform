"""
Report generation endpoints.

POST /reports/credit-quality   — generate .docx credit quality report
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from ...reports.credit_quality_report import generate_credit_quality_report

router = APIRouter(prefix="/reports", tags=["reports"])


class CreditQualityReportRequest(BaseModel):
    tenant_id: str
    period: str                         # e.g. "2024Q4"
    report_type: Literal[
        "monthly_risk_committee",
        "quarterly_board",
    ] = "monthly_risk_committee"


@router.post("/credit-quality")
async def credit_quality_report(body: CreditQualityReportRequest) -> Response:
    """
    Generate and return a .docx credit quality report.

    The response Content-Disposition header suggests a filename; the client
    should save or stream the bytes directly to the user's download.
    """
    docx_bytes = await generate_credit_quality_report(
        tenant_id=body.tenant_id,
        period=body.period,
        report_type=body.report_type,
    )
    label     = "risk_committee" if body.report_type == "monthly_risk_committee" else "board"
    filename  = f"credit_quality_{label}_{body.period}.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
