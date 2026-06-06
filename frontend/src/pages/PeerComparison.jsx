/**
 * Head-to-head peer benchmarking dashboard.
 *
 * Sections:
 *   1. Peer group selector (auto: same state ±50% assets, or custom search)
 *   2. Comparison matrix  — radar chart + metric table
 *   3. Geographic breakdown — horizontal grouped bar chart sorted by underperformance
 *   4. Trend comparison   — multi-line SVG chart over 8 quarters, per-peer toggle
 *   5. Generate report    — POSTs to /reports/peer-comparison → .docx download
 *
 * Required env vars:
 *   VITE_API_URL              — backend base URL
 *   VITE_OWN_INSTITUTION_ID   — tenant's own charter_or_cert
 *
 * API endpoints consumed:
 *   GET  /peers/auto    ?period
 *   GET  /peers/search  ?q&period
 *   GET  /peers/compare ?peer_ids&period
 *   GET  /peers/trend   ?peer_ids&metric&from_period
 *   GET  /peers/county  ?peer_ids&period
 *   POST /reports/peer-comparison
 */
import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const OWN_ID   = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';

// ── Metric configuration ──────────────────────────────────────────────────────

const METRICS = [
  { id: 'deposit_market_share',  label: 'Deposit Share',    short: 'Dep. Share', unit: 'pct' },
  { id: 'loan_market_share',     label: 'Loan Share',       short: 'Loan Share', unit: 'pct' },
  { id: 'member_growth_pct',     label: 'Member Growth',    short: 'Mbr Growth', unit: 'pct' },
  { id: 'deposit_growth_pct',    label: 'Deposit Growth',   short: 'Dep. Growth',unit: 'pct' },
  { id: 'branch_count',          label: 'Branch Count',     short: 'Branches',   unit: 'int' },
  { id: 'mortgage_market_share', label: 'Mortgage Share',   short: 'Mtg Share',  unit: 'pct' },
];

const OWN_COLOR    = '#2563eb';
const MEDIAN_COLOR = '#475569';
const PEER_COLORS  = ['#7c3aed','#d97706','#059669','#dc2626','#0891b2','#f97316','#65a30d','#ec4899','#14b8a6','#8b5cf6'];

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtVal = (v, unit) => {
  if (v == null) return '—';
  if (unit === 'pct')  return `${(v * 100).toFixed(1)}%`;
  if (unit === 'int')  return Math.round(v).toLocaleString();
  return v.toFixed(2);
};

const fmtAssets = (n) => {
  if (!n) return '';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
};

function recentQuarters(n, fromPeriod) {
  let year = fromPeriod?.match?.(/^\d{4}/)?.[0] ? parseInt(fromPeriod) : new Date().getFullYear();
  let q    = fromPeriod?.includes('Q') ? parseInt(fromPeriod[5]) : 4;
  const result = [];
  for (let i = 0; i < n; i++) {
    result.unshift(`${year}Q${q}`);
    if (--q === 0) { q = 4; year--; }
  }
  return result;
}

function computeMedians(metrics, peerIds) {
  const medians = {};
  for (const [metric, values] of Object.entries(metrics)) {
    const vals = peerIds.map(id => values[id]).filter(v => v != null).sort((a, b) => a - b);
    if (!vals.length) { medians[metric] = null; continue; }
    const m = Math.floor(vals.length / 2);
    medians[metric] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }
  return medians;
}

