import React, { useState, useCallback, useEffect } from 'react';

// ─── METRIC DATA DICTIONARY ──────────────────────────────────────────────────

export const METRIC_DICT = {
  delinq_rate_total: {
    displayName: 'Delinquency Ratio',
    callahanName: 'Delinquency Ratio',
    formula: 'Delinquent Loans / Total Loans',
    ncuaFields: ['DELINQ_LOANS', 'LOANS'],
    description:
      'Percentage of total loans delinquent 2+ months. The primary credit quality metric watched by NCUA examiners and the most common basis for peer comparison.',
    lowerIsBetter: true,
    alertThreshold: '> 1.5%',
    p76MetricId: 'delinq_rate_total',
  },
  delinq_90plus_rate: {
    displayName: 'Total Delinquency (90+ Days)',
    callahanName: 'Total Delinquency 90+ Days',
    formula: 'Loans Delinquent 90+ Days / Total Loans',
    ncuaFields: ['DELINQ_90DAY', 'LOANS'],
    description:
      'Loans past due 90 or more days as a share of total loans. 90+ day delinquency signals loans that are not curing — borrowers have not resolved their delinquency after three months and are likely proceeding toward charge-off.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_90plus_rate',
  },
  alll_coverage_ratio: {
    displayName: 'Allowance for Loan Losses / Delinquency',
    callahanName: 'Allowance for Loan Losses/Delinquency',
    formula: 'ALLL Balance / Delinquent Loans',
    ncuaFields: ['ALLL', 'DELINQ_LOANS'],
    description:
      'How much of the delinquent loan balance is covered by reserves. A ratio below 1.0x is an NCUA examiner threshold — the credit union is not fully reserved against its problem loan portfolio. Higher is better.',
    lowerIsBetter: false,
    alertThreshold: '< 1.0x (RED — examiner threshold)',
    p76MetricId: 'alll_coverage_ratio',
  },
  alll_to_loans_ratio: {
    displayName: 'Allowance for Loan Losses to Total Loans',
    callahanName: 'Allowance for Loan Losses to Total Loans',
    formula: 'ALLL Balance / Total Loans',
    ncuaFields: ['ALLL', 'LOANS'],
    description:
      'The reserve buffer as a share of the total loan portfolio. A higher ratio provides more cushion against future losses. Examiners compare this against the peer distribution given the portfolio risk profile.',
    lowerIsBetter: false,
    p76MetricId: 'alll_to_loans_ratio',
  },
  delinq_rate_credit_card: {
    displayName: 'Credit Card Delinquency',
    callahanName: 'Credit Card Loan Delinquency',
    formula: 'Delinquent Credit Card Loans / Total Credit Card Loans',
    ncuaFields: ['DELINQ_CC', 'LOANS_CC'],
    description:
      'Credit card delinquency rate. Credit cards carry the highest delinquency of any product and are highly sensitive to changes in consumer financial stress. Often the first indicator of a downturn in the member base.',
    lowerIsBetter: true,
    alertThreshold: '> 3.5%',
    p76MetricId: 'delinq_rate_credit_card',
  },
  delinq_rate_auto: {
    displayName: 'Total Auto Delinquency',
    callahanName: 'Total Auto Loan Delinquency',
    formula: 'Delinquent Auto Loans / Total Auto Loans',
    ncuaFields: ['DELINQ_AUTO', 'LOANS_AUTO'],
    description:
      'Combined new and used auto delinquency rate. Auto is typically the largest loan category for credit unions. Auto delinquency is often the earliest leading indicator of broader consumer financial stress.',
    lowerIsBetter: true,
    alertThreshold: '> 2.0%',
    p76MetricId: 'delinq_rate_auto',
  },
  delinq_rate_new_auto: {
    displayName: 'New Auto Delinquency',
    callahanName: 'New Auto Loan Delinquency',
    formula: 'Delinquent New Auto Loans / Total New Auto Loans',
    ncuaFields: ['DELINQ_NEW_AUTO', 'LOANS_NEW_AUTO'],
    description:
      'New vehicle loan delinquency rate. New auto typically runs 50–100 basis points below used auto. A rising new auto rate may indicate underwriting loosening or a specific channel or program issue.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_rate_new_auto',
  },
  delinq_rate_used_auto: {
    displayName: 'Used Auto Delinquency',
    callahanName: 'Used Auto Loan Delinquency',
    formula: 'Delinquent Used Auto Loans / Total Used Auto Loans',
    ncuaFields: ['DELINQ_USED_AUTO', 'LOANS_USED_AUTO'],
    description:
      'Used vehicle loan delinquency rate. Used auto typically carries higher delinquency than new auto due to collateral depreciation and the risk profile of borrowers purchasing older vehicles.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_rate_used_auto',
  },
  delinq_rate_first_mortgage: {
    displayName: '1st Mortgage Delinquency',
    callahanName: '1st Mortgage Delinquency',
    formula: 'Delinquent 1st Mortgage Loans / Total 1st Mortgage Loans',
    ncuaFields: ['DELINQ_1ST_MORT', 'LOANS_1ST_MORT'],
    description:
      'First mortgage delinquency rate. First mortgage delinquency is a lagging indicator; elevated rates often reflect housing market conditions in the institution\'s geography more than underwriting quality.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_rate_first_mortgage',
  },
  delinq_rate_real_estate: {
    displayName: 'Real Estate Delinquency',
    callahanName: 'Real Estate Delinquency',
    formula: 'Delinquent Real Estate Loans / Total Real Estate Loans',
    ncuaFields: ['DELINQ_RE', 'LOANS_RE'],
    description:
      'Delinquency across the full real estate portfolio including first mortgages, HELOCs, non-farm non-residential, and multifamily. NCUA 5300 provides aggregate RE delinquency; sub-segment detail requires additional field mapping.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_rate_real_estate',
  },
  delinq_rate_commercial: {
    displayName: 'Commercial & Industrial Delinquency',
    callahanName: 'Commercial Loan Delinquency',
    formula: 'Delinquent Commercial Loans / Total Commercial Loans',
    ncuaFields: ['DELINQ_COM', 'LOANS_COM'],
    description:
      'Member business loan and commercial delinquency rate. Even modest increases carry outsized ALLL impact due to higher loss severity on business loans. Closely watched for institutions that have grown their MBL portfolio.',
    lowerIsBetter: true,
    alertThreshold: '> 1.0%',
    p76MetricId: 'delinq_rate_commercial',
  },
  delinq_rate_indirect: {
    displayName: 'Indirect Loan Delinquency',
    callahanName: 'Indirect Loan Delinquency',
    formula: 'Delinquent Indirect Loans / Total Indirect Loans',
    ncuaFields: ['DELINQ_INDIRECT', 'LOANS_INDIRECT'],
    description:
      'Delinquency on dealer-originated and third-party-channel loans. Indirect loans often carry higher delinquency than direct loans due to the weaker member relationship and the role of dealer incentives in origination.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_rate_indirect',
  },
  chargeoff_rate_total: {
    displayName: 'Net Charge-Off Ratio',
    callahanName: 'Net Charge-Off Ratio',
    formula: 'Net Charge-Offs × 4 / Total Loans (annualized quarterly)',
    ncuaFields: ['NET_CHARGE_OFFS', 'LOANS'],
    description:
      'Annualized net charge-offs as a share of total loans. NCUA 5300 data is quarterly — multiply by 4 to annualize. Charge-offs represent losses already realized; this is the final outcome metric after delinquency.',
    lowerIsBetter: true,
    p76MetricId: 'chargeoff_rate_total',
  },
  tdr_to_loans_ratio: {
    displayName: 'TDR to Loans Ratio',
    callahanName: 'TDR Balance / Loans',
    formula: 'Troubled Debt Restructuring Balance / Total Loans',
    ncuaFields: ['TDR_BALANCE', 'LOANS'],
    description:
      'Troubled Debt Restructurings (TDRs) are loans where the credit union granted a concession to a financially distressed borrower. A rising TDR ratio is a leading indicator of future charge-offs as restructured loans often re-default.',
    lowerIsBetter: true,
    p76MetricId: 'tdr_to_loans_ratio',
  },
  oreo_to_assets_ratio: {
    displayName: 'OREO to Assets Ratio',
    callahanName: 'OREO / Assets',
    formula: 'Other Real Estate Owned / Total Assets',
    ncuaFields: ['OREO_BALANCE', 'TOTAL_ASSETS'],
    description:
      'Property acquired through foreclosure as a share of total assets. A rising OREO ratio signals that foreclosed properties are accumulating and the credit union has not been able to dispose of them, generating carrying costs.',
    lowerIsBetter: true,
    p76MetricId: 'oreo_to_assets_ratio',
  },
  delinq_to_assets: {
    displayName: 'Delinquent Loans / Assets',
    callahanName: 'Delinquent Loans / Assets',
    formula: 'Delinquent Loans / Total Assets',
    ncuaFields: ['DELINQ_LOANS', 'TOTAL_ASSETS'],
    description:
      'Delinquent loans scaled to total assets. NCUA FPR Asset Quality metric; normalizes delinquency exposure relative to the total size of the institution rather than the loan portfolio alone.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_to_assets',
  },
  delinq_to_net_worth: {
    displayName: 'Delinquent Loans / Net Worth',
    callahanName: 'Delinquent Loans / Net Worth',
    formula: 'Delinquent Loans / Net Worth',
    ncuaFields: ['DELINQ_LOANS', 'NET_WORTH'],
    description:
      'Delinquent loans as a share of capital. Measures how much of the capital cushion is exposed to problem loans. A ratio above 100% means the delinquent portfolio exceeds the institution\'s net worth.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_to_net_worth',
  },
  delinq_plus_nco_to_avg_loans: {
    displayName: 'Delinquent Loans + NCOs / Average Loans',
    callahanName: 'Delinquent Loans + Net Charge-Offs / Average Loans',
    formula: '(Delinquent Loans + Annualized Net Charge-Offs) / Average Loans',
    ncuaFields: ['DELINQ_LOANS', 'NET_CHARGE_OFFS', 'LOANS'],
    description:
      'NCUA FPR composite stress metric combining current delinquency with annualized charge-offs relative to average loans. Provides a single figure representing both current problem loans and already-realized losses in the same period.',
    lowerIsBetter: true,
    p76MetricId: 'delinq_plus_nco_to_avg_loans',
  },
  delinquency_breakdown: {
    displayName: 'Delinquency by Product',
    callahanName: 'Delinquency Breakdown',
    formula: 'Multiple: auto, RE, credit card, commercial, indirect rates',
    ncuaFields: ['Multiple NCUA 5300 fields'],
    description:
      'Multi-product delinquency overview showing all major loan categories side by side. P76 adds a regional comparison layer — each bar shows your institution vs. all institutions with branch presence in the selected geography.',
    lowerIsBetter: true,
    p76MetricId: 'delinquency_breakdown',
  },
};

