/**
 * SignalSeparator — contextual interpretation card below every delinquency
 * and charge-off chart.
 *
 * NEVER suppress this component. It is P76's primary differentiator from
 * Callahan. Tagline: "Is this a you-problem or a market-problem?"
 *
 * Props:
 *   signal       object   from peer_engine.separate_market_vs_institution_signal():
 *                  { signal_type, institution_value, regional_median, national_median,
 *                    interpretation_text, peer_label, n_regional_peers, n_national_peers }
 *   metric       string   metric key, e.g. "delinq_rate_total"
 *   geography    string   display label, e.g. "Michigan" or "Summit County, OH"
 *   loanType     string?  e.g. "auto loan" — appears in STATE 2 body text
 *   isLoading    boolean
 */
import React, { useState } from 'react';

// ── Metric display metadata ────────────────────────────────────────────────────
// isRate: decimal fraction × 100 → display as %
// isRatio: coverage/leverage ratio → display as ×

const METRIC_META = {
  delinq_rate_total:          { label: 'Delinquency Ratio',           isRate: true  },
  delinq_rate_auto:           { label: 'auto loan delinquency',       isRate: true  },
  delinq_rate_real_estate:    { label: 'real estate delinquency',     isRate: true  },
  delinq_rate_first_mortgage: { label: '1st mortgage delinquency',    isRate: true  },
  delinq_rate_credit_card:    { label: 'credit card delinquency',     isRate: true  },
  delinq_rate_commercial:     { label: 'commercial delinquency',      isRate: true  },
  delinq_rate_indirect:       { label: 'indirect loan delinquency',   isRate: true  },
  delinq_rate_new_auto:       { label: 'new auto delinquency',        isRate: true  },
  delinq_rate_used_auto:      { label: 'used auto delinquency',       isRate: true  },
  delinq_90plus_rate:         { label: '90+ day delinquency',         isRate: true  },
  chargeoff_rate_total:       { label: 'Net Charge-Off Ratio',        isRate: true  },
  alll_coverage_ratio:        { label: 'ALLL Coverage Ratio',         isRatio: true },
  alll_to_loans_ratio:        { label: 'ALLL / Loans ratio',          isRate: true  },
  tdr_to_loans_ratio:         { label: 'TDR / Loans ratio',           isRate: true  },
  oreo_to_assets_ratio:       { label: 'OREO / Assets ratio',         isRate: true  },
};

function fmtValue(v, metric) {
  if (v == null || isNaN(v)) return '—';
  const meta = METRIC_META[metric] ?? {};
  if (meta.isRatio) return `${(+v).toFixed(2)}×`;
  if (meta.isRate)  return `${((+v) * 100).toFixed(2)}%`;
  return (+v).toLocaleString();
}

function metricLabel(metric) {
  return METRIC_META[metric]?.label ?? metric.replace(/_/g, ' ');
}

// ── State configuration ────────────────────────────────────────────────────────

const STATES = {
  regional_pressure: {
    bg:          '#fffbeb',
    border:      '#fde68a',
    badgeBg:     '#fef3c7',
    badgeColor:  '#92400e',
    badgeBorder: '#fcd34d',
    badgeText:   'Market condition',
    headlineColor: '#92400e',
    icon:        'pin',
  },
  institution_specific: {
    bg:          '#fff1f2',
    border:      '#fecdd3',
    badgeBg:     '#fee2e2',
    badgeColor:  '#991b1b',
    badgeBorder: '#fca5a5',
    badgeText:   'Institution signal',
    headlineColor: '#991b1b',
    icon:        'building',
  },
  outperforming_market: {
    bg:          '#f0fdf4',
    border:      '#86efac',
    badgeBg:     '#dcfce7',
    badgeColor:  '#14532d',
    badgeBorder: '#4ade80',
    badgeText:   'Outperforming market',
    headlineColor: '#14532d',
    icon:        'shield',
  },
  no_signal: {
    bg:          '#f8fafc',
    border:      '#e2e8f0',
    badgeBg:     '#f1f5f9',
    badgeColor:  '#475569',
    badgeBorder: '#cbd5e1',
    badgeText:   'No divergence',
    headlineColor: '#475569',
    icon:        'dash',
  },
  insufficient_data: {
    bg:          '#f8fafc',
    border:      '#e2e8f0',
    badgeBg:     '#f1f5f9',
    badgeColor:  '#64748b',
    badgeBorder: '#cbd5e1',
    badgeText:   'Insufficient data',
    headlineColor: '#64748b',
    icon:        'info',
  },
};

