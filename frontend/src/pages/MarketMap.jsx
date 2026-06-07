/**
 * Primary dashboard view.
 *
 * Layout: full-viewport controls bar + map (60 %) + right panel (40 %).
 *
 * Required npm packages:
 *   mapbox-gl  @mapbox/mapbox-gl-draw  topojson-client
 *
 * Required env vars (Vite):
 *   VITE_MAPBOX_TOKEN          — Mapbox public token
 *   VITE_API_URL               — backend base URL (default: empty = same origin)
 *   VITE_OWN_INSTITUTION_ID    — charter_or_cert of the tenant's institution
 *
 * API endpoints consumed:
 *   GET  /market-share/county-map  ?period&metric&institution_types[&institution_id]
 *        → { [fips5]: number }  (share as fraction 0–1 per county)
 *   GET  /market-share            ?geography_type&geography_id&period&metric&institution_types
 *        → array of institution rows
 *   GET  /market-share/periods    ?metric
 *        → string[]
 *   POST /custom-regions          body: { name, geojson }
 */
import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as topojson from 'topojson-client';
import GeographySelector from '../components/GeographySelector';
import CompetitorTable from '../components/CompetitorTable';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const API_BASE     = import.meta.env.VITE_API_URL ?? '';
const OWN_ID       = import.meta.env.VITE_OWN_INSTITUTION_ID ?? '';

const COUNTIES_TOPO = 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json';
const STATES_TOPO   = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';

// Color scales — fractions 0–1
const OWN_FILL_EXPR = [
  'interpolate', ['linear'],
  ['coalesce', ['feature-state', 'ownShare'], 0],
  0,    '#eff6ff',   // 0 %
  0.05, '#bfdbfe',   // 5 %
  0.15, '#60a5fa',   // 15 %
  0.30, '#2563eb',   // 30 %
  1.0,  '#1e3a8a',   // 100 %
];

const COMP_FILL_EXPR = [
  'interpolate', ['linear'],
  ['coalesce', ['feature-state', 'compShare'], 0],
  0,    '#fff1f2',
  0.05, '#fecdd3',
  0.15, '#f87171',
  0.30, '#dc2626',
  1.0,  '#7f1d1d',
];

// us-atlas feature IDs are 5-digit FIPS strings (or integers — normalise both)
const normFips = (id) => String(id).padStart(5, '0');

// ── Main component ─────────────────────────────────────────────────────────────

