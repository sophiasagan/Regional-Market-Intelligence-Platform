/**
 * PeerBandChart — P76's signature chart component.
 *
 * Matches Callahan's color language exactly while adding P76's exclusive
 * regional median layer. Every chart rendered with this component must show
 * a peer group label — the peerGroupLabel prop satisfies that CLAUDE.md rule.
 *
 * Props:
 *   institutionData    [{period, value}]      Bold brand-color line
 *   peerMedian         [{period, value}]      Dashed gray line
 *   peerTopDecile      [{period, value}]      Teal thin line (top 10%)
 *   peerBottomDecile   [{period, value}]      Coral thin line (bottom 10%)
 *   peerBand           [{period, p25, p75}]   IQR shaded fill
 *   regionalMedian     [{period, value}]      Dashed purple (P76 exclusive, optional)
 *   metric             string                 Metric key — drives title + formatting
 *   periods            string[]               Ordered period keys for x-axis
 *   threshold          number                 Examiner threshold (same units as value)
 *   peerGroupLabel     string                 Shown in header pill (required)
 *   availablePeerGroups [{id, label}]         Options in peer-group dropdown
 *   onPeerGroupChange  (id) => void
 *   percentileRank     number                 0–1, latest period
 *   peerCount          number
 *   height             number                 Chart area height px (default 320)
 *
 * All value/p25/p75/threshold fields must be in the same units:
 *   decimal rates  (0.018 = 1.8%)  for rate metrics
 *   raw ratios     (1.45)          for alll_coverage_ratio
 *   raw counts/$ for volume metrics
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// ── Design tokens (Callahan color language) ───────────────────────────────────

const C = {
  own:          '#2563eb',   // brand primary — bold institution line
  topDecile:    '#0F6E56',   // teal  — top 10% (Callahan: green = better)
  bottomDecile: '#993C1D',   // coral — bottom 10% (Callahan: red = worse)
  median:       '#94a3b8',   // slate — peer median (dashed)
  regional:     '#7c3aed',   // purple — regional median (P76 exclusive)
  band:         '#94a3b8',   // slate — IQR fill
  threshold:    '#ef4444',   // red   — examiner threshold
  flag:         '#f59e0b',   // amber — median-crossing flag
  grid:         '#f3f4f6',
  axis:         '#6b7280',
  border:       '#e5e7eb',
};
const BAND_OPACITY = 0.20;  // spec: 20%

// ── Period range options (Callahan default: 12 quarters = 3 years) ────────────

const RANGE_OPTS = [
  { id: '4',   label: '1Y'  },
  { id: '8',   label: '2Y'  },
  { id: '12',  label: '3Y'  },   // default
  { id: 'all', label: 'All' },
];

// ── Metric metadata ───────────────────────────────────────────────────────────
// Callahan-matching labels per CLAUDE.md §Callahan UX parity rules.
// isRate: decimal fraction × 100 → display as %
// isRatio: already a ratio (1.45×)
// lowerIsBetter: true for adverse metrics — see percentile bar annotation

const METRIC_META = {
  delinq_rate_total:          { label: 'Delinquency Ratio',            isRate: true,  lowerIsBetter: true  },
  delinq_rate_auto:           { label: 'Auto Loan Delinquency',        isRate: true,  lowerIsBetter: true  },
  delinq_rate_real_estate:    { label: 'Real Estate Delinquency',      isRate: true,  lowerIsBetter: true  },
  delinq_rate_first_mortgage: { label: '1st Mortgage Delinquency',     isRate: true,  lowerIsBetter: true  },
  delinq_rate_credit_card:    { label: 'Credit Card Delinquency',      isRate: true,  lowerIsBetter: true  },
  delinq_rate_commercial:     { label: 'Commercial Loan Delinquency',  isRate: true,  lowerIsBetter: true  },
  delinq_rate_indirect:       { label: 'Indirect Loan Delinquency',    isRate: true,  lowerIsBetter: true  },
  delinq_rate_new_auto:       { label: 'New Auto Loan Delinquency',    isRate: true,  lowerIsBetter: true  },
  delinq_rate_used_auto:      { label: 'Used Auto Loan Delinquency',   isRate: true,  lowerIsBetter: true  },
  delinq_90plus_rate:         { label: 'Total Delinquency 90+ Days',   isRate: true,  lowerIsBetter: true  },
  chargeoff_rate_total:       { label: 'Net Charge-Off Ratio',         isRate: true,  lowerIsBetter: true  },
  alll_coverage_ratio:        { label: 'Allowance for Loan Losses',    isRatio: true, lowerIsBetter: false },
  alll_to_loans_ratio:        { label: 'ALLL / Total Loans',           isRate: true,  lowerIsBetter: false },
  tdr_to_loans_ratio:         { label: 'TDR / Total Loans',            isRate: true,  lowerIsBetter: true  },
  oreo_to_assets_ratio:       { label: 'OREO / Total Assets',          isRate: true,  lowerIsBetter: true  },
};

// ── Period utilities ──────────────────────────────────────────────────────────

function parsePer(raw) {
  const m = typeof raw === 'string' && raw.match(/^(\d{4})Q(\d)$/);
  return m ? { year: +m[1], q: +m[2] } : null;
}
const sortKey    = raw => { const p = parsePer(raw); return p ? p.year * 10 + p.q : 0; };
const shortLabel = raw => { const p = parsePer(raw); return p ? `Q${p.q}'${String(p.year).slice(2)}` : raw; };
const fullLabel  = raw => { const p = parsePer(raw); return p ? `Q${p.q} ${p.year}` : raw; };

// ── PercentileBar sub-component ───────────────────────────────────────────────

function PercentileBar({ percentileRank, peerCount, lowerIsBetter }) {
  if (percentileRank == null || isNaN(percentileRank)) return null;

  const pct = Math.round(percentileRank * 100);
  // For adverse metrics (delinquency): high percentile = bad
  const isBad  = lowerIsBetter ? percentileRank > 0.75 : percentileRank < 0.25;
  const isWarn = lowerIsBetter
    ? (percentileRank >= 0.50 && percentileRank <= 0.75)
    : (percentileRank >= 0.25 && percentileRank < 0.50);
  const barColor = isBad ? '#ef4444' : isWarn ? '#f59e0b' : '#16a34a';
  const suffix   = pct === 1 ? 'st' : pct === 2 ? 'nd' : pct === 3 ? 'rd' : 'th';

  return (
    <div style={{
      marginTop: 14, padding: '10px 14px', background: '#f8fafc',
      borderRadius: 6, border: '1px solid #e2e8f0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#374151' }}>
          Your institution is at the{' '}
          <strong style={{ color: barColor }}>{pct}{suffix} percentile</strong>
          {' '}among <strong>{peerCount}</strong> peer institution{peerCount !== 1 ? 's' : ''}
        </span>
        {lowerIsBetter && (
          <span style={{
            fontSize: 10, color: '#64748b', background: '#f1f5f9',
            border: '1px solid #e2e8f0', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap',
          }}>
            Lower percentile = better
          </span>
        )}
      </div>

      {/* Track */}
      <div style={{ position: 'relative', height: 8, background: '#e5e7eb', borderRadius: 4 }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, height: 8,
          width: `${pct}%`, borderRadius: 4,
          background: `linear-gradient(to right, #16a34a 0%, ${barColor} 100%)`,
          transition: 'width 0.4s ease',
        }} />
        {/* Needle */}
        <div style={{
          position: 'absolute', top: -2, left: `calc(${pct}% - 1.5px)`,
          width: 3, height: 12, background: '#0f172a', borderRadius: 2,
        }} />
        {/* Quartile ticks */}
        {[25, 50, 75].map(t => (
          <div key={t} style={{
            position: 'absolute', top: -1, left: `${t}%`,
            width: 1, height: 10, background: '#d1d5db',
          }} />
        ))}
      </div>

      {/* Scale labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: '#9ca3af' }}>
        <span>{lowerIsBetter ? 'Best ←' : '← Worst'}</span>
        <span>P25</span>
        <span>Median</span>
        <span>P75</span>
        <span>{lowerIsBetter ? '→ Worst' : 'Best →'}</span>
      </div>
    </div>
  );
}

// ── Tooltip badge ─────────────────────────────────────────────────────────────

function TipBadge({ color, children }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4,
      background: `${color}18`, border: `1px solid ${color}55`, color,
    }}>
      {children}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PeerBandChart({
  institutionData   = [],
  peerMedian        = [],
  peerTopDecile     = [],
  peerBottomDecile  = [],
  peerBand          = [],
  regionalMedian,
  metric            = 'delinq_rate_total',
  periods           = [],
  threshold,
  peerGroupLabel    = '',
  availablePeerGroups = [],
  onPeerGroupChange,
  percentileRank,
  peerCount         = 0,
  height            = 320,
}) {
  const [periodRange, setPeriodRange] = useState('12');  // Callahan default: 3 years
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);
  const peerMenuRef = useRef(null);

  const meta          = METRIC_META[metric] ?? { label: metric.replace(/_/g, ' ') };
  const isRate        = !!meta.isRate;
  const isRatio       = !!meta.isRatio;
  const lowerIsBetter = !!meta.lowerIsBetter;
  const scale         = isRate ? 100 : 1;

  const fmt = useCallback(v => {
    if (v == null) return '';
    if (isRatio) return `${(+v).toFixed(2)}×`;
    if (isRate)  return `${(+v).toFixed(2)}%`;
    if (Math.abs(+v) >= 1_000_000) return `${((+v) / 1_000_000).toFixed(1)}M`;
    if (Math.abs(+v) >= 1_000)     return `${((+v) / 1_000).toFixed(1)}K`;
    return (+v).toFixed(2);
  }, [isRate, isRatio]);

  // ── All available periods (sorted) ─────────────────────────────────────────
  const allPeriods = useMemo(() => {
    const base = periods.length ? [...periods] : Array.from(new Set([
      ...institutionData.map(d => d.period),
      ...peerMedian.map(d => d.period),
    ]));
    return base.sort((a, b) => sortKey(a) - sortKey(b));
  }, [periods, institutionData, peerMedian]);

  // ── Trimmed periods per range selector ─────────────────────────────────────
  const visiblePeriods = useMemo(() => {
    if (periodRange === 'all') return allPeriods;
    return allPeriods.slice(-parseInt(periodRange, 10));
  }, [allPeriods, periodRange]);

  // ── Merge all series into one Recharts data array ──────────────────────────
  const mergedData = useMemo(() => {
    const toMap = (arr, key = 'value') =>
      Object.fromEntries(arr.map(d => [d.period, d[key]]));

    const ownMap = toMap(institutionData);
    const medMap = toMap(peerMedian);
    const topMap = toMap(peerTopDecile);
    const botMap = toMap(peerBottomDecile);
    const regMap = regionalMedian ? toMap(regionalMedian) : {};
    const bndMap = Object.fromEntries(peerBand.map(d => [d.period, d]));

    return visiblePeriods.map(raw => {
      const own = ownMap[raw];
      const med = medMap[raw];
      const top = topMap[raw];
      const bot = botMap[raw];
      const reg = regMap[raw];
      const bnd = bndMap[raw];
      const p25 = bnd?.p25;
      const p75 = bnd?.p75;
      return {
        rawPeriod:  raw,
        period:     shortLabel(raw),
        periodFull: fullLabel(raw),
        own:        own != null ? own * scale : undefined,
        median:     med != null ? med * scale : undefined,
        topDecile:  top != null ? top * scale : undefined,
        botDecile:  bot != null ? bot * scale : undefined,
        regional:   reg != null ? reg * scale : undefined,
        // Stacked-area band: transparent base (0→p25) + visible cap (p25→p75)
        bandBase:   p25 != null ? p25 * scale : undefined,
        bandHeight: p25 != null && p75 != null ? (p75 - p25) * scale : undefined,
        p25:        p25 != null ? p25 * scale : undefined,
        p75:        p75 != null ? p75 * scale : undefined,
      };
    });
  }, [institutionData, peerMedian, peerTopDecile, peerBottomDecile,
      regionalMedian, peerBand, visiblePeriods, scale]);

  // Threshold in display units
  const thresholdY = threshold != null ? threshold * scale : null;

  // ── Y-axis domain ───────────────────────────────────────────────────────────
  const [yMin, yMax] = useMemo(() => {
    const vals = mergedData.flatMap(d =>
      [d.own, d.p25, d.p75, d.median, d.topDecile, d.botDecile, d.regional]
        .filter(v => v != null),
    );
    if (thresholdY != null) vals.push(thresholdY);
    if (!vals.length) return [0, isRatio ? 2 : 5];
    const lo  = Math.min(...vals);
    const hi  = Math.max(...vals);
    const pad = ((hi - lo) * 0.22) || hi * 0.2 || 0.5;
    return [Math.max(0, lo - pad), hi + pad];
  }, [mergedData, thresholdY, isRatio]);

  // ── Annotation detection ────────────────────────────────────────────────────

  // Periods where institution line crosses peer median
  const crossingPeriods = useMemo(() => {
    const s = new Set();
    for (let i = 1; i < mergedData.length; i++) {
      const p = mergedData[i - 1], c = mergedData[i];
      if (p.own == null || p.median == null || c.own == null || c.median == null) continue;
      if ((p.own > p.median) !== (c.own > c.median)) s.add(c.rawPeriod);
    }
    return s;
  }, [mergedData]);

  // Periods where institution enters top or bottom decile
  const { topEntries, botEntries } = useMemo(() => {
    const top = new Set(), bot = new Set();
    for (let i = 1; i < mergedData.length; i++) {
      const p = mergedData[i - 1], c = mergedData[i];
      if (c.own == null || p.own == null) continue;
      if (c.topDecile != null && p.topDecile != null &&
          p.own < p.topDecile && c.own >= c.topDecile) top.add(c.rawPeriod);
      if (c.botDecile != null && p.botDecile != null &&
          p.own > p.botDecile && c.own <= c.botDecile) bot.add(c.rawPeriod);
    }
    return { topEntries: top, botEntries: bot };
  }, [mergedData]);

  // All periods where institution exceeds threshold, and the first-breach transitions
  const { thresholdBreaches, thresholdAllExceeding } = useMemo(() => {
    if (thresholdY == null) return { thresholdBreaches: new Set(), thresholdAllExceeding: [] };
    const breaches = new Set();
    const all      = [];
    for (let i = 0; i < mergedData.length; i++) {
      const c = mergedData[i], p = mergedData[i - 1];
      if (c.own == null) continue;
      if (c.own > thresholdY) {
        all.push(c.rawPeriod);
        const wasOK = p == null || p.own == null || p.own <= thresholdY;
        if (wasOK) breaches.add(c.rawPeriod);
      }
    }
    return { thresholdBreaches: breaches, thresholdAllExceeding: all };
  }, [mergedData, thresholdY]);

  // ── Custom dot (circle + flag pole + pennant at annotated points) ───────────
  const renderOwnDot = useCallback(({ cx, cy, payload, value }) => {
    if (value == null || !isFinite(cx) || !isFinite(cy)) return null;
    const raw         = payload?.rawPeriod;
    const isCrossing  = crossingPeriods.has(raw);
    const isTopEntry  = topEntries.has(raw);
    const isBotEntry  = botEntries.has(raw);
    const isBreach    = thresholdBreaches.has(raw);

    if (!isCrossing && !isTopEntry && !isBotEntry && !isBreach) {
      return (
        <circle key={`dot-${raw}`} cx={cx} cy={cy} r={3}
          fill={C.own} stroke="white" strokeWidth={1} />
      );
    }

    const flagColor = isBreach   ? C.threshold
                    : isTopEntry ? C.topDecile
                    : isBotEntry ? C.bottomDecile
                    :              C.flag;
    const poleBase  = cy - 5;
    const poleTop   = cy - 24;

    return (
      <g key={`ann-${raw}`}>
        <circle cx={cx} cy={cy} r={4.5} fill={C.own} stroke="white" strokeWidth={1.5} />
        <line x1={cx} y1={poleBase} x2={cx} y2={poleTop} stroke={flagColor} strokeWidth={1.5} />
        <polygon
          points={`${cx},${poleTop} ${cx + 11},${poleTop + 5} ${cx},${poleTop + 10}`}
          fill={flagColor}
        />
      </g>
    );
  }, [crossingPeriods, topEntries, botEntries, thresholdBreaches]);

  // ── Custom tooltip ──────────────────────────────────────────────────────────
  const renderTooltip = useCallback(({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;

    // Band-position interpretation
    let bandNote = null, bandNoteColor = C.axis;
    if (d.own != null && d.p25 != null && d.p75 != null) {
      if (lowerIsBetter) {
        if (d.own > d.p75)      { bandNote = 'Above peer band — worse than most peers';    bandNoteColor = C.threshold; }
        else if (d.own < d.p25) { bandNote = 'Below peer band — better than most peers';   bandNoteColor = '#16a34a';   }
        else                    { bandNote = 'Within typical peer range';                   bandNoteColor = C.axis;     }
      } else {
        if (d.own > d.p75)      { bandNote = 'Above peer band — better than most peers';   bandNoteColor = '#16a34a';   }
        else if (d.own < d.p25) { bandNote = 'Below peer band — worse than most peers';    bandNoteColor = C.threshold; }
        else                    { bandNote = 'Within typical peer range';                   bandNoteColor = C.axis;     }
      }
    }

    const raw        = d.rawPeriod;
    const isCrossing = crossingPeriods.has(raw);
    const isTopEntry = topEntries.has(raw);
    const isBotEntry = botEntries.has(raw);
    const isBreach   = thresholdBreaches.has(raw);

    const rows = [
      d.own       != null && { label: 'Your institution', val: fmt(d.own),       color: C.own,          bold: true },
      d.topDecile != null && { label: 'Top decile',        val: fmt(d.topDecile), color: C.topDecile                },
      d.median    != null && { label: 'Peer median',       val: fmt(d.median),    color: C.median                   },
      d.botDecile != null && { label: 'Bottom decile',     val: fmt(d.botDecile), color: C.bottomDecile             },
      d.regional  != null && { label: 'Regional peers',    val: fmt(d.regional),  color: C.regional                 },
      d.p25       != null && d.p75 != null && {
        label: 'Peer P25–P75', val: `${fmt(d.p25)} – ${fmt(d.p75)}`, color: '#9ca3af',
      },
      thresholdY  != null && { label: 'Threshold',         val: fmt(thresholdY),  color: C.threshold                },
    ].filter(Boolean);

    return (
      <div style={{
        background: 'white', border: `1px solid ${C.border}`, borderRadius: 8,
        padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.10)',
        fontSize: 12, minWidth: 225,
      }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#111', marginBottom: 8,
                      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          {d.periodFull}
          {isCrossing  && <TipBadge color={C.flag}>↕ median crossing</TipBadge>}
          {isTopEntry  && <TipBadge color={C.topDecile}>→ top decile</TipBadge>}
          {isBotEntry  && <TipBadge color={C.bottomDecile}>→ bottom decile</TipBadge>}
          {isBreach    && <TipBadge color={C.threshold}>⚠ threshold</TipBadge>}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map(({ label, val, color, bold }) => (
              <tr key={label}>
                <td style={{ color, fontWeight: bold ? 600 : 400, paddingBottom: 3, paddingRight: 12 }}>
                  {label}
                </td>
                <td style={{ textAlign: 'right', fontWeight: bold ? 700 : 400, color: '#111' }}>
                  {val}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bandNote && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.grid}`,
                        color: bandNoteColor, fontWeight: 600, fontSize: 11 }}>
            {bandNote}
          </div>
        )}
      </div>
    );
  }, [lowerIsBetter, crossingPeriods, topEntries, botEntries, thresholdBreaches, thresholdY, fmt]);

  // ── CSV export ──────────────────────────────────────────────────────────────
  function exportCSV() {
    const headers = ['Period', 'Institution', 'Peer Median', 'Top Decile', 'Bottom Decile',
                     'Regional Median', 'P25', 'P75'];
    const body    = mergedData.map(d =>
      [d.rawPeriod, d.own, d.median, d.topDecile, d.botDecile, d.regional, d.p25, d.p75]
        .map(v => v != null ? (typeof v === 'number' ? v.toFixed(6) : v) : '')
        .join(',')
    ).join('\n');
    const blob = new Blob([`${headers.join(',')}\n${body}`], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `peer-band-${metric}.csv`,
    }).click();
    URL.revokeObjectURL(url);
  }

  // ── No-data fallback ────────────────────────────────────────────────────────
  if (!mergedData.length) {
    return (
      <div style={{
        height: height + 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#9ca3af', fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 8,
        fontFamily: 'system-ui, sans-serif',
      }}>
        No peer data available
      </div>
    );
  }

  // ── Legend entries ──────────────────────────────────────────────────────────
  const legendEntries = [
    { key: 'own',    label: 'Your Institution',    swatch: 'solid',  color: C.own,          width: 2.5 },
    peerTopDecile.length    && { key: 'top', label: 'Top decile',          swatch: 'solid',  color: C.topDecile,    width: 1   },
    peerBottomDecile.length && { key: 'bot', label: 'Bottom decile',       swatch: 'solid',  color: C.bottomDecile, width: 1   },
    peerMedian.length       && { key: 'med', label: 'Peer median',         swatch: 'dashed', color: C.median,       width: 1   },
    regionalMedian?.length  && { key: 'reg', label: 'Regional peers (P76)',swatch: 'dashed', color: C.regional,     width: 1.5 },
    peerBand.length         && { key: 'bnd', label: 'Peer P25–P75',        swatch: 'area',   color: C.band                    },
    thresholdY != null      && { key: 'thr', label: `Threshold (${fmt(thresholdY)})`, swatch: 'dashed', color: C.threshold, width: 1.5 },
  ].filter(Boolean);

  // ── Annotation banners ──────────────────────────────────────────────────────
  const banners = [];
  if (topEntries.size > 0) {
    const pts = [...topEntries].sort((a, b) => sortKey(a) - sortKey(b)).map(fullLabel).join(', ');
    const label = lowerIsBetter
      ? `Entered top decile — higher than 90% of peers (adverse): ${pts}`
      : `Entered top decile — better than 90% of peers: ${pts}`;
    banners.push({ label, color: C.topDecile, bg: '#f0fdf4', border: '#86efac' });
  }
  if (botEntries.size > 0) {
    const pts = [...botEntries].sort((a, b) => sortKey(a) - sortKey(b)).map(fullLabel).join(', ');
    const label = lowerIsBetter
      ? `Entered bottom decile — better than 90% of peers: ${pts}`
      : `Entered bottom decile — worse than 90% of peers: ${pts}`;
    const good  = lowerIsBetter;
    banners.push({ label, color: good ? C.topDecile : C.bottomDecile,
                   bg: good ? '#f0fdf4' : '#fff1f2', border: good ? '#86efac' : '#fecdd3' });
  }
  if (thresholdAllExceeding.length > 0) {
    const pts = thresholdAllExceeding.sort((a, b) => sortKey(a) - sortKey(b)).map(fullLabel).join(', ');
    banners.push({
      label:  `Examiner threshold exceeded: ${pts}`,
      color:  C.threshold, bg: '#fff1f2', border: '#fecdd3',
    });
  }

  const title = meta.label ?? metric.replace(/_/g, ' ');

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>

        {/* Metric title */}
        <span style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', flex: '1 1 auto', minWidth: 0 }}>
          {title}
        </span>

        {/* Period range selector */}
        <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
          {RANGE_OPTS.map(({ id, label }, i, arr) => (
            <button key={id} onClick={() => setPeriodRange(id)} style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 500,
              border: 'none', cursor: 'pointer', outline: 'none',
              borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : 'none',
              background: periodRange === id ? '#2563eb' : '#fff',
              color:      periodRange === id ? '#fff'    : '#64748b',
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Peer group pill + dropdown */}
        {peerGroupLabel && (
          <div style={{ position: 'relative', flexShrink: 0 }} ref={peerMenuRef}>
            <button
              onClick={() => setPeerMenuOpen(o => !o)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                border: '1.5px solid #c7d2fe', borderRadius: 20, cursor: 'pointer',
                background: '#eef2ff', color: '#4338ca', outline: 'none',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {peerGroupLabel}
              {availablePeerGroups.length > 0 && (
                <span style={{ fontSize: 9 }}>{peerMenuOpen ? '▲' : '▼'}</span>
              )}
            </button>

            {peerMenuOpen && availablePeerGroups.length > 0 && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60,
                background: 'white', border: `1px solid ${C.border}`, borderRadius: 6,
                boxShadow: '0 4px 14px rgba(0,0,0,0.12)', minWidth: 230, overflow: 'hidden',
              }}>
                {availablePeerGroups.map(({ id, label }) => (
                  <button key={id}
                    style={{
                      display: 'block', width: '100%', padding: '8px 12px', textAlign: 'left',
                      border: 'none', background: 'none', fontSize: 12, cursor: 'pointer', color: '#374151',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                    onClick={() => { onPeerGroupChange?.(id); setPeerMenuOpen(false); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Export to Excel (CSV) */}
        <button onClick={exportCSV} title="Export underlying data to CSV / Excel" style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 500,
          border: `1px solid ${C.border}`, borderRadius: 5,
          cursor: 'pointer', background: '#fff', color: '#64748b', outline: 'none',
          display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        }}>
          ↓ Excel
        </button>
      </div>

      {/* ── Chart ─────────────────────────────────────────────────────────── */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={mergedData} margin={{ top: 26, right: 18, bottom: 2, left: 4 }}>

          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />

          <XAxis
            dataKey="period"
            tick={{ fontSize: 11, fill: C.axis }}
            axisLine={{ stroke: C.border }}
            tickLine={false}
          />

          <YAxis
            domain={[yMin, yMax]}
            tickFormatter={fmt}
            tick={{ fontSize: 11, fill: C.axis }}
            axisLine={false}
            tickLine={false}
            width={58}
          />

          <Tooltip content={renderTooltip} cursor={{ stroke: C.border, strokeWidth: 1 }} />

          {/*
           * IQR band — stacked Area trick (same as DelinquencyTrendChart):
           *   bandBase   fills 0 → p25  (transparent — invisible spacer)
           *   bandHeight fills p25 → p75 (visible gray region)
           */}
          <Area type="monotone" dataKey="bandBase"   stackId="band"
            fill="transparent" fillOpacity={0} stroke="none"
            dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
          <Area type="monotone" dataKey="bandHeight" stackId="band"
            fill={C.band} fillOpacity={BAND_OPACITY} stroke="none"
            dot={false} activeDot={false} isAnimationActive={false} legendType="none" />

          {/* Top decile — teal, 1px, no markers */}
          <Line type="monotone" dataKey="topDecile"
            stroke={C.topDecile} strokeWidth={1}
            dot={false} activeDot={false} legendType="none" />

          {/* Bottom decile — coral, 1px, no markers */}
          <Line type="monotone" dataKey="botDecile"
            stroke={C.bottomDecile} strokeWidth={1}
            dot={false} activeDot={false} legendType="none" />

          {/* Peer median — dashed gray, 1px */}
          <Line type="monotone" dataKey="median"
            stroke={C.median} strokeWidth={1} strokeDasharray="5 3"
            dot={false} activeDot={false} legendType="none" />

          {/* Regional median — dashed purple, 1.5px (P76 exclusive) */}
          {regionalMedian && (
            <Line type="monotone" dataKey="regional"
              stroke={C.regional} strokeWidth={1.5} strokeDasharray="6 3"
              dot={false} activeDot={false} legendType="none" />
          )}

          {/* Institution — 2.5px brand color, annotated dots, rendered last (on top) */}
          <Line type="monotone" dataKey="own"
            stroke={C.own} strokeWidth={2.5}
            dot={renderOwnDot}
            activeDot={{ r: 5, fill: C.own, stroke: 'white', strokeWidth: 2 }}
            legendType="none" />

          {/* Examiner threshold */}
          {thresholdY != null && (
            <ReferenceLine
              y={thresholdY}
              stroke={C.threshold}
              strokeDasharray="6 3"
              strokeWidth={1.5}
              label={{
                value: `Threshold ${fmt(thresholdY)}`,
                position: 'insideTopRight',
                fill: C.threshold,
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* ── Legend ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', justifyContent: 'center', marginTop: 10 }}>
        {legendEntries.map(entry => (
          <div key={entry.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {entry.swatch === 'area' && (
              <div style={{ width: 20, height: 10, borderRadius: 2,
                            background: entry.color, opacity: BAND_OPACITY + 0.15 }} />
            )}
            {(entry.swatch === 'solid' || entry.swatch === 'dashed') && (
              <svg width={20} height={3} style={{ display: 'block' }}>
                <line x1={0} y1={1.5} x2={20} y2={1.5}
                  stroke={entry.color}
                  strokeWidth={entry.width ?? 1.5}
                  strokeDasharray={entry.swatch === 'dashed' ? '4 2' : undefined} />
              </svg>
            )}
            <span style={{ fontSize: 11, color: '#555', whiteSpace: 'nowrap' }}>{entry.label}</span>
          </div>
        ))}
      </div>

      {/* ── Annotation banners ────────────────────────────────────────────── */}
      {banners.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {banners.map((b, i) => (
            <div key={i} style={{
              padding: '6px 12px', borderRadius: 5, fontSize: 12, fontWeight: 500,
              border: `1px solid ${b.border}`, background: b.bg, color: b.color,
            }}>
              {b.label}
            </div>
          ))}
        </div>
      )}

      {/* ── Percentile summary bar ─────────────────────────────────────────── */}
      <PercentileBar
        percentileRank={percentileRank}
        peerCount={peerCount}
        lowerIsBetter={lowerIsBetter}
      />

    </div>
  );
}
