/**
 * Right-panel competitor breakdown for a selected geography.
 *
 * Props:
 *   rows                array of market-share API rows (see API response schema)
 *   ownInstitutionId    charter_or_cert of the tenant's own institution
 *   metric              'deposits' | 'loans' | 'members' | 'mortgage_originations'
 *   onMetricChange      (metric: string) => void
 *   period              string
 *   comparePeriod       string | null
 *   selectedCompetitorId  string | null
 *   onCompetitorSelect  (id: string | null) => void  — activates map overlay
 *   isLoading           boolean
 *   geoLabel            string  — displayed in panel header
 */
import React, { useState, useMemo } from 'react';
import ConfidenceBadge from './ConfidenceBadge';

const METRICS = [
  { id: 'deposits',              label: 'Deposits'     },
  { id: 'loans',                 label: 'Loans'        },
  { id: 'members',               label: 'Members'      },
  { id: 'mortgage_originations', label: 'Mortgages'    },
];

const SORT_OPTIONS = [
  { id: 'share',        label: 'Market Share'  },
  { id: 'share_change', label: 'Share Change'  },
  { id: 'name',         label: 'Name (A–Z)'    },
];

const s = {
  panel: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#fff', overflow: 'hidden' },
  header: { padding: '14px 16px 0', borderBottom: '1px solid #e2e8f0' },
  geoLabel: { fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 10 },
  metricTabs: { display: 'flex', gap: 0, marginBottom: 0 },
  tab: (active) => ({
    padding: '8px 14px', fontSize: 13, fontWeight: 500,
    border: 'none', outline: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0',
    backgroundColor: active ? '#2563eb' : 'transparent',
    color: active ? '#fff' : '#64748b',
    borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
  }),
  controls: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
    borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap',
  },
  select: {
    padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1',
    borderRadius: 5, backgroundColor: '#fff', color: '#334155',
  },
  filterGroup: { display: 'flex', border: '1px solid #cbd5e1', borderRadius: 5, overflow: 'hidden' },
  filterBtn: (active) => ({
    padding: '5px 10px', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
    backgroundColor: active ? '#e0e7ff' : '#fff', color: active ? '#2563eb' : '#64748b',
    borderRight: '1px solid #cbd5e1',
  }),
  exportBtn: {
    marginLeft: 'auto', padding: '5px 10px', fontSize: 12, fontWeight: 500,
    border: '1px solid #cbd5e1', borderRadius: 5, cursor: 'pointer',
    backgroundColor: '#fff', color: '#64748b', display: 'flex', alignItems: 'center', gap: 4,
  },
  tableWrap: { flex: 1, overflowY: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11,
    color: '#64748b', backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0',
    position: 'sticky', top: 0, cursor: 'pointer', userSelect: 'none',
    whiteSpace: 'nowrap',
  },
  td: { padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' },
  ownRow: { backgroundColor: '#eff6ff' },
  selectedRow: { backgroundColor: '#fef3c7' },
  institutionName: { fontWeight: 500, color: '#0f172a' },
  ownBadge: {
    display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '1px 5px',
    borderRadius: 3, backgroundColor: '#2563eb', color: '#fff', marginLeft: 5,
  },
  typeBadge: (type) => ({
    display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '2px 6px',
    borderRadius: 3, whiteSpace: 'nowrap',
    backgroundColor: type === 'credit_union' ? '#e0f2fe' : '#fce7f3',
    color: type === 'credit_union' ? '#0369a1' : '#9d174d',
  }),
  sharePct: { fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  changePositive: { color: '#16a34a', fontWeight: 500, fontVariantNumeric: 'tabular-nums' },
  changeNegative: { color: '#dc2626', fontWeight: 500, fontVariantNumeric: 'tabular-nums' },
  changeNeutral: { color: '#64748b', fontVariantNumeric: 'tabular-nums' },
  emptyState: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 200, color: '#94a3b8', fontSize: 14,
  },
  skeleton: { backgroundColor: '#e2e8f0', borderRadius: 4, animation: 'pulse 1.5s infinite' },
  competitorBtn: (active) => ({
    padding: '3px 8px', fontSize: 11, fontWeight: 500, border: '1px solid #cbd5e1',
    borderRadius: 4, cursor: 'pointer', outline: 'none',
    backgroundColor: active ? '#fef3c7' : '#fff',
    color: active ? '#d97706' : '#64748b',
  }),
};

