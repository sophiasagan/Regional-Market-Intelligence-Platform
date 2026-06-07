/**
 * Portfolio credit quality dashboard.
 *
 * Source: NCUA 5300 Call Report (institution-level) → always "measured" confidence.
 * No geographic allocation — delinquency figures are exact regulatory submissions.
 *
 * API endpoints consumed:
 *   GET /delinquency/summary           → KPI cards
 *   GET /delinquency/trend             → Trend tab
 *   GET /delinquency/peer-distribution → Peer Distribution tab
 *   GET /delinquency/loan-breakdown    → Loan Type tab
 *   GET /delinquency/regional          → Regional Context tab
 */
import React, { useState, useEffect, useRef } from 'react';
import ConfidenceBadge from '../components/ConfidenceBadge';
import RegionalContextPanel from '../components/RegionalContextPanel';

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const OWN_ID   = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  brand:    '#2563eb',
  median:   '#475569',
  band:     'rgba(37,99,235,0.09)',
  green:    '#16a34a',
  coral:    '#ef4444',
  amber:    '#d97706',
  border:   '#e2e8f0',
  bg:       '#f8fafc',
  text:     '#0f172a',
  muted:    '#64748b',
  rowAlt:   '#fafafa',
};

// 90+ day alert threshold per CLAUDE.md default
const THRESHOLD_90PLUS = 0.015;

// ── Metric lists ──────────────────────────────────────────────────────────────
const TREND_METRICS = [
  { key: 'delinq_rate_total',       label: 'Total Delinquency' },
  { key: 'delinq_90plus_rate',      label: '90+ Day Delinquency' },
  { key: 'delinq_rate_auto',        label: 'Auto Loans' },
  { key: 'delinq_rate_real_estate', label: 'Real Estate' },
  { key: 'delinq_rate_credit_card', label: 'Credit Cards' },
  { key: 'delinq_rate_commercial',  label: 'Commercial' },
  { key: 'chargeoff_rate_total',    label: 'Charge-offs (Annualized)' },
];

const LOAN_TYPES = [
  { key: 'real_estate', label: 'Real Estate' },
  { key: 'auto',        label: 'Auto' },
  { key: 'credit_card', label: 'Credit Card' },
  { key: 'commercial',  label: 'Commercial' },
  { key: 'student',     label: 'Student' },
];

const TABS = ['Trend Analysis', 'Peer Distribution', 'Portfolio Composition', 'Regional Context'];

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtRate = (v) => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(2)}%`;
const fmtCov  = (v) => (v == null || isNaN(v)) ? '—' : `${v.toFixed(2)}x`;
const fmtPct  = (v) => (v == null || isNaN(v)) ? '—' : `${Math.round(v * 100)}th`;

// ── Quarter helpers ───────────────────────────────────────────────────────────
function recentQuarters(n = 8) {
  const d  = new Date();
  let yr   = d.getFullYear();
  let q    = Math.ceil((d.getMonth() + 1) / 3);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${yr}Q${q}`);
    if (--q < 1) { q = 4; yr--; }
  }
  return out;
}

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, params = {}) {
  const qs  = new URLSearchParams({ institution_id: OWN_ID, ...params }).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('jwt') ?? ''}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── SVG chart primitives ──────────────────────────────────────────────────────
function linePath(values, xS, yS) {
  let started = false;
  return values.map((v, i) => {
    if (v == null) { started = false; return ''; }
    const cmd = started ? 'L' : 'M';
    started = true;
    return `${cmd}${xS(i).toFixed(1)},${yS(v).toFixed(1)}`;
  }).filter(Boolean).join(' ');
}

function bandPath(lo, hi, xS, yS) {
  const top  = hi.map((v, i)  => `${i === 0 ? 'M' : 'L'}${xS(i).toFixed(1)},${yS(v ?? 0).toFixed(1)}`).join(' ');
  const back = [...lo].reverse().map((v, i) => `L${xS(lo.length - 1 - i).toFixed(1)},${yS(v ?? 0).toFixed(1)}`).join(' ');
  return `${top} ${back} Z`;
}