export default function MarketMap() {
  const mapContainerRef = useRef(null);
  const mapRef          = useRef(null);
  const drawRef         = useRef(null);
  const popupRef        = useRef(null);
  const hoveredIdRef    = useRef(null);

  // Stale-closure guards for Mapbox event handlers
  const shareDataRef        = useRef({});
  const compDataRef         = useRef({});
  const selectedFipsRef     = useRef(null);
  // Tracks the raw numeric feature ID of the selected county for setFeatureState
  const selectedRawIdRef    = useRef(null);

  // UI state
  const [geoType,        setGeoType]        = useState('county');
  const [period,         setPeriod]         = useState('latest');
  const [comparePeriod,  setComparePeriod]  = useState(null);
  const [metric,         setMetric]         = useState('deposits');
  const [instTypes]                         = useState(['credit_union', 'bank']);
  const [selectedFips,   setSelectedFips]   = useState(null);
  const [geoLabel,       setGeoLabel]       = useState('');
  const [selectedComp,   setSelectedComp]   = useState(null);
  const [drawActive,     setDrawActive]     = useState(false);

  // Data
  const [shareData,        setShareData]        = useState({});
  const [compData,         setCompData]         = useState({});
  const [countyDetails,    setCountyDetails]    = useState([]);
  const [availablePeriods, setAvailablePeriods] = useState([]);
  const [detailsLoading,   setDetailsLoading]   = useState(false);
  const [mapReady,         setMapReady]         = useState(false);

  // Keep refs in sync
  useEffect(() => { shareDataRef.current = shareData; }, [shareData]);
  useEffect(() => { compDataRef.current  = compData;  }, [compData]);
  useEffect(() => { selectedFipsRef.current = selectedFips; }, [selectedFips]);

  // ── Map initialisation (runs once) ────────────────────────────────────────

  useEffect(() => {
    if (mapRef.current) return;
    if (!MAPBOX_TOKEN) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-95, 38],
      zoom: 3.5,
      minZoom: 2,
      maxZoom: 14,
      attributionControl: false,
    });
    mapRef.current = map;

    popupRef.current = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-left');
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120 }), 'bottom-left');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      defaultMode: 'simple_select',
    });
    drawRef.current = draw;
    map.addControl(draw, 'top-left');

    map.on('load', async () => {
      // ── County source ─────────────────────────────────────────────────────
      const [countyTopo, stateTopo] = await Promise.all([
        fetch(COUNTIES_TOPO).then(r => r.json()),
        fetch(STATES_TOPO).then(r => r.json()),
      ]);

      map.addSource('counties', {
        type: 'geojson',
        data: topojson.feature(countyTopo, countyTopo.objects.counties),
      });

      map.addSource('states', {
        type: 'geojson',
        data: topojson.feature(stateTopo, stateTopo.objects.states),
      });

      // ── Fill layers ───────────────────────────────────────────────────────
      map.addLayer({
        id: 'county-fill-own',
        type: 'fill',
        source: 'counties',
        paint: {
          'fill-color': OWN_FILL_EXPR,
          'fill-opacity': [
            'case', ['boolean', ['feature-state', 'hovered'], false], 1, 0.82,
          ],
        },
      });

      // Competitor overlay: red tones, 50 % opacity → blends with blue base
      map.addLayer({
        id: 'county-fill-competitor',
        type: 'fill',
        source: 'counties',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': COMP_FILL_EXPR,
          'fill-opacity': 0.50,
        },
      });

      // County borders — thicker at higher zoom
      map.addLayer({
        id: 'county-stroke',
        type: 'line',
        source: 'counties',
        paint: {
          'line-color': '#94a3b8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.2, 7, 0.8, 11, 1.2],
          'line-opacity': 0.5,
        },
      });

      // State borders — always visible on top of counties
      map.addLayer({
        id: 'state-stroke',
        type: 'line',
        source: 'states',
        paint: {
          'line-color': '#475569',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1, 7, 1.8],
        },
      });

      // Selected-county amber fill — driven by feature-state to avoid ID type mismatch
      map.addLayer({
        id: 'county-selected-fill',
        type: 'fill',
        source: 'counties',
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.30, 0],
        },
      });

      // Selected-county highlight ring
      map.addLayer({
        id: 'county-selected',
        type: 'line',
        source: 'counties',
        paint: {
          'line-color': '#d97706',
          'line-width': 2.5,
          'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
        },
      });

      // State fill — clickable only in state mode (visibility toggled below).
      // fill-opacity must be > 0 for Mapbox to fire click events.
      map.addLayer({
        id: 'state-fill',
        type: 'fill',
        source: 'states',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#2563eb',
          'fill-opacity': [
            'case', ['boolean', ['feature-state', 'hovered'], false], 0.12, 0.04,
          ],
        },
      });

      // ── State hover ───────────────────────────────────────────────────────
      let hoveredStateId = null;
      map.on('mousemove', 'state-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        if (hoveredStateId !== null) {
          map.setFeatureState({ source: 'states', id: hoveredStateId }, { hovered: false });
        }
        hoveredStateId = e.features[0].id;
        map.setFeatureState({ source: 'states', id: hoveredStateId }, { hovered: true });
      });
      map.on('mouseleave', 'state-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredStateId !== null) {
          map.setFeatureState({ source: 'states', id: hoveredStateId }, { hovered: false });
          hoveredStateId = null;
        }
      });

      // ── Hover ─────────────────────────────────────────────────────────────
      map.on('mousemove', 'county-fill-own', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const id   = e.features[0].id;
        const fips = normFips(id);

        if (hoveredIdRef.current !== null && hoveredIdRef.current !== id) {
          map.setFeatureState({ source: 'counties', id: hoveredIdRef.current }, { hovered: false });
        }
        hoveredIdRef.current = id;
        map.setFeatureState({ source: 'counties', id }, { hovered: true });

        const own  = shareDataRef.current[fips];
        const comp = compDataRef.current[fips];
        popupRef.current.setLngLat(e.lngLat).setHTML(tooltipHTML(fips, own, comp)).addTo(map);
      });

      map.on('mouseleave', 'county-fill-own', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredIdRef.current !== null) {
          map.setFeatureState({ source: 'counties', id: hoveredIdRef.current }, { hovered: false });
          hoveredIdRef.current = null;
        }
        popupRef.current.remove();
      });

      // ── Click — county ────────────────────────────────────────────────────
      map.on('click', 'county-fill-own', (e) => {
        const id   = e.features[0].id;
        const fips = normFips(id);

        // Clear previous selection highlight via feature-state
        if (selectedRawIdRef.current != null) {
          map.setFeatureState({ source: 'counties', id: selectedRawIdRef.current }, { selected: false });
        }
        map.setFeatureState({ source: 'counties', id }, { selected: true });
        selectedRawIdRef.current = id;

        setSelectedFips(fips);
        setGeoLabel(`County ${fips}`);
      });

      // ── Click — state (activated when geoType === 'state') ────────────────
      map.on('click', 'state-fill', (e) => {
        // State TopoJSON feature IDs are 2-digit FIPS integers (e.g. 39 → "39").
        // normFips pads to 5 digits so we can't use it here.
        const stateId = String(e.features[0].id).padStart(2, '0');
        setSelectedFips(stateId);
        setGeoLabel(e.features[0].properties?.name ?? `State ${stateId}`);
      });

      // ── Custom region draw complete ────────────────────────────────────────
      map.on('draw.create', (e) => {
        setDrawActive(false);
        handleCustomRegionCreated(e.features[0]);
      });

      setMapReady(true);
    });

    return () => {
      if (popupRef.current) popupRef.current.remove();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Feature-state: own share ──────────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    Object.entries(shareData).forEach(([fips, share]) => {
      map.setFeatureState({ source: 'counties', id: fips }, { ownShare: share });
    });
  }, [shareData, mapReady]);

  // ── Feature-state: competitor share ──────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Clear stale competitor state first
    if (Object.keys(compData).length === 0) {
      // Reset all counties
      map.querySourceFeatures('counties').forEach(f => {
        map.setFeatureState({ source: 'counties', id: f.id }, { compShare: 0 });
      });
    } else {
      Object.entries(compData).forEach(([fips, share]) => {
        map.setFeatureState({ source: 'counties', id: fips }, { compShare: share });
      });
    }
  }, [compData, mapReady]);

  // ── Selected county highlight ─────────────────────────────────────────────
  // Highlight is managed via feature-state in the click handler.
  // This effect only clears the highlight if selectedFips is reset externally.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || selectedFips) return;
    if (selectedRawIdRef.current != null) {
      map.setFeatureState({ source: 'counties', id: selectedRawIdRef.current }, { selected: false });
      selectedRawIdRef.current = null;
    }
  }, [selectedFips, mapReady]);

  // ── Competitor overlay layer visibility ───────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty(
      'county-fill-competitor', 'visibility',
      selectedComp ? 'visible' : 'none',
    );
  }, [selectedComp, mapReady]);

  // ── Geography type — toggle state-click layer ─────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const isState = geoType === 'state';
    map.setLayoutProperty('state-fill', 'visibility', isState ? 'visible' : 'none');
    map.setLayoutProperty('county-fill-own', 'visibility', isState ? 'none' : 'visible');
    map.setLayoutProperty('county-stroke',   'visibility', isState ? 'none' : 'visible');
    map.setLayoutProperty('county-fill-competitor', 'visibility',
      !isState && selectedComp ? 'visible' : 'none');
  }, [geoType, mapReady, selectedComp]);

  // ── Draw mode ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.changeMode(drawActive ? 'draw_polygon' : 'simple_select');
  }, [drawActive]);

  // ── Data fetching: bulk county share map ──────────────────────────────────

  useEffect(() => {
    const qs = new URLSearchParams({
      period, metric, institution_types: instTypes.join(','),
    });
    fetch(`${API_BASE}/market-share/county-map?${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setShareData(typeof data === 'object' && data.data ? data.data : data))
      .catch(err => console.error('County map data error:', err));
  }, [period, metric, instTypes]);

  // ── Data fetching: competitor share map ───────────────────────────────────

  useEffect(() => {
    if (!selectedComp) { setCompData({}); return; }
    const qs = new URLSearchParams({
      period, metric, institution_types: instTypes.join(','),
      institution_id: selectedComp,
    });
    fetch(`${API_BASE}/market-share/county-map?${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setCompData(typeof data === 'object' && data.data ? data.data : data))
      .catch(err => console.error('Competitor map data error:', err));
  }, [selectedComp, period, metric, instTypes]);

  // ── Data fetching: county/geo detail for right panel ─────────────────────

  useEffect(() => {
    if (!selectedFips) return;
    setDetailsLoading(true);
    const resolvedType = geoType === 'custom' ? 'custom_region' : geoType;
    const qs = new URLSearchParams({
      geography_type: resolvedType,
      geography_id: selectedFips,
      period, metric,
      institution_types: instTypes.join(','),
    });
    fetch(`${API_BASE}/market-share?${qs}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setCountyDetails(Array.isArray(data) ? data : data.results ?? []))
      .catch(err => console.error('Detail fetch error:', err))
      .finally(() => setDetailsLoading(false));
  }, [selectedFips, geoType, period, metric, instTypes]);

  // ── Data fetching: available periods ─────────────────────────────────────

  useEffect(() => {
    fetch(`${API_BASE}/market-share/periods?metric=${metric}`)
      .then(r => r.ok ? r.json() : [])
      .then(periods => {
        const ps = Array.isArray(periods) ? periods : [];
        setAvailablePeriods(ps);
        // Auto-select the most recent real period when current period is
        // 'latest' or not present in the returned list.
        if (ps.length > 0) {
          setPeriod(prev => (prev === 'latest' || !ps.includes(prev)) ? ps[0] : prev);
        }
      })
      .catch(() => {});
  }, [metric]);

  // ── Custom region handler ─────────────────────────────────────────────────

  const handleCustomRegionCreated = useCallback(async (polygon) => {
    const name = `Custom Region ${new Date().toLocaleDateString()}`;
    try {
      await fetch(`${API_BASE}/custom-regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, geojson: polygon }),
      });
    } catch (err) {
      console.error('Failed to save custom region:', err);
    }
    setSelectedFips(name);
    setGeoLabel(name);
  }, []);

  // ── Competitor selection ──────────────────────────────────────────────────

  function handleCompetitorSelect(id) {
    setSelectedComp(prev => prev === id ? null : id);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={layout.root}>
      <GeographySelector
        geoType={geoType}         onGeoTypeChange={setGeoType}
        period={period}           onPeriodChange={setPeriod}
        comparePeriod={comparePeriod} onComparePeriodChange={setComparePeriod}
        availablePeriods={availablePeriods}
        drawActive={drawActive}
        onStartDraw={() => setDrawActive(true)}
        onCancelDraw={() => setDrawActive(false)}
      />

      <div style={layout.body}>
        {/* ── Map pane ──────────────────────────────────────────────────── */}
        <div style={layout.mapPane}>
          <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

          {/* Legend */}
          {mapReady && (
            <Legend metric={metric} showCompetitor={!!selectedComp} />
          )}

          {/* Competitor overlay banner */}
          {selectedComp && (
            <div style={overlayBanner}>
              <span style={{ color: '#2563eb', fontWeight: 600 }}>●</span>&nbsp;Your Share&nbsp;&nbsp;
              <span style={{ color: '#dc2626', fontWeight: 600 }}>●</span>&nbsp;Competitor (50 % blend)&nbsp;&nbsp;
              <button
                style={{ fontSize: 12, border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}
                onClick={() => setSelectedComp(null)}
              >
                ✕ Remove overlay
              </button>
            </div>
          )}
        </div>

        {/* ── Right panel ───────────────────────────────────────────────── */}
        <div style={layout.panel}>
          <CompetitorTable
            rows={countyDetails}
            ownInstitutionId={OWN_ID}
            metric={metric}
            onMetricChange={setMetric}
            period={period}
            comparePeriod={comparePeriod}
            selectedCompetitorId={selectedComp}
            onCompetitorSelect={handleCompetitorSelect}
            isLoading={detailsLoading}
            geoLabel={geoLabel}
          />
        </div>
      </div>
    </div>
  );
}