export default function CompetitorTable({
  rows = [], ownInstitutionId, metric, onMetricChange,
  period, comparePeriod, selectedCompetitorId, onCompetitorSelect,
  isLoading, geoLabel,
}) {
  const [sort, setSort]       = useState('share');
  const [sortDir, setSortDir] = useState('desc');
  const [filter, setFilter]   = useState('all');   // 'all' | 'credit_union' | 'bank'

  function handleSort(col) {
    if (sort === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSort(col); setSortDir('desc'); }
  }

  const displayed = useMemo(() => {
    let r = filter === 'all' ? rows : rows.filter(row => row.institution_type === filter);
    const dir = sortDir === 'desc' ? -1 : 1;
    r = [...r].sort((a, b) => {
      if (sort === 'name')         return dir * a.institution_name.localeCompare(b.institution_name);
      if (sort === 'share_change') return dir * ((a.share_change_prior_period ?? 0) - (b.share_change_prior_period ?? 0));
      return dir * (a.market_share - b.market_share);
    });
    return r;
  }, [rows, sort, sortDir, filter]);

  function sortIndicator(col) {
    if (sort !== col) return ' ↕';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  }

  function formatShare(v) {
    return v != null ? `${(v * 100).toFixed(2)}%` : '—';
  }

  function formatChange(v) {
    if (v == null) return null;
    const pct = (v * 100).toFixed(2);
    return v > 0 ? `+${pct}pp` : `${pct}pp`;
  }

  function changeStyle(v) {
    if (v == null) return s.changeNeutral;
    return v > 0 ? s.changePositive : v < 0 ? s.changeNegative : s.changeNeutral;
  }

  function trendArrow(v) {
    if (v == null) return '—';
    if (v > 0.001)  return '▲';
    if (v < -0.001) return '▼';
    return '→';
  }

  function exportCSV() {
    const cols = ['institution_name', 'institution_type', 'market_share',
                   'share_change_prior_period', 'confidence'];
    const header = cols.join(',');
    const body = displayed.map(r =>
      cols.map(c => JSON.stringify(r[c] ?? '')).join(',')
    ).join('\n');
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url,
      download: `market-share-${geoLabel}-${period}.csv` });
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div style={s.panel}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.geoLabel}>{geoLabel || 'Select a geography'}</div>
        <div style={s.metricTabs}>
          {METRICS.map(m => (
            <button key={m.id} style={s.tab(metric === m.id)} onClick={() => onMetricChange(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={s.controls}>
        <div style={s.filterGroup}>
          {[['all','All'],['credit_union','Credit Unions'],['bank','Banks']].map(([id,lbl],i,arr) => (
            <button
              key={id}
              style={{ ...s.filterBtn(filter === id), borderRight: i < arr.length - 1 ? '1px solid #cbd5e1' : 'none' }}
              onClick={() => setFilter(id)}
            >
              {lbl}
            </button>
          ))}
        </div>

        <select style={s.select} value={sort} onChange={e => { setSort(e.target.value); setSortDir('desc'); }}>
          {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>

        <button style={s.exportBtn} onClick={exportCSV} title="Export as CSV">
          ↓ CSV
        </button>
      </div>

      {/* Table */}
      <div style={s.tableWrap}>
        {isLoading ? (
          <LoadingSkeleton />
        ) : displayed.length === 0 ? (
          <div style={s.emptyState}>
            {geoLabel ? 'No data for this geography and period.' : 'Click a county on the map to see competitive data.'}
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th} onClick={() => handleSort('name')}>
                  Institution{sortIndicator('name')}
                </th>
                <th style={{ ...s.th, textAlign: 'right' }} onClick={() => handleSort('share')}>
                  Share{sortIndicator('share')}
                </th>
                <th style={{ ...s.th, textAlign: 'right' }} onClick={() => handleSort('share_change')}>
                  Δ vs Prior{sortIndicator('share_change')}
                </th>
                <th style={s.th}>Quality</th>
                <th style={s.th}>Overlay</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(row => {
                const isOwn      = row.charter_or_cert === ownInstitutionId;
                const isSelected = row.charter_or_cert === selectedCompetitorId;
                const change     = comparePeriod
                  ? row.share_change_prior_period
                  : row.share_change_prior_period;
                return (
                  <tr
                    key={row.charter_or_cert}
                    style={isOwn ? s.ownRow : isSelected ? s.selectedRow : undefined}
                  >
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={s.institutionName}>{row.institution_name}</span>
                        {isOwn && <span style={s.ownBadge}>YOU</span>}
                      </div>
                      <span style={s.typeBadge(row.institution_type)}>
                        {row.institution_type === 'credit_union' ? 'Credit Union' : 'Bank'}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <span style={s.sharePct}>{formatShare(row.market_share)}</span>
                    </td>
                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <span style={{ ...changeStyle(change), marginRight: 4 }}>
                        {trendArrow(change)}
                      </span>
                      <span style={changeStyle(change)}>
                        {formatChange(change) ?? '—'}
                      </span>
                    </td>
                    <td style={s.td}>
                      <ConfidenceBadge confidence={row.confidence} />
                    </td>
                    <td style={s.td}>
                      {!isOwn && (
                        <button
                          style={s.competitorBtn(isSelected)}
                          onClick={() => onCompetitorSelect(isSelected ? null : row.charter_or_cert)}
                          title={isSelected ? 'Remove overlay' : 'Show on map'}
                        >
                          {isSelected ? '✕ Hide' : '⊕ Map'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>
        {Array.from({ length: 8 }).map((_, i) => (
          <tr key={i}>
            {[200, 70, 70, 70, 60].map((w, j) => (
              <td key={j} style={{ padding: '10px 12px' }}>
                <div style={{ ...s.skeleton, height: 14, width: w, maxWidth: '100%' }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
