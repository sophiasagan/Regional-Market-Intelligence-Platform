import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import MarketMap from './pages/MarketMap';
import PeerComparison from './pages/PeerComparison';
import NLQuery from './pages/NLQuery';
import DelinquencyDashboard from './pages/DelinquencyDashboard';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
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

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/market-map" replace />} />
          <Route path="/market-map" element={<MarketMap />} />
          <Route path="/peers" element={<PeerComparison />} />
          <Route path="/query" element={<NLQuery />} />
          <Route path="/delinquency" element={<DelinquencyDashboard />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