// ── Tooltip HTML ──────────────────────────────────────────────────────────────

function tooltipHTML(fips, ownShare, compShare) {
  const pct = (v) => v != null ? `${(v * 100).toFixed(1)}%` : '—';
  return `
    <div style="font-size:13px;line-height:1.6;padding:2px 0">
      <strong style="font-size:14px;display:block;margin-bottom:4px">${fips}</strong>
      <span style="color:#2563eb">●</span> Your share: <strong>${pct(ownShare)}</strong>
      ${compShare != null
        ? `<br/><span style="color:#dc2626">●</span> Competitor: <strong>${pct(compShare)}</strong>`
        : ''}
    </div>`;
}

// ── Legend ────────────────────────────────────────────────────────────────────

const METRIC_LABELS = {
  deposits:              'Deposit Share',
  loans:                 'Loan Share',
  members:               'Member Share',
  mortgage_originations: 'Mortgage Share',
};

function Legend({ metric, showCompetitor }) {
  return (
    <div style={{
      position: 'absolute', bottom: 40, left: 10, zIndex: 2,
      backgroundColor: 'rgba(255,255,255,0.96)', padding: '10px 12px',
      borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      fontSize: 11, minWidth: 150, pointerEvents: 'none',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#0f172a', fontSize: 12 }}>
        {METRIC_LABELS[metric] ?? 'Market Share'}
      </div>
      <GradientBar gradient="linear-gradient(to right, #eff6ff, #bfdbfe, #60a5fa, #2563eb, #1e3a8a)" />
      {showCompetitor && (
        <>
          <div style={{ fontWeight: 700, marginTop: 10, marginBottom: 6, color: '#dc2626', fontSize: 12 }}>
            Competitor
          </div>
          <GradientBar gradient="linear-gradient(to right, #fff1f2, #fecdd3, #f87171, #dc2626, #7f1d1d)" />
        </>
      )}
    </div>
  );
}

function GradientBar({ gradient }) {
  return (
    <>
      <div style={{ background: gradient, width: 126, height: 10, borderRadius: 3, marginBottom: 3 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', width: 126 }}>
        {['0%', '5%', '15%', '30%+'].map(l => <span key={l}>{l}</span>)}
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const layout = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  mapPane: { flex: '0 0 60%', position: 'relative', overflow: 'hidden' },
  panel: { flex: '0 0 40%', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #e2e8f0', overflow: 'hidden' },
};

const overlayBanner = {
  position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
  backgroundColor: 'rgba(255,255,255,0.96)', padding: '6px 14px',
  borderRadius: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  fontSize: 13, whiteSpace: 'nowrap', zIndex: 2, display: 'flex', alignItems: 'center',
};
