/**
 * PeerComparison — line-by-line NCUA schedule benchmarking.
 *
 * API consumed:
 *   GET /peer-comparison/{charter}?period=&schedule=&peer_group_id=
 *   GET /delinquency/{charter}/trend?metric=&n_quarters=8
 *   GET /delinquency/latest-period
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import PeerBandChart from '../components/PeerBandChart';

const API         = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const OWN_CHARTER = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';
const OWN_STATE   = import.meta.env.VITE_OWN_INSTITUTION_STATE ?? '';

// ── Navigation tree ───────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  {
    id: 'financials', label: 'Financial Statements', items: [
      { id: 'sfc_assets',  label: 'Statement of Financial Condition — Assets',            schedule: 'balance_sheet' },
      { id: 'sfc_liab',    label: 'Statement of Financial Condition — Liabilities & Equity', schedule: 'capital' },
      { id: 'income',      label: 'Statement of Income and Expense',                      schedule: 'earnings' },
    ],
  },
  {
    id: 'loans', label: 'Loan Information', items: [
      { id: 'loan_comp',   label: 'Schedule A — Loan Composition',                        schedule: 'balance_sheet',  view: 'loans' },
      { id: 'delinq_60',   label: 'Schedule A — Delinquency (60+ by type)',               schedule: 'asset_quality',  view: 'delinquency' },
      { id: 'delinq_30',   label: 'Schedule A — Delinquency (30-59 days)',                schedule: 'asset_quality',  view: 'delinquency_30' },
      { id: 'chargeoff',   label: 'Schedule A — Charge-Offs and Recoveries',              schedule: 'asset_quality',  view: 'chargeoff' },
      { id: 'indirect',    label: 'Schedule A — Indirect Loans',                          schedule: 'asset_quality',  view: 'indirect' },
      { id: 'commercial',  label: 'Schedule A — Commercial Lending',                      schedule: 'asset_quality',  view: 'commercial' },
    ],
  },
  {
    id: 'capital_mem', label: 'Capital and Membership', items: [
      { id: 'shares',      label: 'Schedule D — Shares and Members',                      schedule: 'balance_sheet',  view: 'shares' },
      { id: 'cap_adeq',    label: 'Schedule G — Capital Adequacy',                        schedule: 'capital' },
    ],
  },
  {
    id: 'ratios', label: 'Key Ratios (Computed)', items: [
      { id: 'aq_ratios',   label: 'Asset Quality Ratios',                                 schedule: 'asset_quality' },
      { id: 'nco_ratios',  label: 'Charge-Off Ratios by Type',                           schedule: 'asset_quality',  view: 'chargeoff_ratios' },
      { id: 'fp_ratios',   label: 'Financial Performance Ratios',                         schedule: 'earnings' },
      { id: 'cap_liq',     label: 'Capital and Liquidity Ratios',                         schedule: 'liquidity' },
    ],
  },
];

// Account codes to show per view type (subset of full schedule)
const VIEW_FILTER = {
  delinquency:      ['delinq_rate_total','delinq_90plus_rate','delinq_rate_auto','delinq_rate_real_estate','delinq_rate_first_mortgage','delinq_rate_credit_card','delinq_rate_commercial'],
  delinquency_30:   ['delinq_rate_total','delinq_rate_auto','delinq_rate_real_estate','delinq_rate_credit_card'],
  chargeoff:        ['chargeoff_rate_total','alll_coverage_ratio','alll_to_loans_ratio'],
  chargeoff_ratios: ['chargeoff_rate_total','alll_coverage_ratio','alll_to_loans_ratio','tdr_to_loans_ratio','oreo_to_assets_ratio'],
  indirect:         ['delinq_rate_indirect'],
  commercial:       ['delinq_rate_commercial'],
  loans:            ['total_loans','loan_to_share_ratio'],
  shares:           ['total_deposits','total_members'],
};

function authHeaders() {
  const tok = localStorage.getItem('token') ?? '';
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(val, format) {
  if (val == null || isNaN(val)) return '—';
  switch (format) {
    case 'dollar': {
      const abs = Math.abs(val);
      if (abs >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
      if (abs >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
      return `$${val.toFixed(0)}`;
    }
    case 'percent': return `${(val * 100).toFixed(2)}%`;
    case 'bp':      return `${(val * 10000).toFixed(1)} bp`;
    case 'ratio':   return `${val.toFixed(2)}×`;
    case 'count':   return Number(val).toLocaleString();
    default:        return val.toFixed(4);
  }
}

function fmtRank(r) {
  if (r == null) return '—';
  return `${(r * 100).toFixed(0)}th`;
}

function assetTierLabel(assets) {
  if (!assets) return 'All Sizes';
  if (assets < 250e6)  return 'Under $250M';
  if (assets < 1e9)    return '$250M–$1B';
  if (assets < 5e9)    return '$1B–$5B';
  return 'Over $5B';
}

// ── Small pure components ─────────────────────────────────────────────────────

function Stars({ n }) {
  if (n == null) return <span style={{ color: '#cbd5e1', fontSize: 11 }}>—</span>;
  return (
    <span style={{ letterSpacing: 1, fontSize: 12 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{ color: i <= n ? '#f59e0b' : '#e2e8f0' }}>★</span>
      ))}
    </span>
  );
}

function PercentileBar({ rank, isAdverse }) {
  if (rank == null) return null;
  const display = isAdverse ? 1 - rank : rank;
  const color = display >= 0.9 ? '#16a34a' : display <= 0.1 ? '#dc2626' : '#94a3b8';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 90 }}>
      <div style={{ flex: 1, height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${display * 100}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, color, fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 26 }}>
        {fmtRank(rank)}
      </span>
    </div>
  );
}

function BucketBars({ row }) {
  const { peer_p10: p10, peer_p25: p25, peer_median: med, peer_p75: p75, peer_p90: p90, institution_value: val, display_format: df } = row;
  if (med == null) return null;
  const vals = [p10, p25, med, p75, p90].filter(v => v != null);
  const lo = Math.min(...vals, val ?? Infinity);
  const hi = Math.max(...vals, val ?? -Infinity);
  if (hi <= lo) return null;
  const pct = v => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div style={{ paddingTop: 10, paddingBottom: 6 }}>
      <div style={{ position: 'relative', height: 20, background: '#f8fafc', borderRadius: 4, margin: '0 4px' }}>
        {/* IQR band */}
        {p25 != null && p75 != null && (
          <div style={{ position: 'absolute', left: pct(p25), width: `calc(${pct(p75)} - ${pct(p25)})`, height: '100%', background: '#dbeafe', borderRadius: 2 }} />
        )}
        {/* Median */}
        {med != null && <div style={{ position: 'absolute', left: pct(med), width: 2, height: '100%', background: '#2563eb' }} />}
        {/* Own */}
        {val != null && (
          <div style={{ position: 'absolute', left: `calc(${pct(val)} - 5px)`, top: 2, width: 10, height: 16, background: '#0f172a', borderRadius: 3, zIndex: 2 }} title={fmt(val, df)} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#94a3b8', margin: '2px 4px 0', fontVariantNumeric: 'tabular-nums' }}>
        <span>{fmt(p10, df)}</span>
        <span style={{ color: '#64748b', fontWeight: 600 }}>median {fmt(med, df)}</span>
        <span>{fmt(p90, df)}</span>
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ selected, onSelect, collapsed, onToggle }) {
  const [open, setOpen] = useState(() => {
    const s = {};
    NAV_SECTIONS.forEach(sec => { s[sec.id] = true; });
    return s;
  });

  return (
    <div style={{
      width: collapsed ? 36 : 230, flexShrink: 0, borderRight: '1px solid #e2e8f0',
      background: '#fafafa', display: 'flex', flexDirection: 'column',
      transition: 'width 0.2s', overflow: 'hidden',
    }}>
      {/* Collapse button */}
      <button
        onClick={onToggle}
        style={{ alignSelf: 'flex-end', margin: '8px 6px 4px', padding: '4px 6px', fontSize: 11, background: 'none', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', color: '#64748b', flexShrink: 0 }}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        {collapsed ? '›' : '‹'}
      </button>
      {!collapsed && (
        <div style={{ overflow: 'auto', flex: 1, paddingBottom: 16 }}>
          {NAV_SECTIONS.map(sec => (
            <div key={sec.id}>
              <button
                onClick={() => setOpen(o => ({ ...o, [sec.id]: !o[sec.id] }))}
                style={{ width: '100%', textAlign: 'left', padding: '7px 14px 5px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
              >
                {sec.label}
                <span style={{ fontSize: 9 }}>{open[sec.id] ? '▲' : '▼'}</span>
              </button>
              {open[sec.id] && sec.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => onSelect(item)}
                  style={{
                    width: '100%', textAlign: 'left', padding: '6px 16px 6px 18px',
                    fontSize: 12, background: selected?.id === item.id ? '#eff6ff' : 'none',
                    border: 'none', borderLeft: `2px solid ${selected?.id === item.id ? '#2563eb' : 'transparent'}`,
                    cursor: 'pointer', color: selected?.id === item.id ? '#1d4ed8' : '#374151',
                    fontWeight: selected?.id === item.id ? 600 : 400, lineHeight: 1.35,
                    transition: 'all 0.1s',
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Trend drawer ──────────────────────────────────────────────────────────────

function TrendDrawer({ row, charter, period, onClose }) {
  const [trend, setTrend] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!row || !charter) return;
    setLoading(true); setTrend(null);
    fetch(
      `${API}/delinquency/${charter}/trend?metric=${row.account_code}&n_quarters=8`,
      { headers: authHeaders() }
    )
      .then(r => r.json())
      .then(setTrend)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [row, charter]);

  const navigate = useNavigate();

  if (!row) return null;

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 440, zIndex: 200,
      background: '#fff', borderLeft: '1px solid #e2e8f0',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column',
    }}>
      {/* Drawer header */}
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{row.line_item}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            {row.account_code} · {period}
            {row.is_adverse ? ' · lower is better' : ' · higher is better'}
          </div>
        </div>
        <button onClick={onClose} style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0 4px' }}>×</button>
      </div>

      {/* Current value summary */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 20 }}>
        {[
          { label: 'Your value', val: fmt(row.institution_value, row.display_format), bold: true },
          { label: 'Peer median', val: fmt(row.peer_median, row.display_format) },
          { label: 'Percentile', val: fmtRank(row.percentile_rank) },
        ].map(({ label, val, bold }) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: bold ? 700 : 500, color: '#0f172a' }}>{val}</div>
          </div>
        ))}
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stars</div>
          <Stars n={row.stars} />
        </div>
      </div>

      {/* Trend chart */}
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>Loading trend…</div>}
        {!loading && trend && (
          <PeerBandChart
            institutionData={trend.institution ?? []}
            peerMedian={trend.peer_median ?? []}
            peerTopDecile={trend.peer_top_decile ?? []}
            peerBottomDecile={trend.peer_bottom_decile ?? []}
            peerBand={trend.peer_band ?? []}
            metric={row.account_code}
            periods={trend.periods ?? []}
            peerGroupLabel="State peers (similar size)"
            peerCount={trend.peer_count}
            percentileRank={trend.percentile_rank}
            height={220}
          />
        )}
        {!loading && !trend && (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>
            Trend data unavailable for this metric.
          </div>
        )}
      </div>

      {/* Explain button */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid #f1f5f9' }}>
        <button
          onClick={() => navigate?.(`/query?metric=${row.account_code}&context=${encodeURIComponent(row.line_item)}`)}
          style={{ width: '100%', padding: '8px 0', fontSize: 12, fontWeight: 600, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 5, cursor: 'pointer' }}
        >
          Explain this metric in the AI assistant →
        </button>
      </div>
    </div>
  );
}

// ── Standard comparison table ─────────────────────────────────────────────────

const ROW_BG = { green: '#f0fdf4', red: '#fef2f2', white: '#fff', null: '#fff' };
const ROW_BORDER = { green: '#86efac', red: '#fecaca', white: '#f1f5f9', null: '#f1f5f9' };

function StandardTable({ rows, viewType, onRowClick, expandedRow }) {
  const filtered = viewType && VIEW_FILTER[viewType]
    ? rows.filter(r => VIEW_FILTER[viewType].includes(r.account_code))
    : rows;

  const isChargeoff = viewType === 'chargeoff' || viewType === 'chargeoff_ratios';

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
          <th style={TH}>Line Item</th>
          <th style={{ ...TH, width: 80 }}>Account</th>
          <th style={{ ...TH, textAlign: 'right' }}>Your Value {isChargeoff && <span style={{ color: '#94a3b8', fontWeight: 400 }}>(ann. ×4)</span>}</th>
          <th style={{ ...TH, textAlign: 'right' }}>Peer Median</th>
          <th style={{ ...TH, textAlign: 'right' }}>Top Decile</th>
          <th style={{ ...TH, textAlign: 'right' }}>Percentile</th>
          <th style={{ ...TH, textAlign: 'center', width: 80 }}>Stars</th>
        </tr>
      </thead>
      <tbody>
        {filtered.map(row => {
          const expanded = expandedRow === row.account_code;
          const bg = ROW_BG[row.color_flag ?? 'null'];
          const bdColor = ROW_BORDER[row.color_flag ?? 'null'];
          const topDecile = row.is_adverse ? row.peer_p10 : row.peer_p90;
          return (
            <React.Fragment key={row.account_code}>
              <tr
                onClick={() => onRowClick(row)}
                style={{ background: bg, borderBottom: `1px solid ${bdColor}`, cursor: 'pointer', transition: 'filter 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.filter = 'brightness(0.97)'}
                onMouseLeave={e => e.currentTarget.style.filter = ''}
              >
                <td style={{ padding: '8px 16px' }}>
                  <div style={{ fontWeight: 500, color: '#1e293b' }}>{row.line_item}</div>
                  {row.threshold != null && (
                    <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 1 }}>
                      Examiner threshold: {fmt(row.threshold, row.display_format)}
                      {row.institution_value != null && row.is_adverse && row.institution_value > row.threshold && (
                        <span style={{ color: '#dc2626', fontWeight: 700 }}> ▲ breached</span>
                      )}
                    </div>
                  )}
                </td>
                <td style={{ padding: '8px 16px', color: '#94a3b8', fontFamily: 'monospace', fontSize: 11 }}>{row.account_code}</td>
                <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#0f172a' }}>
                  {fmt(row.institution_value, row.display_format)}
                </td>
                <td style={{ padding: '8px 16px', textAlign: 'right', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(row.peer_median, row.display_format)}
                </td>
                <td style={{ padding: '8px 16px', textAlign: 'right', color: row.is_adverse ? '#16a34a' : '#2563eb', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmt(topDecile, row.display_format)}
                </td>
                <td style={{ padding: '8px 16px' }}>
                  <PercentileBar rank={row.percentile_rank} isAdverse={row.is_adverse} />
                </td>
                <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                  <Stars n={row.stars} />
                </td>
              </tr>
              {expanded && (
                <tr style={{ background: bg }}>
                  <td colSpan={7} style={{ padding: '0 16px 8px' }}>
                    <BucketBars row={row} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Delinquency special table ─────────────────────────────────────────────────

const DELINQ_TYPES = [
  { code: 'delinq_rate_total',           label: 'Total',              adverse: true },
  { code: 'delinq_rate_auto',            label: 'Auto Loans',         adverse: true },
  { code: 'delinq_rate_real_estate',     label: 'Real Estate',        adverse: true },
  { code: 'delinq_rate_first_mortgage',  label: '1st Mortgage',       adverse: true },
  { code: 'delinq_rate_credit_card',     label: 'Credit Card',        adverse: true },
  { code: 'delinq_rate_commercial',      label: 'Commercial',         adverse: true },
  { code: 'delinq_rate_indirect',        label: 'Indirect',           adverse: true },
  { code: 'delinq_90plus_rate',          label: '90+ Days (Total)',   adverse: true },
];

function DelinquencyTable({ rows, show30, onRowClick, expandedRow }) {
  const byCode = Object.fromEntries(rows.map(r => [r.account_code, r]));
  const types = DELINQ_TYPES.filter(t => !show30 || t.code !== 'delinq_90plus_rate');

  return (
    <div>
      <div style={{ padding: '8px 16px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: 11, color: '#92400e' }}>
        Delinquency rate = delinquent balance ÷ total loans in category. All values are institution-level NCUA measurements (confidence: measured).
        {!show30 && ' Showing 60+ day delinquency. '}
        {show30  && ' Showing 30-59 day delinquency. '}
        Bucket breakdowns (30-59 / 60-89 / 90-179 / 180-359 / 360+) require loan-level data integration.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
            <th style={TH}>Loan Type</th>
            <th style={{ ...TH, textAlign: 'right' }}>{show30 ? '30-59 Day Rate' : '60+ Day Rate'}</th>
            <th style={{ ...TH, textAlign: 'right' }}>Peer Median</th>
            <th style={{ ...TH, textAlign: 'right' }}>Top Decile</th>
            <th style={{ ...TH }}>vs Peer</th>
            <th style={{ ...TH, textAlign: 'center' }}>Stars</th>
            <th style={{ ...TH, textAlign: 'center', width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {types.map(t => {
            const row = byCode[t.code];
            if (!row) return null;
            const expanded = expandedRow === t.code;
            const bg = ROW_BG[row.color_flag ?? 'null'];
            return (
              <React.Fragment key={t.code}>
                <tr
                  onClick={() => onRowClick(row)}
                  style={{ background: bg, borderBottom: `1px solid ${ROW_BORDER[row.color_flag ?? 'null']}`, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.filter = 'brightness(0.97)'}
                  onMouseLeave={e => e.currentTarget.style.filter = ''}
                >
                  <td style={{ padding: '8px 16px', fontWeight: t.code === 'delinq_rate_total' ? 700 : 400, color: '#1e293b' }}>
                    {t.label}
                    {row.threshold && row.institution_value > row.threshold && (
                      <span style={{ marginLeft: 6, background: '#fef2f2', color: '#dc2626', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, border: '1px solid #fecaca' }}>ABOVE THRESHOLD</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: row.color_flag === 'red' ? '#dc2626' : row.color_flag === 'green' ? '#16a34a' : '#0f172a' }}>
                    {fmt(row.institution_value, 'percent')}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(row.peer_median, 'percent')}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: '#16a34a', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {fmt(row.peer_p10, 'percent')}
                  </td>
                  <td style={{ padding: '8px 16px' }}>
                    <PercentileBar rank={row.percentile_rank} isAdverse />
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                    <Stars n={row.stars} />
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                    <button
                      onClick={e => { e.stopPropagation(); onRowClick(row); }}
                      style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
                      title="Expand distribution"
                    >
                      {expanded ? '▲' : '▼'}
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr style={{ background: bg }}>
                    <td colSpan={7} style={{ padding: '0 16px 8px' }}>
                      <BucketBars row={row} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Charge-off special table ──────────────────────────────────────────────────

const NCO_ROWS = [
  { code: 'chargeoff_rate_total', label: 'Net Charge-Off Ratio',                      adverse: true  },
  { code: 'alll_coverage_ratio',  label: 'Allowance for Loan Losses / Delinquency',   adverse: false },
  { code: 'alll_to_loans_ratio',  label: 'Allowance for Loan Losses / Total Loans',   adverse: false },
  { code: 'tdr_to_loans_ratio',   label: 'TDR to Total Loans',                        adverse: true  },
  { code: 'oreo_to_assets_ratio', label: 'OREO to Total Assets',                      adverse: true  },
];

function ChargeOffTable({ rows, onRowClick, expandedRow }) {
  const byCode = Object.fromEntries(rows.map(r => [r.account_code, r]));
  return (
    <div>
      <div style={{ padding: '8px 16px', background: '#f0f9ff', borderBottom: '1px solid #bae6fd', fontSize: 11, color: '#0369a1' }}>
        NCO Rate is annualized (quarterly net charge-offs × 4 ÷ total loans). ALLL coverage and ratio are point-in-time.
        CECL institutions may show 0 ALLL — excluded from coverage ratio peer distribution.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc', position: 'sticky', top: 0, zIndex: 1 }}>
            <th style={TH}>Metric</th>
            <th style={{ ...TH, textAlign: 'right' }}>Your Value</th>
            <th style={{ ...TH, textAlign: 'right', color: '#94a3b8' }}><em>annualized ×4</em></th>
            <th style={{ ...TH, textAlign: 'right' }}>Peer Median</th>
            <th style={{ ...TH, textAlign: 'right' }}>Top Decile</th>
            <th style={{ ...TH }}>Percentile</th>
            <th style={{ ...TH, textAlign: 'center' }}>Stars</th>
          </tr>
        </thead>
        <tbody>
          {NCO_ROWS.map(t => {
            const row = byCode[t.code];
            if (!row) return null;
            const expanded = expandedRow === t.code;
            const bg = ROW_BG[row.color_flag ?? 'null'];
            const isNco = t.code === 'chargeoff_rate_total';
            return (
              <React.Fragment key={t.code}>
                <tr
                  onClick={() => onRowClick(row)}
                  style={{ background: bg, borderBottom: `1px solid ${ROW_BORDER[row.color_flag ?? 'null']}`, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.filter = 'brightness(0.97)'}
                  onMouseLeave={e => e.currentTarget.style.filter = ''}
                >
                  <td style={{ padding: '8px 16px', fontWeight: 500, color: '#1e293b' }}>{t.label}</td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: row.color_flag === 'red' ? '#dc2626' : row.color_flag === 'green' ? '#16a34a' : '#0f172a' }}>
                    {fmt(row.institution_value, row.display_format)}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: '#94a3b8', fontSize: 11 }}>
                    {isNco ? '(ann. ×4)' : '—'}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(row.peer_median, row.display_format)}
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: t.adverse ? '#16a34a' : '#2563eb', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {fmt(t.adverse ? row.peer_p10 : row.peer_p90, row.display_format)}
                  </td>
                  <td style={{ padding: '8px 16px' }}>
                    <PercentileBar rank={row.percentile_rank} isAdverse={t.adverse} />
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                    <Stars n={row.stars} />
                  </td>
                </tr>
                {expanded && (
                  <tr style={{ background: bg }}>
                    <td colSpan={7} style={{ padding: '0 16px 8px' }}>
                      <BucketBars row={row} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Shared table header style ─────────────────────────────────────────────────

const TH = {
  padding: '8px 16px', fontSize: 11, fontWeight: 600, color: '#64748b',
  textTransform: 'uppercase', letterSpacing: '0.04em',
  borderBottom: '1px solid #e2e8f0', textAlign: 'left', whiteSpace: 'nowrap',
};

// ── CSV export ────────────────────────────────────────────────────────────────

function downloadCSV(data, navItem) {
  if (!data?.rows?.length) return;
  const hdr = ['Line Item', 'Account Code', 'Your Value', 'Peer P10', 'Peer P25', 'Peer Median', 'Peer P75', 'Peer P90', 'N Peers', 'Percentile Rank', 'Stars', 'Color Flag', 'Display Format', 'Is Adverse'];
  const rws = data.rows.map(r => [
    `"${r.line_item}"`, r.account_code,
    r.institution_value ?? '', r.peer_p10 ?? '', r.peer_p25 ?? '',
    r.peer_median ?? '', r.peer_p75 ?? '', r.peer_p90 ?? '',
    r.n_peers ?? '', r.percentile_rank != null ? (r.percentile_rank * 100).toFixed(2) + '%' : '',
    r.stars ?? '', r.color_flag ?? '', r.display_format, r.is_adverse ? 'Y' : 'N',
  ]);
  const csv = [hdr, ...rws].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `${navItem.id}_${data.period}.csv` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Period helpers ────────────────────────────────────────────────────────────

function recentPeriods(latest, n = 12) {
  if (!latest) return [];
  const periods = [];
  let [y, q] = [parseInt(latest), parseInt(latest[5])];
  for (let i = 0; i < n; i++) {
    periods.push(`${y}Q${q}`);
    if (--q < 1) { q = 4; y--; }
  }
  return periods;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PeerComparison() {
  const [charter, setCharter]           = useState(OWN_CHARTER);
  const [charterInput, setCharterInput] = useState('');
  const [sidebarCollapsed, setSidebar]  = useState(false);
  const [selectedNav, setSelectedNav]   = useState(NAV_SECTIONS[3].items[0]); // Asset Quality Ratios
  const [period, setPeriod]             = useState('');
  const [latestPeriod, setLatestPeriod] = useState('');
  const [peerGroupType, setPeerGroupType] = useState('state'); // 'state' | 'national'
  const [data, setData]                 = useState(null);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [drawerRow, setDrawerRow]       = useState(null);
  const [expandedRow, setExpandedRow]   = useState(null);

  // Fetch latest period once
  useEffect(() => {
    fetch(`${API}/delinquency/latest-period`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setLatestPeriod(d.period ?? '');
        if (!period) setPeriod(d.period ?? '');
      })
      .catch(() => {});
  }, []);

  // Fetch comparison data when deps change
  useEffect(() => {
    if (!charter || !period || !selectedNav) return;
    setLoading(true); setError(''); setData(null);
    const qs = new URLSearchParams({ period, schedule: selectedNav.schedule });
    fetch(`${API}/peer-comparison/${charter}?${qs}`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message ?? 'Failed to load comparison data'))
      .finally(() => setLoading(false));
  }, [charter, period, selectedNav]);

  const handleRowClick = useCallback((row) => {
    setExpandedRow(prev => prev === row.account_code ? null : row.account_code);
    setDrawerRow(row);
  }, []);

  const instName  = data?.institution?.name ?? charter;
  const instState = data?.institution?.state ?? OWN_STATE;
  const instAssets= data?.institution?.total_assets;
  const peerLabel = data?.peer_group?.label ?? `${instState} state peers`;
  const nPeers    = data?.peer_group?.n_peers ?? 0;
  const viewType  = selectedNav?.view ?? '';
  const periods   = recentPeriods(latestPeriod);

  const greenCount = data?.rows?.filter(r => r.color_flag === 'green').length ?? 0;
  const redCount   = data?.rows?.filter(r => r.color_flag === 'red').length ?? 0;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 44px)', fontFamily: 'system-ui, -apple-system, sans-serif', overflow: 'hidden' }}>

      {/* Sidebar */}
      <Sidebar
        selected={selectedNav}
        onSelect={item => { setSelectedNav(item); setDrawerRow(null); setExpandedRow(null); }}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebar(c => !c)}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Charter input — shown when VITE_OWN_INSTITUTION_ID not set */}
        {!charter && (
          <div style={{ padding: '10px 20px', background: '#fefce8', borderBottom: '1px solid #fde68a', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: '#854d0e' }}>Enter your NCUA charter number to load data:</span>
            <input
              type="text" value={charterInput} maxLength={7}
              onChange={e => setCharterInput(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => e.key === 'Enter' && charterInput.length >= 4 && setCharter(charterInput)}
              placeholder="e.g. 68535"
              style={{ padding: '4px 8px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4, width: 100 }}
            />
            <button
              onClick={() => charterInput.length >= 4 && setCharter(charterInput)}
              disabled={charterInput.length < 4}
              style={{ padding: '4px 12px', fontSize: 12, fontWeight: 600, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: charterInput.length < 4 ? 0.5 : 1 }}
            >
              Load →
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', flexShrink: 0, background: '#fff' }}>
          {/* Schedule title */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selectedNav?.label}
            </div>
            {instName && (
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {instName} · {period}
                {nPeers > 0 && ` · ${nPeers} peers`}
              </div>
            )}
          </div>

          {/* Period selector */}
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #d1d5db', borderRadius: 4, color: '#374151' }}
          >
            {periods.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          {/* Peer group toggle */}
          <div style={{ display: 'flex', border: '1px solid #e2e8f0', borderRadius: 5, overflow: 'hidden', fontSize: 11 }}>
            {[
              { key: 'state',    label: `${instState || OWN_STATE || 'State'} CUs` },
              { key: 'national', label: `US ${assetTierLabel(instAssets)}` },
            ].map(opt => (
              <button
                key={opt.key}
                onClick={() => setPeerGroupType(opt.key)}
                style={{ padding: '5px 10px', fontWeight: peerGroupType === opt.key ? 600 : 400, background: peerGroupType === opt.key ? '#dbeafe' : '#fff', color: peerGroupType === opt.key ? '#1d4ed8' : '#64748b', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Score summary pills */}
          {data && (
            <>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 20, padding: '2px 8px' }}>
                ★ {greenCount} top decile
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 20, padding: '2px 8px' }}>
                ▼ {redCount} bottom decile
              </span>
            </>
          )}

          {/* Download */}
          <button
            onClick={() => downloadCSV(data, selectedNav)}
            disabled={!data}
            style={{ padding: '5px 10px', fontSize: 11, fontWeight: 500, border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: data ? 'pointer' : 'not-allowed', color: '#374151', opacity: data ? 1 : 0.5, flexShrink: 0 }}
          >
            ↓ Export CSV
          </button>
        </div>

        {/* Peer group label bar */}
        {data && (
          <div style={{ padding: '6px 20px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9', fontSize: 11, color: '#64748b', display: 'flex', gap: 16, flexShrink: 0 }}>
            <span>Peer group: <strong style={{ color: '#334155' }}>{peerLabel}</strong></span>
            {nPeers > 0 && <span>n = {nPeers} institutions</span>}
            <span style={{ color: '#94a3b8', marginLeft: 'auto' }}>
              Green = top decile (best) · Red = bottom decile (worst)
              {(viewType === 'delinquency' || viewType === 'chargeoff') && ' · All figures measured (NCUA 5300)'}
            </span>
          </div>
        )}

        {/* Table area */}
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          {!charter && (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: '#94a3b8', fontSize: 14 }}>
              Enter your charter number above to load peer comparison data.
            </div>
          )}

          {charter && loading && (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: '#94a3b8', fontSize: 13 }}>
              <div style={{ marginBottom: 12 }}>Loading {selectedNav?.label}…</div>
              <div style={{ height: 3, background: '#e2e8f0', maxWidth: 300, margin: '0 auto', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'linear-gradient(90deg,transparent,#2563eb,transparent)', animation: 'p76-bar-slide 1.4s ease-in-out infinite' }} />
              </div>
              <style>{`@keyframes p76-bar-slide { 0%{transform:translateX(-100%)} 50%{transform:translateX(0%)} 100%{transform:translateX(100%)} }`}</style>
            </div>
          )}

          {charter && !loading && error && (
            <div style={{ margin: 24, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '12px 16px', fontSize: 12, color: '#991b1b' }}>
              {error}
            </div>
          )}

          {charter && !loading && !error && data?.rows && (() => {
            if (viewType === 'delinquency' || viewType === 'delinquency_30') {
              return <DelinquencyTable rows={data.rows} show30={viewType === 'delinquency_30'} onRowClick={handleRowClick} expandedRow={expandedRow} />;
            }
            if (viewType === 'chargeoff' || viewType === 'chargeoff_ratios') {
              return <ChargeOffTable rows={data.rows} onRowClick={handleRowClick} expandedRow={expandedRow} />;
            }
            return <StandardTable rows={data.rows} viewType={viewType} onRowClick={handleRowClick} expandedRow={expandedRow} />;
          })()}

          {charter && !loading && !error && !data && period && (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: '#94a3b8', fontSize: 13 }}>
              No data returned for {period}. The peer_distributions table may not be seeded yet.
            </div>
          )}
        </div>
      </div>

      {/* Trend drawer */}
      {drawerRow && (
        <TrendDrawer
          row={drawerRow}
          charter={charter}
          period={period}
          onClose={() => setDrawerRow(null)}
        />
      )}
    </div>
  );
}
