import React, { useState, useCallback, useRef, useEffect } from 'react';
import PeerBandChart from '../components/PeerBandChart';
import SignalSeparator from '../components/SignalSeparator';

const API         = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const OWN_CHARTER = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';
const OWN_NAME    = import.meta.env.VITE_OWN_INSTITUTION_NAME ?? 'Your Credit Union';
const OWN_STATE   = import.meta.env.VITE_OWN_INSTITUTION_STATE ?? '';

// ─── CALLAHAN VOCABULARY ──────────────────────────────────────────────────────
// Mirror of CALLAHAN_TO_P76_METRIC_MAP in api/routers/query.py

const CALLAHAN_TO_P76 = {
  'delinquency ratio':                             'delinq_rate_total',
  'total delinquency':                             'delinq_rate_total',
  'net charge off ratio':                          'chargeoff_rate_total',
  'net charge offs to average loans':              'chargeoff_rate_total',
  'allowance for loan losses to delinquent loans': 'alll_coverage_ratio',
  'allowance for loan losses delinquency':         'alll_coverage_ratio',
  'allowance for loan losses to total loans':      'alll_to_loans_ratio',
  'total delinquency 90 days':                     'delinq_90plus_rate',
  'total delinquency 90 days delinquency':         'delinq_90plus_rate',
  'total auto loan delinquency':                   'delinq_rate_auto',
  'new auto loan delinquency':                     'delinq_rate_new_auto',
  'used auto loan delinquency':                    'delinq_rate_used_auto',
  'credit card loan delinquency':                  'delinq_rate_credit_card',
  'real estate delinquency':                       'delinq_rate_real_estate',
  '1st mortgage delinquency':                      'delinq_rate_first_mortgage',
  'commercial loan delinquency':                   'delinq_rate_commercial',
  'indirect loan delinquency':                     'delinq_rate_indirect',
  'delinquent loans to assets':                    'delinq_to_assets',
  'delinquent loans to net worth':                 'delinq_to_net_worth',
  'net charge offs to prior year delinquency':     'nco_to_prior_delinquency',
};

// Pre-normalize map keys once so lookup is O(1)
const _normalizedMap = Object.fromEntries(
  Object.entries(CALLAHAN_TO_P76).map(([k, v]) => [k, v])
);

const P76_LABELS = {
  delinq_rate_total:          'Delinquency Ratio',
  chargeoff_rate_total:       'Net Charge-Off Ratio',
  alll_coverage_ratio:        'Allowance for Loan Losses / Delinquency',
  alll_to_loans_ratio:        'Allowance for Loan Losses to Total Loans',
  delinq_90plus_rate:         'Total Delinquency (90+ Days)',
  delinq_rate_auto:           'Total Auto Delinquency',
  delinq_rate_new_auto:       'New Auto Delinquency',
  delinq_rate_used_auto:      'Used Auto Delinquency',
  delinq_rate_credit_card:    'Credit Card Delinquency',
  delinq_rate_real_estate:    'Real Estate Delinquency',
  delinq_rate_first_mortgage: '1st Mortgage Delinquency',
  delinq_rate_commercial:     'Commercial & Industrial Delinquency',
  delinq_rate_indirect:       'Indirect Loan Delinquency',
  delinq_to_assets:           'Delinquent Loans / Assets',
  delinq_to_net_worth:        'Delinquent Loans / Net Worth',
  nco_to_prior_delinquency:   'NCO to Prior Year Delinquency',
};

const ASSET_TIERS = [
  { id: 'under_50m',  label: 'Under $50M'    },
  { id: '50m_100m',   label: '$50M – $100M'  },
  { id: '100m_250m',  label: '$100M – $250M' },
  { id: '250m_500m',  label: '$250M – $500M' },
  { id: '500m_1b',    label: '$500M – $1B'   },
  { id: '1b_5b',      label: '$1B – $5B'     },
  { id: 'over_5b',    label: 'Over $5B'      },
];

const FOM_TYPES = [
  { id: 'any',           label: 'Any — do not filter by FOM'  },
  { id: 'community',     label: 'Community Charter'            },
  { id: 'seg',           label: 'Select Employee Group (SEG)' },
  { id: 'occupational',  label: 'Occupational'                },
  { id: 'associational', label: 'Associational'               },
  { id: 'multiple',      label: 'Multiple Common Bond'        },
];