function normalizeForRadar(metrics, allIds) {
  const norm = {};
  for (const [metric, values] of Object.entries(metrics)) {
    const max = Math.max(...allIds.map(id => values[id] ?? 0), 0.0001);
    norm[metric] = {};
    allIds.forEach(id => { norm[metric][id] = (values[id] ?? 0) / max; });
  }
  return norm;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PeerComparison() {
  const [period,        setPeriod]        = useState('2023');
  const [peerMode,      setPeerMode]      = useState('auto');   // 'auto' | 'custom'
  const [peers,         setPeers]         = useState([]);        // [{id, name, state, total_assets}]
  const [trendMetric,   setTrendMetric]   = useState('deposit_market_share');
  const [activePeerIds, setActivePeerIds] = useState(new Set());
  const [comparison,    setComparison]    = useState(null);
  const [geographic,    setGeographic]    = useState([]);
  const [trendData,     setTrendData]     = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [compLoading,   setCompLoading]   = useState(false);
  const [geoLoading,    setGeoLoading]    = useState(false);
  const [trendLoading,  setTrendLoading]  = useState(false);

  // ── Auto-load peer group ──────────────────────────────────────────────────

  useEffect(() => {
    if (peerMode !== 'auto') return;
    fetch(`${API_BASE}/peers/auto?period=${period}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        const list = Array.isArray(data) ? data : (data.peers ?? []);
        setPeers(list);
        setActivePeerIds(new Set(list.map(p => p.id)));
      })
      .catch(() => {});
  }, [peerMode, period]);

  // ── Comparison matrix ────────────────────────────────────────────────────

  useEffect(() => {
    if (!peers.length) return;
    const ids = [OWN_ID, ...peers.map(p => p.id)].filter(Boolean).join(',');
    setCompLoading(true);
    fetch(`${API_BASE}/peers/compare?peer_ids=${encodeURIComponent(ids)}&period=${period}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setComparison(data))
      .catch(() => setComparison(null))
      .finally(() => setCompLoading(false));
  }, [peers, period]);

  // ── Geographic breakdown ─────────────────────────────────────────────────

  useEffect(() => {
    if (!peers.length) return;
    const ids = peers.map(p => p.id).join(',');
    setGeoLoading(true);
    fetch(`${API_BASE}/peers/county?peer_ids=${encodeURIComponent(ids)}&period=${period}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setGeographic(Array.isArray(data) ? data : []))
      .catch(() => setGeographic([]))
      .finally(() => setGeoLoading(false));
  }, [peers, period]);

  // ── Trend data ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!peers.length) return;
    const ids = [OWN_ID, ...peers.map(p => p.id)].filter(Boolean).join(',');
    const periods = recentQuarters(8, period + 'Q4').join(',');
    setTrendLoading(true);
    fetch(
      `${API_BASE}/peers/trend?peer_ids=${encodeURIComponent(ids)}&metric=${trendMetric}&periods=${encodeURIComponent(periods)}`
    )
      .then(r => r.ok ? r.json() : null)
      .then(data => setTrendData(data))
      .catch(() => setTrendData(null))
      .finally(() => setTrendLoading(false));
  }, [peers, trendMetric, period]);

  // ── Report generation ─────────────────────────────────────────────────────

  async function handleGenerateReport() {
    setReportLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/peer-comparison`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, peer_ids: peers.map(p => p.id), metrics: METRICS.map(m => m.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href: url, download: `peer-comparison-${period}.docx`,
      }).click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Report generation failed:', err);
    } finally {
      setReportLoading(false);
    }
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const institutions  = comparison?.institutions ?? [];
  const rawMetrics    = comparison?.metrics ?? {};
  const peerIds       = peers.map(p => p.id);
  const allIds        = [OWN_ID, ...peerIds].filter(Boolean);
  const medians       = useMemo(() => computeMedians(rawMetrics, peerIds), [rawMetrics, peerIds]);
  const normalized    = useMemo(() => normalizeForRadar(rawMetrics, allIds), [rawMetrics, allIds]);
  const visiblePeerIds = useMemo(() => [...activePeerIds], [activePeerIds]);

  function togglePeer(id) {
    setActivePeerIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const ownName   = institutions.find(i => i.id === OWN_ID)?.name ?? 'Your Institution';
  const peerColor = (id) => PEER_COLORS[peerIds.indexOf(id) % PEER_COLORS.length];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={L.root}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div style={L.pageHeader}>
        <div>
          <h1 style={L.pageTitle}>Peer Benchmarking</h1>
          <p style={L.pageSub}>Head-to-head comparison against auto-selected or custom peer credit unions.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <select style={L.periodSelect} value={period} onChange={e => setPeriod(e.target.value)}>
            {['2023','2022','2021','2020'].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={handleGenerateReport} disabled={reportLoading || !peers.length} style={L.reportBtn}>
            {reportLoading ? '⏳ Generating…' : '↓ Generate Report'}
          </button>
        </div>
      </div>

      <div style={L.content}>

        {/* ── Peer selector ────────────────────────────────────────────── */}
        <PeerSelector
          mode={peerMode}         onModeChange={setPeerMode}
          period={period}
          peers={peers}           onPeersChange={(list) => { setPeers(list); setActivePeerIds(new Set(list.map(p => p.id))); }}
          ownName={ownName}
        />

        {/* ── Comparison matrix ────────────────────────────────────────── */}
        <section style={L.card}>
          <h2 style={L.sectionTitle}>Comparison Matrix</h2>
          {compLoading ? (
            <Skeleton height={320} />
          ) : comparison ? (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 360px' }}>
                <RadarChart
                  metrics={METRICS}
                  normalized={normalized}
                  allIds={allIds}
                  ownId={OWN_ID}
                  peerIds={peerIds}
                  medians={medians}
                  rawMetrics={rawMetrics}
                  peerColor={peerColor}
                  institutions={institutions}
                  ownName={ownName}
                />
              </div>
              <div style={{ flex: 1, minWidth: 280 }}>
                <ComparisonTable
                  metrics={METRICS}
                  rawMetrics={rawMetrics}
                  medians={medians}
                  ownId={OWN_ID}
                  ownName={ownName}
                  peerIds={peerIds}
                />
              </div>
            </div>
          ) : (
            <EmptyNotice text="Select peers to see the comparison matrix." />
          )}
        </section>

        {/* ── Geographic breakdown ─────────────────────────────────────── */}
        <section style={L.card}>
          <h2 style={L.sectionTitle}>
            Geographic Breakdown
            <span style={L.sectionNote}>Sorted by underperformance — markets where peers outperform you</span>
          </h2>
          {geoLoading ? <Skeleton height={220} /> : (
            geographic.length > 0
              ? <GeographicBreakdown data={geographic} ownName={ownName} />
              : <EmptyNotice text="No monitored geographies found for this peer group." />
          )}
        </section>

        {/* ── Trend comparison ─────────────────────────────────────────── */}
        <section style={L.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <h2 style={{ ...L.sectionTitle, margin: 0 }}>Trend Comparison</h2>
            <select style={L.periodSelect} value={trendMetric} onChange={e => setTrendMetric(e.target.value)}>
              {METRICS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {/* Peer toggles */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
              {peers.map(p => (
                <button
                  key={p.id}
                  onClick={() => togglePeer(p.id)}
                  style={{
                    ...L.toggleBtn,
                    borderColor: peerColor(p.id),
                    backgroundColor: activePeerIds.has(p.id) ? peerColor(p.id) : '#fff',
                    color: activePeerIds.has(p.id) ? '#fff' : peerColor(p.id),
                  }}
                >
                  {p.name.split(' ').slice(0, 2).join(' ')}
                </button>
              ))}
            </div>
          </div>
          {trendLoading ? <Skeleton height={260} /> : (
            trendData
              ? <TrendChart
                  data={trendData}
                  ownId={OWN_ID}
                  ownName={ownName}
                  visiblePeerIds={visiblePeerIds}
                  peerColor={peerColor}
                  metric={METRICS.find(m => m.id === trendMetric)}
                  institutions={institutions}
                />
              : <EmptyNotice text="Trend data unavailable for the selected metric and peers." />
          )}
        </section>

      </div>
    </div>
  );
}

// ── Peer selector ─────────────────────────────────────────────────────────────

function PeerSelector({ mode, onModeChange, period, peers, onPeersChange, ownName }) {
  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [open,      setOpen]      = useState(false);
  const wrapRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function close(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Debounced search
  useEffect(() => {
    if (mode !== 'custom' || query.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`${API_BASE}/peers/search?q=${encodeURIComponent(query)}&period=${period}`)
        .then(r => r.ok ? r.json() : [])
        .then(data => setResults(Array.isArray(data) ? data.slice(0, 15) : []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [query, mode, period]);

  function addPeer(inst) {
    if (peers.length >= 10 || peers.some(p => p.id === inst.id) || inst.id === OWN_ID) return;
    onPeersChange([...peers, inst]);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  function removePeer(id) { onPeersChange(peers.filter(p => p.id !== id)); }

  const alreadyAdded = (id) => id === OWN_ID || peers.some(p => p.id === id);

  return (
    <section style={{ ...L.card, padding: '14px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={L.sectionTitle}>Peer Group</span>
        <div style={L.modeToggle}>
          {['auto', 'custom'].map(m => (
            <button key={m} onClick={() => onModeChange(m)}
              style={L.modeBtn(mode === m)}>
              {m === 'auto' ? 'Auto-selected' : 'Custom'}
            </button>
          ))}
        </div>
        {mode === 'auto' && (
          <span style={L.hint}>Same state · ±50% asset size · {peers.length} peers loaded</span>
        )}
        {mode === 'custom' && (
          <span style={L.hint}>{peers.length}/10 peers selected</span>
        )}
      </div>

      {/* Peer chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {/* Own institution (non-removable) */}
        <span style={L.ownChip}>{ownName} <span style={{ fontSize: 10, opacity: 0.7 }}>YOU</span></span>

        {peers.map((p, i) => (
          <span key={p.id} style={{ ...L.peerChip, borderColor: PEER_COLORS[i % PEER_COLORS.length] }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: PEER_COLORS[i % PEER_COLORS.length], display: 'inline-block', marginRight: 5 }} />
            {p.name}
            {fmtAssets(p.total_assets) && <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 4 }}>{fmtAssets(p.total_assets)}</span>}
            {mode === 'custom' && (
              <button onClick={() => removePeer(p.id)} style={L.chipRemove}>✕</button>
            )}
          </span>
        ))}

        {/* Search input — custom mode */}
        {mode === 'custom' && peers.length < 10 && (
          <div ref={wrapRef} style={{ position: 'relative' }}>
            <input
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              placeholder="+ Search by name…"
              style={L.searchInput}
            />
            {open && (query.length >= 2) && (
              <div style={L.dropdown}>
                {searching && <div style={L.dropItem}>Searching…</div>}
                {!searching && results.length === 0 && query.length >= 2 && (
                  <div style={L.dropItem}>No results for "{query}"</div>
                )}
                {results.map(r => (
                  <button
                    key={r.id}
                    onClick={() => addPeer(r)}
                    disabled={alreadyAdded(r.id)}
                    style={{ ...L.dropItem, ...L.dropBtn, opacity: alreadyAdded(r.id) ? 0.4 : 1 }}
                  >
                    <span style={{ fontWeight: 500 }}>{r.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>
                      {r.state} · {fmtAssets(r.total_assets)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Radar chart (SVG) ─────────────────────────────────────────────────────────

const RC = { cx: 170, cy: 170, r: 130, size: 340 };  // radar chart constants

function radarPt(normVal, axisIdx, numAxes, r, cx, cy) {
  const a = (axisIdx / numAxes) * 2 * Math.PI - Math.PI / 2;
  return { x: cx + normVal * r * Math.cos(a), y: cy + normVal * r * Math.sin(a) };
}

function radarPolygon(metricIds, normalized, instId, metrics) {
  const n = metrics.length;
  return metrics.map((m, i) => {
    const { x, y } = radarPt(normalized[m.id]?.[instId] ?? 0, i, n, RC.r, RC.cx, RC.cy);
    return `${x},${y}`;
  }).join(' ');
}

function RadarChart({ metrics, normalized, allIds, ownId, peerIds, medians, rawMetrics, peerColor, institutions, ownName }) {
  const n = metrics.length;
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Normalize medians for the dashed line
  const normMedians = {};
  metrics.forEach(m => {
    const max = Math.max(...allIds.map(id => rawMetrics[m.id]?.[id] ?? 0), 0.0001);
    normMedians[m.id] = (medians[m.id] ?? 0) / max;
  });

  return (
    <svg viewBox={`0 0 ${RC.size} ${RC.size}`} width={RC.size} height={RC.size}>
      {/* Grid rings */}
      {rings.map(r => (
        <polygon key={r} fill="none" stroke="#e2e8f0" strokeWidth={1}
          points={metrics.map((_, i) => {
            const { x, y } = radarPt(r, i, n, RC.r, RC.cx, RC.cy);
            return `${x},${y}`;
          }).join(' ')}
        />
      ))}

      {/* Axis lines */}
      {metrics.map((m, i) => {
        const outer = radarPt(1, i, n, RC.r, RC.cx, RC.cy);
        return <line key={m.id} x1={RC.cx} y1={RC.cy} x2={outer.x} y2={outer.y} stroke="#e2e8f0" strokeWidth={1} />;
      })}

      {/* Peer polygons (behind own) */}
      {peerIds.map((id, pi) => (
        <polygon key={id} fill={peerColor(id)} fillOpacity={0.12} stroke={peerColor(id)}
          strokeWidth={1.5} strokeOpacity={0.7}
          points={radarPolygon(metrics.map(m => m.id), normalized, id, metrics)}
        />
      ))}

      {/* Median dashed line */}
      <polygon fill="none" stroke={MEDIAN_COLOR} strokeWidth={2} strokeDasharray="5,3"
        points={metrics.map((m, i) => {
          const { x, y } = radarPt(normMedians[m.id] ?? 0, i, n, RC.r, RC.cx, RC.cy);
          return `${x},${y}`;
        }).join(' ')}
      />

      {/* Own institution polygon (on top) */}
      <polygon fill={OWN_COLOR} fillOpacity={0.18} stroke={OWN_COLOR} strokeWidth={2.5}
        points={radarPolygon(metrics.map(m => m.id), normalized, ownId, metrics)}
      />

      {/* Axis labels */}
      {metrics.map((m, i) => {
        const a     = (i / n) * 2 * Math.PI - Math.PI / 2;
        const lx    = RC.cx + (RC.r + 22) * Math.cos(a);
        const ly    = RC.cy + (RC.r + 22) * Math.sin(a);
        const cosDeg = Math.cos(a);
        const anchor = Math.abs(cosDeg) < 0.2 ? 'middle' : cosDeg > 0 ? 'start' : 'end';
        return (
          <text key={m.id} x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle"
            fontSize={11} fill="#475569" fontFamily="system-ui">
            {m.short}
          </text>
        );
      })}

      {/* Centre label */}
      <text x={RC.cx} y={RC.cy - 6} textAnchor="middle" fontSize={10} fill="#94a3b8" fontFamily="system-ui">you</text>
      <circle cx={RC.cx} cy={RC.cy} r={3} fill={OWN_COLOR} />

      {/* Legend */}
      <g transform={`translate(6, ${RC.size - 46})`}>
        <rect width={10} height={10} fill={OWN_COLOR} fillOpacity={0.5} rx={2} />
        <text x={14} y={9} fontSize={10} fill="#475569" fontFamily="system-ui">{ownName.split(' ').slice(0,3).join(' ')}</text>
        <line x1={0} y1={22} x2={10} y2={22} stroke={MEDIAN_COLOR} strokeWidth={2} strokeDasharray="4,2" />
        <text x={14} y={26} fontSize={10} fill="#475569" fontFamily="system-ui">Peer Median</text>
      </g>
    </svg>
  );
}

// ── Comparison table ──────────────────────────────────────────────────────────

function ComparisonTable({ metrics, rawMetrics, medians, ownId, ownName, peerIds }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={L.table}>
        <thead>
          <tr>
            <th style={L.th}>Metric</th>
            <th style={{ ...L.th, color: OWN_COLOR }}>You</th>
            <th style={L.th}>Peer Median</th>
            <th style={L.th}>Rank</th>
            <th style={L.th}>vs Median</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(m => {
            const ownVal    = rawMetrics[m.id]?.[ownId];
            const median    = medians[m.id];
            const allVals   = [ownId, ...peerIds].map(id => rawMetrics[m.id]?.[id]).filter(v => v != null);
            const sorted    = [...allVals].sort((a, b) => b - a);
            const rank      = ownVal != null ? sorted.indexOf(ownVal) + 1 : null;
            const diff      = ownVal != null && median != null ? ownVal - median : null;
            const diffColor = diff == null ? '#94a3b8' : diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#94a3b8';
            return (
              <tr key={m.id}>
                <td style={L.td}>{m.label}</td>
                <td style={{ ...L.td, fontWeight: 700, color: OWN_COLOR }}>{fmtVal(ownVal, m.unit)}</td>
                <td style={L.td}>{fmtVal(median, m.unit)}</td>
                <td style={L.td}>
                  {rank ? (
                    <span style={{
                      ...L.rankBadge,
                      backgroundColor: rank === 1 ? '#fef9c3' : rank <= 3 ? '#f0fdf4' : '#f8fafc',
                      color: rank === 1 ? '#a16207' : rank <= 3 ? '#166534' : '#64748b',
                    }}>
                      #{rank} of {allVals.length}
                    </span>
                  ) : '—'}
                </td>
                <td style={{ ...L.td, color: diffColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                  {diff != null
                    ? `${diff > 0 ? '+' : ''}${fmtVal(Math.abs(diff), m.unit)}`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Geographic breakdown ──────────────────────────────────────────────────────

function GeographicBreakdown({ data, ownName }) {
  // Sort by gap ascending (most underperforming first)
  const sorted = [...data].sort((a, b) => (a.own_share - a.peer_median) - (b.own_share - b.peer_median));
  const maxShare = Math.max(...data.flatMap(d => [d.own_share, d.peer_median]), 0.001);
  const BAR_H = 14, ROW_H = 48, LABEL_W = 180, BAR_MAX = 300, GAP_W = 70;
  const SVG_W = LABEL_W + BAR_MAX + GAP_W + 16;
  const SVG_H = sorted.length * ROW_H + 32;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={SVG_W} height={SVG_H} style={{ display: 'block' }}>
        {/* Column headers */}
        <text x={LABEL_W} y={18} fontSize={10} fill="#94a3b8" fontFamily="system-ui">0%</text>
        <text x={LABEL_W + BAR_MAX} y={18} textAnchor="end" fontSize={10} fill="#94a3b8" fontFamily="system-ui">
          {(maxShare * 100).toFixed(0)}%+
        </text>

        {sorted.map((row, i) => {
          const y      = i * ROW_H + 26;
          const ownW   = (row.own_share / maxShare) * BAR_MAX;
          const medW   = (row.peer_median / maxShare) * BAR_MAX;
          const gap    = row.own_share - row.peer_median;
          const gapPP  = (gap * 100).toFixed(1);
          const gapClr = gap >= 0 ? '#16a34a' : '#dc2626';
          const name   = (row.county_name ?? row.fips ?? '').length > 24
            ? (row.county_name ?? row.fips ?? '').slice(0, 24) + '…'
            : (row.county_name ?? row.fips ?? '');

          return (
            <g key={row.fips ?? i}>
              {/* County label */}
              <text x={LABEL_W - 8} y={y + BAR_H + 2} textAnchor="end"
                fontSize={12} fill="#334155" fontFamily="system-ui">
                {name}
              </text>

              {/* Own bar */}
              <rect x={LABEL_W} y={y} width={Math.max(ownW, 2)} height={BAR_H} fill={OWN_COLOR} rx={2} />
              <text x={LABEL_W + Math.max(ownW, 2) + 3} y={y + BAR_H - 2}
                fontSize={10} fill={OWN_COLOR} fontFamily="system-ui" fontWeight="600">
                {(row.own_share * 100).toFixed(1)}%
              </text>

              {/* Peer median bar */}
              <rect x={LABEL_W} y={y + BAR_H + 4} width={Math.max(medW, 2)} height={BAR_H}
                fill={MEDIAN_COLOR} fillOpacity={0.35} rx={2} />
              <text x={LABEL_W + Math.max(medW, 2) + 3} y={y + 2 * BAR_H + 4}
                fontSize={10} fill="#64748b" fontFamily="system-ui">
                {(row.peer_median * 100).toFixed(1)}% med.
              </text>

              {/* Gap indicator */}
              <text x={LABEL_W + BAR_MAX + 8} y={y + BAR_H + 2}
                fontSize={11} fill={gapClr} fontFamily="system-ui" fontWeight="600">
                {gap > 0 ? '+' : ''}{gapPP}pp
              </text>
            </g>
          );
        })}

        {/* Legend */}
        <g transform={`translate(${LABEL_W}, ${SVG_H - 12})`}>
          <rect width={10} height={10} fill={OWN_COLOR} rx={2} />
          <text x={14} y={9} fontSize={10} fill="#475569" fontFamily="system-ui">{ownName.split(' ').slice(0,3).join(' ')}</text>
          <rect x={100} width={10} height={10} fill={MEDIAN_COLOR} fillOpacity={0.35} rx={2} />
          <text x={114} y={9} fontSize={10} fill="#475569" fontFamily="system-ui">Peer Median</text>
        </g>
      </svg>
    </div>
  );
}

// ── Trend chart (SVG multi-line) ──────────────────────────────────────────────

function TrendChart({ data, ownId, ownName, visiblePeerIds, peerColor, metric, institutions }) {
  const { periods = [], series = {} } = data;
  if (!periods.length) return <EmptyNotice text="No trend data available." />;

  const allSeries = [
    { id: ownId, color: OWN_COLOR, width: 2.5, dash: '', label: ownName },
    ...visiblePeerIds.map(id => ({
      id,
      color: peerColor(id),
      width: 1.5,
      dash: '5,3',
      label: institutions.find(i => i.id === id)?.name ?? id,
    })),
  ].filter(s => series[s.id]);

  const allValues = allSeries.flatMap(s => series[s.id] ?? []).filter(v => v != null);
  if (!allValues.length) return <EmptyNotice text="No trend data for visible peers." />;

  const yMin = Math.min(...allValues) * 0.95;
  const yMax = Math.max(...allValues) * 1.05;

  const PAD  = { l: 58, r: 20, t: 16, b: 40 };
  const W    = 640, H = 240;
  const iW   = W - PAD.l - PAD.r;
  const iH   = H - PAD.t - PAD.b;
  const xs   = (i) => PAD.l + (periods.length > 1 ? (i / (periods.length - 1)) * iW : iW / 2);
  const ys   = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * iH;
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (i / 4) * (yMax - yMin));

  function linePath(vals) {
    return vals
      .map((v, i) => v != null ? `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}` : null)
      .filter(Boolean)
      .join(' ');
  }

  // Period label format: "Q2 2023"
  const fmt = (p) => p.includes('Q') ? `Q${p[5]} ${p.slice(0,4)}` : p;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* Horizontal grid lines + y-axis labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={ys(v)} x2={W - PAD.r} y2={ys(v)}
              stroke="#f1f5f9" strokeWidth={i === 0 ? 1.5 : 1} />
            <text x={PAD.l - 6} y={ys(v) + 4} textAnchor="end"
              fontSize={10} fill="#94a3b8" fontFamily="system-ui">
              {fmtVal(v, metric?.unit)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {periods.map((p, i) => (
          <text key={p} x={xs(i)} y={H - PAD.b + 14} textAnchor="middle"
            fontSize={10} fill="#94a3b8" fontFamily="system-ui">
            {fmt(p)}
          </text>
        ))}

        {/* Data lines */}
        {allSeries.map(s => (
          <path key={s.id} d={linePath(series[s.id])}
            fill="none" stroke={s.color} strokeWidth={s.width}
            strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round"
          />
        ))}

        {/* Data points for own institution */}
        {(series[ownId] ?? []).map((v, i) => v != null && (
          <circle key={i} cx={xs(i)} cy={ys(v)} r={3} fill={OWN_COLOR} />
        ))}

        {/* Axes */}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} stroke="#e2e8f0" strokeWidth={1} />
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#e2e8f0" strokeWidth={1} />

        {/* Legend — bottom right */}
        {allSeries.slice(0, 6).map((s, i) => (
          <g key={s.id} transform={`translate(${PAD.l + (i % 3) * 185}, ${H - 10})`}>
            <line x1={0} y1={0} x2={16} y2={0} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />
            <text x={20} y={4} fontSize={10} fill="#475569" fontFamily="system-ui">
              {s.label.split(' ').slice(0,3).join(' ')}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function Skeleton({ height }) {
  return (
    <div style={{ height, borderRadius: 6, background: 'linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%)', backgroundSize: '400px 100%' }}>
      <style>{`@keyframes sk{to{background-position:400px 0}}`}</style>
    </div>
  );
}

function EmptyNotice({ text }) {
  return <div style={{ padding: '32px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>{text}</div>;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const L = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'system-ui,-apple-system,sans-serif', backgroundColor: '#f8fafc' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 28px 14px', backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 },
  pageTitle:  { margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' },
  pageSub:    { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  periodSelect: { padding: '6px 10px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6, backgroundColor: '#fff', color: '#334155' },
  reportBtn: { padding: '8px 16px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 8, backgroundColor: '#0f172a', color: '#fff', cursor: 'pointer' },
  content: { flex: 1, overflowY: 'auto', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 20 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: '18px 22px', border: '1px solid #e2e8f0' },
  sectionTitle: { margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 10 },
  sectionNote: { fontSize: 12, fontWeight: 400, color: '#94a3b8' },
  // Peer selector
  modeToggle: { display: 'flex', border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' },
  modeBtn: (active) => ({ padding: '5px 12px', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', backgroundColor: active ? '#2563eb' : '#fff', color: active ? '#fff' : '#64748b' }),
  hint: { fontSize: 12, color: '#94a3b8' },
  ownChip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, backgroundColor: '#eff6ff', color: OWN_COLOR, border: `1px solid #bfdbfe` },
  peerChip: { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500, backgroundColor: '#f8fafc', color: '#334155', border: '1px solid' },
  chipRemove: { marginLeft: 6, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0 },
  searchInput: { padding: '5px 10px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 20, outline: 'none', minWidth: 160 },
  dropdown: { position: 'absolute', top: '100%', left: 0, zIndex: 50, backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 320, maxHeight: 280, overflowY: 'auto', marginTop: 4 },
  dropItem: { padding: '9px 14px', fontSize: 13, color: '#334155', width: '100%', display: 'block' },
  dropBtn: { background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', width: '100%' },
  // Table
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '7px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' },
  td: { padding: '9px 12px', borderBottom: '1px solid #f8fafc', verticalAlign: 'middle', fontVariantNumeric: 'tabular-nums' },
  rankBadge: { display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600 },
  // Trend toggle
  toggleBtn: { padding: '4px 10px', fontSize: 11, fontWeight: 600, border: '1.5px solid', borderRadius: 20, cursor: 'pointer', transition: 'all 0.15s' },
};
