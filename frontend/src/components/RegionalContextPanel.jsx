/**
 * RegionalContextPanel — "Is this a us problem or a market problem?"
 *
 * Shows all institutions with branch presence in a county/MSA, sorted by
 * total delinquency rate. Claude-generated interpretation classifies the
 * pattern as regional stress vs institution-specific. P37 economic signals
 * overlaid when available.
 *
 * API endpoint:
 *   GET /delinquency/regional/context
 *     ?geography_type=county&geography_id=12086&period=2024Q4
 *
 * Response shape — see InstitutionRecord and ContextResponse types below.
 * Interpretation is cached server-side, refreshed when new NCUA data is
 * published (quarterly). Claude call happens in the API layer, not here.
 */
import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  own:         '#2563eb',   // brand blue  — your institution
  cu:          '#0d9488',   // teal        — other credit unions
  bank:        '#94a3b8',   // slate gray  — banks
  median:      '#475569',
  border:      '#e2e8f0',
  text:        '#0f172a',
  muted:       '#64748b',
  bg:          '#f8fafc',
  rowOwn:      '#eff6ff',
  rowAlt:      '#fafafa',
  stress:      { bg: '#fffbeb', border: '#fcd34d', text: '#92400e', dot: '#d97706' },
  specific:    { bg: '#f0fdfa', border: '#5eead4', text: '#0f766e', dot: '#0d9488' },
  mixed:       { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', dot: '#2563eb' },
  sigGood:     { bg: '#f0fdf4', border: '#86efac', text: '#166534' },
  sigBad:      { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412' },
  sigNeutral:  { bg: '#f8fafc', border: '#cbd5e1', text: '#475569' },
};

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtRate  = (v)  => (v == null || isNaN(v)) ? '—' : `${(v * 100).toFixed(2)}%`;
const fmtDelta = (v)  => (v == null || isNaN(v)) ? '' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;
const truncate = (s, n = 28) => s?.length > n ? s.slice(0, n - 1) + '…' : (s ?? '');

// ── Constants ─────────────────────────────────────────────────────────────────
const ROW_H  = 32;   // px per institution row in SVG
const BAR_H  = 16;   // bar height
const LBL_W  = 210;  // label column width  (name + trend arrow)
const VAL_W  = 48;   // rate value column after bar

function typeColor(inst) {
  if (inst.is_own)                           return C.own;
  if (inst.institution_type === 'bank')      return C.bank;
  return C.cu;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchContext(geographyType, geographyId, period) {
  const raw = { period };
  if (geographyId) { raw.geography_type = geographyType; raw.geography_id = geographyId; }
  const params = new URLSearchParams(raw);
  const res    = await fetch(`${API_BASE}/delinquency/regional/context?${params}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('jwt') ?? ''}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── BarChart ──────────────────────────────────────────────────────────────────
// Pure SVG horizontal bar chart. Width is responsive via ResizeObserver.
function BarChart({ institutions, institutionMedian }) {
  const [w, setW]   = useState(640);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const sorted = [...institutions].sort((a, b) => (a.delinq_rate ?? 0) - (b.delinq_rate ?? 0));
  const n      = sorted.length;
  const H      = n * ROW_H + 28;   // 28 = x-axis area
  const BAR_W  = w - LBL_W - VAL_W - 16;
  const maxV   = Math.max(...sorted.map(i => i.delinq_rate ?? 0), institutionMedian ?? 0) * 1.15 || 0.05;
  const xS     = (v) => LBL_W + (v / maxV) * BAR_W;
  const xTicks = Array.from({ length: 5 }, (_, i) => (i / 4) * maxV);

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg width={w} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <clipPath id="rc-label-clip">
            <rect x={24} y={0} width={LBL_W - 30} height={H} />
          </clipPath>
        </defs>

        {/* X-axis grid lines and tick labels */}
        {xTicks.map((v, i) => (
          <g key={i}>
            <line x1={xS(v)} x2={xS(v)} y1={0} y2={n * ROW_H} stroke="#e8edf2" strokeWidth={1} />
            <text x={xS(v)} y={H - 6} textAnchor="middle" fontSize={9.5} fill={C.muted}>{fmtRate(v)}</text>
          </g>
        ))}

        {/* Median reference line — drawn behind rows */}
        {institutionMedian != null && (
          <line
            x1={xS(institutionMedian)} x2={xS(institutionMedian)}
            y1={0} y2={n * ROW_H}
            stroke={C.median} strokeWidth={1.5} strokeDasharray="4,3"
          />
        )}

        {/* Institution rows */}
        {sorted.map((inst, idx) => {
          const rowY    = idx * ROW_H;
          const midY    = rowY + ROW_H / 2;
          const barY    = rowY + (ROW_H - BAR_H) / 2;
          const barW    = inst.delinq_rate != null ? (inst.delinq_rate / maxV) * BAR_W : 0;
          const color   = typeColor(inst);
          const trendArrow = inst.trend === 'rising' ? '↑' : inst.trend === 'falling' ? '↓' : '→';
          const trendColor = inst.trend === 'rising' ? '#ef4444' : inst.trend === 'falling' ? '#16a34a' : C.muted;

          return (
            <g key={inst.charter_or_cert ?? idx}>
              {/* Row background */}
              <rect
                x={0} y={rowY}
                width={w} height={ROW_H}
                fill={inst.is_own ? C.rowOwn : idx % 2 === 0 ? '#fff' : C.rowAlt}
              />

              {/* Institution type dot */}
              <circle cx={10} cy={midY} r={4} fill={color} />

              {/* Trend arrow */}
              <text x={20} y={midY + 1} fontSize={11} fill={trendColor} dominantBaseline="middle" fontWeight={700}>
                {trendArrow}
              </text>

              {/* Institution name */}
              <text
                x={34} y={midY} fontSize={11}
                fill={inst.is_own ? C.own : C.text}
                fontWeight={inst.is_own ? 700 : 400}
                dominantBaseline="middle"
                clipPath="url(#rc-label-clip)"
              >
                {truncate(inst.is_own ? `▶ ${inst.name}` : inst.name, 26)}
              </text>

              {/* Bar */}
              <rect x={LBL_W} y={barY} width={barW} height={BAR_H} fill={color} rx={3} opacity={inst.is_own ? 1 : 0.72} />

              {/* Rate value */}
              <text x={LBL_W + barW + 6} y={midY} fontSize={10} fill={color} fontWeight={inst.is_own ? 700 : 500} dominantBaseline="middle">
                {fmtRate(inst.delinq_rate)}
              </text>
            </g>
          );
        })}

        {/* Median label at top */}
        {institutionMedian != null && (
          <text x={xS(institutionMedian)} y={14} textAnchor="middle" fontSize={9} fill={C.median} fontWeight={600}>
            Median
          </text>
        )}
      </svg>
    </div>
  );
}

// ── TrendSparkline ────────────────────────────────────────────────────────────
// Tiny 3-quarter trend within the interpretation card.
function TrendSparkline({ data, color = C.own, label }) {
  if (!data?.length) return null;
  const W = 48, H = 20;
  const minV = Math.min(...data);
  const maxV = Math.max(...data);
  const span = maxV - minV || 0.001;
  const x = (i) => (i / (data.length - 1)) * (W - 4) + 2;
  const y = (v) => H - 3 - ((v - minV) / span) * (H - 6);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return (
    <span title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}>
      <svg width={W} height={H}>
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2} fill={color} />
      </svg>
    </span>
  );
}

// ── EconomySignalChip ─────────────────────────────────────────────────────────
function EconomySignalChip({ signal }) {
  // Determine if the signal is stress-indicating for credit quality
  const isStress =
    (signal.key === 'employer_hiring'   && signal.trend === 'declining') ||
    (signal.key === 'business_closures' && signal.trend === 'rising')    ||
    (signal.key === 'permit_activity'   && signal.trend === 'declining');

  const palette = isStress ? C.sigBad : signal.trend === 'stable' ? C.sigNeutral : C.sigGood;
  const arrow   = signal.trend === 'rising' ? '↑' : signal.trend === 'declining' ? '↓' : '→';
  const creditArrow = isStress ? '↑ credit risk' : '↓ credit risk';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      background: palette.bg, border: `1px solid ${palette.border}`,
      borderRadius: 8, padding: '10px 14px', flex: '1 1 0', minWidth: 130,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: palette.text, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {signal.label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: palette.text }}>
        {arrow} {signal.description_short ?? (signal.value != null ? `${(Math.abs(signal.value) * 100).toFixed(0)}%` : '—')}
      </div>
      <div style={{ fontSize: 10, color: palette.text, opacity: 0.8 }}>
        {signal.description ?? ''} · {creditArrow}
      </div>
    </div>
  );
}

// ── InterpretationCard ────────────────────────────────────────────────────────
// Renders the Claude-generated narrative with color-coded type badge.
function InterpretationCard({ interpretation, data }) {
  const TYPE_META = {
    regional_stress:      { label: 'Regional Stress Signal Detected', palette: C.stress,   icon: '⚠' },
    institution_specific: { label: 'Institution-Specific Pattern',    palette: C.specific,  icon: '◎' },
    mixed:                { label: 'Mixed Signals',                   palette: C.mixed,     icon: '◑' },
    healthy:              { label: 'No Elevated Risk Detected',       palette: C.specific,  icon: '✓' },
  };

  const meta    = TYPE_META[interpretation.type] ?? TYPE_META.mixed;
  const palette = meta.palette;

  // Rising-institution count for the prominent stat
  const nRising = data?.n_rising_3q;
  const nTotal  = data?.n_total;

  return (
    <div style={{
      border: `1.5px solid ${palette.border}`,
      borderLeft: `4px solid ${palette.dot}`,
      borderRadius: 10,
      background: palette.bg,
      padding: '16px 18px',
    }}>
      {/* Type badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: palette.dot, color: '#fff',
        }}>
          {meta.icon} {meta.label}
        </span>
        {nRising != null && nTotal != null && (
          <span style={{ fontSize: 12, color: palette.text, fontWeight: 500 }}>
            <strong>{nRising}</strong> of <strong>{nTotal}</strong> institutions rising over 3 quarters
          </span>
        )}
      </div>

      {/* Narrative */}
      <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.7, color: palette.text }}>
        {interpretation.narrative}
      </p>

      {/* Footer: own trend sparkline + refresh timestamp */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        {data?.own_prior_rates?.length >= 2 && (
          <span style={{ fontSize: 11, color: palette.text, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 5 }}>
            Your 3-quarter trend
            <TrendSparkline data={data.own_prior_rates} color={palette.dot} label="Your delinquency rate trend" />
            {data.own_prior_rates.length >= 2 && (
              <span style={{ fontWeight: 600 }}>
                {fmtDelta(data.own_prior_rates.at(-1) - data.own_prior_rates[0])} over period
              </span>
            )}
          </span>
        )}
        <span style={{ fontSize: 10, color: palette.text, opacity: 0.65 }}>
          Analysis generated {interpretation.refreshed_at
            ? new Date(interpretation.refreshed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—'
          } · Updated quarterly with NCUA data release
        </span>
      </div>
    </div>
  );
}

// ── P37Panel ──────────────────────────────────────────────────────────────────
// Renders economic context signals from the P37 Local Economy Radar module.
// Shown only when economy_signals.available === true.
function P37Panel({ signals }) {
  if (!signals?.available) return (
    <div style={{ padding: '12px 0', fontSize: 12, color: C.muted, fontStyle: 'italic' }}>
      P37 Local Economy Radar not connected — economic context unavailable.
    </div>
  );

  const isStress   = signals.overall_signal === 'stress';
  const palette    = isStress ? C.sigBad : C.sigGood;
  const unemploy   = signals.local_unemployment_change;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: isStress ? C.stress.dot : C.specific.dot,
          }} />
          Local Economy Signals
          <span style={{ fontSize: 10, color: C.muted, fontWeight: 400 }}>via P37 Radar</span>
        </div>
        <span style={{
          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: palette.border, color: palette.text,
        }}>
          {signals.signal_label}
        </span>
      </div>

      {/* Signal chips */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {signals.signals?.map(sig => (
          <EconomySignalChip key={sig.key} signal={sig} />
        ))}
      </div>

      {/* Unemployment callout */}
      {unemploy != null && Math.abs(unemploy) >= 0.001 && (
        <div style={{
          marginTop: 10, fontSize: 12, color: unemploy > 0 ? C.stress.text : C.specific.text,
          background: unemploy > 0 ? C.stress.bg : C.specific.bg,
          border: `1px solid ${unemploy > 0 ? C.stress.border : C.specific.border}`,
          borderRadius: 6, padding: '6px 12px',
        }}>
          Local unemployment {unemploy > 0 ? 'rose' : 'fell'} {' '}
          <strong>{Math.abs(unemploy * 100).toFixed(1)} points</strong> over this period
          {unemploy > 0 && ' — consistent with rising area-wide delinquency pressure.'}
        </div>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────
function Legend({ hasBanks }) {
  const items = [
    { color: C.own,  label: 'Your institution' },
    { color: C.cu,   label: 'Other credit unions' },
    ...(hasBanks ? [{ color: C.bank, label: 'Banks' }] : []),
    { color: C.median, label: 'Market median', dashed: true },
  ];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: C.muted, marginTop: 10 }}>
      {items.map(({ color, label, dashed }) => (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {dashed
            ? <span style={{ display: 'inline-block', width: 16, height: 0, borderTop: `2px dashed ${color}`, verticalAlign: 'middle' }} />
            : <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
          }
          {label}
        </span>
      ))}
      <span style={{ color: C.muted }}>↑ Rising · → Stable · ↓ Falling (3-quarter trend)</span>
    </div>
  );
}

// ── SummaryBar ────────────────────────────────────────────────────────────────
// Header statistics strip below the geography label.
function SummaryBar({ data }) {
  const { institution_median, cu_median, bank_median, n_rising_3q, n_total, own_rate } = data;
  const aboveMedian = own_rate != null && institution_median != null && own_rate > institution_median;

  const stats = [
    { label: 'Your rate',         value: fmtRate(own_rate),          color: C.own },
    { label: 'Institution median', value: fmtRate(institution_median), color: C.text },
    { label: 'CU median',         value: fmtRate(cu_median),         color: C.cu },
    ...(bank_median != null ? [{ label: 'Bank median', value: fmtRate(bank_median), color: C.bank }] : []),
    { label: 'Rising 3-quarter',  value: `${n_rising_3q ?? '—'} / ${n_total ?? '—'}`, color: n_rising_3q > (n_total ?? 0) / 2 ? '#d97706' : C.text },
  ];

  return (
    <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
      {stats.map(({ label, value, color }, i) => (
        <div key={label} style={{
          padding: '10px 18px', borderRight: i < stats.length - 1 ? `1px solid ${C.border}` : 'none',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{label}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
        </div>
      ))}
      {aboveMedian !== null && own_rate != null && institution_median != null && (
        <div style={{
          marginLeft: 'auto', padding: '10px 18px', display: 'flex', alignItems: 'center',
          fontSize: 12, color: aboveMedian ? '#92400e' : '#0f766e',
          background: aboveMedian ? '#fffbeb' : '#f0fdfa',
          borderLeft: `1px solid ${C.border}`,
        }}>
          {aboveMedian
            ? `${fmtRate(own_rate - institution_median)} above market median`
            : `${fmtRate(institution_median - own_rate)} below market median`
          }
        </div>
      )}
    </div>
  );
}

// ── RegionalContextPanel ──────────────────────────────────────────────────────
export default function RegionalContextPanel({
  geographyType = 'county',
  geographyId,
  period,
  style,
}) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!period) return;
    setLoading(true);
    setError(null);
    // geographyId is optional — when omitted the API uses the tenant's primary geography
    fetchContext(geographyType, geographyId ?? null, period)
      .then(d  => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [geographyType, geographyId, period]);

  // ── Loading ──
  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: C.muted, fontSize: 13, ...style }}>
      Loading regional context…
    </div>
  );

  // ── Error ──
  if (error) return (
    <div style={{
      background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8,
      padding: '12px 16px', fontSize: 13, color: '#991b1b', ...style,
    }}>
      Failed to load regional context: {error}
    </div>
  );

  if (!data) return null;

  const { geography_label, institutions = [], interpretation, economy_signals } = data;
  const hasBanks = institutions.some(i => i.institution_type === 'bank');

  return (
    <div style={{ fontFamily: 'system-ui,-apple-system,sans-serif', color: C.text, ...style }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 4 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 16, fontWeight: 700 }}>
          Institutions in {geography_label ?? `${geographyType} ${geographyId}`}
        </h3>
        <div style={{ fontSize: 12, color: C.muted }}>
          Delinquency comparison · {period}
        </div>
      </div>

      {/* ── Summary stats bar ── */}
      <SummaryBar data={data} />

      {/* ── Horizontal bar chart ── */}
      <BarChart institutions={institutions} institutionMedian={data.institution_median} />
      <Legend hasBanks={hasBanks} />

      {/* ── Interpretation card (Claude-generated) ── */}
      {interpretation?.narrative && (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, fontWeight: 500 }}>
            Analysis
          </div>
          <InterpretationCard interpretation={interpretation} data={data} />
        </div>
      )}

      {/* ── P37 Economic Signals ── */}
      <P37Panel signals={economy_signals} />

      {/* ── Data note ── */}
      <div style={{ marginTop: 16, fontSize: 11, color: C.muted, paddingTop: 10, borderTop: `1px solid ${C.border}`, lineHeight: 1.7 }}>
        Delinquency rates: NCUA 5300 (credit unions) + FDIC Call Report (banks) · Institution-level, not estimated.
        Branch presence determined via FDIC Summary of Deposits.
        Trend arrows reflect 3-quarter direction.
        {economy_signals?.available && ' Economic signals: P37 Local Economy Radar via Indeed, Yelp, Census permit data.'}
      </div>
    </div>
  );
}