const US_STATES = [
  ['AL','Alabama'],  ['AK','Alaska'],       ['AZ','Arizona'],      ['AR','Arkansas'],
  ['CA','California'],['CO','Colorado'],    ['CT','Connecticut'],  ['DE','Delaware'],
  ['FL','Florida'],  ['GA','Georgia'],      ['HI','Hawaii'],       ['ID','Idaho'],
  ['IL','Illinois'], ['IN','Indiana'],      ['IA','Iowa'],         ['KS','Kansas'],
  ['KY','Kentucky'], ['LA','Louisiana'],    ['ME','Maine'],        ['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'], ['MN','Minnesota'],    ['MS','Mississippi'],
  ['MO','Missouri'], ['MT','Montana'],      ['NE','Nebraska'],     ['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],  ['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],     ['OK','Oklahoma'],
  ['OR','Oregon'],   ['PA','Pennsylvania'], ['RI','Rhode Island'], ['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'], ['TX','Texas'],        ['UT','Utah'],
  ['VT','Vermont'],  ['VA','Virginia'],     ['WA','Washington'],   ['WV','West Virginia'],
  ['WI','Wisconsin'],['WY','Wyoming'],
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Normalize a Callahan column header for map lookup:
// lower-case, strip hyphens/special chars, collapse spaces, strip leading period label
function normalizeCallahanHeader(raw) {
  return String(raw)
    .replace(/^\d{4}\s*Q[1-4]\s*/i, '')   // strip "2024 Q4 " prefix
    .replace(/^Q[1-4]\s*\d{4}\s*/i, '')   // strip "Q4 2024 " prefix
    .toLowerCase()
    .replace(/-/g, ' ')                    // hyphens → space
    .replace(/[^a-z0-9\s\/]/g, '')        // keep letters, digits, spaces, slashes
    .replace(/\//g, ' ')                   // slashes → space for loose matching
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupCallahanMetric(header) {
  const norm = normalizeCallahanHeader(header);
  return _normalizedMap[norm] ?? null;
}

function parsePercent(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/,/g, '');
  if (s.endsWith('%')) return parseFloat(s) / 100;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  // Callahan exports may use 1.42 to mean 1.42%; anything >1 treat as already pct-points
  return n > 1 ? n / 100 : n;
}

function fmtPct(val, digits = 2) {
  if (val == null) return '—';
  return `${(val * 100).toFixed(digits)}%`;
}

function matchStatus(a, b) {
  if (a == null || b == null) return 'unknown';
  const diff = Math.abs(a - b);
  if (diff < 0.0002) return 'exact';   // within ~2 bp (rounding in Callahan display)
  if (diff < 0.001)  return 'close';   // within 10 bp
  return 'mismatch';
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const splitLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

function authHeaders() {
  const tok = localStorage.getItem('token') ?? '';
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function stateNameFor(abbr) {
  return US_STATES.find(([a]) => a === abbr)?.[1] ?? abbr;
}

// ─── STEP INDICATOR ──────────────────────────────────────────────────────────

function StepIndicator({ current }) {
  const steps = [
    { n: 1, label: 'Match Peer Group'     },
    { n: 2, label: 'Verify Numbers'       },
    { n: 3, label: 'See Regional View'    },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
      {steps.map(({ n, label }, i) => (
        <React.Fragment key={n}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
              background: n < current ? '#16a34a' : n === current ? '#2563eb' : '#e2e8f0',
              color:      n <= current ? '#fff'    : '#94a3b8',
            }}>
              {n < current ? '✓' : n}
            </div>
            <span style={{
              fontSize: 13, whiteSpace: 'nowrap',
              fontWeight: n === current ? 600 : 400,
              color: n < current ? '#16a34a' : n === current ? '#1e293b' : '#94a3b8',
            }}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{
              flex: 1, height: 2, margin: '0 10px', minWidth: 20, maxWidth: 60,
              background: n < current ? '#16a34a' : '#e2e8f0',
            }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── SHARED STYLE ATOMS ───────────────────────────────────────────────────────

const s = {
  h2:       { fontSize: 18, fontWeight: 700, color: '#0f172a', margin: '0 0 6px' },
  subtitle: { fontSize: 13, color: '#64748b', lineHeight: '1.6', margin: '0 0 22px' },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 },
  hint:     { fontWeight: 400, color: '#94a3b8', marginLeft: 6 },
  input:    {
    width: '100%', padding: '7px 10px', fontSize: 13,
    border: '1px solid #d1d5db', borderRadius: 5, outline: 'none',
    color: '#1e293b', boxSizing: 'border-box', fontFamily: 'inherit',
  },
  primaryBtn: {
    padding: '8px 18px', fontSize: 13, fontWeight: 600,
    background: '#2563eb', color: '#fff',
    border: '1.5px solid #2563eb', borderRadius: 5, cursor: 'pointer',
  },
  ghostBtn: {
    padding: '7px 14px', fontSize: 12, fontWeight: 500,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 5, cursor: 'pointer',
  },
  pill: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
  },
  th: {
    padding: '8px 16px', fontSize: 11, fontWeight: 600, color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid #e2e8f0', textAlign: 'left',
  },
};

// ─── SMALL PIECES ─────────────────────────────────────────────────────────────

function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 18, ...style }}>
      <label style={s.label}>
        {label}
        {hint && <span style={s.hint}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function MatchIcon({ status }) {
  if (status === 'exact')    return <span style={{ color: '#16a34a', fontWeight: 700, fontSize: 12 }}>✓ exact</span>;
  if (status === 'close')    return <span style={{ color: '#d97706', fontWeight: 600, fontSize: 12 }}>≈ close</span>;
  if (status === 'mismatch') return <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 12 }}>✗ differs</span>;
  return <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>;
}

function StateChipGrid({ selected, onChange }) {
  const toggle = (abbr) =>
    onChange(selected.includes(abbr) ? selected.filter(a => a !== abbr) : [...selected, abbr]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {US_STATES.map(([abbr, name]) => {
        const on = selected.includes(abbr);
        return (
          <button key={abbr} onClick={() => toggle(abbr)} title={name} style={{
            padding: '3px 7px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${on ? '#2563eb' : '#d1d5db'}`,
            background: on ? '#dbeafe' : '#fff',
            color:      on ? '#1d4ed8' : '#374151',
            fontWeight: on ? 600 : 400, transition: 'all 0.1s',
          }}>
            {abbr}
          </button>
        );
      })}
    </div>
  );
}

// ─── STEP 1: MATCH PEER GROUP ─────────────────────────────────────────────────

function Step1({ onComplete }) {
  const [assetTier, setAssetTier] = useState('');
  const [states, setStates] = useState(OWN_STATE ? [OWN_STATE] : []);
  const [fomType, setFomType] = useState('any');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function build() {
    if (!assetTier) { setErr('Select an asset tier to continue.'); return; }
    setErr(''); setLoading(true);
    try {
      const qs = new URLSearchParams({ asset_tier: assetTier, fom_type: fomType });
      states.forEach(st => qs.append('states', st));
      const res = await fetch(`${API}/peers/callahan-equivalent?${qs}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) {
      setErr(e.message ?? 'Failed to load peer group.');
    } finally {
      setLoading(false);
    }
  }

  const stateLabel = states.length === 0 ? 'all states'
    : states.length === 1 ? stateNameFor(states[0])
    : `${states.length} states`;

  return (
    <div>
      <h2 style={s.h2}>Step 1 — Match Your Callahan Peer Group</h2>
      <p style={s.subtitle}>
        Enter the peer group criteria you use in Callahan and we will match it exactly.
        Then we'll show you what the regional layer adds on top.
      </p>

      <Field label="Describe your peer group" hint="optional — for your records">
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Michigan community credit unions, $100M–$250M assets, used for quarterly board reporting"
          rows={2}
          style={{ ...s.input, resize: 'vertical' }}
        />
      </Field>

      <Field label="Asset Tier" hint="Callahan's primary grouping dimension">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ASSET_TIERS.map(t => (
            <button key={t.id} onClick={() => setAssetTier(t.id)} style={{
              padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
              border: `1.5px solid ${assetTier === t.id ? '#2563eb' : '#d1d5db'}`,
              background: assetTier === t.id ? '#dbeafe' : '#fff',
              color:      assetTier === t.id ? '#1d4ed8' : '#374151',
              fontWeight: assetTier === t.id ? 600 : 400,
            }}>
              {t.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="State Filter" hint="select all states included in your Callahan peer group">
        <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
          <button onClick={() => setStates(US_STATES.map(([a]) => a))} style={s.ghostBtn}>Select all</button>
          <button onClick={() => setStates([])} style={s.ghostBtn}>Clear</button>
        </div>
        <StateChipGrid selected={states} onChange={setStates} />
      </Field>

      <Field label="Field of Membership" hint="Callahan 'charter type' filter">
        <select value={fomType} onChange={e => setFomType(e.target.value)} style={{ ...s.input, width: 'auto', maxWidth: 340 }}>
          {FOM_TYPES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </Field>

      {err && <p style={{ color: '#dc2626', fontSize: 12, margin: '0 0 12px' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={build} disabled={loading} style={s.primaryBtn}>
          {loading ? 'Building…' : 'Build Callahan-Equivalent Peer Group →'}
        </button>
        <button onClick={() => onComplete(null)} style={s.ghostBtn}>Skip this step</button>
      </div>

      {result && (
        <div style={{ marginTop: 24, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>

          {/* Callahan-equivalent count */}
          <div style={{ padding: '14px 18px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ ...s.pill, background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}>
                Callahan-equivalent
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>
                {result.callahan_count ?? result.institution_count ?? '—'} institutions matched
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
              {ASSET_TIERS.find(t => t.id === assetTier)?.label}
              {' · '}{stateLabel}
              {fomType !== 'any' ? ` · ${FOM_TYPES.find(f => f.id === fomType)?.label}` : ''}
              {' — '}This is the national same-tier peer group Callahan uses. Continue to Step 2 to verify our numbers match.
            </p>
          </div>

          {/* P76 regional layer — the preview of what's coming */}
          {result.regional_count != null && (
            <div style={{ padding: '14px 18px', background: '#faf5ff', borderBottom: '1px solid #e9d5ff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ ...s.pill, background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' }}>
                  P76 regional layer
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#4c1d95' }}>
                  + {result.regional_count} institutions in {result.regional_geography ?? stateLabel}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: '#5b21b6', lineHeight: 1.5 }}>
                All banks and credit unions with branch presence in your primary geography —
                not filtered by asset tier. This is what Callahan's national peer group can't show.
                You'll see this in Step 3.
              </p>
            </div>
          )}

          {/* Sample institutions */}
          {result.institutions?.length > 0 && (
            <div style={{ padding: '12px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Sample peers matched
              </div>
              {result.institutions.slice(0, 6).map((inst, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155', marginBottom: 4 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 10, width: 14, flexShrink: 0 }}>{i + 1}.</span>
                  <span style={{ flex: 1 }}>{inst.name}</span>
                  <span style={{ color: '#94a3b8', fontSize: 11 }}>{inst.state}</span>
                  <span style={{ color: '#64748b', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                    ${inst.total_assets >= 1e9
                      ? `${(inst.total_assets / 1e9).toFixed(1)}B`
                      : `${(inst.total_assets / 1e6).toFixed(0)}M`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ padding: '12px 18px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => onComplete(result)} style={s.primaryBtn}>
              Continue to Step 2: Verify Numbers →
            </button>
            <button onClick={() => onComplete(result, true)} style={s.ghostBtn}>
              Skip to Step 3 — show me the regional view now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STEP 2: VERIFY NUMBERS ───────────────────────────────────────────────────

function Step2({ latestPeriod, onComplete }) {
  const [dragOver, setDragOver]   = useState(false);
  const [parsing, setParsing]     = useState(false);
  const [parseErr, setParseErr]   = useState('');
  const [parsed, setParsed]       = useState(null);
  const [p76Data, setP76Data]     = useState(null);
  const [p76Loading, setP76Loading] = useState(false);
  const inputRef = useRef(null);

  async function processFile(file) {
    setParsing(true); setParseErr(''); setParsed(null); setP76Data(null);
    try {
      let rows;
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'xlsx' || ext === 'xls') {
        setParseErr(
          'Excel (.xlsx) files are not supported directly. ' +
          'In Callahan: open your export → File → Save As → CSV UTF-8, then re-upload the .csv file.'
        );
        return;
      }
      rows = parseCSV(await file.text());

      if (!rows.length) { setParseErr('No data rows found in file.'); return; }

      // Detect institution name column
      const nameCol = Object.keys(rows[0]).find(k =>
        /^(institution|credit union|cu name|name|organization)/i.test(k.trim())
      );

      // Find own institution row
      const ownRow = nameCol
        ? (rows.find(r => String(r[nameCol]).toLowerCase().includes(OWN_NAME.toLowerCase())) ?? rows[0])
        : rows[0];

      // Map recognized columns to P76 metric IDs
      const callahanMetrics = {};
      const unmapped = [];
      for (const col of Object.keys(rows[0])) {
        const p76id = lookupCallahanMetric(col);
        if (p76id) {
          const val = parsePercent(ownRow[col]);
          if (val != null) callahanMetrics[p76id] = { value: val, callahanColName: col };
        } else if (col.trim().length > 3 && col !== nameCol) {
          unmapped.push(col);
        }
      }

      if (!Object.keys(callahanMetrics).length) {
        setParseErr(
          'No recognized Callahan metric columns found. ' +
          'Column headers must match standard Callahan export names, e.g. "Delinquency Ratio", ' +
          '"Net Charge-Off Ratio", "Allowance for Loan Losses/Delinquency".'
        );
        return;
      }

      setParsed({
        callahanMetrics,
        institutionName: nameCol ? (ownRow[nameCol] ?? OWN_NAME) : OWN_NAME,
        unmappedCols: unmapped.slice(0, 8),
      });
    } catch (e) {
      setParseErr(`File parse error: ${e.message}`);
    } finally {
      setParsing(false);
    }
  }

  // Fetch P76 values once file is parsed
  useEffect(() => {
    if (!parsed || !latestPeriod || !OWN_CHARTER) return;
    setP76Loading(true);
    fetch(`${API}/delinquency/${OWN_CHARTER}/kpis?period=${latestPeriod}&peer_group_type=callahan`, {
      headers: authHeaders(),
    })
      .then(r => r.json())
      .then(d => setP76Data(d.metrics ?? {}))
      .catch(() => setP76Data({}))
      .finally(() => setP76Loading(false));
  }, [parsed, latestPeriod]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  // Match summary
  const matchSummary = (() => {
    if (!parsed || !p76Data || p76Loading) return null;
    let exact = 0, close = 0, mismatch = 0;
    for (const [id, { value }] of Object.entries(parsed.callahanMetrics)) {
      const s2 = matchStatus(value, p76Data[id]?.value);
      if (s2 === 'exact') exact++;
      else if (s2 === 'close') close++;
      else mismatch++;
    }
    return { exact, close, mismatch, total: Object.keys(parsed.callahanMetrics).length };
  })();

  const allMatch = matchSummary && matchSummary.mismatch === 0;

  return (
    <div>
      <h2 style={s.h2}>Step 2 — Verify Our Numbers Match Callahan's</h2>
      <p style={s.subtitle}>
        Upload your Callahan Excel or CSV export. We'll map each metric column and show you
        our numbers side by side. When they match, you know you can trust what we add in Step 3.
      </p>

      {/* Drop zone — only shown before file is loaded */}
      {!parsed && !parsing && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
            borderRadius: 8, padding: '40px 24px', textAlign: 'center',
            cursor: 'pointer', background: dragOver ? '#eff6ff' : '#f8fafc',
            transition: 'all 0.15s', marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 10 }}>📂</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
            Drop your Callahan export here, or click to browse
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            CSV only · In Callahan: FPR → Asset Quality → Export to Excel → Save As CSV
          </div>
          <input
            ref={inputRef} type="file" accept=".csv"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files[0]; if (f) processFile(f); e.target.value = ''; }}
          />
        </div>
      )}

      {parsing && (
        <p style={{ fontSize: 12, color: '#64748b', padding: '8px 0' }}>Parsing file…</p>
      )}

      {parseErr && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#991b1b', lineHeight: 1.5 }}>
          {parseErr}
        </div>
      )}

      {/* Comparison table */}
      {parsed && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>

          {/* Match banner */}
          {matchSummary && (
            <div style={{
              padding: '12px 16px',
              background: allMatch ? '#f0fdf4' : matchSummary.mismatch <= 1 ? '#fefce8' : '#fef2f2',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontSize: 22 }}>{allMatch ? '✓' : matchSummary.mismatch <= 1 ? '⚠' : '✗'}</span>
              <div>
                <div style={{
                  fontSize: 13, fontWeight: 700,
                  color: allMatch ? '#14532d' : matchSummary.mismatch <= 1 ? '#854d0e' : '#991b1b',
                }}>
                  {matchSummary.exact} of {matchSummary.total} metrics matched exactly
                  {matchSummary.close > 0 && ` · ${matchSummary.close} within rounding`}
                  {matchSummary.mismatch > 0 && ` · ${matchSummary.mismatch} differ`}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  {allMatch
                    ? 'Our numbers match Callahan\'s exactly. You can trust what we show you in Step 3.'
                    : matchSummary.mismatch <= 1
                    ? 'One metric differs — likely a period timing difference. Review the flagged row below.'
                    : 'Multiple metrics differ. Check that the export period matches the latest NCUA quarter.'}
                </div>
              </div>
            </div>
          )}

          {/* Institution + period label */}
          <div style={{ padding: '7px 16px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9', fontSize: 11, color: '#64748b', display: 'flex', gap: 16 }}>
            <span>Institution: <strong style={{ color: '#334155' }}>{parsed.institutionName}</strong></span>
            {latestPeriod && <span>P76 period: <strong style={{ color: '#334155' }}>{latestPeriod}</strong></span>}
          </div>

          {/* Data rows */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={s.th}>Metric</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Callahan</th>
                <th style={{ ...s.th, textAlign: 'right' }}>P76</th>
                <th style={{ ...s.th, textAlign: 'center' }}>Match</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(parsed.callahanMetrics).map(([id, { value: calVal, callahanColName }]) => {
                const p76Entry = p76Data?.[id];
                const p76Val   = p76Entry?.value;
                const status   = p76Loading ? 'loading' : matchStatus(calVal, p76Val);
                const isRatio  = id === 'alll_coverage_ratio';
                const rowBg    = status === 'exact' ? '#f0fdf4' : status === 'mismatch' ? '#fef2f2' : '#fff';
                const fmt      = v => v == null ? '—' : isRatio ? `${v.toFixed(2)}×` : fmtPct(v);
                return (
                  <tr key={id} style={{ background: rowBg, borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px 16px' }}>
                      <div style={{ fontWeight: 600, color: '#1e293b' }}>{P76_LABELS[id] ?? id}</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{callahanColName}</div>
                    </td>
                    <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#1e293b' }}>
                      {fmt(calVal)}
                    </td>
                    <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#1e293b' }}>
                      {p76Loading ? <span style={{ color: '#94a3b8' }}>…</span> : fmt(p76Val)}
                    </td>
                    <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                      {p76Loading
                        ? <span style={{ color: '#94a3b8', fontSize: 11 }}>…</span>
                        : <MatchIcon status={status} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Unmapped columns notice */}
          {parsed.unmappedCols?.length > 0 && (
            <div style={{ padding: '8px 16px', background: '#fefce8', borderTop: '1px solid #fef08a', fontSize: 11, color: '#92400e', lineHeight: 1.4 }}>
              <strong>Unrecognized columns</strong> (not in Callahan metric map, not compared):{' '}
              {parsed.unmappedCols.join(', ')}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {parsed && (
          <button onClick={() => onComplete(parsed)} style={s.primaryBtn}>
            {allMatch
              ? 'Numbers verified — show me the regional view →'
              : 'Continue to Step 3 anyway →'}
          </button>
        )}
        <button
          onClick={() => { if (parsed) { setParsed(null); setP76Data(null); } else onComplete(null); }}
          style={s.ghostBtn}
        >
          {parsed ? 'Re-upload a different file' : 'Skip — show me the regional view'}
        </button>
      </div>
    </div>
  );
}

// ─── STEP 3: REGIONAL REVEAL ──────────────────────────────────────────────────

function Step3({ latestPeriod, primaryState }) {
  const [charter, setCharter]   = useState(OWN_CHARTER);
  const [charterInput, setCharterInput] = useState('');
  const [trend, setTrend]       = useState(null);
  const [signal, setSignal]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [showRegional, setShowRegional] = useState(false);

  const geoLabel = primaryState ? stateNameFor(primaryState) : 'your market';

  useEffect(() => {
    if (!charter || !latestPeriod) return;
    setLoading(true);
    setTrend(null);
    setSignal(null);
    Promise.allSettled([
      fetch(
        `${API}/delinquency/${charter}/trend?metric=delinq_rate_total&n_quarters=12&peer_group_type=callahan`,
        { headers: authHeaders() }
      ).then(r => r.json()),
      fetch(
        `${API}/delinquency/${charter}/signal?metric=delinq_rate_total&period=${latestPeriod}&peer_group_type=regional`,
        { headers: authHeaders() }
      ).then(r => r.json()),
    ]).then(([t, sg]) => {
      if (t.status  === 'fulfilled') setTrend(t.value);
      if (sg.status === 'fulfilled') setSignal(sg.value);
    }).finally(() => setLoading(false));
  }, [charter, latestPeriod, primaryState]);

  function doReveal() {
    setShowRegional(true);
    setRevealed(true);
  }

  return (
    <div>
      <h2 style={s.h2}>Step 3 — The View Callahan Couldn't Show You</h2>
      <p style={s.subtitle}>
        Here is what Callahan shows — your institution vs. national same-tier peers.
        Then we'll add the {geoLabel} regional layer that tells you whether your delinquency
        is a <em>you-problem</em> or a <em>{geoLabel}-problem</em>.
      </p>

      {/* Charter input — shown when env var isn't set */}
      {!charter && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
          padding: '18px 20px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 4 }}>
            Enter your NCUA charter number to load your data
          </div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px', lineHeight: 1.5 }}>
            Your charter number is the 5–6 digit number in NCUA's database (e.g. 68535).
            You can find it at mycreditunion.gov or in Callahan's institution header.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={charterInput}
              onChange={e => setCharterInput(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 68535"
              maxLength={7}
              style={{ ...s.input, width: 140 }}
              onKeyDown={e => { if (e.key === 'Enter' && charterInput.length >= 4) setCharter(charterInput); }}
            />
            <button
              onClick={() => { if (charterInput.length >= 4) setCharter(charterInput); }}
              disabled={charterInput.length < 4}
              style={{ ...s.primaryBtn, opacity: charterInput.length < 4 ? 0.5 : 1 }}
            >
              Load my data →
            </button>
          </div>
        </div>
      )}

      {charter && !loading && !trend && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          {latestPeriod ? 'Loading 12-quarter trend…' : 'Waiting for latest period…'}
        </div>
      )}

      {loading && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Loading 12-quarter trend…
        </div>
      )}

      {trend && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '20px 20px 16px', marginBottom: 16 }}>

          {/* Label showing what we're seeing */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ ...s.pill, background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}>
              Callahan-equivalent view
            </span>
            {revealed && (
              <span style={{ ...s.pill, background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' }}>
                + {geoLabel} regional peers
              </span>
            )}
            <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 'auto' }}>
              Delinquency Ratio · Last 12 quarters
            </span>
          </div>

          <PeerBandChart
            institutionData={trend.institution ?? []}
            peerMedian={trend.peer_median ?? []}
            peerTopDecile={trend.peer_top_decile ?? []}
            peerBottomDecile={trend.peer_bottom_decile ?? []}
            peerBand={trend.peer_band ?? []}
            regionalMedian={showRegional ? (trend.regional_median ?? []) : undefined}
            metric="delinq_rate_total"
            periods={trend.periods ?? []}
            threshold={0.015}
            peerGroupLabel={
              revealed
                ? `Callahan peers + ${geoLabel} regional`
                : 'National same-tier (Callahan-equivalent)'
            }
            peerCount={trend.peer_count}
            percentileRank={trend.percentile_rank}
            height={300}
          />

          {/* Reveal CTA — shown only before reveal */}
          {!revealed && (
            <div style={{
              marginTop: 20,
              padding: '18px 20px',
              background: 'linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)',
              border: '1px solid #ddd6fe', borderRadius: 8, textAlign: 'center',
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#4c1d95', marginBottom: 6 }}>
                See what you've been missing — add {geoLabel} regional peers
              </div>
              <p style={{ fontSize: 12, color: '#5b21b6', margin: '0 0 16px', maxWidth: 500, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
                The purple line will show the median of every financial institution — banks and
                credit unions — with branch presence in {geoLabel}.
                This is the benchmark that tells you whether your delinquency tracks the market
                or diverges from it. Callahan's national peer group can't show you this.
              </p>
              <button onClick={doReveal} style={{
                ...s.primaryBtn,
                background: '#7c3aed', borderColor: '#7c3aed',
                fontSize: 14, padding: '10px 22px',
              }}>
                Add {geoLabel} regional peers →
              </button>
            </div>
          )}

          {/* Post-reveal explanation */}
          {revealed && (
            <div style={{
              marginTop: 14, padding: '12px 16px',
              background: '#faf5ff', border: '1px solid #ddd6fe', borderRadius: 6,
              fontSize: 12, color: '#5b21b6', lineHeight: 1.6,
            }}>
              <strong style={{ color: '#4c1d95' }}>Purple dashed line = {geoLabel} regional median.</strong>
              {' '}When your line tracks with the purple line rather than the gray national line,
              your delinquency is a market condition shared across your region —
              not an isolated signal from your institution's underwriting.
            </div>
          )}
        </div>
      )}

      {/* Signal Separator — the core differentiator, always visible in Step 3 */}
      {(signal || loading) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Institution vs. Market Signal
          </div>
          <SignalSeparator
            signal={signal}
            metric="delinq_rate_total"
            geography={geoLabel}
            isLoading={loading && !signal}
          />
        </div>
      )}

      {/* Migration complete — shown after reveal */}
      {revealed && (
        <div style={{
          padding: '18px 20px', background: '#f0fdf4',
          border: '1px solid #86efac', borderRadius: 8,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#14532d', marginBottom: 8 }}>
            You're set up. Migration complete.
          </div>
          <p style={{ fontSize: 12, color: '#166534', margin: '0 0 16px', lineHeight: 1.6 }}>
            Your Callahan-equivalent peer group is saved. Every chart in P76 shows
            the same metrics Callahan shows — with the regional layer always available on top.
            The Signal Separator below every chart will tell you whether any metric
            reflects a <em>you-problem</em> or a <em>{geoLabel}-problem</em>.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="/credit-quality" style={{
              ...s.primaryBtn, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center',
            }}>
              Go to Credit Quality →
            </a>
            <a href="/market-map" style={{
              ...s.ghostBtn, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center',
            }}>
              Explore Market Share Map
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN: CALLAHAN MIGRATION ─────────────────────────────────────────────────

export default function CallahanMigration({ primaryState = OWN_STATE }) {
  const [step, setStep]                   = useState(1);
  const [peerGroupResult, setPeerGroupResult] = useState(null);
  const [latestPeriod, setLatestPeriod]   = useState('');

  useEffect(() => {
    fetch(`${API}/delinquency/latest-period`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setLatestPeriod(d.period ?? ''))
      .catch(() => {});
  }, []);

  function advance(n) {
    setStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function onStep1Complete(result, skipToStep3 = false) {
    setPeerGroupResult(result);
    advance(skipToStep3 ? 3 : 2);
  }

  return (
    <div style={{
      maxWidth: 800, margin: '0 auto', padding: '32px 24px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>

      {/* Page header */}
      <div style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ ...s.pill, background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}>
            Callahan Migration
          </span>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            What Callahan shows — plus your regional picture
          </span>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: '0 0 8px' }}>
          Switching from Callahan Associates?
        </h1>
        <p style={{ fontSize: 14, color: '#475569', margin: 0, lineHeight: 1.65, maxWidth: 620 }}>
          We'll match your Callahan peer group exactly, verify our numbers against your export,
          and then show you the regional context Callahan can't provide — all in three steps.
          Your existing Callahan benchmarks carry over. We add the local market layer on top.
        </p>
      </div>

      <StepIndicator current={step} />

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '28px 28px 24px' }}>
        {step === 1 && <Step1 onComplete={onStep1Complete} />}
        {step === 2 && <Step2 latestPeriod={latestPeriod} onComplete={() => advance(3)} />}
        {step === 3 && <Step3 latestPeriod={latestPeriod} primaryState={primaryState} />}
      </div>

      {/* Below-card nav */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        {step > 1
          ? <button onClick={() => advance(step - 1)} style={s.ghostBtn}>← Back</button>
          : <span />}
        {step < 3 && (
          <button onClick={() => advance(step + 1)} style={{ ...s.ghostBtn, color: '#64748b' }}>
            Skip step {step} →
          </button>
        )}
      </div>
    </div>
  );
}
