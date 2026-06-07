/**
 * Natural-language competitive intelligence interface.
 *
 * Sends plain-English questions to POST /ask, renders Claude-generated
 * narrative + supporting data table/chart, data-source confidence note,
 * contextual follow-up suggestions, and a "Save insight" action.
 *
 * Required env vars (Vite):
 *   VITE_API_URL               — backend base URL (default: same origin)
 *   VITE_OWN_INSTITUTION_ID    — charter_or_cert of the tenant's institution
 *
 * Backend note:
 *   The /ask endpoint should return { narrative, follow_up_questions, data_sources }
 *   in addition to the current schema.  If absent, this component builds fallback
 *   versions from the structured result data.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import ConfidenceBadge from '../components/ConfidenceBadge';

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const OWN_ID   = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';

// ── Example questions by audience ─────────────────────────────────────────────

const EXAMPLES = [
  {
    category: 'Growth Strategy',
    color: '#2563eb',
    icon: '📈',
    questions: [
      'Which counties have the fastest-growing deposit markets over the past 3 years?',
      'Which MSAs in Florida have seen the largest increase in credit union membership?',
      'Where are bank branches closing and leaving market share available?',
    ],
  },
  {
    category: 'Competitive',
    color: '#7c3aed',
    icon: '⚔️',
    questions: [
      'Who gained the most mortgage market share in our state last year?',
      'Which competitors have been growing faster than the market in our key counties?',
      'What is our market position relative to the top 3 banks in each of our markets?',
    ],
  },
  {
    category: 'Our Position',
    color: '#0891b2',
    icon: '📍',
    questions: [
      'What is our market share in each county where we have branches?',
      'Are we gaining or losing ground compared to our direct competitors?',
      'In which geographies is our market share the strongest and weakest?',
    ],
  },
  {
    category: 'Peer Benchmarking',
    color: '#059669',
    icon: '🔄',
    questions: [
      'How does our loan-to-deposit ratio compare to similar-sized credit unions in our state?',
      'What is the average deposit market share for credit unions of our asset size?',
      'Which peer credit unions are outgrowing the market and what markets are they in?',
    ],
  },
  {
    category: 'Trend Analysis',
    color: '#d97706',
    icon: '📊',
    questions: [
      'Has Suncoast been gaining or losing market share in our markets over 3 years?',
      'Is the mortgage origination market shifting from banks to credit unions in Florida?',
      'How has the total deposit base changed in our 5 largest markets since 2020?',
    ],
  },
  {
    category: 'Opportunity',
    color: '#dc2626',
    icon: '🎯',
    questions: [
      'Which MSAs in Florida have the lowest credit union market share?',
      'Where are underserved markets with high deposit growth and low CU penetration?',
      'Which neighboring counties have strong growth but no credit union presence?',
    ],
  },
];

const LOADING_STEPS = [
  'Parsing your question…',
  'Identifying geography and time period…',
  'Querying market share data…',
  'Comparing institution positions…',
  'Generating competitive analysis…',
];

const METRIC_LABEL = {
  deposits:              'deposits',
  loans:                 'loans',
  members:               'members',
  mortgage_originations: 'mortgage originations',
};

// ── Fallback helpers (used when backend doesn't return these fields) ───────────

function buildFallbackNarrative(data) {
  const { results = [], metric, geography_id, period, confidence_distribution = {} } = data;
  if (!results.length) return data.summary || 'No data was found for this query.';

  const metricLabel = METRIC_LABEL[metric] ?? metric;
  const ownRow  = results.find(r => r.charter_or_cert === OWN_ID);
  const topRow  = results[0];
  const parts   = [];

  if (ownRow) {
    const rank = results.indexOf(ownRow) + 1;
    parts.push(
      `Your institution holds ${pct(ownRow.market_share)} of the ${geography_id} ${metricLabel} ` +
      `market as of ${period}, ranking #${rank} of ${results.length} institutions tracked.`,
    );
    if (ownRow.share_change_prior_period != null) {
      const dir = ownRow.share_change_prior_period > 0 ? 'gained' : 'lost';
      parts.push(
        `You ${dir} ${pct(Math.abs(ownRow.share_change_prior_period))} since the prior period.`,
      );
    }
  } else {
    parts.push(
      `The ${geography_id} ${metricLabel} market has ${results.length} active institutions as of ${period}.`,
    );
    parts.push(
      `${topRow.institution_name} leads with ${pct(topRow.market_share)} share` +
      (topRow.share_change_prior_period != null
        ? `, ${topRow.share_change_prior_period > 0 ? 'up' : 'down'} ${pct(Math.abs(topRow.share_change_prior_period))} from the prior period.`
        : '.'),
    );
  }

  const total = Object.values(confidence_distribution).reduce((a, b) => a + b, 0);
  if (total > 0 && confidence_distribution.measured) {
    const m = Math.round(confidence_distribution.measured / total * 100);
    if (m >= 60) parts.push(`${m}% of this market's data comes from direct FDIC source measurements.`);
  }

  return parts.join(' ');
}

function generateFollowUps(data) {
  const { results = [], metric, geography_type, geography_id, period } = data;
  const geoRef = geography_type === 'state'
    ? geography_id
    : `this ${geography_type}`;
  const topComp = results.find(r => r.charter_or_cert !== OWN_ID);
  const yearNum = period?.match(/^\d{4}/)?.[0];
  const priorYear = yearNum ? String(Number(yearNum) - 1) : null;

  const pool = [
    metric !== 'loans'   && `What is the loan market share breakdown in ${geoRef}?`,
    metric !== 'deposits' && `How does the deposit picture compare for these institutions in ${geoRef}?`,
    topComp && `Has ${topComp.institution_name} been growing or losing ground over the past 3 years?`,
    priorYear && `How did ${geoRef}'s ${METRIC_LABEL[metric] ?? metric} market change from ${priorYear} to ${period}?`,
    `Which ${geography_type === 'county' ? 'MSA' : 'counties'} near ${geoRef} have the highest credit union concentration?`,
    `What is the total market size trend for ${METRIC_LABEL[metric] ?? metric} in ${geoRef}?`,
  ].filter(Boolean);

  // Shuffle and take 3
  return pool.sort(() => Math.random() - 0.5).slice(0, 3);
}

function buildDataSources(data) {
  const { confidence_distribution = {}, period } = data;
  const sources = [];
  if (confidence_distribution.measured)
    sources.push({ label: `FDIC SOD — measured (${period ?? ''})`, color: '#166534', bg: '#dcfce7' });
  if (confidence_distribution.modeled)
    sources.push({ label: `Estimation model — modeled (${period ?? ''})`, color: '#854d0e', bg: '#fef9c3' });
  if (confidence_distribution.estimated)
    sources.push({ label: `Branch-count scaling — estimated`, color: '#991b1b', bg: '#fee2e2' });
  return sources;
}

function pct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : '—'; }

// ── Main component ─────────────────────────────────────────────────────────────

export default function NLQuery() {
  const inputRef = useRef(null);

  const [inputValue,  setInputValue]  = useState('');
  const [isLoading,   setIsLoading]   = useState(false);
  const [loadingMsg,  setLoadingMsg]  = useState(LOADING_STEPS[0]);
  const [answer,      setAnswer]      = useState(null);
  const [error,       setError]       = useState(null);
  const [history,     setHistory]     = useState([]);   // [{question, answer}, ...]
  const [viewMode,    setViewMode]    = useState('table');
  const [saved,       setSaved]       = useState(false);
  const [savedCount,  setSavedCount]  = useState(
    () => JSON.parse(localStorage.getItem('savedInsights') ?? '[]').length,
  );

  const loadingIntervalRef = useRef(null);

  useEffect(() => () => clearInterval(loadingIntervalRef.current), []);

  // ── API call ─────────────────────────────────────────────────────────────────

  const handleAsk = useCallback(async (q) => {
    const question = (q ?? inputValue).trim();
    if (!question || isLoading) return;

    setInputValue(question);
    setIsLoading(true);
    setAnswer(null);
    setError(null);
    setSaved(false);
    setViewMode('table');

    let stepIdx = 0;
    setLoadingMsg(LOADING_STEPS[0]);
    loadingIntervalRef.current = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, LOADING_STEPS.length - 1);
      setLoadingMsg(LOADING_STEPS[stepIdx]);
    }, 1800);

    try {
      const res = await fetch(`${API_BASE}/ask/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, context: { own_institution_id: OWN_ID } }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Server error ${res.status}`);
      }

      const data = await res.json();

      // Enrich with client-side fallbacks if backend hasn't added them
      if (!data.narrative)             data.narrative            = buildFallbackNarrative(data);
      if (!data.follow_up_questions?.length) data.follow_up_questions = generateFollowUps(data);
      if (!data.data_sources?.length)  data.data_sources         = buildDataSources(data);

      setAnswer(data);
      setHistory(prev => {
        const next = [{ question, answer: data }, ...prev.filter(h => h.question !== question)];
        return next.slice(0, 8);
      });
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(loadingIntervalRef.current);
      setIsLoading(false);
    }
  }, [inputValue, isLoading]);

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); }
  }

  // ── Save insight ─────────────────────────────────────────────────────────────

  function handleSave() {
    if (!answer || saved) return;
    const existing = JSON.parse(localStorage.getItem('savedInsights') ?? '[]');
    const insight  = {
      id: Date.now(),
      question: answer.question,
      narrative: answer.narrative,
      summary: answer.summary,
      geography_type: answer.geography_type,
      geography_id: answer.geography_id,
      period: answer.period,
      metric: answer.metric,
      results: answer.results?.slice(0, 20),
      confidence_distribution: answer.confidence_distribution,
      savedAt: new Date().toISOString(),
    };
    const updated = [insight, ...existing].slice(0, 50);
    localStorage.setItem('savedInsights', JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('insight-saved', { detail: insight }));
    setSaved(true);
    setSavedCount(updated.length);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const hasAnswer = !!answer && !isLoading;

  return (
    <div style={L.root}>

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div style={L.pageHeader}>
        <div>
          <h1 style={L.pageTitle}>✦ Competitive Intelligence</h1>
          <p style={L.pageSubtitle}>Ask plain-English questions about your markets, competitors, and growth opportunities.</p>
        </div>
        {savedCount > 0 && (
          <a href="/reports" style={L.savedBadge}>
            💾 {savedCount} saved {savedCount === 1 ? 'insight' : 'insights'}
          </a>
        )}
      </div>

      {/* ── Question input ───────────────────────────────────────────────────── */}
      <div style={L.inputSection}>
        <div style={L.inputWrap}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about your competitive position…"
            rows={2}
            style={L.textarea}
          />
          <button
            onClick={() => handleAsk()}
            disabled={isLoading || !inputValue.trim()}
            style={{ ...L.askBtn, opacity: (isLoading || !inputValue.trim()) ? 0.5 : 1 }}
          >
            {isLoading ? <Spinner /> : 'Ask →'}
          </button>
        </div>

        {/* Recent history pills */}
        {history.length > 0 && (
          <div style={L.historyRow}>
            <span style={L.historyLabel}>Recent:</span>
            {history.slice(0, 5).map((h, i) => (
              <button
                key={i}
                onClick={() => { setInputValue(h.question); setAnswer(h.answer); setSaved(false); }}
                style={L.historyPill}
                title={h.question}
              >
                {h.question.length > 45 ? h.question.slice(0, 45) + '…' : h.question}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────────── */}
      <div style={L.body}>

        {/* Sidebar */}
        <aside style={L.sidebar}>
          <div style={L.sidebarTitle}>Example questions</div>
          {EXAMPLES.map(cat => (
            <div key={cat.category} style={{ marginBottom: 20 }}>
              <div style={L.catHeader}>
                <span>{cat.icon}</span>
                <span style={{ ...L.catLabel, color: cat.color }}>{cat.category}</span>
              </div>
              {cat.questions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => { setInputValue(q); inputRef.current?.focus(); }}
                  style={L.exampleQ}
                  title={q}
                >
                  {q}
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* Main content area */}
        <main style={L.main}>

          {/* Loading */}
          {isLoading && (
            <div style={L.loadingCard}>
              <div style={L.loadingDots}><Spinner size={22} /><span style={{ marginLeft: 12, fontSize: 15, color: '#334155' }}>{loadingMsg}</span></div>
              <div style={L.loadingBar}><div style={L.loadingFill} /></div>
            </div>
          )}

          {/* Error */}
          {error && !isLoading && (
            <div style={L.errorCard}>
              <strong>⚠ Could not complete analysis</strong>
              <p style={{ margin: '6px 0 0', color: '#475569' }}>{error}</p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
                Try rephrasing with a specific geography (county, state, MSA) and time period.
              </p>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && !hasAnswer && (
            <EmptyState onSelectExample={(q) => { setInputValue(q); inputRef.current?.focus(); }} />
          )}

          {/* Answer */}
          {hasAnswer && <AnswerPanel answer={answer} viewMode={viewMode} setViewMode={setViewMode} onSave={handleSave} saved={saved} onFollowUp={(q) => { setInputValue(q); handleAsk(q); }} />}

        </main>
      </div>
    </div>
  );
}

// ── Answer panel ──────────────────────────────────────────────────────────────

function AnswerPanel({ answer, viewMode, setViewMode, onSave, saved, onFollowUp }) {
  const { narrative, results = [], metric, geography_type, geography_id, period,
          institution_types = [], confidence_distribution = {},
          data_sources = [], follow_up_questions = [] } = answer;

  const queryContext = [
    geography_type, geography_id, METRIC_LABEL[metric] ?? metric, period,
    institution_types.join(' + '),
  ].filter(Boolean).join(' · ');

  const confidenceSources = data_sources.length
    ? data_sources
    : buildDataSources(answer);

  return (
    <div style={L.answerWrap}>

      {/* Narrative card */}
      <div style={L.narrativeCard}>
        <div style={L.narrativeHeader}>
          <span style={L.narrativeIcon}>✦</span>
          <span style={L.narrativeTitle}>Competitive Analysis</span>
          <span style={L.queryCtx}>{queryContext}</span>
        </div>
        <p style={L.narrativeText}>{narrative}</p>
      </div>

      {/* Data view toggle + table/chart */}
      {results.length > 0 && (
        <div style={L.dataSection}>
          <div style={L.dataHeader}>
            <span style={L.dataLabel}>
              {results.length} institutions · {METRIC_LABEL[metric] ?? metric}
            </span>
            <div style={L.viewToggle}>
              {['table', 'chart'].map(mode => (
                <button key={mode} onClick={() => setViewMode(mode)}
                  style={L.viewBtn(viewMode === mode)}>
                  {mode === 'table' ? '≡ Table' : '▦ Chart'}
                </button>
              ))}
            </div>
          </div>

          <div style={L.dataBody}>
            {viewMode === 'table'
              ? <ResultsTable rows={results} />
              : <HorizontalBarChart rows={results} />}
          </div>
        </div>
      )}

      {/* Data sources */}
      {confidenceSources.length > 0 && (
        <div style={L.sourcesRow}>
          <span style={L.sourcesLabel}>Data sources:</span>
          {confidenceSources.map((s, i) => (
            <span key={i} style={{ ...L.sourceChip, backgroundColor: s.bg, color: s.color }}>
              {s.label}
            </span>
          ))}
        </div>
      )}

      {/* Follow-up suggestions */}
      {follow_up_questions.length > 0 && (
        <div style={L.followSection}>
          <div style={L.followLabel}>Suggested follow-ups</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {follow_up_questions.map((q, i) => (
              <button key={i} onClick={() => onFollowUp(q)} style={L.followBtn}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Save action */}
      <div style={L.saveRow}>
        <button onClick={onSave} disabled={saved} style={L.saveBtn(saved)}>
          {saved ? '✓ Insight saved to Reports' : '💾 Save this insight'}
        </button>
      </div>
    </div>
  );
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ rows }) {
  const top = rows.slice(0, 25);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={L.table}>
        <thead>
          <tr>
            {['#', 'Institution', 'Type', 'Share', 'Δ vs Prior', 'Confidence'].map(h => (
              <th key={h} style={L.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {top.map((row, i) => {
            const isOwn = row.charter_or_cert === OWN_ID;
            const change = row.share_change_prior_period;
            return (
              <tr key={row.charter_or_cert} style={isOwn ? { backgroundColor: '#eff6ff' } : undefined}>
                <td style={{ ...L.td, color: '#94a3b8', width: 28 }}>{i + 1}</td>
                <td style={L.td}>
                  <span style={{ fontWeight: isOwn ? 700 : 400 }}>{row.institution_name}</span>
                  {isOwn && <span style={L.ownTag}>YOU</span>}
                </td>
                <td style={L.td}>
                  <span style={L.typeBadge(row.institution_type)}>
                    {row.institution_type === 'credit_union' ? 'CU' : 'Bank'}
                  </span>
                </td>
                <td style={{ ...L.td, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {pct(row.market_share)}
                </td>
                <td style={{ ...L.td, fontVariantNumeric: 'tabular-nums', color: changePalette(change) }}>
                  {change != null
                    ? `${change > 0 ? '▲ +' : change < 0 ? '▼ ' : '→ '}${pct(Math.abs(change))}`
                    : '—'}
                </td>
                <td style={L.td}>
                  <ConfidenceBadge confidence={row.confidence} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Horizontal bar chart (dependency-free SVG) ────────────────────────────────

function HorizontalBarChart({ rows }) {
  const top = rows.slice(0, 12);
  if (!top.length) return null;

  const maxShare = Math.max(...top.map(r => r.market_share), 0.001);
  const ROW_H   = 28;
  const GAP     = 8;
  const LABEL_W = 185;
  const BAR_MAX = 240;
  const NUM_W   = 55;
  const TOTAL_W = LABEL_W + BAR_MAX + NUM_W;
  const TOTAL_H = top.length * (ROW_H + GAP) + 20;

  return (
    <div style={{ overflowX: 'auto', padding: '8px 0' }}>
      <svg width={TOTAL_W} height={TOTAL_H} style={{ display: 'block' }}>
        {top.map((row, i) => {
          const y    = i * (ROW_H + GAP) + 10;
          const barW = Math.max((row.market_share / maxShare) * BAR_MAX, 2);
          const isOwn = row.charter_or_cert === OWN_ID;
          const fill  = isOwn ? '#2563eb' : (row.institution_type === 'credit_union' ? '#93c5fd' : '#cbd5e1');
          const name  = row.institution_name.length > 24
            ? row.institution_name.slice(0, 24) + '…'
            : row.institution_name;
          const change = row.share_change_prior_period;

          return (
            <g key={row.charter_or_cert}>
              <text x={LABEL_W - 8} y={y + ROW_H / 2 + 4}
                textAnchor="end" fontSize={12} fill="#334155" fontFamily="system-ui">
                {name}
              </text>
              <rect x={LABEL_W} y={y + 3} width={barW} height={ROW_H - 6}
                fill={fill} rx={3} opacity={isOwn ? 1 : 0.75} />
              <text x={LABEL_W + barW + 6} y={y + ROW_H / 2 + 4}
                fontSize={12} fill="#0f172a" fontFamily="system-ui"
                fontWeight={isOwn ? '700' : '400'}>
                {pct(row.market_share)}
                {change != null && (
                  <tspan fontSize={10} fill={changePalette(change)}>
                    {' '}{change > 0 ? '▲' : change < 0 ? '▼' : '→'}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
        <span style={{ display: 'inline-block', width: 10, height: 10, background: '#2563eb', borderRadius: 2, marginRight: 4 }} />Your institution
        <span style={{ display: 'inline-block', width: 10, height: 10, background: '#93c5fd', borderRadius: 2, margin: '0 4px 0 12px' }} />Credit unions
        <span style={{ display: 'inline-block', width: 10, height: 10, background: '#cbd5e1', borderRadius: 2, margin: '0 4px 0 12px' }} />Banks
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onSelectExample }) {
  return (
    <div style={L.emptyWrap}>
      <div style={L.emptyHero}>
        <div style={L.emptyIcon}>✦</div>
        <h2 style={L.emptyTitle}>Ask your market data anything</h2>
        <p style={L.emptySubtitle}>
          Get instant answers about market share, competitive positions, growth trends, and
          opportunities — powered by FDIC, NCUA, HMDA, and Census data.
        </p>
      </div>
      <div style={L.exampleGrid}>
        {EXAMPLES.map(cat => (
          <div key={cat.category} style={L.exampleCard}>
            <div style={{ ...L.exampleCardHeader, borderLeft: `3px solid ${cat.color}` }}>
              <span style={{ fontSize: 18 }}>{cat.icon}</span>
              <span style={{ ...L.catLabel, color: cat.color }}>{cat.category}</span>
            </div>
            {cat.questions.slice(0, 2).map((q, i) => (
              <button key={i} onClick={() => onSelectExample(q)} style={L.exampleCardQ}>
                "{q}"
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      style={{ animation: 'spin 0.9s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="9" stroke="#cbd5e1" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function changePalette(v) {
  if (v == null) return '#94a3b8';
  return v > 0.001 ? '#16a34a' : v < -0.001 ? '#dc2626' : '#94a3b8';
}

// ── Styles ────────────────────────────────────────────────────────────────────

const L = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif', backgroundColor: '#f8fafc',
  },
  pageHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '20px 28px 12px', backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0',
    flexShrink: 0,
  },
  pageTitle:   { margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' },
  pageSubtitle:{ margin: '4px 0 0', fontSize: 14, color: '#64748b' },
  savedBadge: {
    fontSize: 13, color: '#2563eb', textDecoration: 'none', fontWeight: 500,
    padding: '4px 10px', border: '1px solid #bfdbfe', borderRadius: 20,
    backgroundColor: '#eff6ff', whiteSpace: 'nowrap', marginTop: 4,
  },
  inputSection: {
    padding: '16px 28px', backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0',
    flexShrink: 0,
  },
  inputWrap: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  textarea: {
    flex: 1, padding: '12px 14px', fontSize: 16, lineHeight: 1.5,
    border: '2px solid #e2e8f0', borderRadius: 10, resize: 'none', outline: 'none',
    fontFamily: 'inherit', color: '#0f172a',
    transition: 'border-color 0.15s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  askBtn: {
    padding: '12px 22px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
    backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: 10,
    whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
    transition: 'opacity 0.15s',
  },
  historyRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginTop: 10,
    flexWrap: 'wrap',
  },
  historyLabel: { fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' },
  historyPill: {
    padding: '3px 10px', fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 20,
    backgroundColor: '#f8fafc', color: '#475569', cursor: 'pointer', maxWidth: 280,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: 260, flexShrink: 0, overflowY: 'auto', padding: '18px 14px',
    borderRight: '1px solid #e2e8f0', backgroundColor: '#fff',
  },
  sidebarTitle: { fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 14 },
  catHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  catLabel:  { fontSize: 12, fontWeight: 700 },
  exampleQ: {
    display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px',
    fontSize: 12, color: '#475569', background: 'none', border: 'none', cursor: 'pointer',
    borderRadius: 4, lineHeight: 1.4, marginBottom: 2,
    transition: 'background 0.1s',
  },
  main: { flex: 1, overflowY: 'auto', padding: '24px 28px' },
  loadingCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: '28px 24px',
    border: '1px solid #e2e8f0', marginBottom: 16,
  },
  loadingDots: { display: 'flex', alignItems: 'center', marginBottom: 14 },
  loadingBar: { height: 3, backgroundColor: '#e2e8f0', borderRadius: 2, overflow: 'hidden' },
  loadingFill: {
    height: '100%', width: '40%', backgroundColor: '#2563eb', borderRadius: 2,
    animation: 'shimmer 1.8s ease-in-out infinite',
  },
  errorCard: {
    backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
    padding: '16px 20px', color: '#991b1b',
  },
  answerWrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  narrativeCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: '20px 24px',
    border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  narrativeHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  narrativeIcon: { fontSize: 16, color: '#2563eb' },
  narrativeTitle:{ fontSize: 14, fontWeight: 700, color: '#0f172a' },
  narrativeText: { margin: 0, fontSize: 15, lineHeight: 1.75, color: '#1e293b' },
  queryCtx: {
    marginLeft: 'auto', fontSize: 11, color: '#94a3b8', fontFamily: 'monospace',
    backgroundColor: '#f8fafc', padding: '2px 8px', borderRadius: 4,
    whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: 340, textOverflow: 'ellipsis',
  },
  dataSection: {
    backgroundColor: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
    overflow: 'hidden',
  },
  dataHeader: {
    display: 'flex', alignItems: 'center', padding: '12px 16px',
    borderBottom: '1px solid #f1f5f9',
  },
  dataLabel: { fontSize: 13, fontWeight: 600, color: '#475569' },
  viewToggle: { display: 'flex', marginLeft: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' },
  viewBtn: (active) => ({
    padding: '5px 12px', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
    backgroundColor: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#64748b',
  }),
  dataBody: { padding: '12px 16px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11,
    color: '#64748b', backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0',
    whiteSpace: 'nowrap',
  },
  td: { padding: '8px 10px', borderBottom: '1px solid #f8fafc', verticalAlign: 'middle' },
  ownTag: {
    display: 'inline-block', marginLeft: 6, fontSize: 10, fontWeight: 700,
    padding: '1px 5px', borderRadius: 3, backgroundColor: '#2563eb', color: '#fff',
  },
  typeBadge: (type) => ({
    display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
    backgroundColor: type === 'credit_union' ? '#e0f2fe' : '#fce7f3',
    color: type === 'credit_union' ? '#0369a1' : '#9d174d',
  }),
  sourcesRow: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 0',
  },
  sourcesLabel: { fontSize: 12, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' },
  sourceChip: {
    fontSize: 11, fontWeight: 500, padding: '3px 10px', borderRadius: 20,
    whiteSpace: 'nowrap',
  },
  followSection: {
    backgroundColor: '#fff', borderRadius: 12, padding: '16px 18px',
    border: '1px solid #e2e8f0',
  },
  followLabel: { fontSize: 12, fontWeight: 700, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' },
  followBtn: {
    padding: '7px 14px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 20,
    backgroundColor: '#f8fafc', color: '#334155', cursor: 'pointer', textAlign: 'left',
    lineHeight: 1.4,
  },
  saveRow: { display: 'flex', justifyContent: 'flex-end' },
  saveBtn: (saved) => ({
    padding: '9px 18px', fontSize: 13, fontWeight: 600, border: 'none',
    borderRadius: 8, cursor: saved ? 'default' : 'pointer',
    backgroundColor: saved ? '#dcfce7' : '#0f172a',
    color: saved ? '#166534' : '#fff',
    transition: 'all 0.2s',
  }),
  // Empty state
  emptyWrap: { maxWidth: 900, margin: '0 auto' },
  emptyHero: { textAlign: 'center', padding: '32px 0 28px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 10px', fontSize: 26, fontWeight: 700, color: '#0f172a' },
  emptySubtitle: { fontSize: 15, color: '#64748b', maxWidth: 520, margin: '0 auto', lineHeight: 1.6 },
  exampleGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14,
  },
  exampleCard: {
    backgroundColor: '#fff', borderRadius: 10, padding: '14px 16px',
    border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  exampleCardHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingLeft: 8,
  },
  exampleCardQ: {
    display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
    fontSize: 12.5, color: '#334155', background: 'none', border: 'none',
    cursor: 'pointer', borderRadius: 5, lineHeight: 1.45, marginBottom: 4,
    fontStyle: 'italic',
  },
};
