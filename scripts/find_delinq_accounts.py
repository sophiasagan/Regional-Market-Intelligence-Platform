"""
Diagnostic: find NCUA account codes for per-loan-type delinquency.

Strategy:
  Navy Federal (charter 5536) showed all per-type delinquency fields as 0.
  This script samples the top-50 CUs by asset size (excluding Navy Federal)
  and checks which ACCT_7xx / ACCT_6xx codes contain non-zero delinquency
  figures for multiple institutions.

  If a code is non-zero for many CUs → it's a real populated field.
  If all codes in the delinquency range are zero for all CUs → the data
  simply isn't in the bulk FS220.txt and we need a different approach.

Run from the Railway console:
    python scripts/find_delinq_accounts.py [--year 2024] [--top N]
"""
from __future__ import annotations

import argparse
import io
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import httpx
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

NCUA_ZIP_URL_TEMPLATE = (
    "https://ncua.gov/files/publications/analysis/call-report-data-{year}-12.zip"
)
SKIP_CHARTERS = {"5536"}  # Navy Federal — already diagnosed, skip


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2024)
    parser.add_argument("--top",  type=int, default=50,
                        help="Number of largest CUs (excl. Navy Fed) to sample")
    args = parser.parse_args()

    url = NCUA_ZIP_URL_TEMPLATE.format(year=args.year)
    print(f"Downloading {args.year} Q4 NCUA ZIP from {url} …")
    with httpx.Client(follow_redirects=True, timeout=300) as client:
        resp = client.get(url)
        resp.raise_for_status()
    raw_zip = resp.content
    print(f"  Downloaded {len(raw_zip)/1e6:.1f} MB\n")

    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf:
        names = zf.namelist()
        print(f"ZIP contents: {names}\n")

        # ── Load FS220.txt (financial data) ──────────────────────────────────
        fs220_name = next(
            (n for n in names
             if n.upper() == "FS220.TXT"
             or (n.upper().startswith("FS220") and not n.upper().startswith("FS220S"))),
            None,
        )
        if not fs220_name:
            print("ERROR: FS220.TXT not found in ZIP")
            return
        print(f"Reading {fs220_name} …")
        with zf.open(fs220_name) as fh:
            sample = fh.read(4096).decode("latin-1", errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        with zf.open(fs220_name) as fh:
            fs220 = pd.read_csv(fh, dtype=str, low_memory=False, sep=sep,
                                encoding_errors="replace")
        print(f"  {len(fs220):,} rows × {len(fs220.columns):,} columns\n")

        # ── Load FOICU.txt (identity / assets) ───────────────────────────────
        foicu_name = next((n for n in names if "foicu" in n.lower()), None)
        assets_map: dict[str, float] = {}
        if foicu_name:
            with zf.open(foicu_name) as fh:
                foicu = pd.read_csv(fh, dtype=str, low_memory=False,
                                    encoding_errors="replace")
            foicu.columns = [c.strip().lower() for c in foicu.columns]
            cu_col_f  = next((c for c in foicu.columns if "cu_number" in c or "charter" in c), None)
            asset_col = next((c for c in foicu.columns if "asset" in c.lower()), None)
            name_col  = next((c for c in foicu.columns if "cu_name" in c.lower() or "name" in c.lower()), None)
            if cu_col_f and asset_col:
                for _, row in foicu.iterrows():
                    try:
                        assets_map[str(row[cu_col_f]).strip()] = float(str(row[asset_col]).replace(",", ""))
                    except Exception:
                        pass

    # ── Find charter column in FS220 ─────────────────────────────────────────
    cu_col = next(
        (c for c in fs220.columns if "cu_number" in c.lower() or "charter" in c.lower()),
        None,
    )
    if not cu_col:
        print(f"Columns: {list(fs220.columns[:20])}")
        print("ERROR: Cannot find charter number column in FS220")
        return

    fs220[cu_col] = fs220[cu_col].astype(str).str.strip()

    # ── Select top-N CUs by assets (excluding Navy Federal) ──────────────────
    if assets_map:
        top_charters = sorted(
            [c for c in assets_map if c not in SKIP_CHARTERS],
            key=lambda c: assets_map.get(c, 0),
            reverse=True,
        )[: args.top]
    else:
        # Fall back: pick rows that exist in FS220
        top_charters = [
            c for c in fs220[cu_col].unique()
            if c not in SKIP_CHARTERS
        ][: args.top]

    print(f"Sampling {len(top_charters)} largest CUs (excl. Navy Federal)\n")

    # ── Identify all ACCT_6xx–ACCT_8xx columns ───────────────────────────────
    def is_delinq_range(col: str) -> bool:
        up = col.upper()
        if not up.startswith("ACCT_"):
            return False
        rest = up[5:].lstrip("_")
        try:
            num = int("".join(filter(str.isdigit, rest.split("_")[0])))
            return 600 <= num <= 800
        except Exception:
            return False

    delinq_cols = [c for c in fs220.columns if is_delinq_range(c)]
    print(f"Found {len(delinq_cols)} ACCT_6xx–8xx columns to check\n")

    # ── Tally non-zero counts across sampled CUs ──────────────────────────────
    nonzero_count: dict[str, int] = defaultdict(int)
    nonzero_examples: dict[str, list[tuple[str, float]]] = defaultdict(list)

    sampled = fs220[fs220[cu_col].isin(set(top_charters))]
    print(f"Rows matched in FS220: {len(sampled)} (of {len(top_charters)} requested charters)\n")

    for _, row in sampled.iterrows():
        charter = row[cu_col]
        for col in delinq_cols:
            raw = str(row.get(col, "")).strip()
            if raw not in ("", "0", "0.0", "nan", "None", "NaN"):
                try:
                    val = float(raw.replace(",", ""))
                    if val != 0:
                        nonzero_count[col] += 1
                        if len(nonzero_examples[col]) < 3:
                            nonzero_examples[col].append((charter, val))
                except Exception:
                    pass

    # ── Report ────────────────────────────────────────────────────────────────
    print("=" * 72)
    print(f"ACCT_6xx–8xx columns with non-zero values in ≥1 sampled CU:")
    print("=" * 72)
    if not nonzero_count:
        print("\nNO non-zero values found in any ACCT_6xx–8xx column for any sampled CU.")
        print("Conclusion: per-type delinquency is NOT present in FS220.txt bulk download.")
    else:
        sorted_cols = sorted(nonzero_count.items(), key=lambda x: -x[1])
        for col, cnt in sorted_cols:
            pct = cnt / len(sampled) * 100
            examples = ", ".join(
                f"charter {c}: ${v/1e6:.1f}M" for c, v in nonzero_examples[col]
            )
            print(f"  {col:22s}  populated for {cnt:3d}/{len(sampled)} CUs ({pct:.0f}%)  e.g. {examples}")

    # ── Cross-reference known delinquency keywords in codebook ───────────────
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as zf2:
        cb_name = next((n for n in zf2.namelist() if "acctdesc" in n.lower()), None)
        if cb_name:
            print(f"\n{'='*72}")
            print(f"Codebook entries matching 'delinq|past due' for populated accounts:")
            print("=" * 72)
            with zf2.open(cb_name) as fh:
                cb = pd.read_csv(fh, dtype=str, sep=sep,
                                 low_memory=False, encoding_errors="replace")
            cb.columns = [c.strip().lower() for c in cb.columns]
            text_col = next((c for c in cb.columns if "desc" in c or "name" in c or "label" in c), cb.columns[-1])
            acct_col = next((c for c in cb.columns if "acct" in c or "code" in c or "num" in c), cb.columns[0])
            for col in (nonzero_count or {}):
                code = col.upper().replace("ACCT_", "")
                match = cb[cb[acct_col].str.upper().str.contains(code, na=False)]
                for _, r in match.iterrows():
                    desc = r.get(text_col, "")
                    if any(kw in str(desc).lower() for kw in ("delinq", "past due", "charge", "90")):
                        print(f"  {col:22s}  → {desc}")


if __name__ == "__main__":
    main()
