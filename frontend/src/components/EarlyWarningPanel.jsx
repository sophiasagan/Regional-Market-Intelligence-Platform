/**
 * EarlyWarningPanel — three early warning signal cards positioned above PeerBandChart.
 *
 * CLAUDE.md rules enforced:
 *   - Auto-expands when any_alert is true; collapsed by default otherwise
 *   - Threshold projection always shows "Linear projection only" disclaimer
 *   - "Review with your risk committee" always appears in projection card
 *   - Alert levels: watch (amber) | alert (orange) | urgent (red)
 *   - All three signals displayed (projection conditional on trajectory direction)
 *
 * Props:
 *   signals        object  — EarlyWarningEngine.run_all_signals() result
 *   metricLabel    string  — Callahan display name e.g. "Delinquency Ratio"
 *   thresholdPct   number | null  — threshold as a percentage e.g. 1.5
 *   thresholdLabel string | null  — e.g. "NCUA examiner threshold"
 *   isLoading      boolean
 */
import React, { useState, useEffect } from 'react';

// ── Alert level styling ────────────────────────────────────────────────────────

const ALERT_META = {
  watch:  { bg: '#fffbeb', border: '#d97706', badgeBg: '#d97706', badgeText: '#fff', label: 'Watch'  },
  alert:  { bg: '#fff7ed', border: '#ea580c', badgeBg: '#ea580c', badgeText: '#fff', label: 'Alert'  },
  urgent: { bg: '#fef2f2', border: '#dc2626', badgeBg: '#dc2626', badgeText: '#fff', label: 'Urgent' },
  none:   { bg: '#f8fafc', border: '#e2e8f0', badgeBg: null,      badgeText: null,   label: null     },
};

// ── Number formatters ──────────────────────────────────────────────────────────

// decimal fraction → ±X.XX pp  (0.003 → "+0.30 pp")
function fmtPP(val, alwaysSign = false) {
  if (val == null || !Number.isFinite(val)) return '—';
  const pp   = val * 100;
  const sign = alwaysSign && pp > 0 ? '+' : '';
  return `${sign}${pp.toFixed(2)} pp`;
}

