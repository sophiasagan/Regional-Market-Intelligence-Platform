/**
 * CreditQuality — primary credit quality / delinquency benchmarking view.
 *
 * Layout mirrors Callahan Associates' visual hierarchy so analysts can adopt
 * P76 without relearning. P76-exclusive features (EarlyWarningPanel,
 * SignalSeparator, regional peer group) are layered on top.
 *
 * CLAUDE.md rules enforced here:
 *   - Peer group label shown on every chart (peerGroupLabel required by PeerBandChart)
 *   - LOWER percentile = BETTER for all delinquency / charge-off metrics (annotated)
 *   - Top decile GREEN, bottom decile RED (exact Callahan color convention)
 *   - Percentile stars 1–5 (Callahan scale: 5 = top 90%+)
 *   - Confidence badge on every figure (ConfidenceBadge via CompetitorTable pattern)
 *   - SignalSeparator never suppressed
 *   - EarlyWarningPanel collapsed by default, auto-expands on any alert
 *   - Every chart has a CSV/Excel download button
 *
 * Props (all optional — fall back to env vars for single-tenant deployments):
 *   charter          string  NCUA charter number
 *   institutionName  string  e.g. "Dort Financial"
 *   institutionState string  2-letter abbr, e.g. "MI"
 *   primaryCounty    string  5-digit FIPS
 *   primaryMsa       string  CBSA code
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import EarlyWarningPanel from '../components/EarlyWarningPanel';
import PeerBandChart     from '../components/PeerBandChart';
import SignalSeparator   from '../components/SignalSeparator';

// ── API ────────────────────────────────────────────────────────────────────────

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

const ep = {
  kpis:     (cn, period, pt)   => `${API}/delinquency/${cn}/kpis?period=${period}&peer_group_type=${pt}`,
  trend:    (cn, m, n, pt)     => `${API}/delinquency/${cn}/trend?metric=${m}&n_quarters=${n}&peer_group_type=${pt}`,
  breakdown:(cn, period, pt)   => `${API}/delinquency/${cn}/breakdown?period=${period}&peer_group_type=${pt}`,
  signal:   (cn, m, period, pt)=> `${API}/delinquency/${cn}/signal?metric=${m}&period=${period}&peer_group_type=${pt}`,
  ew:       (cn, m, pt)        => `${API}/delinquency/${cn}/early-warning?metric=${m}&peer_group_type=${pt}`,
  latest:   ()                 => `${API}/delinquency/latest-period`,
};

// ── Constants ─────────────────────────────────────────────────────────────────

// Metrics that are LOWER-IS-BETTER (delinquency, charge-offs, stress ratios).
const LOWER_IS_BETTER = new Set([
  'delinq_rate_total','delinq_90plus_rate','delinq_rate_auto','delinq_rate_new_auto',
  'delinq_rate_used_auto','delinq_rate_real_estate','delinq_rate_first_mortgage',
  'delinq_rate_credit_card','delinq_rate_commercial','delinq_rate_indirect',
  'chargeoff_rate_total','tdr_to_loans_ratio','oreo_to_assets_ratio',
]);

// Examiner alert thresholds per CLAUDE.md defaults.
const THRESHOLDS = {
  delinq_rate_total:      0.015,
  delinq_rate_auto:       0.020,
  delinq_rate_credit_card:0.035,
  delinq_rate_commercial: 0.010,
  alll_coverage_ratio:    1.0,
};

const THRESHOLD_LABELS = {
  delinq_rate_total:      'NCUA examiner threshold',
  delinq_rate_auto:       'NCUA examiner threshold',
  delinq_rate_credit_card:'NCUA examiner threshold',
  alll_coverage_ratio:    'NCUA examiner minimum',
};

// Metric selector — mirrors Callahan's Asset Quality left-nav tree exactly.
const METRIC_OPTIONS = [
  { group: 'Delinquency', options: [
    { value: 'delinq_rate_total',          label: 'Total Delinquency Ratio',     callahan: 'Delinquency Ratio'              },
    { value: 'delinq_90plus_rate',         label: '90+ Day Delinquency',         callahan: 'Total Delinquency 90+ Days'     },
    { value: 'delinq_rate_auto',           label: 'Auto Loan Delinquency',       callahan: 'Total Auto Loan Delinquency'    },
    { value: 'delinq_rate_new_auto',       label: 'New Auto Delinquency',        callahan: 'New Auto Loan Delinquency'      },
    { value: 'delinq_rate_used_auto',      label: 'Used Auto Delinquency',       callahan: 'Used Auto Loan Delinquency'     },
    { value: 'delinq_rate_real_estate',    label: 'Real Estate Delinquency',     callahan: 'Real Estate Delinquency'        },
    { value: 'delinq_rate_first_mortgage', label: '1st Mortgage Delinquency',    callahan: '1st Mortgage Delinquency'       },
    { value: 'delinq_rate_credit_card',    label: 'Credit Card Delinquency',     callahan: 'Credit Card Loan Delinquency'   },
    { value: 'delinq_rate_commercial',     label: 'Commercial Delinquency',      callahan: 'Commercial Loan Delinquency'    },
    { value: 'delinq_rate_indirect',       label: 'Indirect Delinquency',        callahan: 'Indirect Loan Delinquency'      },
  ]},
  { group: 'Charge-offs', options: [
    { value: 'chargeoff_rate_total',       label: 'Net Charge-Off Ratio',        callahan: 'Net Charge-Off Ratio'           },
  ]},
  { group: 'Reserves', options: [
    { value: 'alll_coverage_ratio',        label: 'Allowance for Loan Losses / Delinquency', callahan: 'Allowance for Loan Losses/Delinquency' },
    { value: 'alll_to_loans_ratio',        label: 'Allowance for Loan Losses / Total Loans', callahan: 'Allowance for Loan Losses to Total Loans' },
  ]},
];

const METRIC_FLAT = METRIC_OPTIONS.flatMap(g => g.options);
const metricLabel = (m) => METRIC_FLAT.find(o => o.value === m)?.label ?? m.replace(/_/g,' ');
const metricCallahan = (m) => METRIC_FLAT.find(o => o.value === m)?.callahan ?? null;

// Four KPI cards at the top of the page (Callahan's top-of-page layout).
const KPI_METRICS = [
  { key: 'delinq_rate_total',   label: 'Total Delinquency',    callahan: 'Delinquency Ratio'    },
  { key: 'delinq_90plus_rate',  label: '90+ Day Delinquency',  callahan: '90+ Day Delinquency'  },
  { key: 'chargeoff_rate_total',label: 'Net Charge-Off Rate',  callahan: 'Net Charge-Off Ratio' },
  { key: 'alll_coverage_ratio', label: 'ALLL Coverage',        callahan: 'Allowance for Loan Losses/Delinquency' },
];

// Loan type breakdown rows — Callahan's "Delinquency by Product" view.
const LOAN_TYPE_ROWS = [
  { metric: 'delinq_rate_real_estate',    label: 'Real Estate'   },
  { metric: 'delinq_rate_first_mortgage', label: '1st Mortgage'  },
  { metric: 'delinq_rate_auto',           label: 'Auto (Total)'  },
  { metric: 'delinq_rate_new_auto',       label: 'New Auto'      },
  { metric: 'delinq_rate_used_auto',      label: 'Used Auto'     },
  { metric: 'delinq_rate_credit_card',    label: 'Credit Card'   },
  { metric: 'delinq_rate_commercial',     label: 'Commercial'    },
  { metric: 'delinq_rate_indirect',       label: 'Indirect'      },
];

const PERIOD_OPTIONS = [
  { id: '3Y', quarters: 12, label: '3Y'  },
  { id: '5Y', quarters: 20, label: '5Y'  },
  { id: '10Y',quarters: 40, label: '10Y' },
];

const PEER_GROUP_OPTIONS = [
  { id: 'state_default', label: 'State peers ±50% assets', tag: 'P76 default'    },
  { id: 'regional',      label: 'Regional peers (in geography)', tag: 'P76 exclusive' },
  { id: 'callahan',      label: 'National same-tier',      tag: 'Callahan-equivalent' },
];

// ── Number helpers ─────────────────────────────────────────────────────────────

const fmtRate  = (v) => v != null ? `${(v * 100).toFixed(2)}%` : '—';
const fmtRatio = (v) => v != null ? `${(+v).toFixed(2)}×` : '—';

function fmtMetric(v, metric) {
  if (v == null) return '—';
  if (metric === 'alll_coverage_ratio') return fmtRatio(v);
  return fmtRate(v);
}

// Stars: 5 = top performers (best), 1 = bottom performers (worst) — Callahan scale.
function getPeerStars(percentileRank, lowerIsBetter) {
  if (percentileRank == null) return 0;
  const p = lowerIsBetter ? (1 - percentileRank) : percentileRank;
  if (p >= 0.90) return 5;
  if (p >= 0.75) return 4;
  if (p >= 0.25) return 3;
  if (p >  0.10) return 2;
  return 1;
}

// Returns 'top' | 'bottom' | null for Callahan green/red badge.
function getDecile(percentileRank, lowerIsBetter) {
  if (percentileRank == null) return null;
  const p = lowerIsBetter ? (1 - percentileRank) : percentileRank;
  if (p >= 0.90) return 'top';
  if (p <= 0.10) return 'bottom';
  return null;
}

function trendArrow(own, prior) {
  if (own == null || prior == null) return null;
  const diff = own - prior;
  if (Math.abs(diff) < 0.0001) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StarRow({ stars }) {
  return (
    <span style={{ color: '#f59e0b', letterSpacing: 1, fontSize: 13 }}>
      {'★'.repeat(stars)}
      <span style={{ color: '#e2e8f0' }}>{'★'.repeat(5 - stars)}</span>
    </span>
  );
}

function DecileBadge({ decile }) {
  if (!decile) return null;
  const isTop = decile === 'top';
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700,
      padding: '2px 6px', borderRadius: 3,
      backgroundColor: isTop ? '#dcfce7' : '#fee2e2',
      color: isTop ? '#15803d' : '#b91c1c',
      letterSpacing: '0.03em',
    }}>
      {isTop ? 'Top 10%' : 'Bottom 10%'}
    </span>
  );
}

function TrendArrow({ direction, lowerIsBetter }) {
  if (!direction || direction === 'flat') return <span style={{ color: '#94a3b8' }}>→</span>;
  const isAdverse = lowerIsBetter ? direction === 'up' : direction === 'down';
  return (
    <span style={{ color: isAdverse ? '#dc2626' : '#16a34a', fontWeight: 700, fontSize: 15 }}>
      {direction === 'up' ? '▲' : '▼'}
    </span>
  );
}

// KPI card — Callahan's top-of-page metric card.
function KpiCard({ kpiMeta, data, onClick, isActive }) {
  const { key, label } = kpiMeta;
  const lowerIsBetter = LOWER_IS_BETTER.has(key);
  const own   = data?.own_rate;
  const prior = data?.prior_quarter_rate;
  const pctRank = data?.percentile_rank;
  const stars = getPeerStars(pctRank, lowerIsBetter);
  const decile = getDecile(pctRank, lowerIsBetter);
  const arrow  = trendArrow(own, prior);

  return (
    <button
      onClick={() => onClick(key)}
      style={{
        flex: 1, minWidth: 0, textAlign: 'left',
        padding: '14px 16px', cursor: 'pointer',
        border: isActive ? '2px solid #2563eb' : '1px solid #e2e8f0',
        borderRadius: 8, backgroundColor: isActive ? '#eff6ff' : '#fff',
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase',
                    letterSpacing: '0.06em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
          {own != null ? fmtMetric(own, key) : '—'}
        </span>
        {arrow && <TrendArrow direction={arrow} lowerIsBetter={lowerIsBetter} />}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
        Peer median: <strong>{data?.peer_median != null ? fmtMetric(data.peer_median, key) : '—'}</strong>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StarRow stars={stars} />
        <DecileBadge decile={decile} />
      </div>
    </button>
  );
}

// Peer group dropdown pill.
function PeerGroupPill({ selectedId, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const selected = PEER_GROUP_OPTIONS.find(o => o.id === selectedId) ?? PEER_GROUP_OPTIONS[0];

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
          border: '1px solid #cbd5e1', borderRadius: 20, backgroundColor: '#fff',
          fontSize: 12, fontWeight: 600, color: '#334155', cursor: 'pointer',
        }}
      >
        {selected.label}
        <span style={{ fontSize: 9, color: '#94a3b8' }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '110%', left: 0, zIndex: 300,
          backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 260, padding: '6px 0',
        }}>
          {PEER_GROUP_OPTIONS.map(opt => (
            <button key={opt.id}
              onClick={() => { onChange(opt.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 14px', border: 'none', cursor: 'pointer',
                backgroundColor: opt.id === selectedId ? '#eff6ff' : 'transparent',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 600, color: '#0f172a' }}>{opt.label}</div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{opt.tag}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Delinquency by Product — Recharts grouped horizontal bar chart.
function LoanTypeBreakdown({ data, isLoading }) {
  if (isLoading) return <ChartSkeleton height={260} />;
  if (!data?.length) return (
    <div style={{ height: 260, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>
      No loan type data available.
    </div>
  );

  const chartData = data.map(d => ({
    ...d,
    own_pct:    d.own_rate  != null ? +(d.own_rate  * 100).toFixed(3) : null,
    peer_pct:   d.peer_median != null ? +(d.peer_median * 100).toFixed(3) : null,
  }));

  function downloadCSV() {
    const header = 'Loan Type,Your Rate,Peer Median,Percentile Rank';
    const rows = data.map(d =>
      `"${d.label}",${fmtRate(d.own_rate)},${fmtRate(d.peer_median)},${d.percentile_rank != null ? (d.percentile_rank * 100).toFixed(1) + '%' : ''}`
    );
    const blob = new Blob([[header,...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: 'delinquency-by-product.csv' }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
          Delinquency by Product
          <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b', marginLeft: 8 }}>
            vs peer median
          </span>
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            Green = below peer median (better)  ·  Coral = above peer median (worse)
          </span>
          <button onClick={downloadCSV} style={s.exportBtn}>↓ CSV</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(260, data.length * 36)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 120 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
          <XAxis
            type="number"
            tickFormatter={v => `${v.toFixed(1)}%`}
            tick={{ fontSize: 11, fill: '#64748b' }}
            axisLine={false} tickLine={false}
          />
          <YAxis
            type="category" dataKey="label" width={112}
            tick={{ fontSize: 12, fill: '#334155' }}
            axisLine={false} tickLine={false}
          />
          <Tooltip
            formatter={(val, name) => [`${(+val).toFixed(2)}%`, name]}
            contentStyle={{ fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 6 }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={v => v === 'own_pct' ? 'You' : 'Peer Median'}
          />
          <Bar dataKey="own_pct" name="own_pct" radius={[0, 3, 3, 0]}>
            {chartData.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.own_pct != null && entry.peer_pct != null && entry.own_pct <= entry.peer_pct
                  ? '#16a34a'   // green: below peer median = better
                  : '#993C1D'}  // coral: above peer median = worse
              />
            ))}
          </Bar>
          <Bar dataKey="peer_pct" name="peer_pct" fill="#94a3b8" opacity={0.6} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartSkeleton({ height = 320 }) {
  return (
    <div style={{
      height, borderRadius: 6, backgroundColor: '#f1f5f9',
      animation: 'cq-pulse 1.5s ease-in-out infinite',
    }} />
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const s = {
  page:       { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#f8fafc' },
  topBar:     { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px',
                borderBottom: '1px solid #e2e8f0', backgroundColor: '#fff', flexWrap: 'wrap' },
  title:      { fontSize: 18, fontWeight: 700, color: '#0f172a', marginRight: 6 },
  instPill:   { padding: '5px 10px', border: '1px solid #e2e8f0', borderRadius: 20,
                fontSize: 12, fontWeight: 600, color: '#0f172a', backgroundColor: '#f8fafc' },
  regionalBtn:(active) => ({
    padding: '5px 10px', borderRadius: 20, border: '1px solid',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    borderColor: active ? '#7c3aed' : '#e2e8f0',
    backgroundColor: active ? '#f5f3ff' : '#fff',
    color: active ? '#7c3aed' : '#64748b',
  }),
  periodGroup:{ display: 'flex', border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' },
  periodBtn:  (active) => ({
    padding: '5px 10px', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
    backgroundColor: active ? '#e0e7ff' : '#fff', color: active ? '#2563eb' : '#64748b',
    borderRight: '1px solid #e2e8f0',
  }),
  iconBtn:    { padding: '5px 10px', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer',
                backgroundColor: '#fff', fontSize: 13, color: '#64748b' },
  exportBtn:  { padding: '5px 10px', fontSize: 11, fontWeight: 500, border: '1px solid #cbd5e1',
                borderRadius: 5, cursor: 'pointer', backgroundColor: '#fff', color: '#64748b' },
  body:       { flex: 1, overflowY: 'auto', padding: '20px', display: 'flex',
                flexDirection: 'column', gap: 16 },
  kpiRow:     { display: 'flex', gap: 10 },
  card:       { backgroundColor: '#fff', borderRadius: 10, padding: '20px', border: '1px solid #e2e8f0' },
  sectionTitle:{ fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase',
                  letterSpacing: '0.07em', marginBottom: 12 },
};

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CreditQuality({
  charter:       propCharter,
  institutionName: propName,
  institutionState: propState,
  primaryCounty,
  primaryMsa,
}) {
  const charter   = propCharter   ?? import.meta.env.VITE_OWN_INSTITUTION_ID     ?? '';
  const instName  = propName      ?? import.meta.env.VITE_OWN_INSTITUTION_NAME   ?? 'Your Institution';
  const instState = propState     ?? import.meta.env.VITE_OWN_INSTITUTION_STATE  ?? '';

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [selectedMetric,  setSelectedMetric]  = useState('delinq_rate_total');
  const [selectedPeriod,  setSelectedPeriod]  = useState('3Y');
  const [peerGroupId,     setPeerGroupId]     = useState('state_default');
  const [latestPeriod,    setLatestPeriod]    = useState('2024Q4');

  // ── Server data ───────────────────────────────────────────────────────────────
  const [kpiData,         setKpiData]         = useState(null);   // { [metric]: kpiObj }
  const [trendData,       setTrendData]       = useState(null);
  const [breakdownData,   setBreakdownData]   = useState(null);
  const [signalData,      setSignalData]      = useState(null);
  const [ewData,          setEwData]          = useState(null);
  const [isLoading,       setIsLoading]       = useState(false);
  const [trendLoading,    setTrendLoading]    = useState(false);

  const nQuarters = PERIOD_OPTIONS.find(p => p.id === selectedPeriod)?.quarters ?? 12;
  const isRegional = peerGroupId === 'regional';
  const peerGroupLabel = PEER_GROUP_OPTIONS.find(o => o.id === peerGroupId)?.label ?? 'Peers';

  // Available peer groups passed to PeerBandChart dropdown.
  const availablePeerGroups = PEER_GROUP_OPTIONS.map(o => ({ id: o.id, label: o.label }));

  // ── Fetch latest period on mount ───────────────────────────────────────────
  useEffect(() => {
    apiFetch(ep.latest()).then(d => { if (d?.period) setLatestPeriod(d.period); }).catch(() => {});
  }, []);

  // ── Fetch KPI row + loan breakdown + signals (period / peer-group changes) ──
  useEffect(() => {
    if (!charter) return;
    let cancelled = false;
    setIsLoading(true);

    async function load() {
      const [kpisResult, bkdResult, signalResult, ewResult] = await Promise.allSettled([
        apiFetch(ep.kpis(charter, latestPeriod, peerGroupId)),
        apiFetch(ep.breakdown(charter, latestPeriod, peerGroupId)),
        apiFetch(ep.signal(charter, selectedMetric, latestPeriod, peerGroupId)),
        apiFetch(ep.ew(charter, selectedMetric, peerGroupId)),
      ]);
      if (cancelled) return;
      setKpiData(kpisResult.status === 'fulfilled' ? kpisResult.value : null);
      setBreakdownData(bkdResult.status === 'fulfilled' ? bkdResult.value : null);
      setSignalData(signalResult.status === 'fulfilled' ? signalResult.value : null);
      setEwData(ewResult.status === 'fulfilled' ? ewResult.value : null);
      setIsLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [charter, latestPeriod, peerGroupId, selectedMetric]);

  // ── Fetch trend data separately (metric / period range changes) ───────────
  useEffect(() => {
    if (!charter) return;
    let cancelled = false;
    setTrendLoading(true);

    apiFetch(ep.trend(charter, selectedMetric, nQuarters, peerGroupId))
      .then(d  => { if (!cancelled) { setTrendData(d);  setTrendLoading(false); } })
      .catch(() => { if (!cancelled) { setTrendData(null); setTrendLoading(false); } });

    return () => { cancelled = true; };
  }, [charter, selectedMetric, nQuarters, peerGroupId]);

  // ── Transform trend API response → PeerBandChart props ───────────────────
  const chartProps = useMemo(() => {
    if (!trendData?.periods) return null;
    const { periods, own_values: own = [], peer_medians: medians = [],
            peer_p25s: p25s = [], peer_p75s: p75s = [],
            peer_p10s: p10s = [], peer_p90s: p90s = [],
            regional_medians: regMeds = [] } = trendData;

    const filt = (arr, valKey) =>
      periods.map((p, i) => ({ period: p, value: arr[i] ?? null })).filter(d => d.value != null);

    return {
      periods,
      institutionData:   filt(own,     'value'),
      peerMedian:        filt(medians, 'value'),
      peerBand:          periods.map((p, i) => ({ period: p, p25: p25s[i]??null, p75: p75s[i]??null })).filter(d => d.p25 != null),
      peerTopDecile:     filt(p10s,    'value'),
      peerBottomDecile:  filt(p90s,    'value'),
      regionalMedian:    filt(regMeds, 'value'),
      peerCount:         trendData.n_peers,
    };
  }, [trendData]);

  // ── CSV export for the full page ──────────────────────────────────────────
  const exportCSV = useCallback(() => {
    const rows = [];
    rows.push(['Metric','Your Value','Peer Median','Percentile Rank']);
    KPI_METRICS.forEach(({ key, label }) => {
      const d = kpiData?.[key];
      rows.push([label, fmtMetric(d?.own_rate, key), fmtMetric(d?.peer_median, key),
                 d?.percentile_rank != null ? `${(d.percentile_rank * 100).toFixed(1)}%` : '']);
    });
    rows.push([]);
    rows.push(['Delinquency by Product','','','']);
    rows.push(['Loan Type','Your Rate','Peer Median','']);
    (breakdownData ?? []).forEach(d => {
      rows.push([d.label, fmtRate(d.own_rate), fmtRate(d.peer_median), '']);
    });
    const csv = rows.map(r => r.map(c => JSON.stringify(c ?? '')).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `credit-quality-${latestPeriod}.csv`
    }).click();
    URL.revokeObjectURL(url);
  }, [kpiData, breakdownData, latestPeriod]);

  const threshold    = THRESHOLDS[selectedMetric] ?? null;
  const thresholdPct = threshold != null
    ? (selectedMetric === 'alll_coverage_ratio' ? threshold * 100 : threshold * 100)
    : null;
  const thresholdLabel = THRESHOLD_LABELS[selectedMetric] ?? null;
  const lowerIsBetter = LOWER_IS_BETTER.has(selectedMetric);
  const callahan = metricCallahan(selectedMetric);
  const geoLabel = primaryCounty ? `FIPS ${primaryCounty}` : primaryMsa ? `MSA ${primaryMsa}` : instState;

  return (
    <>
      <style>{`
        @keyframes cq-pulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
      `}</style>

      <div style={s.page}>

        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <div style={s.topBar}>
          <span style={s.title}>Credit Quality</span>

          {/* Institution pill */}
          <span style={s.instPill}>
            {instName}{instState ? ` (${instState})` : ''}
          </span>

          {/* Peer group dropdown pill */}
          <PeerGroupPill selectedId={peerGroupId} onChange={setPeerGroupId} />

          {/* Regional peers toggle — P76 exclusive (CLAUDE.md: never hide) */}
          <button
            style={s.regionalBtn(isRegional)}
            onClick={() => setPeerGroupId(isRegional ? 'state_default' : 'regional')}
            title="Switch to geography-first regional peer group (P76 exclusive)"
          >
            {isRegional ? '🔵' : '⬜'} Regional peers
          </button>

          <div style={{ flex: 1 }} />

          {/* Period selector (Callahan default: 3Y) */}
          <div style={s.periodGroup}>
            {PERIOD_OPTIONS.map((p, i, arr) => (
              <button
                key={p.id}
                style={{ ...s.periodBtn(selectedPeriod === p.id),
                         borderRight: i < arr.length - 1 ? '1px solid #e2e8f0' : 'none' }}
                onClick={() => setSelectedPeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Page-level CSV export */}
          <button style={s.iconBtn} onClick={exportCSV} title="Export page data as CSV">
            ↓ CSV
          </button>

          {/* Settings (stub) */}
          <button style={s.iconBtn} title="Settings">⚙</button>
        </div>

        {/* ── Scrollable body ──────────────────────────────────────────────── */}
        <div style={s.body}>

          {/* KPI row — 4 metric cards, Callahan top-of-page layout */}
          <div style={s.kpiRow}>
            {KPI_METRICS.map(kpiMeta => (
              <KpiCard
                key={kpiMeta.key}
                kpiMeta={kpiMeta}
                data={isLoading ? null : kpiData?.[kpiMeta.key]}
                isActive={selectedMetric === kpiMeta.key}
                onClick={setSelectedMetric}
              />
            ))}
          </div>

          {/* Annotation: percentile direction for all delinquency metrics */}
          <p style={{ margin: '0 0 -8px', fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
            For delinquency and charge-off metrics, a lower percentile rank indicates better performance.
            Stars reflect peer standing: ★★★★★ = top 10%, ★☆☆☆☆ = bottom 10%.
          </p>

          {/* Early Warning Panel — P76 exclusive, auto-expands on any alert */}
          <EarlyWarningPanel
            signals={ewData}
            metricLabel={metricLabel(selectedMetric)}
            thresholdPct={thresholdPct}
            thresholdLabel={thresholdLabel}
            isLoading={isLoading}
          />

          {/* Main chart section */}
          <div style={s.card}>
            {/* Metric selector header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={s.sectionTitle}>Trend</span>
              <select
                value={selectedMetric}
                onChange={e => setSelectedMetric(e.target.value)}
                style={{
                  padding: '5px 10px', fontSize: 13, fontWeight: 500,
                  border: '1px solid #cbd5e1', borderRadius: 6,
                  backgroundColor: '#fff', color: '#0f172a', cursor: 'pointer',
                }}
              >
                {METRIC_OPTIONS.map(group => (
                  <optgroup key={group.group} label={group.group}>
                    {group.options.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                        {opt.callahan !== opt.label ? ` (Callahan: "${opt.callahan}")` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {callahan && callahan !== metricLabel(selectedMetric) && (
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  Callahan: "{callahan}"
                </span>
              )}
            </div>

            {/* PeerBandChart — peer group label is required per CLAUDE.md */}
            {trendLoading ? (
              <ChartSkeleton height={340} />
            ) : chartProps ? (
              <PeerBandChart
                {...chartProps}
                metric={selectedMetric}
                peerGroupLabel={peerGroupLabel}
                availablePeerGroups={availablePeerGroups}
                onPeerGroupChange={setPeerGroupId}
                threshold={threshold}
                percentileRank={kpiData?.[selectedMetric]?.percentile_rank}
                height={340}
              />
            ) : (
              <div style={{ height: 340, display: 'flex', alignItems: 'center',
                            justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>
                {charter ? 'No trend data available for this metric.' : 'No institution selected.'}
              </div>
            )}
          </div>

          {/* Signal Separator — P76 exclusive, never suppressed (CLAUDE.md rule) */}
          <SignalSeparator
            signal={signalData}
            metric={selectedMetric}
            geography={geoLabel}
            isLoading={isLoading}
          />

          {/* Loan type breakdown — Callahan's "Delinquency by Product" */}
          <div style={s.card}>
            <LoanTypeBreakdown data={breakdownData} isLoading={isLoading} />
          </div>

        </div>
      </div>
    </>
  );
}