// ─── TREE DEFINITION ─────────────────────────────────────────────────────────

const TREE = [
  {
    id: 'asset_quality',
    label: 'Asset Quality',
    type: 'folder',
    defaultOpen: true,
    items: [
      { label: 'Delinquency Breakdown', metricId: 'delinquency_breakdown', isOverview: true },
      { label: 'Total Delinquency (90+ Days Delinquency)', metricId: 'delinq_90plus_rate' },
      { label: 'Allowance for Loan Losses / Delinquency', metricId: 'alll_coverage_ratio' },
      { label: 'Credit Card Delinquency (90+ Day)', metricId: 'delinq_rate_credit_card' },
      { label: 'Total Auto Delinquency (90+ Day)', metricId: 'delinq_rate_auto' },
      { label: '1st Mortgage Delinquency', metricId: 'delinq_rate_first_mortgage' },
      { label: 'Non-Farm Non-Residential RE Delinquency', metricId: 'delinq_rate_real_estate' },
      { label: 'Multifamily Real Estate Delinquency', metricId: 'delinq_rate_real_estate' },
      { label: 'Commercial & Industrial Delinquency', metricId: 'delinq_rate_commercial' },
      { label: 'Delinquency by Product', metricId: 'delinquency_breakdown', p76Exclusive: true, p76Label: '+ regional comparison' },
    ],
  },
  {
    id: 'lending',
    label: 'Lending',
    type: 'folder',
    defaultOpen: false,
    items: [
      { label: 'Delinquent Loans / Loans', metricId: 'delinq_rate_total' },
      { label: 'Net Charge-Off Ratio', metricId: 'chargeoff_rate_total' },
      { label: 'Indirect Loan Delinquency', metricId: 'delinq_rate_indirect' },
      { label: 'New Auto Delinquency', metricId: 'delinq_rate_new_auto' },
      { label: 'Used Auto Delinquency', metricId: 'delinq_rate_used_auto' },
    ],
  },
  {
    id: 'fpr',
    label: 'FPR Reports',
    type: 'folder',
    defaultOpen: false,
    children: [
      {
        id: 'fpr_asset_quality',
        label: 'Asset Quality',
        items: [
          { label: 'Delinquent Loans / Assets', metricId: 'delinq_to_assets' },
          { label: 'Delinquent Loans / Total Loans', metricId: 'delinq_rate_total' },
          { label: 'Delinquent Loans / Net Worth', metricId: 'delinq_to_net_worth' },
          { label: 'Delinquent Loans + Net Charge-Offs / Average Loans', metricId: 'delinq_plus_nco_to_avg_loans' },
        ],
      },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced Analysis',
    type: 'folder',
    defaultOpen: false,
    children: [
      {
        id: 'advanced_perf',
        label: 'Credit Union Performance Overview',
        items: [
          { label: 'Delinquency Ratio', metricId: 'delinq_rate_total' },
          { label: 'Net Charge-Off Ratio', metricId: 'chargeoff_rate_total' },
          { label: 'Allowance for Loan Losses to Total Loans', metricId: 'alll_to_loans_ratio' },
        ],
      },
      {
        id: 'advanced_trendwatch',
        label: 'Trendwatch',
        items: [
          { label: 'Asset Quality Ratio: Net Charge-Off', metricId: 'chargeoff_rate_total' },
          { label: 'Delinquency by Product', metricId: 'delinquency_breakdown', p76Exclusive: true, p76Label: 'vs regional peers' },
        ],
      },
    ],
  },
  {
    id: 'data_dictionary',
    label: 'Data Dictionary',
    type: 'dictionary',
    p76Exclusive: true,
    defaultOpen: false,
  },
];

const SAVED_KEY = 'cu_market_saved_metric_views';

// ─── SMALL PIECES ─────────────────────────────────────────────────────────────

function P76Badge({ label }) {
  return (
    <span style={{
      flexShrink: 0,
      background: '#0d9488', color: '#fff',
      fontSize: 9, fontWeight: 700,
      borderRadius: 3, padding: '1px 5px',
      marginLeft: 5, letterSpacing: '0.06em',
      textTransform: 'uppercase',
      lineHeight: '14px',
    }}>
      P76{label ? ` · ${label}` : ''}
    </span>
  );
}

function Caret({ open }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 10, flexShrink: 0,
      fontSize: 8, color: '#94a3b8',
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 0.14s ease',
      marginRight: 5,
    }}>▶</span>
  );
}