// ── KpiCard ───────────────────────────────────────────────────────────────────
function KpiCard({ label, value, peerMedian, percentileRank, priorValue, isCoverage = false, alert = false }) {
  const fmt      = isCoverage ? fmtCov : fmtRate;
  const delta    = value != null && priorValue != null ? value - priorValue : null;
  const trendUp  = delta != null && delta > 0;
  // For delinquency/NCO: up = worse. For coverage: down = worse.
  const isWorse  = isCoverage ? !trendUp : trendUp;
  const cvAlert  = isCoverage && value != null && value < 1.0;
  const hasAlert = alert || cvAlert;

  const rankColor = percentileRank > 0.75 ? C.coral : percentileRank > 0.50 ? C.amber : C.green;

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${hasAlert ? C.coral : C.border}`,
      borderTop: `3px solid ${hasAlert ? C.coral : C.brand}`,
      borderRadius: 10, padding: '18px 20px',
      flex: '1 1 0', minWidth: 190,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 500, lineHeight: 1.4, maxWidth: 130 }}>{label}</span>
        <ConfidenceBadge confidence="measured" showTooltip />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', color: hasAlert ? C.coral : C.text }}>
          {fmt(value)}
        </span>
        {delta != null && Math.abs(delta) > 0.0001 && (
          <span style={{ fontSize: 12, fontWeight: 600, color: isWorse ? C.coral : C.green }}>
            {trendUp ? '▲' : '▼'} {fmt(Math.abs(delta))}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: C.muted, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Peer median</span>
          <span style={{ fontWeight: 600, color: C.text }}>{fmt(peerMedian)}</span>
        </div>
        {!isCoverage && percentileRank != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Percentile rank</span>
            <span style={{ fontWeight: 600, color: rankColor }}>{fmtPct(percentileRank)} ↑risk</span>
          </div>
        )}
        {isCoverage && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Min. adequate</span>
            <span style={{ fontWeight: 600, color: cvAlert ? C.coral : C.green }}>
              1.00x {cvAlert ? '⚠ Under' : '✓'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── TrendChart ────────────────────────────────────────────────────────────────
const TP = { top: 24, right: 28, bottom: 40, left: 54 };

function TrendChart({ data, metric }) {
  const [w, setW] = useState(600);
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  if (!data) return (
    <div ref={ref} style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>
      Loading chart…
    </div>
  );

  const hasOwnData = data.own_values?.some(v => v != null);
  if (!hasOwnData) return (
    <div ref={ref} style={{ height: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.muted }}>
      <span style={{ fontSize: 15 }}>No institution-level data for this metric</span>
      <span style={{ fontSize: 12 }}>NCUA 5300 does not report per-type delinquency in a standard machine-readable field.</span>
    </div>
  );

  const { periods, own_values, peer_median, peer_p25, peer_p75 } = data;
  const n     = periods.length;
  const H     = 264;
  const cW    = w - TP.left - TP.right;
  const cH    = H - TP.top - TP.bottom;
  const allV  = [...own_values, ...peer_median, ...peer_p75].filter(v => v != null);
  const maxV  = (Math.max(...allV) || 0.05) * 1.18;
  const xS    = (i) => TP.left + (n < 2 ? cW / 2 : (i / (n - 1)) * cW);
  const yS    = (v) => TP.top + cH - Math.max(0, (v / maxV) * cH);
  const yTick = Array.from({ length: 5 }, (_, i) => (i / 4) * maxV);

  // Flag crossings: own crosses peer_median or the 90+ threshold
  const flags = [];
  for (let i = 1; i < n; i++) {
    if (
      own_values[i - 1] != null && own_values[i] != null &&
      peer_median[i - 1] != null && peer_median[i] != null
    ) {
      const prevAbove = own_values[i - 1] > peer_median[i - 1];
      const currAbove = own_values[i] > peer_median[i];
      if (prevAbove !== currAbove) flags.push({ i, color: C.amber, label: currAbove ? '▲ peer' : '▼ peer' });
    }
    if (metric === 'delinq_90plus_rate' && own_values[i - 1] != null && own_values[i] != null) {
      const prev = own_values[i - 1] > THRESHOLD_90PLUS;
      const curr = own_values[i] > THRESHOLD_90PLUS;
      if (prev !== curr) flags.push({ i, color: C.coral, label: curr ? '▲ alert' : '▼ alert' });
    }
  }

  return (
    <div ref={ref}>
      <svg width={w} height={H} style={{ overflow: 'visible', display: 'block' }}>
        {/* Y grid */}
        {yTick.map((v, i) => (
          <g key={i}>
            <line x1={TP.left} x2={w - TP.right} y1={yS(v)} y2={yS(v)} stroke="#e8edf2" strokeWidth={1} />
            <text x={TP.left - 7} y={yS(v)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={C.muted}>
              {fmtRate(v)}
            </text>
          </g>
        ))}

        {/* Alert threshold (90+ tab only) */}
        {metric === 'delinq_90plus_rate' && (
          <>
            <line x1={TP.left} x2={w - TP.right} y1={yS(THRESHOLD_90PLUS)} y2={yS(THRESHOLD_90PLUS)}
              stroke={C.coral} strokeWidth={1} strokeDasharray="3,3" />
            <text x={w - TP.right + 4} y={yS(THRESHOLD_90PLUS)} fontSize={9} fill={C.coral} dominantBaseline="middle">
              Alert
            </text>
          </>
        )}

        {/* Crossing flags */}
        {flags.map((f, idx) => (
          <g key={idx}>
            <line x1={xS(f.i)} x2={xS(f.i)} y1={TP.top} y2={H - TP.bottom} stroke={f.color} strokeWidth={1} strokeDasharray="2,3" opacity={0.55} />
            <text x={xS(f.i)} y={TP.top - 6} textAnchor="middle" fontSize={8} fill={f.color}>{f.label}</text>
          </g>
        ))}

        {/* P25–P75 band */}
        <path d={bandPath(peer_p25, peer_p75, xS, yS)} fill={C.band} />

        {/* Peer median */}
        <path d={linePath(peer_median, xS, yS)} fill="none" stroke={C.median} strokeWidth={1.5} strokeDasharray="5,3" />

        {/* Own line */}
        <path d={linePath(own_values, xS, yS)} fill="none" stroke={C.brand} strokeWidth={2.5} />

        {/* Own dots */}
        {own_values.map((v, i) => v != null && (
          <circle key={i} cx={xS(i)} cy={yS(v)} r={3.5} fill={C.brand} />
        ))}

        {/* X labels */}
        {periods.map((p, i) => (
          <text key={i} x={xS(i)} y={H - 6} textAnchor="middle" fontSize={9} fill={C.muted}>{p}</text>
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 18, marginTop: 6, paddingLeft: TP.left, fontSize: 11, color: C.muted, flexWrap: 'wrap' }}>
        <LegendItem color={C.brand} solid label="Your institution" />
        <LegendItem color={C.median} dashed label="Peer median" />
        <LegendItem color={C.band} rect label="P25–P75 band" />
      </div>
    </div>
  );
}

function LegendItem({ color, solid, dashed, rect, label }) {
  const swatchStyle = rect
    ? { width: 14, height: 10, background: color, border: '1px solid rgba(37,99,235,0.2)', borderRadius: 2, display: 'inline-block', verticalAlign: 'middle', marginRight: 5 }
    : { display: 'inline-block', width: 16, height: 0, border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, verticalAlign: 'middle', marginRight: 5 };
  return <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={swatchStyle} />{label}</span>;
}

// ── PeerDistributionChart (box plot) ──────────────────────────────────────────
function PeerDistributionChart({ data }) {
  const [w, setW] = useState(560);
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  if (!data) return (
    <div ref={ref} style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>
      Loading…
    </div>
  );

  const { distribution: d, own_value, own_percentile_rank } = data;
  const H   = 120;
  const PAD = { top: 20, right: 64, bottom: 32, left: 64 };
  const cW  = w - PAD.left - PAD.right;
  const bxY = PAD.top + 6;
  const bxH = H - PAD.top - PAD.bottom - 10;
  const midY = bxY + bxH / 2;

  const allV = [d.p10, d.p25, d.median, d.p75, d.p90, own_value].filter(v => v != null && !isNaN(v));
  const maxV = (Math.max(...allV) || 0.05) * 1.2;
  const xS   = (v) => PAD.left + (v / maxV) * cW;

  const ticks = Array.from({ length: 5 }, (_, i) => (i / 4) * maxV);

  const rankColor = own_percentile_rank > 0.75 ? C.coral : own_percentile_rank > 0.50 ? C.amber : C.green;

  return (
    <div ref={ref}>
      <svg width={w} height={H} style={{ overflow: 'visible', display: 'block' }}>
        {/* X ticks */}
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={xS(v)} x2={xS(v)} y1={bxY} y2={bxY + bxH + 6} stroke="#e8edf2" strokeWidth={1} />
            <text x={xS(v)} y={H - 4} textAnchor="middle" fontSize={10} fill={C.muted}>{fmtRate(v)}</text>
          </g>
        ))}

        {/* Whisker spine (p10 → p90) */}
        <line x1={xS(d.p10)} x2={xS(d.p90)} y1={midY} y2={midY} stroke={C.median} strokeWidth={1.5} />
        {/* Whisker end caps */}
        {[d.p10, d.p90].map((v, i) => v != null && (
          <line key={i} x1={xS(v)} x2={xS(v)} y1={bxY + 10} y2={bxY + bxH - 10} stroke={C.median} strokeWidth={1.5} />
        ))}

        {/* IQR box (p25–p75) */}
        <rect
          x={xS(d.p25)} y={bxY + 5}
          width={Math.max(0, xS(d.p75) - xS(d.p25))} height={bxH - 10}
          fill={C.band} stroke={C.median} strokeWidth={1.5} rx={2}
        />

        {/* Median bar */}
        <line x1={xS(d.median)} x2={xS(d.median)} y1={bxY + 3} y2={bxY + bxH - 3} stroke={C.median} strokeWidth={3} />

        {/* Mean dot */}
        {d.mean != null && (
          <circle cx={xS(d.mean)} cy={midY} r={3} fill={C.median} opacity={0.45} />
        )}

        {/* Own institution marker */}
        {own_value != null && (
          <g>
            <line x1={xS(own_value)} x2={xS(own_value)} y1={bxY} y2={bxY + bxH} stroke={C.brand} strokeWidth={2.5} />
            <polygon
              points={`${xS(own_value)},${bxY - 2} ${xS(own_value) - 5},${bxY - 11} ${xS(own_value) + 5},${bxY - 11}`}
              fill={C.brand}
            />
            <text x={xS(own_value)} y={bxY - 14} textAnchor="middle" fontSize={9} fill={C.brand} fontWeight={700}>You</text>
          </g>
        )}

        {/* Percentile labels below */}
        {[['p10','P10'], ['p25','P25'], ['p75','P75'], ['p90','P90']].map(([k, lbl]) => d[k] != null && (
          <text key={k} x={xS(d[k])} y={H - 2} textAnchor="middle" fontSize={8} fill={C.muted} opacity={0.65}>{lbl}</text>
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 14, fontSize: 12, color: C.muted }}>
        <span>n = <strong style={{ color: C.text }}>{d.n_institutions}</strong> peers</span>
        <span>Median <strong style={{ color: C.text }}>{fmtRate(d.median)}</strong></span>
        <span>P25–P75 <strong style={{ color: C.text }}>{fmtRate(d.p25)}–{fmtRate(d.p75)}</strong></span>
        {own_percentile_rank != null && (
          <span style={{ fontWeight: 700, color: rankColor }}>
            You: {fmtPct(own_percentile_rank)} percentile
            <span style={{ fontWeight: 400, color: C.muted }}> (higher = more risk)</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ── PeerTable ─────────────────────────────────────────────────────────────────
function PeerTable({ peers, anonymize }) {
  if (!peers?.length) return null;
  const sorted = [...peers].sort((a, b) => (a.value ?? 0) - (b.value ?? 0));

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        Peer institutions — sorted by rate{anonymize ? ' (names anonymized)' : ''}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${C.border}` }}>
            <th style={TH}>#</th>
            <th style={TH}>Institution</th>
            <th style={{ ...TH, textAlign: 'right' }}>Rate</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((peer, idx) => (
            <tr key={peer.charter_number ?? idx} style={{ background: peer.is_own ? '#eff6ff' : idx % 2 === 0 ? '#fff' : C.rowAlt, borderBottom: `1px solid ${C.border}` }}>
              <td style={{ ...TD, color: C.muted, width: 32 }}>{idx + 1}</td>
              <td style={{ ...TD, fontWeight: peer.is_own ? 700 : 400, color: peer.is_own ? C.brand : C.text }}>
                {peer.is_own ? '▶ ' : ''}
                {anonymize && !peer.is_own ? `Peer ${String.fromCharCode(65 + (idx % 26))}` : (peer.name ?? 'Unknown')}
              </td>
              <td style={{ ...TD, textAlign: 'right', fontWeight: peer.is_own ? 700 : 400, color: peer.is_own ? C.brand : C.text }}>
                {fmtRate(peer.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── LoanTypeChart (portfolio composition) ─────────────────────────────────────
// Shows % of total loans by category vs peer median.
// Per-type delinquency is not available in NCUA 5300 bulk data.
function LoanTypeChart({ data }) {
  const hasData = data?.loan_types?.some(lt => lt.own_share != null);
  if (!data?.loan_types?.length || !hasData) return (
    <div style={{ padding: 32, textAlign: 'center', color: C.muted }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>No portfolio data available</div>
      <div style={{ fontSize: 12 }}>Loan balance data could not be loaded for this period.</div>
    </div>
  );

  const fmtShare = (v) => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(1)}%`;

  const { loan_types } = data;
  const BAR_W   = 22;
  const GAP     = 6;
  const GROUP   = 32;
  const GROUP_W = BAR_W * 2 + GAP;
  const PAD     = { top: 32, right: 20, bottom: 56, left: 54 };
  const H       = 240;
  const totalW  = PAD.left + loan_types.length * (GROUP_W + GROUP) + PAD.right;
  const cH      = H - PAD.top - PAD.bottom;
  const maxV    = Math.max(
    ...loan_types.flatMap(lt => [lt.own_share ?? 0, lt.peer_median ?? 0]),
    0.05
  ) * 1.15;
  const yS    = (v) => PAD.top + cH - (v / maxV) * cH;
  const yTick = Array.from({ length: 5 }, (_, i) => (i / 4) * maxV);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>Loan Portfolio Composition</div>
        <div style={{ fontSize: 12, color: C.muted }}>
          Share of total loans by category — your institution vs peer median.
          Overweight in a category means higher concentration if that segment faces stress.
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg width={totalW} height={H} style={{ display: 'block' }}>
          {yTick.map((v, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={totalW - PAD.right} y1={yS(v)} y2={yS(v)} stroke="#e8edf2" strokeWidth={1} />
              <text x={PAD.left - 7} y={yS(v)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={C.muted}>
                {fmtShare(v)}
              </text>
            </g>
          ))}

          {loan_types.map((lt, i) => {
            const gx         = PAD.left + i * (GROUP_W + GROUP);
            const overweight = lt.own_share != null && lt.peer_median != null && lt.own_share > lt.peer_median * 1.2;
            const ownColor   = overweight ? C.amber : C.brand;
            const ownH       = lt.own_share != null ? (lt.own_share / maxV) * cH : 0;
            const medH       = lt.peer_median != null ? (lt.peer_median / maxV) * cH : 0;

            return (
              <g key={lt.key ?? i}>
                {lt.own_share != null && (
                  <>
                    <rect x={gx} y={yS(lt.own_share)} width={BAR_W} height={ownH} fill={ownColor} rx={2} opacity={0.9} />
                    <text x={gx + BAR_W / 2} y={yS(lt.own_share) - 4} textAnchor="middle" fontSize={8.5} fill={ownColor} fontWeight={700}>
                      {fmtShare(lt.own_share)}
                    </text>
                  </>
                )}
                {lt.peer_median != null && (
                  <>
                    <rect x={gx + BAR_W + GAP} y={yS(lt.peer_median)} width={BAR_W} height={medH}
                      fill={C.band} stroke={C.median} strokeWidth={1.5} rx={2} />
                    <text x={gx + BAR_W + GAP + BAR_W / 2} y={yS(lt.peer_median) - 4} textAnchor="middle" fontSize={8} fill={C.muted}>
                      {fmtShare(lt.peer_median)}
                    </text>
                  </>
                )}
                <text x={gx + GROUP_W / 2} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill={C.muted}>
                  {lt.label}
                </text>
                {overweight && (
                  <text x={gx + GROUP_W / 2} y={H - PAD.bottom + 26} textAnchor="middle" fontSize={9} fill={C.amber} fontWeight={600}>
                    ▲ overweight
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <div style={{ display: 'flex', gap: 20, marginTop: 4, paddingLeft: PAD.left, fontSize: 11, color: C.muted, flexWrap: 'wrap' }}>
          <LegendItem color={C.brand} solid label="Your institution" />
          <LegendItem color={C.amber} solid label="Overweight vs peers (>120% of peer median)" />
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span style={{ display: 'inline-block', width: BAR_W, height: 10, background: C.band, border: `1.5px solid ${C.median}`, borderRadius: 2, marginRight: 5 }} />
            Peer median
          </span>
        </div>
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: C.muted, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
        Source: NCUA 5300 Call Report · Loan balances as reported · Per-type delinquency rates are not available in NCUA bulk data.
      </div>
    </div>
  );
}

// ── RegionalContextView ───────────────────────────────────────────────────────
function RegionalContextView({ data }) {
  if (!data?.institutions?.length) return (
    <div style={{ padding: 32, textAlign: 'center', color: C.muted }}>No regional data available.</div>
  );

  const { geography_label, market_median, institutions } = data;
  const sorted  = [...institutions].sort((a, b) => (a.delinq_rate ?? 0) - (b.delinq_rate ?? 0));
  const maxRate = Math.max(...sorted.map(i => i.delinq_rate ?? 0)) || 0.05;
  const ownRate = institutions.find(i => i.is_own)?.delinq_rate;
  const aboveMarket = ownRate != null && market_median != null && ownRate > market_median;

  return (
    <div>
      {/* Context banner */}
      <div style={{ background: aboveMarket ? '#fff7ed' : '#f0fdf4', border: `1px solid ${aboveMarket ? '#fed7aa' : '#bbf7d0'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
        <strong>{geography_label}</strong>
        {' — '}market median: <strong>{fmtRate(market_median)}</strong>
        {ownRate != null && (
          <span style={{ marginLeft: 12, color: aboveMarket ? C.coral : C.green }}>
            {aboveMarket
              ? `Your institution is ${fmtRate(ownRate - market_median)} above market median — institution-specific pattern.`
              : `Your institution is ${fmtRate(market_median - ownRate)} below market median — performing well vs local market.`
            }
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.border}` }}>
              <th style={TH}>Institution</th>
              <th style={{ ...TH, textAlign: 'right', width: 90 }}>Delinq. Rate</th>
              <th style={{ ...TH, width: '45%' }}>vs Market</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((inst, idx) => {
              const pct      = maxRate > 0 ? (inst.delinq_rate ?? 0) / maxRate : 0;
              const medPct   = maxRate > 0 ? (market_median ?? 0) / maxRate : 0;
              const aboveMed = inst.delinq_rate > market_median;
              const barColor = inst.is_own ? C.brand : aboveMed ? C.coral : '#94a3b8';

              return (
                <tr key={inst.charter_number ?? idx} style={{ background: inst.is_own ? '#eff6ff' : idx % 2 === 0 ? '#fff' : C.rowAlt, borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ ...TD, fontWeight: inst.is_own ? 700 : 400, color: inst.is_own ? C.brand : C.text }}>
                    {inst.is_own ? '▶ ' : ''}{inst.name ?? 'Institution'}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: inst.is_own ? 700 : 400, color: inst.is_own ? C.brand : C.text }}>
                    {fmtRate(inst.delinq_rate)}
                  </td>
                  <td style={{ ...TD }}>
                    {/* Inline bar with median reference line */}
                    <div style={{ position: 'relative', height: 12, background: '#f1f5f9', borderRadius: 3 }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct * 100}%`, background: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
                      <div style={{ position: 'absolute', left: `${medPct * 100}%`, top: 0, width: 1.5, height: '100%', background: C.median, opacity: 0.7 }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>
        Vertical line = market median · Blue bar = your institution · Red = above market median
      </div>
    </div>
  );
}

// ── Shared table styles ───────────────────────────────────────────────────────
const TH = {
  padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600,
  color: C.muted, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
};
const TD = { padding: '8px 10px', verticalAlign: 'middle' };

// ── ErrorBanner ───────────────────────────────────────────────────────────────
function ErrorBanner({ msg }) {
  return (
    <div style={{ background: '#fee2e2', border: `1px solid ${C.coral}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#991b1b' }}>
      Failed to load data: {msg}
    </div>
  );
}

// ── DelinquencyDashboard ──────────────────────────────────────────────────────
export default function DelinquencyDashboard() {
  const quarters = recentQuarters(8);
  const [period,      setPeriod]      = useState(quarters[quarters.length - 1]);
  const [activeTab,   setActiveTab]   = useState(0);
  const [trendMetric, setTrendMetric] = useState('delinq_rate_total');
  const [distMetric,  setDistMetric]  = useState('delinq_rate_total');
  const [peerType,    setPeerType]    = useState('regional');
  const [anonymize,   setAnonymize]   = useState(false);

  const [summary,   setSummary]   = useState(null);
  const [trendData, setTrendData] = useState(null);
  const [distData,  setDistData]  = useState(null);
  const [loanData,  setLoanData]  = useState(null);

  const [loading, setLoading] = useState({});
  const [errors,  setErrors]  = useState({});

  const load = (key, promise) => {
    setLoading(p => ({ ...p, [key]: true }));
    setErrors(p => ({ ...p, [key]: null }));
    promise
      .then(d => {
        if (key === 'summary')  setSummary(d);
        if (key === 'trend')    setTrendData(d);
        if (key === 'dist')     setDistData(d);
        if (key === 'loan')     setLoanData(d);
      })
      .catch(e => setErrors(p => ({ ...p, [key]: e.message })))
      .finally(() => setLoading(p => ({ ...p, [key]: false })));
  };

  // Summary — reload on period change
  useEffect(() => {
    load('summary', apiFetch('/delinquency/summary', { period }));
  }, [period]);

  // Trend tab
  useEffect(() => {
    if (activeTab !== 0) return;
    load('trend', apiFetch('/delinquency/trend', { period, metric: trendMetric, n_periods: 8 }));
  }, [activeTab, period, trendMetric]);

  // Peer distribution tab
  useEffect(() => {
    if (activeTab !== 1) return;
    load('dist', apiFetch('/delinquency/peer-distribution', { period, metric: distMetric, peer_type: peerType }));
  }, [activeTab, period, distMetric, peerType]);

  // Loan breakdown tab
  useEffect(() => {
    if (activeTab !== 2) return;
    load('loan', apiFetch('/delinquency/loan-breakdown', { period }));
  }, [activeTab, period]);

  const m = summary?.metrics ?? {};

  return (
    <div style={{ fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, maxWidth: 1200, margin: '0 auto', padding: '0 20px 48px' }}>

      {/* TopBar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 0 16px', borderBottom: `1px solid ${C.border}`, marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>Portfolio Credit Quality</h1>
          {summary?.institution_name && (
            <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>{summary.institution_name}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Period</label>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            style={{ fontSize: 13, padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, background: '#fff', cursor: 'pointer' }}
          >
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
          {loading.summary && <span style={{ fontSize: 11, color: C.muted }}>Updating…</span>}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
        <KpiCard
          label="Total Delinquency Rate"
          value={m.delinq_rate_total?.value}
          peerMedian={m.delinq_rate_total?.peer_median}
          percentileRank={m.delinq_rate_total?.percentile_rank}
          priorValue={m.delinq_rate_total?.prior_value}
          alert={m.delinq_rate_total?.value > 0.015}
        />
        <KpiCard
          label="90+ Day Rate"
          value={m.delinq_90plus_rate?.value}
          peerMedian={m.delinq_90plus_rate?.peer_median}
          percentileRank={m.delinq_90plus_rate?.percentile_rank}
          priorValue={m.delinq_90plus_rate?.prior_value}
          alert={m.delinq_90plus_rate?.value > THRESHOLD_90PLUS}
        />
        <KpiCard
          label="Net Charge-off Rate (Ann.)"
          value={m.chargeoff_rate_total?.value}
          peerMedian={m.chargeoff_rate_total?.peer_median}
          percentileRank={m.chargeoff_rate_total?.percentile_rank}
          priorValue={m.chargeoff_rate_total?.prior_value}
        />
        <KpiCard
          label="ALLL Coverage Ratio"
          value={m.alll_coverage_ratio?.value}
          peerMedian={m.alll_coverage_ratio?.peer_median}
          priorValue={m.alll_coverage_ratio?.prior_value}
          isCoverage
        />
      </div>

      {errors.summary && <ErrorBanner msg={errors.summary} />}

      {/* Main chart panel */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, background: C.bg, overflowX: 'auto' }}>
          {TABS.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveTab(i)}
              style={{
                padding: '12px 20px', border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: activeTab === i ? `2.5px solid ${C.brand}` : '2.5px solid transparent',
                fontSize: 13, fontWeight: activeTab === i ? 600 : 400,
                color: activeTab === i ? C.brand : C.muted,
                whiteSpace: 'nowrap', transition: 'color 0.15s',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        <div style={{ padding: '24px 28px' }}>

          {/* Tab 0: Trend Analysis */}
          {activeTab === 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>8-Quarter Trend</span>
                <select
                  value={trendMetric}
                  onChange={e => setTrendMetric(e.target.value)}
                  style={{ fontSize: 13, padding: '5px 10px', border: `1px solid ${C.border}`, borderRadius: 6, background: '#fff' }}
                >
                  {TREND_METRICS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
                </select>
              </div>
              {loading.trend
                ? <div style={{ height: 264, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>Loading…</div>
                : errors.trend
                  ? <ErrorBanner msg={errors.trend} />
                  : <TrendChart data={trendData} metric={trendMetric} />
              }
            </div>
          )}

          {/* Tab 1: Peer Distribution */}
          {activeTab === 1 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Distribution vs Peer Group</span>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select
                    value={distMetric}
                    onChange={e => setDistMetric(e.target.value)}
                    style={{ fontSize: 13, padding: '5px 10px', border: `1px solid ${C.border}`, borderRadius: 6, background: '#fff' }}
                  >
                    {TREND_METRICS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
                  </select>

                  {/* Regional / National toggle */}
                  <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                    {['regional', 'national'].map(pt => (
                      <button
                        key={pt}
                        onClick={() => setPeerType(pt)}
                        style={{
                          padding: '5px 12px', border: 'none', cursor: 'pointer', fontSize: 12,
                          background: peerType === pt ? C.brand : '#fff',
                          color: peerType === pt ? '#fff' : C.muted,
                          fontWeight: peerType === pt ? 600 : 400,
                        }}
                      >
                        {pt.charAt(0).toUpperCase() + pt.slice(1)}
                      </button>
                    ))}
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                    <input type="checkbox" checked={anonymize} onChange={e => setAnonymize(e.target.checked)} />
                    Anonymize peers
                  </label>
                </div>
              </div>
              {loading.dist
                ? <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>Loading…</div>
                : errors.dist
                  ? <ErrorBanner msg={errors.dist} />
                  : (
                    <>
                      <PeerDistributionChart data={distData} />
                      {distData && <PeerTable peers={distData.peers ?? []} anonymize={anonymize} />}
                    </>
                  )
              }
            </div>
          )}

          {/* Tab 2: Portfolio Composition */}
          {activeTab === 2 && (
            <div>
              {loading.loan
                ? <div style={{ height: 224, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted }}>Loading…</div>
                : errors.loan
                  ? <ErrorBanner msg={errors.loan} />
                  : <LoanTypeChart data={loanData} />
              }
            </div>
          )}

          {/* Tab 3: Regional Context */}
          {activeTab === 3 && (
            <RegionalContextPanel
              period={period}
              geographyType={summary?.primary_geography?.type}
              geographyId={summary?.primary_geography?.id}
            />
          )}
        </div>
      </div>

      {/* Data footnote */}
      <div style={{ marginTop: 16, fontSize: 11, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10, lineHeight: 1.7 }}>
        Source: NCUA 5300 Call Report — institution-level data, no geographic estimation applied.
        All figures carry <strong>Measured</strong> confidence.
        Rates shown as decimal fractions (0.02 = 2%).
        Charge-off rate annualized: quarterly NCO × 4.
        Default peer group: same state, ±50% total assets. Regional peers: same county/MSA via branch presence.
      </div>
    </div>
  );
}
