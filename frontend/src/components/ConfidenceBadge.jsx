/**
 * Data confidence indicator for market-share figures.
 *
 * Exports
 * -------
 *   default  ConfidenceBadge          — pill badge, optional hover tooltip
 *   named    ConfidenceExplainer      — full methodology modal (controlled)
 *   named    ConfidenceExplainerButton — "?" button that self-manages the modal
 *
 * Confidence tiers match market_share_engine.py CONFIDENCE_RANK:
 *   measured  — direct FDIC SOD / HMDA source
 *   modeled   — estimation_model.py branch-allocation output
 *   estimated — branch-count scaling fallback
 */
import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

// ── Tier configuration ─────────────────────────────────────────────────────────

const CONFIG = {
  measured: {
    label: 'Measured',
    dot:   '#0d9488',
    bg:    '#ccfbf1',
    color: '#0f766e',
    border:'#5eead4',
    tooltip: 'From FDIC branch-level data — direct regulatory source, no estimation applied.',
  },
  modeled: {
    label: 'Modeled',
    dot:   '#2563eb',
    bg:    '#dbeafe',
    color: '#1d4ed8',
    border:'#93c5fd',
    tooltip:
      'Estimated using branch allocation model, typically within ±8% of actual. '
      + 'Validated annually against FDIC actuals.',
  },
  estimated: {
    label: 'Estimated',
    dot:   '#d97706',
    bg:    '#fef3c7',
    color: '#92400e',
    border:'#fcd34d',
    tooltip:
      'Proxy-based estimate. Verify before using in high-stakes planning.',
  },
};

// ── ConfidenceBadge ────────────────────────────────────────────────────────────

export default function ConfidenceBadge({ confidence, showTooltip = true }) {
  const [hovered, setHovered] = useState(false);
  const cfg = CONFIG[String(confidence ?? '').toLowerCase()] ?? CONFIG.estimated;

  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => showTooltip && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Pill */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 9px', borderRadius: 20,
        fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
        backgroundColor: cfg.bg, color: cfg.color,
        border: `1px solid ${cfg.border}`, whiteSpace: 'nowrap',
        cursor: showTooltip ? 'help' : 'default',
        userSelect: 'none',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: cfg.dot, flexShrink: 0 }} />
        {cfg.label}
      </span>

      {/* Hover tooltip */}
      {hovered && (
        <div role="tooltip" style={TT.wrap}>
          {cfg.tooltip}
          <span style={TT.arrow} />
        </div>
      )}
    </span>
  );
}

const TT = {
  wrap: {
    position: 'absolute', bottom: 'calc(100% + 7px)', left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 120, width: 240, padding: '7px 10px',
    backgroundColor: '#0f172a', color: '#e2e8f0',
    fontSize: 11, lineHeight: 1.55, borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    pointerEvents: 'none',
  },
  arrow: {
    position: 'absolute', top: '100%', left: '50%',
    transform: 'translateX(-50%)',
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
    borderTop: '5px solid #0f172a',
  },
};

// ── ConfidenceExplainer modal ─────────────────────────────────────────────────

const TIERS = [
  {
    key: 'measured',
    subtitle: 'Direct regulatory source',
    stats: [
      { label: 'Error range',       value: 'Exact' },
      { label: 'Primary source',    value: 'FDIC SOD / HMDA LAR' },
      { label: 'Update frequency',  value: 'Annual (June call date)' },
      { label: 'Coverage',          value: '~72% of bank deposit data' },
    ],
    body:
      'Deposit figures sourced directly from the FDIC Summary of Deposits annual survey. '
      + 'Mortgage origination share comes from HMDA Loan Application Register records. '
      + 'These are exact regulatory submissions — no estimation is applied. '
      + 'Use Measured figures without caveat in board presentations and planning documents.',
  },
  {
    key: 'modeled',
    subtitle: 'Branch allocation model',
    stats: [
      { label: 'Typical error',   value: '±8% of actual share' },
      { label: 'Validation R²',   value: '> 0.92 across back-tests' },
      { label: 'Source',          value: 'NCUA call report + branch weighting' },
      { label: 'Validated',       value: 'Annually against FDIC actuals' },
    ],
    body:
      'NCUA 5300 Call Reports report total deposits at the institution level, not by branch or county. '
      + 'The branch allocation model distributes institution totals proportionally using branch count, '
      + 'deposit density, and demographic weights. Back-tests against FDIC-measured credit union data '
      + 'show a median absolute error of 8% and R² > 0.92. Suitable for competitive strategy and '
      + 'resource allocation decisions.',
  },
  {
    key: 'estimated',
    subtitle: 'Proxy-based approximation',
    stats: [
      { label: 'Typical error', value: '±15–30% of actual share' },
      { label: 'Method',        value: 'Branch-count / demographic scaling' },
      { label: 'When used',     value: 'No allocation model output available' },
      { label: 'Caution',       value: 'Verify before high-stakes use' },
    ],
    body:
      'When the allocation model has not been run for a geography or period, a fallback estimate '
      + 'scales institution-level NCUA totals by the ratio of local-to-total branch count. '
      + 'Error ranges of 15–30% are common in markets with atypical branch distribution. '
      + 'Estimated figures are suitable for initial scoping and trend direction, but should be '
      + 'confirmed before informing branch investment or pricing decisions.',
  },
];

