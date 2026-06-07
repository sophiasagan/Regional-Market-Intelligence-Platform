"""
Diagnostic: find the correct NCUA account codes for delinquency data.

1. Downloads Q4 2024 NCUA ZIP (same one the ingester uses).
2. Reads ACCTDESC.txt (the codebook) and lists all accounts whose description
   contains 'delinq' or 'past due' or 'charge'.
3. Finds Navy Federal Credit Union (charter 5536) in FS220.txt and prints
   all columns where that CU has a non-zero value — focusing on suspected
   delinquency range (ACCT_600 – ACCT_800).

Run from the Railway console (or locally with DATABASE_URL set):
    python scripts/find_delinq_accounts.py
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import httpx
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

NCUA_ZIP_URL = (
    "https://ncua.gov/files/publications/analysis/call-report-data-2024-12.zip"
)
TARGET_CHARTER = "5536"  # Navy Federal Credit Union


def main() -> None:
    print("Downloading NCUA Q4 2024 ZIP …")
    with httpx.Client(follow_redirects=True, timeout=180) as client:
        resp = client.get(NCUA_ZIP_URL)
        resp.raise_for_status()
    raw_zip = resp.content
    print(f"  Downloaded {len(raw_zip)/1e6:.1f} MB")

    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        names = zf.namelist()
        print(f"\nZIP contents: {names}\n")

        # ── 1. Read the codebook ──────────────────────────────────────────────
        codebook_name = next(
            (n for n in names if "acctdesc" in n.lower()), None
        )
        if codebook_name:
            print(f"=== Codebook: {codebook_name} ===")
            with zf.open(codebook_name) as fh:
                sample = fh.read(4096).decode("latin-1", errors="replace")
            sep = "\t" if sample.count("\t") > sample.count(",") else ","
            with zf.open(codebook_name) as fh:
                cb = pd.read_csv(fh, dtype=str, sep=sep,
                                 low_memory=False, encoding_errors="replace")
            print(f"Codebook columns: {list(cb.columns)}")
            cb.columns = [c.strip().lower() for c in cb.columns]
            # Look for delinquency / charge-off related accounts
            text_col = next(
                (c for c in cb.columns if "desc" in c or "name" in c or "label" in c),
                cb.columns[-1],
            )
            account_col = next(
                (c for c in cb.columns if "acct" in c or "code" in c or "num" in c),
                cb.columns[0],
            )
            mask = cb[text_col].str.lower().str.contains(
                r"delinq|past.?due|charge.?off|charged.?off|non.?accrual|troubled|oreo|other.?real|allowance|alll|tdr",
                na=False,
                regex=True,
            )
            relevant = cb[mask][[account_col, text_col]].drop_duplicates()
            print(f"\nRelevant accounts ({len(relevant)} rows):")
            print(relevant.to_string(index=False))
        else:
            print("(No ACCTDESC file found in ZIP)")

        # ── 2. Find Navy Federal in FS220 and show non-zero columns ──────────
        fs220_name = next(
            (n for n in names if "fs220" in n.lower()), None
        )
        if not fs220_name:
            fs220_name = next(
                (n for n in names
                 if n.lower().endswith((".txt", ".csv"))
                 and "foicu" not in n.lower()
                 and "acctdesc" not in n.lower()
                 and "readme" not in n.lower()),
                None,
            )
        print(f"\n=== FS220 file: {fs220_name} ===")
        with zf.open(fs220_name) as fh:
            sample = fh.read(4096).decode("latin-1", errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        with zf.open(fs220_name) as fh:
            fs220 = pd.read_csv(fh, dtype=str, low_memory=False,
                                sep=sep, encoding_errors="replace")

        # Find charter number column
        cu_col = next(
            (c for c in fs220.columns if "cu_number" in c.lower() or "charter" in c.lower()),
            None,
        )
        if not cu_col:
            print(f"All columns: {list(fs220.columns)}")
            print("ERROR: Cannot find charter number column")
            return

        row = fs220[fs220[cu_col].astype(str).str.strip() == TARGET_CHARTER]
        if row.empty:
            print(f"Charter {TARGET_CHARTER} not found. Showing first row instead.")
            row = fs220.head(1)

        print(f"\nNon-zero ACCT_ columns for charter {TARGET_CHARTER} (NAVY FEDERAL):")
        row_dict = row.iloc[0].to_dict()
        nonzero = {
            k: v for k, v in row_dict.items()
            if k.upper().startswith("ACCT_")
            and str(v).strip() not in ("", "0", "0.0", "nan", "None")
        }
        # Sort by account code number for readability
        def _sort_key(item):
            parts = item[0].upper().replace("ACCT_", "").split("_")
            try:
                return (int(''.join(filter(str.isdigit, parts[0]))), ''.join(filter(str.isalpha, item[0])))
            except Exception:
                return (9999, item[0])

        print(f"  Total non-zero ACCT_ columns: {len(nonzero)}")
        for k, v in sorted(nonzero.items(), key=_sort_key):
            print(f"  {k:20s} = {v}")

        # Also show the suspected delinquency range (600–800)
        print(f"\nAll ACCT_6xx–ACCT_8xx columns for charter {TARGET_CHARTER}:")
        delinq_range = {
            k: v for k, v in row_dict.items()
            if k.upper().startswith("ACCT_")
            and any(k.upper().startswith(f"ACCT_{p}") for p in
                    ["6", "7", "8"])
        }
        for k, v in sorted(delinq_range.items(), key=_sort_key):
            flag = " *** NON-ZERO ***" if str(v).strip() not in ("", "0", "0.0", "nan", "None") else ""
            print(f"  {k:20s} = {v}{flag}")


if __name__ == "__main__":
    main()
