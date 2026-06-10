import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import MarketMap from './pages/MarketMap';
import PeerComparison from './pages/PeerComparison';
import NLQuery from './pages/NLQuery';
import DelinquencyDashboard from './pages/DelinquencyDashboard';
import CreditQuality from './pages/CreditQuality';
import CallahanMigration from './pages/CallahanMigration';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace' }}>
          <strong>Runtime error — check DevTools console for details.</strong>
          <pre style={{ marginTop: 16, color: '#dc2626', whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV_ITEMS = [
  { to: '/credit-quality',      label: 'Credit Quality'    },
  { to: '/market-map',          label: 'Market Map'        },
  { to: '/peers',               label: 'Peer Comparison'   },
  { to: '/query',               label: 'Ask a Question'    },
  { to: '/callahan-migration',  label: 'Callahan Migration' },
];

function NavBar() {
  return (
    <nav style={{
      display: 'flex', alignItems: 'center', gap: 0,
      borderBottom: '1px solid #e2e8f0',
      background: '#fff',
      padding: '0 24px',
      position: 'sticky', top: 0, zIndex: 100,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      {/* Logo / brand */}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#2563eb', marginRight: 28, padding: '14px 0', whiteSpace: 'nowrap' }}>
        Market Intelligence
      </div>

      {/* Nav links */}
      {NAV_ITEMS.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          style={({ isActive }) => ({
            padding: '14px 16px',
            fontSize: 13,
            fontWeight: isActive ? 600 : 400,
            color: isActive ? '#2563eb' : '#64748b',
            textDecoration: 'none',
            borderBottom: isActive ? '2.5px solid #2563eb' : '2.5px solid transparent',
            whiteSpace: 'nowrap',
            transition: 'color 0.15s',
          })}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Layout({ children }) {
  return (
    <>
      <NavBar />
      <main>{children}</main>
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/credit-quality" replace />} />
            <Route path="/credit-quality"     element={<CreditQuality />} />
            <Route path="/market-map"         element={<MarketMap />} />
            <Route path="/peers"              element={<PeerComparison />} />
            <Route path="/query"              element={<NLQuery />} />
            <Route path="/delinquency"        element={<DelinquencyDashboard />} />
            <Route path="/callahan-migration" element={<CallahanMigration />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
