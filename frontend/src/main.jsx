import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import MarketMap from './pages/MarketMap';
import PeerComparison from './pages/PeerComparison';
import NLQuery from './pages/NLQuery';
import DelinquencyDashboard from './pages/DelinquencyDashboard';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/market-map" replace />} />
        <Route path="/market-map" element={<MarketMap />} />
        <Route path="/peers" element={<PeerComparison />} />
        <Route path="/query" element={<NLQuery />} />
        <Route path="/delinquency" element={<DelinquencyDashboard />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
