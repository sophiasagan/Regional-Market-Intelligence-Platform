/**
 * DelinquencyTrendChart — reusable Recharts trend chart for credit quality metrics.
 *
 * Props
 * ─────
 * institutionData    [{period, rate}]         Your institution — decimal fraction (0.018 = 1.8 %)
 * peerMedian         [{period, rate}]         Peer median line — decimal fraction
 * peerBand           [{period, p25, p75}]     Peer P25–P75 spread — decimal fractions
 * metric             string                   e.g. "delinq_rate_total" — drives title + units
 * periods            string[]                 Ordered period list, e.g. ["2023Q1", …, "2024Q4"]
 * highlightThreshold number | null            Optional watch-level horizontal line (decimal fraction)
 * height             number                   Chart area height in px (default 300)
 *
 * alll_coverage_ratio is a special case: values are ratios (1.45×), not rates.
 * Pass highlightThreshold=1.0 to draw the 1.0× NCUA adequacy line.
 */
import React, { useCallback, useMemo } from 'react';
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

// ── Design tokens ──────────────────────────────────────────────────────────

const C = {
  own:       '#2563eb',          // brand primary
  median:    '#94a3b8',          // slate — peer median
  band:      'rgb(148,163,184)', // same slate for band fill
  threshold: '#ef4444',          // red — watch line
  flag:      '#f59e0b',          // amber — median-crossing marker
  grid:      '#f3f4f6',
  axis:      '#6b7280',
  border:    '#e5e7eb',
};
const BAND_OPACITY = 0.30;

const METRIC_LABELS = {
  delinq_rate_total:       'Total Delinquency Rate',
  delinq_rate_auto:        'Auto Loan Delinquency Rate',
  delinq_rate_real_estate: 'Real Estate Delinquency Rate',
  delinq_rate_credit_card: 'Credit Card Delinquency Rate',
  delinq_rate_commercial:  'Commercial Delinquency Rate',
  delinq_90plus_rate:      '90+ Day Delinquency Rate',
  chargeoff_rate_total:    'Net Charge-Off Rate (annualized)',
  alll_coverage_ratio:     'ALLL Coverage Ratio',
};

// ── Period utilities ───────────────────────────────────────────────────────

function _parse(raw) {
  const m = typeof raw === 'string' && raw.match(/^(\d{4})Q(\d)$/);
  return m ? { year: +m[1], q: +m[2] } : null;
}
const _sortKey  = raw => { const p = _parse(raw); return p ? p.year * 10 + p.q : 0; };
const _short    = raw => { const p = _parse(raw); return p ? `Q${p.q}'${String(p.year).slice(2)}` : raw; };
const _full     = raw => { const p = _parse(raw); return p ? `Q${p.q} ${p.year}` : raw; };

// ── Flag SVG (pole + triangle) — used in dot + legend ─────────────────────

function FlagIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: 'block' }}>
      <line x1={2} y1={1} x2={2} y2={11} stroke={C.flag} strokeWidth={1.5} />
      <polygon points="2,1 11,4 2,7" fill={C.flag} />
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export default function DelinquencyTrendChart({
  institutionData = [],
  peerMedian      = [],
  peerBand        = [],
  metric          = 'delinq_rate_total',
  periods         = [],
  highlightThreshold = null,
  height          = 300,
}) {
  // alll_coverage_ratio is stored as a ratio (1.45×) not a decimal rate
  const isRatio  = metric === 'alll_coverage_ratio';
  const scale    = isRatio ? 1 : 100;   // multiply decimal rates to get percentage display values

  // ── Tick / value formatter ───────────────────────────────────────────────
  const fmt = useCallback(
    v => v == null ? '' : isRatio ? `${(+v).toFixed(2)}×` : `${(+v).toFixed(2)}%`,
    [isRatio],
  );

  // Threshold in display units (already scaled)
  const thresholdY = useMemo(
    () => highlightThreshold != null ? highlightThreshold * scale : null,
    [highlightThreshold, scale],
  );

  // ── Merge into a single ordered data array ───────────────────────────────
  const mergedData = useMemo(() => {
    const ordered = (periods.length ? [...periods] : Array.from(new Set([
      ...institutionData.map(d => d.period),
      ...peerMedian.map(d => d.period),
      ...peerBand.map(d => d.period),
    ]))).sort((a, b) => _sortKey(a) - _sortKey(b));

    const ownMap  = Object.fromEntries(institutionData.map(d => [d.period, d.rate]));
    const medMap  = Object.fromEntries(peerMedian.map(d => [d.period, d.rate]));
    const bndMap  = Object.fromEntries(peerBand.map(d => [d.period, d]));

    return ordered.map(raw => {
      const own = ownMap[raw];
      const med = medMap[raw];
      const bnd = bndMap[raw];
      const p25 = bnd?.p25;
      const p75 = bnd?.p75;
      return {
        rawPeriod:  raw,
        period:     _short(raw),         // x-axis label
        periodFull: _full(raw),          // tooltip header
        own:        own  != null ? own  * scale : undefined,
        median:     med  != null ? med  * scale : undefined,
        // Stacked-area band: transparent base 0→p25, visible cap p25→p75
        bandBase:   p25  != null ? p25  * scale : undefined,
        bandHeight: p25  != null && p75 != null ? (p75 - p25) * scale : undefined,
        p25:        p25  != null ? p25  * scale : undefined,
        p75:        p75  != null ? p75  * scale : undefined,
      };
    });
  }, [institutionData, peerMedian, peerBand, periods, scale]);

  // ── Y-axis domain with padding ───────────────────────────────────────────
  const [yMin, yMax] = useMemo(() => {
    const vals = mergedData.flatMap(d =>
      [d.own, d.p25, d.p75, d.median].filter(v => v != null),
    );
    if (thresholdY != null) vals.push(thresholdY);
    if (!vals.length) return [0, 5];
    const lo  = Math.min(...vals);
    const hi  = Math.max(...vals);
    const pad = ((hi - lo) * 0.22) || hi * 0.2 || 0.5;
    return [Math.max(0, lo - pad), hi + pad];
  }, [mergedData, thresholdY]);

  // ── Detect periods where own line crosses peer median ────────────────────
  const crossingPeriods = useMemo(() => {
    const s = new Set();
    for (let i = 1; i < mergedData.length; i++) {
      const p = mergedData[i - 1], c = mergedData[i];
      if (p.own == null || p.median == null || c.own == null || c.median == null) continue;
      if ((p.own > p.median) !== (c.own > c.median)) s.add(c.rawPeriod);
    }
    return s;
  }, [mergedData]);

  // ── Custom dot — circle normally; flag pole+triangle at crossings ────────
  const renderOwnDot = useCallback(({ cx, cy, payload, value }) => {
    if (value == null || !isFinite(cx) || !isFinite(cy)) return null;
    const isCrossing = crossingPeriods.has(payload?.rawPeriod);

    if (!isCrossing) {
      return (
        <circle
          key={`dot-${payload?.rawPeriod}`}
          cx={cx} cy={cy} r={3}
          fill={C.own} stroke="white" strokeWidth={1}
        />
      );
    }

    // Flag: slightly larger dot, pole, and right-pointing triangle
    const poleBase = cy - 5;
    const poleTop  = cy - 22;
    return (
      <g key={`x-${payload?.rawPeriod}`}>
        <circle cx={cx} cy={cy} r={4.5} fill={C.own} stroke="white" strokeWidth={1.5} />
        <line x1={cx} y1={poleBase} x2={cx} y2={poleTop} stroke={C.flag} strokeWidth={1.5} />
        <polygon
          points={`${cx},${poleTop} ${cx + 11},${poleTop + 5} ${cx},${poleTop + 10}`}
          fill={C.flag}
        />
      </g>
    );
  }, [crossingPeriods]);

  // ── Custom tooltip ───────────────────────────────────────────────────────
  const renderTooltip = useCallback(({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;

    // Band-position interpretation
    let bandMsg = null, bandColor = C.axis;
    if (d.own != null && d.p25 != null && d.p75 != null) {
      if (isRatio) {
        if (d.own > d.p75)      { bandMsg = 'Above band — outperforming most peers';     bandColor = '#16a34a'; }
        else if (d.own < d.p25) { bandMsg = 'Below band — lower coverage than most peers'; bandColor = C.threshold; }
        else                    { bandMsg = 'Within peer band — typical coverage level'; bandColor = C.own; }
      } else {
        if (d.own > d.p75)      { bandMsg = 'Above band — outlier on the high side';     bandColor = C.threshold; }
        else if (d.own < d.p25) { bandMsg = 'Below band — outperforming most peers';     bandColor = '#16a34a'; }
        else                    { bandMsg = 'Within peer band — normal peer range';       bandColor = C.own; }
      }
    }

    const isCrossing = crossingPeriods.has(d.rawPeriod);

    return (
      <div style={{
        background: 'white', border: `1px solid ${C.border}`, borderRadius: 8,
        padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.10)',
        fontSize: 12, minWidth: 215,
      }}>
        {/* Header */}
        <div style={{ fontWeight: 700, fontSize: 13, color: '#111', marginBottom: 8,
                      display: 'flex', alignItems: 'center', gap: 6 }}>
          {d.periodFull}
          {isCrossing && (
            <span style={{ fontSize: 10, color: C.flag, fontWeight: 600,
                           background: '#fffbeb', border: '1px solid #fde68a',
                           borderRadius: 4, padding: '1px 5px' }}>
              ↕ median crossing
            </span>
          )}
        </div>

        {/* Values table */}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {d.own != null && (
              <tr>
                <td style={{ color: C.own, fontWeight: 600, paddingBottom: 3, paddingRight: 10 }}>
                  Your institution
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: '#111' }}>
                  {fmt(d.own)}
                </td>
              </tr>
            )}
            {d.median != null && (
              <tr>
                <td style={{ color: C.median, paddingBottom: 3, paddingRight: 10 }}>
                  Peer median
                </td>
                <td style={{ textAlign: 'right', color: '#374151' }}>{fmt(d.median)}</td>
              </tr>
            )}
            {d.p25 != null && d.p75 != null && (
              <tr>
                <td style={{ color: '#9ca3af', paddingBottom: 3, paddingRight: 10 }}>
                  Peer P25–P75
                </td>
                <td style={{ textAlign: 'right', color: '#9ca3af' }}>
                  {fmt(d.p25)} – {fmt(d.p75)}
                </td>
              </tr>
            )}
            {thresholdY != null && (
              <tr>
                <td style={{ color: C.threshold, paddingRight: 10 }}>Watch threshold</td>
                <td style={{ textAlign: 'right', color: C.threshold }}>{fmt(thresholdY)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Band interpretation */}
        {bandMsg && (
          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.grid}`,
            color: bandColor, fontWeight: 600, fontSize: 11,
          }}>
            {bandMsg}
          </div>
        )}
      </div>
    );
  }, [isRatio, crossingPeriods, thresholdY, fmt]);

  // ── Legend entries ───────────────────────────────────────────────────────
  const legendEntries = useMemo(() => {
    const entries = [
      { key: 'own',    label: 'Your Institution',  type: 'solid',  color: C.own },
      { key: 'median', label: 'Peer Median',        type: 'dashed', color: C.median },
      { key: 'band',   label: 'Peer P25–P75 Band',  type: 'area',   color: C.band },
    ];
    if (thresholdY != null) {
      entries.push({
        key: 'threshold',
        label: `Watch Threshold (${fmt(thresholdY)})`,
        type: 'dashed', color: C.threshold,
      });
    }
    if (crossingPeriods.size > 0) {
      entries.push({ key: 'crossing', label: 'Crossed Peer Median', type: 'flag' });
    }
    return entries;
  }, [thresholdY, crossingPeriods, fmt]);

  // ── No-data fallback ─────────────────────────────────────────────────────
  if (!mergedData.length) {
    return (
      <div style={{
        height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#9ca3af', fontSize: 13, fontFamily: 'system-ui, sans-serif',
        border: `1px dashed ${C.border}`, borderRadius: 8,
      }}>
        No data available
      </div>
    );
  }

  const title = METRIC_LABELS[metric] ?? metric.replace(/_/g, ' ');

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: '#111' }}>{title}</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {mergedData.length}q
          {crossingPeriods.size > 0 && (
            <> · {crossingPeriods.size} median crossing{crossingPeriods.size > 1 ? 's' : ''}</>
          )}
        </span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={mergedData} margin={{ top: 18, right: 18, bottom: 2, left: 4 }}>

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

          <Tooltip
            content={renderTooltip}
            cursor={{ stroke: C.border, strokeWidth: 1 }}
          />

          {/*
           * Peer band — stacked area trick:
           *   Area 1 (bandBase = p25): fills 0 → p25; fillOpacity=0 makes it invisible
           *   Area 2 (bandHeight = p75-p25): stacks on top of Area 1; fills p25 → p75
           * Together they produce a shaded region exactly between P25 and P75.
           */}
          <Area
            type="monotone"
            dataKey="bandBase"
            stackId="band"
            fill="transparent"
            fillOpacity={0}
            stroke="none"
            dot={false}
            activeDot={false}
            legendType="none"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="bandHeight"
            stackId="band"
            fill={C.band}
            fillOpacity={BAND_OPACITY}
            stroke="none"
            dot={false}
            activeDot={false}
            legendType="none"
            isAnimationActive={false}
          />

          {/* Peer median — dashed, no dots */}
          <Line
            type="monotone"
            dataKey="median"
            stroke={C.median}
            strokeWidth={1.5}
            strokeDasharray="5 3"
            dot={false}
            activeDot={false}
            legendType="none"
          />

          {/* Own institution — rendered last so it sits on top of the band */}
          <Line
            type="monotone"
            dataKey="own"
            stroke={C.own}
            strokeWidth={2}
            dot={renderOwnDot}
            activeDot={{ r: 5, fill: C.own, stroke: 'white', strokeWidth: 2 }}
            legendType="none"
          />

          {/* NCUA / tenant watch threshold */}
          {thresholdY != null && (
            <ReferenceLine
              y={thresholdY}
              stroke={C.threshold}
              strokeDasharray="6 3"
              strokeWidth={1.5}
              label={{
                value: fmt(thresholdY),
                position: 'insideTopRight',
                fill: C.threshold,
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
        justifyContent: 'center', marginTop: 10,
      }}>
        {legendEntries.map(entry => (
          <div key={entry.key}
               style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {/* Swatch */}
            {entry.type === 'area' && (
              <div style={{
                width: 20, height: 10, borderRadius: 2,
                background: entry.color,
                opacity: BAND_OPACITY + 0.15,
              }} />
            )}
            {entry.type === 'flag' && <FlagIcon size={13} />}
            {(entry.type === 'solid' || entry.type === 'dashed') && (
              <svg width={20} height={3} style={{ display: 'block' }}>
                <line
                  x1={0} y1={1.5} x2={20} y2={1.5}
                  stroke={entry.color}
                  strokeWidth={entry.type === 'dashed' ? 1.5 : 2.5}
                  strokeDasharray={entry.type === 'dashed' ? '4 2' : undefined}
                />
              </svg>
            )}
            {/* Label */}
            <span style={{ fontSize: 11, color: '#555', whiteSpace: 'nowrap' }}>
              {entry.label}
            </span>
          </div>
        ))}
      </div>

    </div>
  );
}
