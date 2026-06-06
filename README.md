# Regional Market Intelligence Platform

Competitive intelligence and credit quality monitoring for credit unions — built on NCUA, FDIC, HMDA, and Census data with a Claude-powered natural language interface.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat-square&logo=redis&logoColor=white)
![Recharts](https://img.shields.io/badge/Recharts-22B5BF?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-Opus_4.8-CC785C?style=flat-square)
![python-docx](https://img.shields.io/badge/python--docx-reports-2B579A?style=flat-square)

---

## What it does

| Module | What you get |
|---|---|
| **Market share** | Deposit and loan market share by county, MSA, or state — updated when FDIC SOD and NCUA data release |
| **Delinquency analytics** | Institution vs. peer comparison for 6 loan types, 90+ day rate, charge-off rate, ALLL coverage |
| **Regional context** | Separates institution-specific credit stress from market-wide economic conditions using P37 signals |
| **NL query** | Ask questions in plain English; Claude selects the right data, runs the query, and writes the answer |
| **Automated alerts** | Quarterly detection of market share shifts and delinquency threshold breaches with Claude narratives |
| **Reports** | One-click `.docx` — monthly risk committee (5 sections) or quarterly board (adds charts + forward outlook) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      DATA SOURCES                        │
│  NCUA 5300 · quarterly    FDIC SOD · annual             │
│  HMDA originations · annual    Census ACS · annual      │
└────────────────────┬─────────────────────────────────────┘
                     │  ingestion/  (APScheduler, per-source cadence)
                     ▼
┌──────────────────────────────────────────────────────────┐
│                     PROCESSING                           │
│  normalizer → geocoder → estimation_model               │
│  market_share_engine    delinquency_engine              │
│  peer_selector          validator                       │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
              PostgreSQL  ←──  Redis (geo aggregation cache)
                     │
┌────────────────────┴─────────────────────────────────────┐
│              FastAPI  ·  JWT multi-tenancy               │
│  /market-share    /peers      /ask (NL query)           │
│  /alerts          /reports    /delinquency/*            │
│                                                          │
│           Claude Opus 4.8  (adaptive thinking)          │
│           · NL query tool selection + synthesis         │
│           · Alert narrative generation                  │
│           · Report section authoring                    │
└────────────────────┬─────────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────┐
│                  React  +  Recharts                      │
│  MarketMap (choropleth)    DelinquencyDashboard         │
│  PeerComparison            TrendAnalysis                │
│  NLQuery                   Reports                      │
└──────────────────────────────────────────────────────────┘
```

**Confidence levels** — every displayed figure carries one of three badges:

| Badge | Source | Accuracy |
|---|---|---|
| `measured` | FDIC branch-level data | Exact |
| `modeled` | Deposit allocation model | ±8% validated |
| `estimated` | Proxy-based | Flag and use with caution |

---

## Tech stack

| Layer | Technology |
|---|---|
| API | FastAPI, SQLAlchemy, Pydantic v2, `asyncio` |
| AI | Anthropic SDK — `claude-opus-4-8` with adaptive thinking |
| Database | PostgreSQL (SQLAlchemy Core, Alembic migrations) |
| Cache | Redis — geo aggregation results |
| Auth | JWT — tenant isolation on every query |
| Scheduler | APScheduler — per-source release cadence |
| Frontend | React 18, Recharts, Vite |
| Reports | python-docx, matplotlib |
| Data | NCUA CUSO API, FDIC BankFind, HMDA API, Census API |

---

## Example questions

The `/ask` endpoint accepts plain English. Claude picks the right tool, runs the query, and writes a direct answer with specific numbers.

---

**1 — Market share movement**
> *"Which credit unions gained deposit share in Palm Beach County over the past year, and how much did we lose to each of them?"*

Returns a ranked list of share gainers with pp changes, your institution's net movement, and a narrative identifying whether losses came from a single competitor or broad market erosion.

---

**2 — Delinquency peer comparison**
> *"How does our auto loan delinquency compare to other credit unions in our county this quarter, and has it been getting better or worse?"*

Returns your rate vs. peer median and P75, your percentile rank, a 4-quarter trend, and a plain-English assessment of whether the trajectory warrants management attention.

---

**3 — Regional vs. institution-specific stress**
> *"Is our elevated commercial delinquency a regional economic problem or something specific to our underwriting?"*

Cross-references your rate against all institutions in the primary geography, overlays P37 signals (employer hiring, business closures, permit activity), and returns a direct conclusion with supporting evidence.

---

**4 — Reserve adequacy**
> *"Are our loan loss reserves adequate compared to peers, and what's the dollar gap if we're below the 1.0× coverage threshold?"*

Returns current ALLL coverage ratio vs. peer median and minimum adequate threshold, the dollar gap to 1.0× (if applicable), and context on examiner expectations.

---

**5 — New market entrant**
> *"Has any bank or credit union entered the Broward County mortgage market in the last two years with meaningful share?"*

Compares HMDA origination share across the two most recent annual snapshots, flags any institution that went from zero to ≥2% share, and provides context on branch footprint if available.

---

## Data sources and update schedule

| Source | Frequency | Lag | Coverage |
|---|---|---|---|
| NCUA 5300 Call Report | Quarterly | ~60 days after quarter end | All federally insured credit unions |
| FDIC Summary of Deposits | Annual | June (prior June 30 snapshot) | All FDIC-insured institutions |
| HMDA | Annual | ~9 months after year end | Mortgage originations by institution + geography |
| Census ACS | Annual | December (prior year) | Population, income, housing |

---

## Setup

```bash
# Backend
cp .env.example .env          # add DB_URL, ANTHROPIC_API_KEY, CENSUS_API_KEY, etc.
pip install -r requirements.txt
alembic upgrade head
uvicorn api.main:app --reload

# Frontend
cd frontend && npm install && npm run dev

# Ingest (first run)
python -m ingestion.ncua_ingester --year 2024 --quarter 4
python -m ingestion.fdic_ingester --year 2023
python -m ingestion.hmda_ingester --year 2023
```

See `.env.example` for all required environment variables.
# Regional-Market-Intelligence-Platform