// decimal fraction → X.XX%  (0.021 → "2.10%")
function fmtPct(val) {
  if (val == null || !Number.isFinite(val)) return '—';
  return `${(val * 100).toFixed(2)}%`;
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function IconTrendUp({ size = 18, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function IconTrendDown({ size = 18, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
      <polyline points="16 17 22 17 22 11" />
    </svg>
  );
}

function IconSplit({ size = 18, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2 12 12 3 22 12" />
      <polyline points="2 12 12 21 22 12" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}

function IconFlag({ size = 18, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function IconCheckCircle({ size = 18, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconInfo({ size = 14, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="8" r="1" fill={color} stroke="none" />
      <line x1="12" y1="12" x2="12" y2="16" />
    </svg>
  );
}

function IconChevronDown({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IconBell({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// ── Alert badge ────────────────────────────────────────────────────────────────

function AlertBadge({ level }) {
  const meta = ALERT_META[level] ?? ALERT_META.none;
  if (!meta.label) return null;
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700,
      padding: '2px 7px', borderRadius: 3,
      backgroundColor: meta.badgeBg, color: meta.badgeText,
      letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0,
    }}>
      {meta.label}
    </span>
  );
}

// ── Methodology modal ─────────────────────────────────────────────────────────

const METHODOLOGY = {
  acceleration: {
    title: 'Trend Acceleration — Methodology',
    paragraphs: [
      'We compare the average quarter-over-quarter change in your metric over the most recent 2 quarters to the average over the prior 6 quarters.',
      'An acceleration ratio > 2.0× in an adverse direction triggers an Alert. A ratio > 3.0× triggers Urgent. A ratio > 1.5× triggers Watch.',
      'This signal detects when a trend is not just continuing but actively speeding up — a pattern that often precedes examiner attention before the raw level triggers a flag.',
    ],
  },
  divergence: {
    title: 'Peer Divergence — Methodology',
    paragraphs: [
      'Each quarter, we compare your quarter-over-quarter change to the median QoQ change across your peer group. We accumulate these differences over 4 quarters.',
      'When cumulative adverse divergence exceeds 0.50 percentage points, we flag a divergence alert (0.30 pp = Watch, 0.50 pp = Alert, 1.0 pp = Urgent).',
      'Adverse divergence means your metric is worsening faster than your peers — which distinguishes an institution-specific problem from a market-wide trend.',
    ],
  },
  projection: {
    title: 'Threshold Projection — Methodology',
    paragraphs: [
      'We fit a linear trend to your most recent 4–5 data points and extrapolate to the examiner threshold.',
      'This is a linear projection only and does not account for management interventions, seasonal patterns, economic shocks, or other factors.',
      'Confidence grades: High (5+ quarters, R² ≥ 0.70), Medium (3+ quarters, R² ≥ 0.40), Low (insufficient history or weak trend consistency).',
      'Use this as an early prompt for your risk committee — not as a forecast.',
    ],
  },
};

function LearnMoreModal({ signal, onClose }) {
  const m = METHODOLOGY[signal];

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!m) return null;
  return (
    <div
      role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        backgroundColor: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#fff', borderRadius: 10,
          padding: '26px 30px', maxWidth: 480, width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.22)', position: 'relative',
        }}
        onClick={e => e.stopPropagation()}
      >
        <button
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 14, background: 'none',
            border: 'none', cursor: 'pointer', color: '#94a3b8',
            fontSize: 18, lineHeight: 1, padding: 4,
          }}
          onClick={onClose}
        >✕</button>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
          {m.title}
        </h3>
        {m.paragraphs.map((para, i) => (
          <p key={i} style={{ margin: '0 0 10px', fontSize: 13, color: '#334155', lineHeight: 1.65 }}>
            {para}
          </p>
        ))}
      </div>
    </div>
  );
}

// ── Card shell ─────────────────────────────────────────────────────────────────

function CardShell({ alertLevel = 'none', icon, title, onLearnMore, children }) {
  const meta = ALERT_META[alertLevel] ?? ALERT_META.none;
  return (
    <div style={{
      flex: '1 1 210px', minWidth: 0,
      backgroundColor: meta.bg,
      border: `1.5px solid ${meta.border}`,
      borderRadius: 8, padding: '13px 15px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ flexShrink: 0, color: meta.border, marginTop: 1 }}>{icon}</span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', lineHeight: 1.35 }}>
            {title}
          </span>
        </div>
        <AlertBadge level={alertLevel} />
      </div>

      <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.65, flex: 1 }}>
        {children}
      </div>

      <button
        style={{
          alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
          cursor: 'pointer', fontSize: 11.5, color: '#2563eb',
          display: 'flex', alignItems: 'center', gap: 4, marginTop: 2,
        }}
        onClick={onLearnMore}
      >
        <IconInfo color="#2563eb" /> Learn more
      </button>
    </div>
  );
}

// ── Acceleration card ─────────────────────────────────────────────────────────

function AccelerationCard({ data, metricLabel, onLearnMore }) {
  if (!data) {
    return (
      <CardShell alertLevel="none" icon={<IconTrendUp size={17} />}
                 title="Trend Acceleration" onLearnMore={onLearnMore}>
        <em style={{ color: '#94a3b8' }}>No data loaded.</em>
      </CardShell>
    );
  }

  const { trend_status: status, alert_level: level = 'none',
          acceleration_ratio: ratio, recent_avg_change: recentAvg,
          historical_avg_change: histAvg, quarters_of_data: nQ } = data;

  if (status === 'insufficient_data') {
    return (
      <CardShell alertLevel="none" icon={<IconTrendUp size={17} color="#94a3b8" />}
                 title="Trend Acceleration" onLearnMore={onLearnMore}>
        <em style={{ color: '#94a3b8' }}>
          Not enough history to assess acceleration (need at least 3 periods).
        </em>
      </CardShell>
    );
  }

  // Approximate total change over 2 quarters (recent_avg_change × 2)
  const recentTotal   = recentAvg != null ? recentAvg * 2 : null;
  const direction     = (recentAvg ?? 0) >= 0 ? 'risen' : 'fallen';
  const ratioStr      = ratio != null ? `${Math.abs(ratio).toFixed(1)}×` : null;
  const isGoodTrend   = status === 'improving' || status === 'decelerating';

  const icon = isGoodTrend
    ? <IconTrendDown size={17} color="#059669" />
    : <IconTrendUp   size={17} color={level !== 'none' ? ALERT_META[level]?.border : '#64748b'} />;

  const title =
    status === 'accelerating' ? 'Acceleration detected'            :
    status === 'decelerating' ? 'Trend decelerating (improving)'   :
    status === 'improving'    ? 'Trend improving'                  :
                                'Trend stable';

  const body =
    status === 'accelerating' ? (
      <>
        Your <strong>{metricLabel}</strong> has {direction}{' '}
        <strong>{fmtPP(recentTotal)}</strong> over the past 2 quarters,
        compared to an average of <strong>{fmtPP(histAvg)}</strong> per
        quarter over the prior 6 quarters. Rate of increase is{' '}
        <strong>{ratioStr ?? '—'}</strong> the historical average.
      </>
    ) : status === 'decelerating' ? (
      <>
        Your <strong>{metricLabel}</strong> is still worsening, but the
        pace is slowing — the recent 2-quarter average is{' '}
        <strong>{ratioStr ?? '—'}</strong> of the prior rate.
      </>
    ) : status === 'improving' ? (
      <>
        Your <strong>{metricLabel}</strong> has been moving in a favorable
        direction over the past{' '}
        {nQ != null ? <strong>{nQ} quarter{nQ !== 1 ? 's' : ''}</strong> : 'recent quarters'}.
      </>
    ) : (
      <>No significant acceleration detected in recent quarters.</>
    );

  return (
    <CardShell alertLevel={level} icon={icon} title={title} onLearnMore={onLearnMore}>
      {body}
    </CardShell>
  );
}

// ── Peer divergence card ──────────────────────────────────────────────────────

function DivergenceCard({ data, metricLabel, onLearnMore }) {
  if (!data) {
    return (
      <CardShell alertLevel="none" icon={<IconSplit size={17} />}
                 title="Peer Divergence" onLearnMore={onLearnMore}>
        <em style={{ color: '#94a3b8' }}>No data loaded.</em>
      </CardShell>
    );
  }

  const { divergence_pattern: pattern, alert_level: level = 'none',
          divergence_score: divScore, institution_trend: instTrend = [],
          peer_trend: peerTrend = [], periods_analyzed: nPeriods = 4,
          n_peers_with_data: nPeers } = data;

  if (pattern === 'insufficient_data' || pattern === 'insufficient_peer_data'
      || pattern === 'no_aligned_data') {
    const msg =
      pattern === 'insufficient_peer_data' || pattern === 'no_aligned_data'
        ? 'No peer data available for comparison in the selected periods.'
        : 'Not enough history to assess peer divergence.';
    return (
      <CardShell alertLevel="none" icon={<IconSplit size={17} color="#94a3b8" />}
                 title="Peer Divergence" onLearnMore={onLearnMore}>
        <em style={{ color: '#94a3b8' }}>{msg}</em>
      </CardShell>
    );
  }

  const instTotal  = instTrend.reduce((s, d) => s + (d.change ?? 0), 0);
  const peerTotal  = peerTrend.reduce((s, d) => s + (d.change ?? 0), 0);
  const direction  = instTotal >= 0 ? 'risen' : 'fallen';
  const peerDir    = peerTotal >= 0 ? 'rose' : 'fell';
  const isGood     = pattern === 'converging';

  const icon = isGood
    ? <IconCheckCircle size={17} color="#059669" />
    : <IconSplit size={17} color={level !== 'none' ? ALERT_META[level]?.border : '#64748b'} />;

  const title =
    pattern === 'diverging'  ? 'Diverging from peers'         :
    pattern === 'converging' ? 'Improving relative to peers'  :
                               'In line with peers';

  const body =
    pattern === 'diverging' ? (
      <>
        Your <strong>{metricLabel}</strong> has {direction}{' '}
        <strong>{fmtPP(instTotal)}</strong> over {nPeriods} quarter{nPeriods !== 1 ? 's' : ''}{' '}
        while your peer median {peerDir}{' '}
        <strong>{fmtPP(peerTotal)}</strong>. You are accumulating{' '}
        <strong>{fmtPP(divScore)}</strong> of adverse divergence from your peer group
        {nPeers != null ? ` (${nPeers} peers)` : ''}.
      </>
    ) : pattern === 'converging' ? (
      <>
        Your <strong>{metricLabel}</strong> is improving faster than your peer median
        over the past {nPeriods} quarter{nPeriods !== 1 ? 's' : ''}.
        Cumulative divergence: <strong>{fmtPP(divScore)}</strong> (favorable).
      </>
    ) : (
      <>
        Your <strong>{metricLabel}</strong> trend is consistent with your peer
        group over the past {nPeriods} quarter{nPeriods !== 1 ? 's' : ''}.
      </>
    );

  return (
    <CardShell alertLevel={level} icon={icon} title={title} onLearnMore={onLearnMore}>
      {body}
    </CardShell>
  );
}

// ── Threshold projection card ─────────────────────────────────────────────────

function ProjectionCard({ data, metricLabel, thresholdPct, thresholdLabel, onLearnMore }) {
  if (!data || (!data.trending_toward_threshold && !data.already_breached)) return null;

  const { alert_level: level = 'urgent', quarters_estimated: qEst,
          confidence, already_breached: breached, threshold } = data;

  const tLabel    = thresholdLabel ?? 'examiner threshold';
  const tValueStr = thresholdPct != null
    ? `${thresholdPct.toFixed(1)}%`
    : (threshold != null ? fmtPct(threshold) : null);

  const qRound    = qEst != null ? Math.round(qEst) : null;
  const confColor = confidence === 'high' ? '#059669'
    : confidence === 'medium' ? '#d97706' : '#94a3b8';
  const confLabel = confidence
    ? confidence.charAt(0).toUpperCase() + confidence.slice(1)
    : null;

  const title = breached
    ? `${tLabel.charAt(0).toUpperCase() + tLabel.slice(1)} already breached`
    : qRound != null
    ? `Projected threshold in ~${qRound} quarter${qRound !== 1 ? 's' : ''}`
    : 'Approaching threshold';

  return (
    <CardShell
      alertLevel={breached ? 'urgent' : level}
      icon={<IconFlag size={17} color={ALERT_META[breached ? 'urgent' : level]?.border ?? '#dc2626'} />}
      title={title}
      onLearnMore={onLearnMore}
    >
      {breached ? (
        <p style={{ margin: 0 }}>
          Your <strong>{metricLabel}</strong> has already breached the{' '}
          {tValueStr && <strong>{tValueStr} </strong>}
          {tLabel}. Immediate attention required.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 6px' }}>
            At your current trajectory, your <strong>{metricLabel}</strong> would
            reach the{' '}
            {tValueStr && <strong>{tValueStr} </strong>}
            {tLabel} in approximately{' '}
            <strong>{qRound} quarter{qRound !== 1 ? 's' : ''}</strong>.{' '}
            {confLabel && (
              <span style={{ color: confColor, fontWeight: 600 }}>
                {confLabel} confidence.
              </span>
            )}
          </p>
          <p style={{ margin: '0 0 6px', fontStyle: 'italic', color: '#64748b' }}>
            This is a linear projection — not a forecast.
          </p>
          <p style={{ margin: 0, fontWeight: 600, color: '#0f172a' }}>
            Review with your risk committee before this occurs.
          </p>
        </>
      )}
    </CardShell>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function PanelSkeleton() {
  const box = { height: 100, borderRadius: 8, border: '1px solid #e2e8f0', backgroundColor: '#f1f5f9' };
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <div style={{ ...box, flex: 1, animation: 'ewp-pulse 1.5s ease-in-out infinite' }} />
      <div style={{ ...box, flex: 1, animation: 'ewp-pulse 1.5s ease-in-out infinite 0.25s' }} />
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export default function EarlyWarningPanel({
  signals,
  metricLabel    = 'Delinquency Ratio',
  thresholdPct   = null,
  thresholdLabel = null,
  isLoading      = false,
}) {
  const anyAlert    = signals?.any_alert        ?? false;
  const maxLevel    = signals?.max_alert_level  ?? 'none';
  const accel       = signals?.acceleration;
  const divergence  = signals?.divergence;
  const projection  = signals?.projection;

  const [expanded,        setExpanded]        = useState(false);
  const [learnMoreSignal, setLearnMoreSignal] = useState(null);

  // Auto-expand whenever any alert becomes active.
  useEffect(() => {
    if (anyAlert) setExpanded(true);
  }, [anyAlert]);

  const maxMeta = ALERT_META[maxLevel] ?? ALERT_META.none;

  const activeCount = [accel, divergence, projection].filter(
    s => s?.alert_level && s.alert_level !== 'none'
  ).length;

  const showProjection = projection?.trending_toward_threshold === true
    || projection?.already_breached === true;

  return (
    <>
      {learnMoreSignal && (
        <LearnMoreModal signal={learnMoreSignal} onClose={() => setLearnMoreSignal(null)} />
      )}

      <style>{`
        @keyframes ewp-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.45; }
        }
      `}</style>

      <div style={{
        border: `1.5px solid ${anyAlert ? maxMeta.border : '#e2e8f0'}`,
        borderRadius: 10,
        backgroundColor: anyAlert ? maxMeta.bg : '#f8fafc',
        overflow: 'hidden',
        marginBottom: 14,
        transition: 'border-color 0.2s',
      }}>
        {/* Collapsible header */}
        <button
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          style={{
            width: '100%', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 10,
            padding: '10px 16px', background: 'none', border: 'none',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconBell color={anyAlert ? maxMeta.border : '#94a3b8'} />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
              Early Warning Signals
            </span>
            {anyAlert && activeCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '1px 6px',
                borderRadius: 10, backgroundColor: maxMeta.badgeBg,
                color: maxMeta.badgeText, letterSpacing: '0.03em',
              }}>
                {activeCount} active
              </span>
            )}
            {!anyAlert && !isLoading && signals && (
              <span style={{ fontSize: 12, color: '#059669', fontWeight: 500 }}>
                No alerts
              </span>
            )}
          </div>
          <span style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease', display: 'flex', flexShrink: 0,
          }}>
            <IconChevronDown color="#94a3b8" />
          </span>
        </button>

        {/* Expanded card grid */}
        {expanded && (
          <div style={{ padding: '0 12px 12px' }}>
            {isLoading ? (
              <PanelSkeleton />
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <AccelerationCard
                  data={accel}
                  metricLabel={metricLabel}
                  onLearnMore={() => setLearnMoreSignal('acceleration')}
                />
                <DivergenceCard
                  data={divergence}
                  metricLabel={metricLabel}
                  onLearnMore={() => setLearnMoreSignal('divergence')}
                />
                {showProjection && (
                  <ProjectionCard
                    data={projection}
                    metricLabel={metricLabel}
                    thresholdPct={thresholdPct}
                    thresholdLabel={thresholdLabel}
                    onLearnMore={() => setLearnMoreSignal('projection')}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