export function ConfidenceExplainer({ open, onClose }) {
  const closeRef = useRef(null);

  // Focus management
  useEffect(() => {
    if (open && closeRef.current) closeRef.current.focus();
  }, [open]);

  // Escape to dismiss
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog" aria-modal="true"
      aria-labelledby="ce-title"
      style={M.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={M.card}>

        {/* Header */}
        <div style={M.header}>
          <h2 id="ce-title" style={M.title}>Data Confidence Levels</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Close" style={M.closeBtn}>✕</button>
        </div>
        <p style={M.intro}>
          Every figure in this platform carries a confidence label reflecting how closely it
          matches the underlying regulatory submission. Use these levels to calibrate how much
          weight to give a number in planning, board reporting, or exploratory analysis.
        </p>

        {/* Tier cards */}
        {TIERS.map(({ key, subtitle, stats, body }) => {
          const cfg = CONFIG[key];
          return (
            <div key={key} style={{ ...M.tier, borderColor: cfg.border, backgroundColor: cfg.bg + '30' }}>
              <div style={M.tierHeader}>
                <ConfidenceBadge confidence={key} showTooltip={false} />
                <span style={M.tierSubtitle}>{subtitle}</span>
              </div>
              <div style={M.statsRow}>
                {stats.map(s => (
                  <div key={s.label} style={M.stat}>
                    <div style={M.statLabel}>{s.label}</div>
                    <div style={{ ...M.statValue, color: cfg.color }}>{s.value}</div>
                  </div>
                ))}
              </div>
              <p style={M.tierBody}>{body}</p>
            </div>
          );
        })}

        {/* Footer */}
        <div style={M.footer}>
          <a
            href={`${API_BASE}/docs/methodology`}
            target="_blank" rel="noopener noreferrer"
            style={M.footerLink}
          >
            View full methodology documentation →
          </a>
          <button
            onClick={() => {
              Object.assign(document.createElement('a'), {
                href:     `${API_BASE}/docs/methodology.pdf`,
                download: 'market-share-methodology.pdf',
              }).click();
            }}
            style={M.downloadBtn}
          >
            ↓ Download methodology PDF
          </button>
        </div>
      </div>
    </div>
  );
}

const M = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.55)', padding: 20,
  },
  card: {
    backgroundColor: '#fff', borderRadius: 14,
    padding: '28px 32px', maxWidth: 680, width: '100%',
    maxHeight: '88vh', overflowY: 'auto',
    boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
    fontFamily: 'system-ui,-apple-system,sans-serif',
    position: 'relative',
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 },
  title:  { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 18, cursor: 'pointer',
    color: '#94a3b8', padding: '2px 6px', borderRadius: 4, lineHeight: 1,
    flexShrink: 0,
  },
  intro: { fontSize: 13, color: '#64748b', lineHeight: 1.65, marginBottom: 22 },
  tier: {
    border: '1px solid', borderRadius: 10, padding: '18px 20px',
    marginBottom: 14,
  },
  tierHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  tierSubtitle: { fontSize: 12, color: '#64748b', fontWeight: 500 },
  statsRow: { display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 },
  stat: { flex: '0 0 auto' },
  statLabel: { fontSize: 10, color: '#94a3b8', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' },
  statValue: { fontSize: 12, fontWeight: 700 },
  tierBody: { fontSize: 12, color: '#475569', lineHeight: 1.65, margin: 0 },
  footer: {
    display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap',
    marginTop: 22, paddingTop: 18, borderTop: '1px solid #e2e8f0',
  },
  footerLink: { fontSize: 13, color: '#2563eb', textDecoration: 'none', fontWeight: 500 },
  downloadBtn: {
    fontSize: 13, color: '#2563eb', fontWeight: 500,
    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
  },
};

// ── ConfidenceExplainerButton ─────────────────────────────────────────────────
// Drop into any table header: <ConfidenceExplainerButton label="Data Quality" />

export function ConfidenceExplainerButton({ label = 'Data Quality', style }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="About data confidence levels"
        aria-haspopup="dialog"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 6px', fontSize: 11, fontWeight: 500,
          color: '#64748b', background: 'none', border: 'none',
          cursor: 'pointer', borderRadius: 4,
          ...style,
        }}
      >
        {label}
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          border: '1px solid #cbd5e1', fontSize: 9, fontWeight: 700,
          color: '#64748b', backgroundColor: '#f8fafc', flexShrink: 0,
        }}>
          ?
        </span>
      </button>
      <ConfidenceExplainer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