// ─── METRIC ROW ───────────────────────────────────────────────────────────────

function MetricRow({ item, depth = 0, isActive, onSelect }) {
  const [hovered, setHovered] = useState(false);
  const paddingLeft = 12 + depth * 16;

  return (
    <button
      onClick={() => onSelect(item.metricId)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={METRIC_DICT[item.metricId]?.callahanName}
      style={{
        display: 'flex', alignItems: 'center',
        width: '100%', textAlign: 'left',
        paddingTop: 4, paddingBottom: 4,
        paddingLeft, paddingRight: 8,
        background: isActive ? '#dbeafe' : hovered ? '#f1f5f9' : 'transparent',
        border: 'none',
        borderLeft: isActive ? '3px solid #2563eb' : '3px solid transparent',
        cursor: 'pointer',
        fontSize: 12, lineHeight: '16px',
        color: isActive ? '#1d4ed8' : '#334155',
        fontWeight: isActive ? 600 : 400,
        transition: 'background 0.08s',
      }}
    >
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.p76Exclusive && <P76Badge label={item.p76Label} />}
    </button>
  );
}

// ─── SUB-FOLDER SECTION ───────────────────────────────────────────────────────

function SubFolderSection({ folder, selectedMetric, onSelect, isOpen, onToggle }) {
  return (
    <div>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center',
          width: '100%', textAlign: 'left',
          padding: '4px 8px 4px 24px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, color: '#475569',
        }}
      >
        <Caret open={isOpen} />
        {folder.label}
      </button>
      {isOpen && (
        <div>
          {folder.items.map((item, i) => (
            <MetricRow
              key={`${folder.id}-${i}`}
              item={item}
              depth={2}
              isActive={selectedMetric === item.metricId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TOP-LEVEL FOLDER SECTION ─────────────────────────────────────────────────

function FolderSection({ folder, selectedMetric, onSelect, openMap, onToggle }) {
  const isOpen = !!openMap[folder.id];

  return (
    <div>
      <button
        onClick={() => onToggle(folder.id)}
        style={{
          display: 'flex', alignItems: 'center',
          width: '100%', textAlign: 'left',
          padding: '7px 12px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: '#64748b',
        }}
      >
        <Caret open={isOpen} />
        {folder.label}
      </button>

      {isOpen && (
        <div style={{ paddingBottom: 4 }}>
          {folder.items && folder.items.map((item, i) => (
            <MetricRow
              key={`${folder.id}-item-${i}`}
              item={item}
              depth={1}
              isActive={selectedMetric === item.metricId}
              onSelect={onSelect}
            />
          ))}

          {folder.children && folder.children.map((child) => (
            <SubFolderSection
              key={child.id}
              folder={child}
              selectedMetric={selectedMetric}
              onSelect={onSelect}
              isOpen={!!openMap[child.id]}
              onToggle={() => onToggle(child.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MY DISPLAYS SECTION ──────────────────────────────────────────────────────

function SavedSection({ selectedMetric, onSelect, isOpen, onToggle }) {
  const [saved, setSaved] = useState([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  return (
    <div>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center',
          width: '100%', textAlign: 'left',
          padding: '7px 12px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: '#64748b',
        }}
      >
        <Caret open={isOpen} />
        My Displays
      </button>

      {isOpen && (
        <div style={{ paddingBottom: 4 }}>
          {saved.length === 0 ? (
            <p style={{
              margin: '4px 12px 8px 28px',
              fontSize: 11, color: '#94a3b8', lineHeight: '15px',
            }}>
              No saved displays yet. Star any view to save it here.
            </p>
          ) : (
            saved.map((item, i) => (
              <MetricRow
                key={`saved-${i}`}
                item={item}
                depth={1}
                isActive={selectedMetric === item.metricId}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── DATA DICTIONARY ──────────────────────────────────────────────────────────

function DictEntry({ metricId, info, isOpen, onToggle }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ borderBottom: '1px solid #f1f5f9' }}>
      <button
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'flex-start',
          width: '100%', textAlign: 'left',
          padding: '6px 12px 6px 28px',
          background: hovered ? '#f8fafc' : 'transparent',
          border: 'none', cursor: 'pointer',
          gap: 6,
        }}
      >
        <span style={{
          fontSize: 8, color: '#94a3b8', marginTop: 4, flexShrink: 0,
          transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.12s',
          display: 'inline-block',
        }}>▶</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', lineHeight: '16px' }}>
            {info.displayName}
          </div>
          {!isOpen && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
              {info.callahanName}
            </div>
          )}
        </div>
        {info.lowerIsBetter === false && (
          <span style={{
            fontSize: 9, background: '#dcfce7', color: '#166534',
            borderRadius: 3, padding: '1px 4px', flexShrink: 0, marginTop: 2,
          }}>↑ better</span>
        )}
        {info.lowerIsBetter === true && (
          <span style={{
            fontSize: 9, background: '#fef3c7', color: '#92400e',
            borderRadius: 3, padding: '1px 4px', flexShrink: 0, marginTop: 2,
          }}>↓ better</span>
        )}
      </button>

      {isOpen && (
        <div style={{ padding: '0 12px 10px 44px' }}>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#475569', lineHeight: '17px' }}>
            {info.description}
          </p>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <tbody>
              <tr>
                <td style={dictLabelStyle}>Formula</td>
                <td style={dictValueStyle}>{info.formula}</td>
              </tr>
              <tr>
                <td style={dictLabelStyle}>NCUA 5300 Fields</td>
                <td style={dictValueStyle}>
                  {Array.isArray(info.ncuaFields)
                    ? info.ncuaFields.join(', ')
                    : info.ncuaFields}
                </td>
              </tr>
              <tr>
                <td style={dictLabelStyle}>Callahan Name</td>
                <td style={dictValueStyle}>{info.callahanName}</td>
              </tr>
              <tr>
                <td style={dictLabelStyle}>P76 Metric ID</td>
                <td style={{ ...dictValueStyle, fontFamily: 'monospace', fontSize: 10, color: '#6366f1' }}>
                  {info.p76MetricId}
                </td>
              </tr>
              {info.alertThreshold && (
                <tr>
                  <td style={dictLabelStyle}>Alert Threshold</td>
                  <td style={{ ...dictValueStyle, color: '#dc2626', fontWeight: 600 }}>
                    {info.alertThreshold}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const dictLabelStyle = {
  padding: '2px 8px 2px 0',
  color: '#94a3b8', fontWeight: 600,
  whiteSpace: 'nowrap', verticalAlign: 'top',
  width: 120,
};
const dictValueStyle = {
  padding: '2px 0',
  color: '#334155', verticalAlign: 'top',
};

function DataDictionarySection({ isOpen, onToggle }) {
  const [openEntries, setOpenEntries] = useState({});

  const toggleEntry = useCallback((id) => {
    setOpenEntries(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  return (
    <div>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center',
          width: '100%', textAlign: 'left',
          padding: '7px 12px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: '#64748b',
        }}
      >
        <Caret open={isOpen} />
        Data Dictionary
        <P76Badge />
      </button>

      {isOpen && (
        <div style={{
          margin: '0 8px 8px',
          border: '1px solid #e2e8f0',
          borderRadius: 6, overflow: 'hidden',
          background: '#fff',
        }}>
          <div style={{
            padding: '6px 12px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            fontSize: 10, color: '#64748b', fontWeight: 600,
            letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            {Object.keys(METRIC_DICT).length} metrics · NCUA 5300 source · measured confidence
          </div>
          {Object.entries(METRIC_DICT).map(([id, info]) => (
            <DictEntry
              key={id}
              metricId={id}
              info={info}
              isOpen={!!openEntries[id]}
              onToggle={() => toggleEntry(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SECTION DIVIDER ─────────────────────────────────────────────────────────

function Divider() {
  return <div style={{ height: 1, background: '#e2e8f0', margin: '4px 0' }} />;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function MetricLibrary({ selectedMetric, onMetricChange }) {
  const [openMap, setOpenMap] = useState(() => {
    const initial = { my_displays: true, asset_quality: true, data_dictionary: false };
    TREE.forEach(f => { if (!(f.id in initial)) initial[f.id] = f.defaultOpen ?? false; });
    TREE.forEach(f => {
      if (f.children) f.children.forEach(c => { initial[c.id] = false; });
    });
    return initial;
  });

  const toggleFolder = useCallback((id) => {
    setOpenMap(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleSelect = useCallback((metricId) => {
    onMetricChange(metricId);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('metric', metricId);
      window.history.pushState({}, '', url.toString());
    } catch { /* ignore */ }
  }, [onMetricChange]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflowY: 'auto',
      fontFamily: 'inherit',
      background: '#fff',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px 8px',
        borderBottom: '1px solid #e2e8f0',
        fontSize: 11, fontWeight: 700, color: '#334155',
        letterSpacing: '0.04em', textTransform: 'uppercase',
        flexShrink: 0,
      }}>
        Metric Library
      </div>

      {/* My Displays */}
      <SavedSection
        selectedMetric={selectedMetric}
        onSelect={handleSelect}
        isOpen={!!openMap.my_displays}
        onToggle={() => toggleFolder('my_displays')}
      />

      <Divider />

      {/* Tree folders */}
      {TREE.filter(f => f.type !== 'dictionary').map((folder) => (
        <FolderSection
          key={folder.id}
          folder={folder}
          selectedMetric={selectedMetric}
          onSelect={handleSelect}
          openMap={openMap}
          onToggle={toggleFolder}
        />
      ))}

      <Divider />

      {/* Data Dictionary */}
      <DataDictionarySection
        isOpen={!!openMap.data_dictionary}
        onToggle={() => toggleFolder('data_dictionary')}
      />

      {/* Footer attribution */}
      <div style={{
        marginTop: 'auto', padding: '10px 12px',
        borderTop: '1px solid #f1f5f9',
        fontSize: 10, color: '#94a3b8', lineHeight: '14px',
        flexShrink: 0,
      }}>
        Data: NCUA 5300 Call Report
        <br />
        All delinquency figures: measured confidence
      </div>
    </div>
  );
}