// ── Headline and body text per signal type ─────────────────────────────────────

function buildHeadline(signalType, metric, geography) {
  const m = metricLabel(metric);
  switch (signalType) {
    case 'regional_pressure':
      return `Your ${m} is elevated — and so is the ${geography} regional market`;
    case 'institution_specific':
      return `Your ${m} is above the regional median while your market is near national`;
    case 'outperforming_market':
      return `Regional ${m} is elevated, but your institution is below the regional median`;
    case 'no_signal':
      return `No significant divergence in ${m} between your institution, region, and national peers`;
    default:
      return 'Insufficient data to compute market vs. institution signal';
  }
}

function buildBody(signalType, metric, geography, loanType, nRegional, nNational) {
  const m   = metricLabel(metric);
  const geo = geography || 'your geography';
  const lt  = loanType  || 'loan';

  switch (signalType) {
    case 'regional_pressure':
      return (
        `Your ${m} is above the national peer median, but so is the ${geo} regional median. ` +
        `This pattern is consistent with regional economic pressure affecting institutions across ` +
        `your market. Among ${nRegional} institutions in ${geo}, the regional median is elevated ` +
        `relative to ${nNational} national same-size peers. This is a market-condition signal, ` +
        `not isolated to your institution.`
      );
    case 'institution_specific':
      return (
        `Your ${m} is above both the national peer median and the ${geo} regional median. ` +
        `Institutions in your local market are not seeing the same pattern — they are tracking ` +
        `near the national baseline. This warrants a review of ${lt} underwriting standards ` +
        `or portfolio mix.`
      );
    case 'outperforming_market':
      return (
        `The ${geo} regional ${m} is elevated above the national peer median, but your ` +
        `institution is below the regional median. Your ${lt} portfolio is performing better ` +
        `than most competitors in your local market despite the broader regional pressure.`
      );
    case 'no_signal':
      return (
        `Your ${m} is tracking close to both the ${geo} regional median and the national ` +
        `peer median. No meaningful divergence detected across ${nRegional} regional and ` +
        `${nNational} national comparison institutions.`
      );
    default:
      return (
        `Not enough data is available to separate market-level and institution-level signals ` +
        `for ${m}. Run the peer engine with a broader geography or a different period.`
      );
  }
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function Icon({ type, color, size = 17 }) {
  const props = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: color, strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0 },
  };

  if (type === 'pin') return (
    <svg {...props}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );

  if (type === 'building') return (
    <svg {...props}>
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <rect x="9" y="14" width="6" height="7" />
      <line x1="9" y1="10" x2="9" y2="10.5" />
      <line x1="15" y1="10" x2="15" y2="10.5" />
    </svg>
  );

  if (type === 'shield') return (
    <svg {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9,12 11,14 15,10" />
    </svg>
  );

  if (type === 'dash') return (
    <svg {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );

  // info
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// ── Mini comparison bar chart ─────────────────────────────────────────────────

function ComparisonBars({ institutionValue, regionalMedian, nationalMedian, metric, cfg }) {
  if (institutionValue == null && regionalMedian == null && nationalMedian == null) return null;

  const bars = [
    { label: 'Your institution', value: institutionValue, color: '#2563eb', bold: true  },
    { label: 'Regional median',  value: regionalMedian,  color: '#7c3aed', bold: false },
    { label: 'National median',  value: nationalMedian,  color: '#94a3b8', bold: false },
  ].filter(b => b.value != null);

  const max = Math.max(...bars.map(b => Math.abs(b.value)));

  return (
    <div style={{ marginTop: 12, marginBottom: 4 }}>
      {bars.map(({ label, value, color, bold }) => {
        const pct = max > 0 ? (Math.abs(value) / max) * 100 : 0;
        return (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5,
          }}>
            <span style={{
              fontSize: 11, color: '#64748b', width: 130, flexShrink: 0,
              fontWeight: bold ? 600 : 400, whiteSpace: 'nowrap',
            }}>
              {label}
            </span>
            <div style={{
              flex: 1, height: 7, background: '#e5e7eb', borderRadius: 4,
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%',
                width: `${pct}%`, background: color, borderRadius: 4,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <span style={{
              fontSize: 11, fontWeight: bold ? 700 : 400,
              color: bold ? '#0f172a' : '#374151',
              width: 46, textAlign: 'right', flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {fmtValue(value, metric)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  const bar = (w) => (
    <div style={{
      height: 12, borderRadius: 4, background: '#e2e8f0',
      width: w, animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  );
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 8, border: '1px solid #e2e8f0',
      background: '#f8fafc', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {bar(80)} {bar(160)}
      </div>
      {bar('100%')} {bar('85%')} {bar('60%')}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SignalSeparator({
  signal,
  metric      = 'delinq_rate_total',
  geography   = '',
  loanType,
  isLoading   = false,
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (isLoading) return <LoadingSkeleton />;

  const signalType = signal?.signal_type ?? 'insufficient_data';
  const cfg        = STATES[signalType] ?? STATES.insufficient_data;

  const instVal    = signal?.institution_value;
  const regMedian  = signal?.regional_median;
  const natMedian  = signal?.national_median;
  const nReg       = signal?.n_regional_peers  ?? 0;
  const nNat       = signal?.n_national_peers  ?? 0;
  const peerLabel  = signal?.peer_label ?? '';

  const headline = buildHeadline(signalType, metric, geography);
  const body     = buildBody(signalType, metric, geography, loanType, nReg, nNat);

  return (
    <div style={{
      borderRadius: 8,
      border:       `1px solid ${cfg.border}`,
      background:   cfg.bg,
      fontFamily:   'system-ui, -apple-system, sans-serif',
      overflow:     'hidden',
    }}>

      {/* ── Header row ───────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        borderBottom: collapsed ? 'none' : `1px solid ${cfg.border}`,
        cursor: 'pointer',
        userSelect: 'none',
      }}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        aria-expanded={!collapsed}
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(c => !c); }}
      >
        <Icon type={cfg.icon} color={cfg.headlineColor} size={16} />

        {/* State badge */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          letterSpacing: '0.02em', whiteSpace: 'nowrap',
          background: cfg.badgeBg, color: cfg.badgeColor, border: `1px solid ${cfg.badgeBorder}`,
        }}>
          {cfg.badgeText}
        </span>

        {/* Headline — visible even when collapsed */}
        <span style={{
          flex: 1, fontSize: 12, fontWeight: 600, color: cfg.headlineColor,
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {headline}
        </span>

        {/* Collapse chevron */}
        <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
          {collapsed ? '▼' : '▲'}
        </span>
      </div>

      {/* ── Body (hidden when collapsed) ──────────────────────────────────── */}
      {!collapsed && (
        <div style={{ padding: '12px 14px 14px' }}>

          {/* Explanation text */}
          <p style={{
            margin: 0, fontSize: 13, lineHeight: 1.65, color: '#374151',
          }}>
            {body}
          </p>

          {/* Comparison bars */}
          <ComparisonBars
            institutionValue={instVal}
            regionalMedian={regMedian}
            nationalMedian={natMedian}
            metric={metric}
            cfg={cfg}
          />

          {/* Footer: tagline + peer context */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 12, paddingTop: 10, borderTop: `1px solid ${cfg.border}`,
            gap: 8, flexWrap: 'wrap',
          }}>
            {/* Tagline — always visible, P76 brand */}
            <span style={{
              fontSize: 11, fontStyle: 'italic', color: '#64748b', fontWeight: 500,
            }}>
              "Is this a you-problem or a market-problem?"
            </span>

            {/* Peer context chip */}
            {(nReg > 0 || peerLabel) && (
              <span style={{
                fontSize: 11, color: '#64748b', background: '#fff',
                border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 8px',
                whiteSpace: 'nowrap',
              }}>
                {nReg > 0 && `${nReg} regional · `}{nNat > 0 && `${nNat} national peers`}
                {peerLabel && !nReg && peerLabel}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
