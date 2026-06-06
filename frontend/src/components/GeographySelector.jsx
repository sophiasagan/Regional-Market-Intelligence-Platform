/**
 * Controls bar rendered above the map.
 *
 * Props:
 *   geoType            'county' | 'msa' | 'state' | 'custom'
 *   onGeoTypeChange    (type: string) => void
 *   period             string   e.g. '2023' or '2024Q2'
 *   onPeriodChange     (period: string) => void
 *   comparePeriod      string | null
 *   onComparePeriodChange (period: string | null) => void
 *   availablePeriods   string[]
 *   drawActive         boolean  — true while polygon drawing is in progress
 *   onStartDraw        () => void  — enable MapboxDraw polygon mode
 *   onCancelDraw       () => void
 */
import React, { useState } from 'react';

const GEO_TYPES = [
  { id: 'county', label: 'County'        },
  { id: 'msa',    label: 'MSA'           },
  { id: 'state',  label: 'State'         },
  { id: 'custom', label: 'Custom Region' },
];

const s = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '10px 16px',
    backgroundColor: '#fff',
    borderBottom: '1px solid #e2e8f0',
    flexWrap: 'wrap',
    zIndex: 10,
    position: 'relative',
  },
  group: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 12, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' },
  segControl: {
    display: 'flex', borderRadius: 6, overflow: 'hidden',
    border: '1px solid #cbd5e1',
  },
  seg: (active) => ({
    padding: '6px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    border: 'none', outline: 'none',
    backgroundColor: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#334155',
    transition: 'background 0.15s',
    borderRight: '1px solid #cbd5e1',
  }),
  select: {
    padding: '6px 10px', fontSize: 13, border: '1px solid #cbd5e1',
    borderRadius: 6, backgroundColor: '#fff', color: '#334155', cursor: 'pointer',
  },
  compareBtn: (active) => ({
    padding: '6px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
    border: '1px solid #cbd5e1', borderRadius: 6, outline: 'none',
    backgroundColor: active ? '#f1f5f9' : '#fff',
    color: active ? '#2563eb' : '#64748b',
  }),
  drawBtn: (active) => ({
    padding: '6px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
    border: '1px solid #cbd5e1', borderRadius: 6, outline: 'none',
    backgroundColor: active ? '#fef3c7' : '#fff',
    color: active ? '#d97706' : '#64748b',
    display: 'flex', alignItems: 'center', gap: 4,
  }),
  divider: { width: 1, height: 24, backgroundColor: '#e2e8f0' },
};

export default function GeographySelector({
  geoType, onGeoTypeChange,
  period, onPeriodChange,
  comparePeriod, onComparePeriodChange,
  availablePeriods = [],
  drawActive, onStartDraw, onCancelDraw,
}) {
  const [compareOpen, setCompareOpen] = useState(!!comparePeriod);

  function toggleCompare() {
    if (compareOpen) {
      setCompareOpen(false);
      onComparePeriodChange(null);
    } else {
      setCompareOpen(true);
      const prev = availablePeriods[1] ?? period;
      onComparePeriodChange(prev);
    }
  }

  const periodOpts = availablePeriods.length
    ? availablePeriods
    : ['2023', '2022', '2021', '2020'];

  return (
    <div style={s.bar}>
      {/* Geography type */}
      <div style={s.group}>
        <span style={s.label}>View by</span>
        <div style={s.segControl}>
          {GEO_TYPES.map((g, i) => (
            <button
              key={g.id}
              style={{ ...s.seg(geoType === g.id), borderRight: i < GEO_TYPES.length - 1 ? '1px solid #cbd5e1' : 'none' }}
              onClick={() => onGeoTypeChange(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Draw tool for custom region */}
      {geoType === 'custom' && (
        <div style={s.group}>
          <button style={s.drawBtn(drawActive)} onClick={drawActive ? onCancelDraw : onStartDraw}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="3,11 22,2 13,21 11,13 3,11" />
            </svg>
            {drawActive ? 'Cancel Draw' : 'Draw Region'}
          </button>
          {drawActive && (
            <span style={{ fontSize: 12, color: '#d97706' }}>
              Click map to draw polygon — double-click to finish
            </span>
          )}
        </div>
      )}

      <div style={s.divider} />

      {/* Period selector */}
      <div style={s.group}>
        <span style={s.label}>Period</span>
        <select style={s.select} value={period} onChange={e => onPeriodChange(e.target.value)}>
          <option value="latest">Latest</option>
          {periodOpts.map(p => (
            <option key={p} value={p}>{formatPeriod(p)}</option>
          ))}
        </select>
      </div>

      {/* Compare period toggle */}
      <div style={s.group}>
        <button style={s.compareBtn(compareOpen)} onClick={toggleCompare}>
          {compareOpen ? '✕ Stop comparing' : '⇄ Compare periods'}
        </button>
        {compareOpen && (
          <>
            <span style={s.label}>vs</span>
            <select
              style={s.select}
              value={comparePeriod ?? ''}
              onChange={e => onComparePeriodChange(e.target.value || null)}
            >
              {periodOpts.map(p => (
                <option key={p} value={p}>{formatPeriod(p)}</option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

function formatPeriod(p) {
  if (!p || p === 'latest') return 'Latest';
  if (p.includes('Q')) return `Q${p[5]} ${p.slice(0, 4)}`;
  return p;
}
