const API_BASE = '/api/v1';

// SatQuery AI – Simplified GIS Frontend

// ==== Global State ====
let map; // Leaflet map instance
let imageOverlay = null; // Current GeoTIFF overlay
let currentLayer = null; // Metadata of selected layer (dataset)
let layers = []; // Array of dataset objects
let pixelMarker = null; // Crosshair marker for pixel inspector
let selectedPixel = null; // Currently inspected pixel data
let basemapLayer = null; // Basemap layer reference
let drawnItems = null; // LayerGroup for drawn features
let vqaEvidenceLayer = null; // LayerGroup for VQA grounding evidence
let currentAOI = null; // Current Area of Interest
let changeAnalysisMode = "live";
let changeBeforeLayer = null;
let changeAfterLayer = null;
let changeOverlayLayer = null;
let caseStudyBeforeScene = null;
let caseStudyAfterScene = null;
let caseStudyBeforeLayer = null;
let caseStudyAfterLayer = null;
let caseStudyChangeLayer = null;
let caseStudyAoiLayer = null;
let caseStudyBeforeMeta = null;
let caseStudyAfterMeta = null;

async function loggedFetch(url, options = {}) {
    console.log(`[FETCH REQUEST] ${options.method || 'GET'} ${url}`);
    const res = await fetch(url, options);
    console.log(`[FETCH RESPONSE] ${res.status} ${res.url}`);
    return res;
}

// ==== Initialization ====
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEventListeners();
  updateNoDataState();
    // FORCE case study selectors to be visible immediately
    const selectors = document.getElementById('change-analysis-selectors');
    const msg = document.getElementById('change-analysis-message');
    if (selectors) selectors.style.display = 'block';
    const cmSelectors = document.getElementById('cross-modal-selectors');
    if (cmSelectors) cmSelectors.style.display = 'block';
    if (msg) msg.style.display = 'none';

});

function initMap() {
  const emptyTileUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
  const emptyTile = L.tileLayer(emptyTileUrl, { attribution: '' });

  basemapLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
  });

  basemapLayer.on('tileerror', function(error, tile) {
      basemapLayer.setOpacity(0);
      document.getElementById('basemap-toggle').checked = false;
      document.getElementById('basemap-toggle').disabled = true;
  });

  map = L.map('map', {
    center: [0, 0],
    zoom: 2,
    zoomControl: false,
    layers: [emptyTile, basemapLayer]
  });

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  vqaEvidenceLayer = L.layerGroup().addTo(map);

  const drawControl = new L.Control.Draw({
    position: 'topleft',
    draw: {
      polyline: false,
      circle: false,
      circlemarker: false,
      marker: true,
      rectangle: true,
      polygon: true
    },
    edit: {
      featureGroup: drawnItems,
      edit: false,
      remove: false
    }
  });
  map.addControl(drawControl);

  map.on(L.Draw.Event.CREATED, function (e) {
      drawnItems.clearLayers();
      const layer = e.layer;
      drawnItems.addLayer(layer);
      
        const geojson = layer.toGeoJSON();
        let area_m2 = null;
        let area_km2 = null;
        
        let nw, se, west, east, north, south;
        if (e.layerType === 'marker') {
            const ll = layer.getLatLng();
            west = ll.lng; east = ll.lng;
            south = ll.lat; north = ll.lat;
        } else {
            const b = layer.getBounds();
            nw = b.getNorthWest().wrap();
            se = b.getSouthEast().wrap();
            west = nw.lng;
            east = se.lng;
            if (west > east) {
                west = b.getWest();
                east = b.getEast();
            }
            south = b.getSouth();
            north = b.getNorth();
            
            try {
                let latlngs = layer.getLatLngs();
                const ring = (latlngs.length > 0 && Array.isArray(latlngs[0])) ? latlngs[0] : latlngs;
                if (L.GeometryUtil && L.GeometryUtil.geodesicArea) {
                    area_m2 = L.GeometryUtil.geodesicArea(ring);
                    area_km2 = area_m2 / 1000000;
                }
            } catch(err) {
                console.warn("Area calculation error", err);
            }
        }

        currentAOI = { 
            geometry_type: e.layerType === 'marker' ? 'Point' : (e.layerType === 'rectangle' ? 'Rectangle' : 'Polygon'),
            geometry: geojson.geometry,
            bbox: { west, south, east, north },
            area_m2: area_m2,
            area_km2: area_km2,
            
            // Legacy attributes to preserve existing UI compatibility
            type: e.layerType === 'marker' ? 'Point' : (e.layerType === 'rectangle' ? 'Rectangle' : 'Polygon'),
            geojson: geojson
        };
        
        if (e.layerType === 'marker') {
            const ll = layer.getLatLng();
            currentAOI.lat = ll.lat;
            currentAOI.lng = ll.lng;
        } else {
            currentAOI.bounds = layer.getBounds();
            currentAOI.area = area_m2;
        console.log('TEMPORARY AOI LOG for verification:', { geometry_type: currentAOI.geometry_type, geometry: currentAOI.geometry, bbox: currentAOI.bbox, area_m2: currentAOI.area_m2, area_km2: currentAOI.area_km2 });
        }
      updateAOIPanel();
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  map.on('mousemove', (e) => {
    updateStatusBarCoords(e.latlng);
  });
  map.on('zoomend', () => {
    updateStatusBar();
  });
  map.on('click', handleMapClick);
}

// ==== UI Helpers ====
function updateAOIPanel() {
    const noSel = document.getElementById('aoi-no-selection');
    const details = document.getElementById('aoi-details');
    
    if (!currentAOI) {
        if(noSel) noSel.style.display = 'block';
        if(details) details.style.display = 'none';
        return;
    }
    
    if(noSel) noSel.style.display = 'none';
    if(details) details.style.display = 'block';
    
    document.getElementById('aoi-type').textContent = currentAOI.type;
    
    document.getElementById('aoi-point-group').style.display = 'none';
    document.getElementById('aoi-bbox-group').style.display = 'none';
    document.getElementById('aoi-area-group').style.display = 'none';
    
    if (currentAOI.type === 'Point') {
        document.getElementById('aoi-point-group').style.display = 'flex';
        document.getElementById('aoi-coords').textContent = `Latitude: ${currentAOI.lat.toFixed(6)}°\nLongitude: ${currentAOI.lng.toFixed(6)}°`;
    } else {
        document.getElementById('aoi-bbox-group').style.display = 'flex';
        const b = currentAOI.bounds;
        document.getElementById('aoi-bbox').textContent = `North: ${b.getNorth().toFixed(6)}°\nSouth: ${b.getSouth().toFixed(6)}°\nEast: ${b.getEast().toFixed(6)}°\nWest: ${b.getWest().toFixed(6)}°`;
        
        if (currentAOI.area) {
            document.getElementById('aoi-area-group').style.display = 'flex';
            let areaStr = '';
            if (currentAOI.area > 1000000) {
                areaStr = (currentAOI.area / 1000000).toFixed(2) + ' km²';
            } else {
                areaStr = currentAOI.area.toFixed(2) + ' m²';
            }
            document.getElementById('aoi-area').textContent = areaStr;
        }
    }
}

function updateNoDataState() {
  const noDataMsg = document.getElementById('no-data-msg');
  if (layers.length === 0) {
    noDataMsg.style.display = 'block';
  } else {
    noDataMsg.style.display = 'none';
  }
}

function addLayerToList(dataset) {
  let targetList;
  if (dataset.is_analysis) {
      targetList = document.getElementById('list-analysis');
      document.getElementById('group-analysis').style.display = 'block';
      document.getElementById('group-stac').style.display = 'block';
  } else {
      targetList = document.getElementById('list-uploaded');
      document.getElementById('group-uploaded').style.display = 'block';
  }

  const li = document.createElement('li');
  li.dataset.id = dataset.id;
  li.style.cursor = 'pointer';
  li.style.display = 'flex';
  li.style.flexDirection = 'column';
  li.style.paddingBottom = '8px';
  
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.disabled = true;

  const nameSpan = document.createElement('span');
  nameSpan.innerHTML = dataset.name;
  nameSpan.style.fontWeight = '600';
  
  const descSpan = document.createElement('span');
  descSpan.style.color = 'var(--muted)';
  descSpan.style.fontSize = '12px';
  descSpan.style.marginLeft = 'auto'; // push to the right side
  
  if (dataset.is_analysis) {
      descSpan.innerHTML = 'NDVI Analysis';
  } else {
      descSpan.innerHTML = `Sentinel-2 &middot; Multispectral`;
  }
  
  header.appendChild(checkbox);
  header.appendChild(nameSpan);
  header.appendChild(descSpan);
  li.appendChild(header);
  
  if (dataset.is_stac) {
      const tree = document.createElement('div');
      tree.style.marginLeft = '24px';
      tree.style.marginTop = '4px';
      tree.style.color = 'var(--text)';
      tree.style.fontSize = '12px';
      tree.style.fontFamily = 'monospace';
      
      dataset.bands.forEach((b, idx) => {
          const isLast = idx === dataset.bands.length - 1;
          const prefix = isLast ? '└── ' : '├── ';
          const node = document.createElement('div');
          node.textContent = `${prefix}${b.id}`;
          tree.appendChild(node);
      });
      li.appendChild(tree);
  }

  li.addEventListener('click', () => {
    selectLayer(dataset.id);
  });

  targetList.appendChild(li);
}

function clearLayerList() {
  document.getElementById('list-uploaded').innerHTML = '';
  document.getElementById('list-stac').innerHTML = '';
  document.getElementById('list-analysis').innerHTML = '';
  
  document.getElementById('group-uploaded').style.display = 'none';
  document.getElementById('group-stac').style.display = 'none';
  document.getElementById('group-analysis').style.display = 'none';
}

function selectLayer(layerId) {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return;
  currentLayer = layer;
  
  const vqaLabel = document.getElementById('vqa-selected-image-panel');
  if (vqaLabel) vqaLabel.textContent = layer.name;

  // Update UI (highlight selected item and sync checkboxes)
  document.querySelectorAll('.layer-list li').forEach(li => {
    const cb = li.querySelector('input[type="checkbox"]');
    if (li.dataset.id === layerId) {
      li.classList.add('selected');
      if (cb) cb.checked = true;
    } else {
      li.classList.remove('selected');
      if (cb && li.dataset.id) cb.checked = false; // Only uncheck dataset layers, preserve basemap if it were in this list
    }
  });
  
  // Populate dropdowns
  const bandSelect = document.getElementById('layer-band');
  const redSelect = document.getElementById('layer-red');
  const greenSelect = document.getElementById('layer-green');
  const blueSelect = document.getElementById('layer-blue');
  
  [bandSelect, redSelect, greenSelect, blueSelect].forEach(sel => {
      sel.innerHTML = '';
      layer.bands.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = `${b.id} — ${b.description}`;
          sel.appendChild(opt);
      });
  });
  
  const bandIds = layer.bands.map(b => b.id);
  const renderMode = document.getElementById('render-mode');
  const singleControls = document.getElementById('single-band-controls');
  const rgbControls = document.getElementById('rgb-controls');
  
  const rgbOption = renderMode.querySelector('option[value="rgb"]');
  const renderModeGroup = document.getElementById('render-mode-group');
  
  if (layer.is_stac) {
      if (renderModeGroup) renderModeGroup.style.display = 'none';
      bandSelect.value = "True Color";
      singleControls.style.display = 'block';
      rgbControls.style.display = 'block';
      redSelect.value = "B04";
      greenSelect.value = "B03";
      blueSelect.value = "B02";
  } else if (layer.bands.length < 3) {
      if (renderModeGroup) renderModeGroup.style.display = 'block';
      if (rgbOption) rgbOption.style.display = 'none';
      renderMode.value = "single";
      bandSelect.value = layer.bands[0].id;
      singleControls.style.display = 'block';
      rgbControls.style.display = 'none';
  } else {
      if (renderModeGroup) renderModeGroup.style.display = 'block';
      if (rgbOption) rgbOption.style.display = '';
      if (bandIds.includes("B04") && bandIds.includes("B03") && bandIds.includes("B02")) {
          renderMode.value = "rgb";
          redSelect.value = "B04";
          greenSelect.value = "B03";
          blueSelect.value = "B02";
          singleControls.style.display = 'none';
          rgbControls.style.display = 'block';
      } else {
          renderMode.value = "single";
          bandSelect.value = layer.bands[0].id;
          singleControls.style.display = 'block';
          rgbControls.style.display = 'none';
      }
  }

  document.getElementById('layer-opacity').value = "100";
  
  const vminInput = document.getElementById('vis-min');
  const vmaxInput = document.getElementById('vis-max');
  const genericVis = document.getElementById('generic-vis-controls');
  const ndviVis = document.getElementById('ndvi-vis-controls');
  
  if (layer.is_analysis && layer.analysis_data && layer.analysis_data.analysis === 'NDVI') {
      if (genericVis) genericVis.style.display = 'none';
      if (ndviVis) ndviVis.style.display = 'block';
      
      const vis = layer.vis_params || { colormap: 'ndvi', vmin: -1.0, vmax: 1.0, opacity: 100 };
      document.getElementById('ndvi-colormap').value = vis.colormap;
      document.getElementById('ndvi-vis-min').value = vis.vmin;
      document.getElementById('ndvi-vis-max').value = vis.vmax;
      document.getElementById('ndvi-opacity').value = vis.opacity;
      const opVal = document.getElementById('ndvi-opacity-val');
      if (opVal) opVal.textContent = `${vis.opacity}%`;
  } else {
      if (genericVis) genericVis.style.display = 'block';
      if (ndviVis) ndviVis.style.display = 'none';
      
      if (layer.is_analysis) {
          vminInput.value = "";
          vmaxInput.value = "";
          vminInput.disabled = true;
          vmaxInput.disabled = true;
      } else {
          vminInput.disabled = false;
          vmaxInput.disabled = false;
          
          if (layer.is_stac) {
              vminInput.value = "";
              vmaxInput.value = "";
          } else {
              const firstMeta = layer.bands[0].metadata;
              vminInput.value = firstMeta.p2 !== undefined ? firstMeta.p2.toFixed(2) : "";
              vmaxInput.value = firstMeta.p98 !== undefined ? firstMeta.p98.toFixed(2) : "";
          }
      }
  }

  updateMapOverlay();

  // Reset pixel inspector
  document.getElementById('pixel-inspector-section').style.display = 'none';
  if (pixelMarker) {
    map.removeLayer(pixelMarker);
    pixelMarker = null;
  }
  selectedPixel = null;
  
  populateInspector(layer);
  updateStatusBar();
}

function updateMapOverlay() {
  if (!currentLayer) return;
  updateVqaUI();
  
  let opacity = 1.0;
  if (currentLayer.is_analysis && currentLayer.analysis_data.analysis === 'NDVI') {
      opacity = parseInt(document.getElementById('ndvi-opacity').value) / 100.0;
  } else {
      opacity = parseInt(document.getElementById('layer-opacity').value) / 100.0;
  }
  
  const renderMode = document.getElementById('render-mode').value;
  
  let url = `${API_BASE}/datasets/${currentLayer.id}/preview`;
  

  if (currentLayer.is_analysis) {
      if (currentLayer.analysis_data.analysis === 'NDVI') {
          const colormap = document.getElementById('ndvi-colormap').value;
          const vmin = document.getElementById('ndvi-vis-min').value;
          const vmax = document.getElementById('ndvi-vis-max').value;
          let fixedMax = parseFloat(vmax);
          let fixedMin = parseFloat(vmin);
          if (fixedMin >= fixedMax) fixedMax = fixedMin + 0.1;
          
          const parts = currentLayer.preview_url.split('/');
          const resultId = parts[parts.length - 2];
          
          url = `${API_BASE}/analysis/render?result_id=${resultId}&colormap=${colormap}&vmin=${fixedMin}&vmax=${fixedMax}`;
      } else {
          url = currentLayer.preview_url;
      }
  } else {
      const band = document.getElementById('layer-band').value;
      const vmin = document.getElementById('vis-min').value;
      const vmax = document.getElementById('vis-max').value;
      
      let params = [];
      if (vmin !== "" && vmax !== "") {
          params.push(`vmin=${vmin}`);
          params.push(`vmax=${vmax}`);
      }
      const paramStr = params.length > 0 ? `?${params.join('&')}` : '';
      
      if (currentLayer.is_stac) {
          if (band === 'True Color') {
              url = currentLayer.preview_url;
          } else {
              url = `${API_BASE}/catalog/scene/${currentLayer.id}/band/${band}/preview${paramStr}`;
          }
      } else {
          let paramStrLocal = "?";
          if (renderMode === 'rgb') {
              const r = document.getElementById('layer-red').value;
              const g = document.getElementById('layer-green').value;
              const b = document.getElementById('layer-blue').value;
              paramStrLocal += `red=${r}&green=${g}&blue=${b}`;
          } else {
              paramStrLocal += `band=${band}`;
          }
          if (vmin !== "" && vmax !== "") {
              paramStrLocal += `&vmin=${vmin}&vmax=${vmax}`;
          }
          url += paramStrLocal;
      }
  }
  const bounds = currentLayer.bounds;

  if (imageOverlay) {
    map.removeLayer(imageOverlay);
    imageOverlay = null;
  }
  
  if (bounds && bounds.length === 2) {
    imageOverlay = L.imageOverlay(url, bounds, { opacity: opacity }).addTo(map);
    map.fitBounds(bounds);
  } else {
    const worldBounds = [[-90, -180], [90, 180]];
    imageOverlay = L.imageOverlay(url, worldBounds, { opacity: opacity }).addTo(map);
    map.setView([0, 0], 2);
  }
  
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '-';
  };
  const vmin = document.getElementById('vis-min').value;
  const vmax = document.getElementById('vis-max').value;
  set('inspector-vmin', vmin !== "" ? vmin : '-');
  set('inspector-vmax', vmax !== "" ? vmax : '-');
  
  const ndviLegend = document.getElementById('ndvi-legend');
  if (ndviLegend) {
      if (currentLayer.is_analysis && currentLayer.analysis_data.analysis === 'NDVI') {
          ndviLegend.style.display = 'block';
          // Update legend dynamically
          const colormap = document.getElementById('ndvi-colormap').value;
          let vmin = parseFloat(document.getElementById('ndvi-vis-min').value);
          let vmax = parseFloat(document.getElementById('ndvi-vis-max').value);
          if (vmin >= vmax) vmax = vmin + 0.1;
          
          let html = `<div style="font-weight: 600; margin-bottom: 8px;">NDVI</div><div style="display: flex; flex-direction: column; gap: 4px;">`;
          const steps = [
              { label: vmax.toFixed(2), frac: 1.0 },
              { label: (vmin + (vmax - vmin) * 0.75).toFixed(2), frac: 0.75 },
              { label: (vmin + (vmax - vmin) * 0.5).toFixed(2), frac: 0.5 },
              { label: (vmin + (vmax - vmin) * 0.25).toFixed(2), frac: 0.25 },
              { label: vmin.toFixed(2), frac: 0.0 }
          ];
          
          steps.forEach(step => {
              let color = '';
              if (colormap === 'grayscale') {
                  const val = Math.round(step.frac * 255);
                  color = `rgb(${val}, ${val}, ${val})`;
              } else if (colormap === 'inverted') {
                  const val = Math.round((1 - step.frac) * 255);
                  color = `rgb(${val}, ${val}, ${val})`;
              } else {
                  if (step.frac >= 0.5) {
                      const f = (step.frac - 0.5) * 2.0;
                      const r = Math.round(255 + f * (0 - 255));
                      const g = Math.round(255 + f * (104 - 255));
                      const b = Math.round(191 + f * (55 - 191));
                      color = `rgb(${r}, ${g}, ${b})`;
                  } else {
                      const f = step.frac * 2.0;
                      const r = Math.round(165 + f * (255 - 165));
                      const g = Math.round(0 + f * (255 - 0));
                      const b = Math.round(38 + f * (191 - 38));
                      color = `rgb(${r}, ${g}, ${b})`;
                  }
              }
              html += `<div style="display: flex; align-items: center; gap: 8px;"><div style="width: 16px; height: 16px; background: ${color};"></div><span>${step.label}</span></div>`;
          });
          html += `</div>`;
          ndviLegend.innerHTML = html;
      } else {
          ndviLegend.style.display = 'none';
      }
  }
}

function populateInspector(dataset) {
  const meta = dataset.metadata; // use base metadata
  
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '-';
  };
  
  const datasetProps = document.getElementById('inspector-dataset-props');
  if (dataset.is_analysis) {
        const stats = dataset.analysis_data.statistics;
        const areaStr = dataset.analysis_data.area ? (dataset.analysis_data.area / 1000000).toFixed(2) + ' km²' : '-';
        datasetProps.innerHTML = `
          <div class="prop-row"><span class="label-text">Analysis</span><span class="value-text" id="inspector-sensor">NDVI</span></div>
          <div class="prop-row"><span class="label-text">Dataset</span><span class="value-text" style="color: var(--accent-color); font-weight: 600;">${dataset.source_layer_name || dataset.scene_info?.scene_id || dataset.analysis_data.scene_id}</span></div>
          <div class="prop-row"><span class="label-text">AOI</span><span class="value-text">${dataset.analysis_data.scope || 'Full Scene'}</span></div>
          <div class="prop-row"><span class="label-text">AOI Area</span><span class="value-text mono">${areaStr}</span></div>
          <div class="prop-row"><span class="label-text">Formula</span><span class="value-text mono" id="inspector-formula" style="font-size: 11px;">(B08 - B04) / (B08 + B04)</span></div>
          
          <div style="margin-top: 12px; margin-bottom: 4px; font-weight: 600; font-size: 11px; color: var(--text-secondary);">STATISTICS</div>
          <div class="prop-row"><span class="label-text">Minimum NDVI</span><span class="value-text mono">${stats.min.toFixed(4)}</span></div>
          <div class="prop-row"><span class="label-text">Maximum NDVI</span><span class="value-text mono">${stats.max.toFixed(4)}</span></div>
          <div class="prop-row"><span class="label-text">Mean NDVI</span><span class="value-text mono">${stats.mean.toFixed(4)}</span></div>
          <div class="prop-row"><span class="label-text">Median NDVI</span><span class="value-text mono">${stats.median.toFixed(4)}</span></div>
          
          <div style="margin-top: 12px; margin-bottom: 4px; font-weight: 600; font-size: 11px; color: var(--text-secondary);">PIXEL COUNTS</div>
          <div class="prop-row"><span class="label-text">Total pixels</span><span class="value-text mono">${(stats.total_pixel_count || 0).toLocaleString()}</span></div>
          <div class="prop-row"><span class="label-text">Valid pixels</span><span class="value-text mono">${(stats.valid_pixel_count || 0).toLocaleString()}</span></div>
          <div class="prop-row"><span class="label-text">No-data pixels</span><span class="value-text mono">${(stats.nodata_pixel_count || 0).toLocaleString()}</span></div>
        `;
    } else if (dataset.is_stac) {
      datasetProps.innerHTML = `
        <div class="prop-row"><span class="label-text">Dataset</span><span class="value-text" id="inspector-sensor">Sentinel-2 L2A</span></div>
        <div class="prop-row"><span class="label-text">Acquisition</span><span class="value-text" id="inspector-acq">${dataset.scene_info.datetime.split('T')[0]}</span></div>
        <div class="prop-row"><span class="label-text">Cloud cover</span><span class="value-text" id="inspector-cloud">${dataset.scene_info.cloud_cover.toFixed(1)}%</span></div>
        <div class="prop-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
            <span class="label-text">Scene ID</span>
            <span class="value-text mono" style="font-size: 11px; word-break: break-all;" id="inspector-sceneid">${dataset.scene_info.scene_id}</span>
        </div>
        <div class="prop-row" style="flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 8px;">
            <span class="label-text">Available assets</span>
            <span class="value-text mono" style="font-size: 11px; word-break: break-word;" id="inspector-assets">${Object.keys(dataset.scene_info.assets).join(', ')}</span>
        </div>
      `;
  } else {
      datasetProps.innerHTML = `
        <div class="prop-row"><span class="label-text">Sensor</span><span class="value-text" id="inspector-sensor">-</span></div>
        <div class="prop-row"><span class="label-text">Band</span><span class="value-text" id="inspector-band">-</span></div>
        <div class="prop-row"><span class="label-text">Dimensions</span><span class="value-text" id="inspector-dim">-</span></div>
        <div class="prop-row"><span class="label-text">Data type</span><span class="value-text mono" id="inspector-dtype">-</span></div>
      `;
      set('inspector-sensor', 'Sentinel-2');
      set('inspector-band', dataset.bands.length === 1 ? `Band ${dataset.bands[0].id.replace('B0', '').replace('B', '')} — ${dataset.bands[0].description}` : `${dataset.bands.length} bands`);
      set('inspector-dim', `${meta.width || '-'} × ${meta.height || '-'}`);
      set('inspector-dtype', meta.dtype || '-');
  }

  set('inspector-name', dataset.name || '-');
  set('inspector-source-crs', meta.source_crs || meta.crs || '-');
  set('inspector-display-crs', 'EPSG:3857');
  set('inspector-coord-crs', 'EPSG:4326');
  set('inspector-res', meta.resolution ? `${Math.abs(meta.resolution).toFixed(0)} m` : '-');
  
  if (dataset.bounds) {
      set('inspector-bounds', `[${dataset.bounds[0][0].toFixed(4)}, ${dataset.bounds[0][1].toFixed(4)}] to [${dataset.bounds[1][0].toFixed(4)}, ${dataset.bounds[1][1].toFixed(4)}]`);
  } else {
      set('inspector-bounds', '-');
  }
  
  set('inspector-driver', meta.driver || '-');
  set('inspector-status', dataset.is_stac ? `STAC reference` : `Loaded successfully`);
}

function updateStatusBarCoords(latlng) {
  const statusBar = document.getElementById('status-bar');
  if (!currentLayer) return;
  const zoom = map.getZoom();
  let text = `CRS: ${currentLayer.metadata.crs || 'EPSG:4326'} | Zoom: ${zoom} | Cursor: ${latlng.lat.toFixed(4)}° N, ${latlng.lng.toFixed(4)}° E`;
  const res = currentLayer.metadata.resolution_x || currentLayer.metadata.resolution;
  if (res) text += ` | Resolution: ${Math.abs(res).toFixed(0)} m`;
  text += ` | Selected: ${currentLayer.name}`;
  if (selectedPixel) {
      text += ` | Pixel: row ${selectedPixel.row}, col ${selectedPixel.column}`;
  }
  statusBar.textContent = text;
}

function updateStatusBar() {
  const statusBar = document.getElementById('status-bar');
  if (!currentLayer) {
    statusBar.textContent = 'Ready';
    return;
  }
  const zoom = map.getZoom();
  const center = map.getCenter();
  let text = `CRS: ${currentLayer.metadata.crs || 'EPSG:4326'} | Zoom: ${zoom} | Center: ${center.lat.toFixed(4)}° N, ${center.lng.toFixed(4)}° E`;
  const res = currentLayer.metadata.resolution_x || currentLayer.metadata.resolution;
  if (res) text += ` | Resolution: ${Math.abs(res).toFixed(0)} m`;
  text += ` | Selected: ${currentLayer.name}`;
  if (selectedPixel) {
      text += ` | Pixel: row ${selectedPixel.row}, col ${selectedPixel.column}`;
  }
  statusBar.textContent = text;
}

async function handleMapClick(e) {
  if (!currentLayer) return;
  
  const section = document.getElementById('pixel-inspector-section');
  const details = document.getElementById('pixel-details');
  const errorSection = document.getElementById('pixel-error-section');
  
  section.style.display = 'block';
  details.style.display = 'block';
  errorSection.style.display = 'none';
  document.getElementById('pixel-coords').textContent = 'Loading...';
  document.getElementById('pixel-rc').textContent = '-';
  document.getElementById('pixel-band-values-container').innerHTML = '';
  document.getElementById('pixel-dtype').textContent = '-';
  document.getElementById('pixel-res').textContent = '-';
  
  if (pixelMarker) map.removeLayer(pixelMarker);
  pixelMarker = L.circleMarker(e.latlng, {
      radius: 5,
      color: 'var(--accent-cyan)',
      weight: 2,
      fillOpacity: 0
  }).addTo(map);
  
  try {
      const resp = await fetch(`${API_BASE}/datasets/${currentLayer.id}/pixel?lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
      if (!resp.ok) throw new Error('Failed to fetch pixel');
      const data = await resp.json();
      
      if (data.status === 'outside') {
          details.style.display = 'none';
          errorSection.style.display = 'block';
          selectedPixel = null;
      } else {
          details.style.display = 'block';
          errorSection.style.display = 'none';
          
          const latDir = data.latitude >= 0 ? 'N' : 'S';
          const lonDir = data.longitude >= 0 ? 'E' : 'W';
          
          document.getElementById('pixel-coords').textContent = `${Math.abs(data.latitude).toFixed(4)}° ${latDir}\n${Math.abs(data.longitude).toFixed(4)}° ${lonDir}`;
          document.getElementById('pixel-rc').textContent = `Row ${data.row}\nColumn ${data.column}`;
          document.getElementById('pixel-dtype').textContent = data.dtype || currentLayer.metadata.dtype;
          document.getElementById('pixel-res').textContent = `${Math.abs(data.resolution_x).toFixed(0)} m`;
          
          // Populate dynamic values list
          const valuesContainer = document.getElementById('pixel-band-values-container');
          valuesContainer.innerHTML = '';
          
          if (data.values.length === 1) {
              const v = data.values[0];
              const bandName = `Band ${v.band.replace('B0', '').replace('B', '')} — ${v.description}`;
              
              valuesContainer.innerHTML = `
                <div class="prop-col" style="margin-bottom: 12px;">
                   <span class="label-text">Band</span>
                   <span class="value-text" id="pixel-band">${bandName}</span>
                </div>
                <div class="prop-col" style="margin-bottom: 12px;">
                   <span class="label-text">Value</span>
                   <span class="value-text mono" id="pixel-value" style="font-weight:600; color: var(--accent);">${v.error ? 'Error' : v.value}</span>
                </div>
              `;
          } else {
              valuesContainer.innerHTML = `<div class="prop-col" style="margin-bottom: 12px;"><span class="label-text">Values</span><div class="multi-values"></div></div>`;
              const dd = valuesContainer.querySelector('.multi-values');
              data.values.forEach(v => {
                  const div = document.createElement('div');
                  div.style.marginBottom = '6px';
                  const title = document.createElement('div');
                  title.textContent = `${v.band} — ${v.description}`;
                  title.className = 'label-text';
                  const val = document.createElement('div');
                  val.textContent = v.error ? 'Error' : v.value;
                  val.className = 'value-text mono';
                  val.style.fontWeight = '600';
                  val.style.color = 'var(--accent)';
                  div.appendChild(title);
                  div.appendChild(val);
                  dd.appendChild(div);
              });
          }
          
          selectedPixel = data;
      }
      
      updateStatusBarCoords(e.latlng);
      
  } catch (err) {
      console.error(err);
      details.style.display = 'none';
      errorSection.style.display = 'block';
      selectedPixel = null;
  }
}

// ==== Event Listeners ====
function setupEventListeners() {
  document.getElementById('btn-clear-aoi').addEventListener('click', () => {
      drawnItems.clearLayers();
      currentAOI = null;
      updateAOIPanel();
  });

  document.getElementById('btn-add-data').addEventListener('click', () => {
    document.getElementById('geotiff-upload').click();
  });
  
  document.getElementById('geotiff-upload').addEventListener('change', async (e) => {
    const fileInput = e.target;
    if (!fileInput.files.length) return;
    
    document.getElementById('header-status').textContent = 'Uploading...';
    
    const form = new FormData();
    for (let i=0; i<fileInput.files.length; i++) {
        form.append('files', fileInput.files[i]);
    }
    
    try {
      const resp = await fetch(API_BASE + '/images/upload', {
        method: 'POST',
        body: form
      });
      const data = await resp.json();
      if (!resp.ok) {
          throw new Error(data.detail || 'Upload failed');
      }
      
      const datasetMeta = {
        id: data.dataset_id || data.id,
        name: data.name || data.filename,
        bounds: data.bounds,
        bands: data.bands || [],
        metadata: data.metadata || (data.bands && data.bands.length > 0 ? data.bands[0].metadata : {})
      };

      const existingIndex = layers.findIndex(l => l.id === datasetMeta.id);
      if (existingIndex >= 0) {
          layers[existingIndex] = datasetMeta;
      } else {
          layers.push(datasetMeta);
      }
      clearLayerList();
      layers.forEach(addLayerToList);
      updateNoDataState();
      
      selectLayer(datasetMeta.id);
      document.getElementById('header-status').textContent = `Dataset loaded: ${datasetMeta.name}`;
      fileInput.value = '';
    } catch (err) {
      console.error(err);
      alert(`Error uploading dataset:\n${err.message}`);
      document.getElementById('header-status').textContent = 'Upload failed';
      fileInput.value = '';
    }
  });

  // Render controls
  document.getElementById('render-mode').addEventListener('change', (e) => {
      const isRgb = e.target.value === 'rgb';
      document.getElementById('single-band-controls').style.display = isRgb ? 'none' : 'block';
      document.getElementById('rgb-controls').style.display = isRgb ? 'block' : 'none';
      updateMapOverlay();
  });

  const selectRedraw = () => {
      if (currentLayer && currentLayer.is_stac) {
          const band = document.getElementById('layer-band').value;
          document.getElementById('rgb-controls').style.display = (band === 'True Color') ? 'block' : 'none';
      }
      updateMapOverlay();
  };
  document.getElementById('layer-band').addEventListener('change', selectRedraw);
  document.getElementById('layer-red').addEventListener('change', selectRedraw);
  document.getElementById('layer-green').addEventListener('change', selectRedraw);
  document.getElementById('layer-blue').addEventListener('change', selectRedraw);

  let debounceTimer;
  const updateVis = () => {
    if (!currentLayer) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        updateMapOverlay();
    }, 500); 
  };

  document.getElementById('vis-min').addEventListener('input', updateVis);
  document.getElementById('vis-max').addEventListener('input', updateVis);
  
  document.getElementById('layer-opacity').addEventListener('input', (e) => {
    if (imageOverlay) {
        imageOverlay.setOpacity(parseInt(e.target.value) / 100.0);
    }
    const el = document.getElementById('inspector-opo');
    if (el) el.textContent = `${e.target.value}%`;
  });
  
  const ndviColormapEl = document.getElementById('ndvi-colormap');
  if (ndviColormapEl) {
      const saveAndUpdate = () => {
          if (currentLayer && currentLayer.is_analysis && currentLayer.analysis_data.analysis === 'NDVI') {
              currentLayer.vis_params = currentLayer.vis_params || {};
              currentLayer.vis_params.colormap = document.getElementById('ndvi-colormap').value;
              let vmin = parseFloat(document.getElementById('ndvi-vis-min').value);
              let vmax = parseFloat(document.getElementById('ndvi-vis-max').value);
              
              if (vmin >= vmax) {
                  vmax = vmin + 0.1;
                  document.getElementById('ndvi-vis-max').value = vmax.toFixed(1);
              }
              
              currentLayer.vis_params.vmin = vmin;
              currentLayer.vis_params.vmax = vmax;
          }
          updateVis();
      };
      
      ndviColormapEl.addEventListener('change', saveAndUpdate);
      document.getElementById('ndvi-vis-min').addEventListener('input', saveAndUpdate);
      document.getElementById('ndvi-vis-max').addEventListener('input', saveAndUpdate);
      
      document.getElementById('ndvi-opacity').addEventListener('input', (e) => {
          if (currentLayer && currentLayer.is_analysis && currentLayer.analysis_data.analysis === 'NDVI') {
              currentLayer.vis_params = currentLayer.vis_params || {};
              currentLayer.vis_params.opacity = parseInt(e.target.value);
              if (imageOverlay) {
                  imageOverlay.setOpacity(currentLayer.vis_params.opacity / 100.0);
              }
          }
          const el = document.getElementById('ndvi-opacity-val');
          if (el) el.textContent = `${e.target.value}%`;
      });
  }
  
  const btnExport = document.getElementById('btn-export-geotiff');
  const btnReport = document.getElementById('btn-generate-report');
  
  if (btnExport) btnExport.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      alert('Export GeoTIFF functionality is not yet implemented.');
  });
  if (btnReport) btnReport.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const payload = {
            layer: currentLayer ? {
                name: currentLayer.name,
                id: currentLayer.id,
                stac_properties: currentLayer.stac_properties || {}
            } : null,
            aoi: currentAOI ? {
                type: currentAOI.geometry_type || currentAOI.type,
                area: currentAOI.area_m2 || currentAOI.area,
                bounds: {
                    north: currentAOI.bounds ? currentAOI.bounds.getNorth() : currentAOI.bbox.north,
                    south: currentAOI.bounds ? currentAOI.bounds.getSouth() : currentAOI.bbox.south,
                    east: currentAOI.bounds ? currentAOI.bounds.getEast() : currentAOI.bbox.east,
                    west: currentAOI.bounds ? currentAOI.bounds.getWest() : currentAOI.bbox.west
                }
            } : null,
            ndvi: (currentLayer && currentLayer.is_analysis && currentLayer.analysis_data) ? {
                ...currentLayer.analysis_data,
                source_crs: currentLayer.metadata?.source_crs || currentLayer.metadata?.crs || '-',
                display_crs: 'EPSG:3857',
                resolution: currentLayer.metadata?.resolution ? `${Math.abs(currentLayer.metadata.resolution).toFixed(0)} m` : '-'
            } : null,
            vqa: document.getElementById('vqa-answer').textContent !== '-' && document.getElementById('vqa-answer').textContent !== 'Analyzing satellite image...' ? {
                question: document.getElementById('query-input-panel').value,
                answer: document.getElementById('vqa-answer').textContent,
                confidence_status: document.getElementById('vqa-confidence').textContent,
                execution: {
                    model: 'google/paligemma-3b-ft-rsvqa-hr-224'
                }
            } : null
        };
        
        btnReport.disabled = true;
        btnReport.textContent = "Generating...";
        
        if (imageOverlay && imageOverlay._url) {
            try {
                const imgRes = await fetch(imageOverlay._url);
                const blob = await imgRes.blob();
                payload.image_data = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
            } catch (e) {
                console.warn("Could not fetch image data for PDF: ", e);
            }
        }
        
        const res = await fetch(API_BASE + '/export/pdf', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error('Failed to generate report');
        
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'satquery_report.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (e) {
        alert("Error exporting PDF: " + e.message);
    } finally {
        btnReport.disabled = false;
        btnReport.textContent = "Export PDF Report";
    }
});

  const tabs = ['data', 'analysis', 'query', 'export', 'settings'];
  tabs.forEach(tab => {
      const navEl = document.getElementById(`nav-${tab}`);
      if (navEl) {
          navEl.addEventListener('click', (e) => {
              tabs.forEach(t => {
                  const nt = document.getElementById(`nav-${t}`);
                  if (nt) {
                      nt.classList.remove('active');
                  }
                  const p = document.getElementById(`${t}-panel`);
                  if (p) p.style.display = 'none';
              });
              navEl.classList.add('active');
              
              const p = document.getElementById(`${tab}-panel`);
              if (p) {
                  p.style.display = (tab === 'data' || tab === 'query') ? 'flex' : 'block';
              }
              
              if (tab === 'query') {
                  document.body.classList.add('query-active');
              } else {
                  document.body.classList.remove('query-active');
              }
          });
      }
  });

  
  const projNav = document.getElementById('nav-project');
  if (projNav) projNav.addEventListener('click', () => alert("Project management is not implemented yet."));

  function getVqaContext() {
      if (!currentLayer) return null;
      let image_type = "raster";
      let modality = "optical";
      let representation = "single_band";
      let displayName = currentLayer.name;
      let source = "unknown";
      
      if (currentLayer.is_stac) {
          image_type = "satellite_scene";
          source = "sentinel-2";
          const band = document.getElementById('layer-band').value;
          if (band === "True Color") {
              representation = "rgb";
              displayName = "Sentinel-2 True Color";
          } else {
              representation = "single_band";
              displayName = band;
          }
      } else if (currentLayer.is_analysis) {
          image_type = "analysis";
          modality = "derived";
          source = "satquery_analysis";
          representation = currentLayer.analysis_data.analysis ? currentLayer.analysis_data.analysis.toLowerCase() : "unknown";
          displayName = currentLayer.name;
      } else {
          image_type = "raster";
          modality = "optical";
          source = "uploaded_raster";
          const renderMode = document.getElementById('render-mode') ? document.getElementById('render-mode').value : 'single';
          if (renderMode === 'rgb' || (currentLayer.bands && currentLayer.bands.length >= 3 && renderMode !== 'single')) {
              representation = "rgb";
              displayName = currentLayer.name + " (RGB)";
          } else {
              representation = "single_band";
              displayName = currentLayer.name;
          }
      }
      return { image_type, modality, representation, displayName, source };
  }

  window.updateVqaUI = function() {
      const vqaLabel = document.getElementById('vqa-selected-image-panel');
      if (!vqaLabel) return;
      const ctx = getVqaContext();
      if (!ctx) {
          vqaLabel.textContent = "None";
      } else {
          vqaLabel.textContent = ctx.displayName;
      }
  };

  const btnQueryPanel = document.getElementById('btn-query-panel');
  const qInputPanel = document.getElementById('query-input-panel');
  if (qInputPanel && btnQueryPanel) {
      qInputPanel.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              btnQueryPanel.click();
          }
      });
  }

    if (btnQueryPanel) {
        btnQueryPanel.addEventListener('click', async () => {
            console.log('Ask Query Button Clicked!');
            const qInput = document.getElementById('query-input-panel');
            const q = qInput.value.trim();
            
            if (!q) {
                document.getElementById('header-status').textContent = 'ERROR: Empty question';
                alert("Enter a question about the selected image.");
                return;
            }
            if (q.length > 500) {
                document.getElementById('header-status').textContent = 'ERROR: Question too long';
                alert("Question is too long.");
                return;
            }
            
            // (Removed hallucinated history code)
            
            const historyContainer = document.getElementById('query-history-container');
            const emptyHistory = document.getElementById('query-history-empty');
            if (emptyHistory) emptyHistory.style.display = 'none';
            
            const historyItem = document.createElement('div');
            historyItem.style.background = 'var(--app-bg)';
            historyItem.style.border = '1px solid var(--border)';
            historyItem.style.borderRadius = 'var(--radius)';
            historyItem.style.padding = '12px';
            
            const qDiv = document.createElement('div');
            qDiv.style.fontWeight = '600';
            qDiv.style.fontSize = '12px';
            qDiv.style.marginBottom = '8px';
            qDiv.innerHTML = `<i class="fa-solid fa-user" style="margin-right: 6px; color: var(--accent);"></i> ${q}`;
            
            const aDiv = document.createElement('div');
            aDiv.style.fontSize = '12px';
            aDiv.style.color = 'var(--text-light)';
            aDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right: 6px;"></i> Analyzing...';
            
            historyItem.appendChild(qDiv);
            historyItem.appendChild(aDiv);
            historyContainer.prepend(historyItem);
            
            const resultSec = document.getElementById('vqa-result-section');
            resultSec.style.display = 'block';
            document.getElementById('vqa-answer').textContent = "Analyzing request intent...";
            
            if (vqaEvidenceLayer) vqaEvidenceLayer.clearLayers();
            
            try {
                btnQueryPanel.disabled = true;
                
                const beforeSel = document.getElementById('change-before-select');
                const afterSel = document.getElementById('change-after-select');
                const beforeId = beforeSel ? beforeSel.value : null;
                const afterId = afterSel ? afterSel.value : null;
                
                let aoiData = null;
                if (currentAOI) {
                    if (currentAOI.bounds) {
                        const b = currentAOI.bounds;
                        aoiData = { type: 'Polygon', bbox: { west: b.getWest(), north: b.getNorth(), east: b.getEast(), south: b.getSouth() } };
                    } else if (currentAOI.bbox) {
                        aoiData = { type: 'Polygon', bbox: currentAOI.bbox };
                    } else if (currentAOI.lat !== undefined) {
                        aoiData = { type: 'Point', lat: currentAOI.lat, lng: currentAOI.lng };
                    }
                }
                
                // 1. Ask the backend to route the query
                document.getElementById('header-status').textContent = 'ROUTING TASK...';
                const routeRes = await loggedFetch(API_BASE + '/query/route', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question: q })
                });
                
                if (!routeRes.ok) throw new Error("Failed to reach routing service.");
                const routeData = await routeRes.json();
                const task = routeData.task;
                
                document.getElementById('header-status').textContent = `TASK DETECTED: ${task.toUpperCase().replace('_', ' ')}`;
                
                let data = null;
                let ctx = null;
                let ansText = '';
                
                if (task === 'change_vqa') {
                    if (!beforeId || !afterId) throw new Error("Change-VQA requires both a Before and After satellite scene. Please select the two scenes first.");
                    if (beforeId === afterId) throw new Error("Before and After scenes must be different. Please select different acquisition dates.");
                    if (!aoiData) throw new Error("Please select an Area of Interest before running Change-VQA.");
                    
                    document.getElementById('header-status').textContent = 'RUNNING CHANGE VQA...';
                    const res = await loggedFetch(API_BASE + '/change/vqa', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image_before_id: beforeId, image_after_id: afterId, question: q, aoi: aoiData })
                    });
                    data = await res.json();
                    
                    if (data.status === 'success') {
                        const changeEv = (data.evidence || []).find(e => e.type === 'image_overlay');
                        if (changeEv) {
                            const evData = changeEv.data;
                            if (changeAnalysisMode === 'case-study') {
                                const KANCHA_AOI = [[17.41, 78.32], [17.45, 78.36]];
                                const imgOverlay = L.imageOverlay(evData, KANCHA_AOI, {opacity: 1.0, interactive: false});
                                
                                if (caseStudyChangeLayer) map.removeLayer(caseStudyChangeLayer);
                                caseStudyChangeLayer = imgOverlay;
                                
                                if (caseStudyBeforeLayer) map.removeLayer(caseStudyBeforeLayer);
                                if (caseStudyAfterLayer) {
                                    caseStudyAfterLayer.addTo(map);
                                    caseStudyAfterLayer.bringToFront();
                                }
                                caseStudyChangeLayer.addTo(map);
                                caseStudyChangeLayer.bringToFront();
                                if (caseStudyAoiLayer) caseStudyAoiLayer.bringToFront();
                                
                                if (!window.changeLegendControl) {
                                    window.changeLegendControl = L.control({position: 'bottomright'});
                                    window.changeLegendControl.onAdd = function(map) {
                                        const div = L.DomUtil.create('div', 'satquery-change-legend');
                                        div.innerHTML = `
                                            <div class="legend-title" style="font-weight: 600; font-size: 11px; margin-bottom: 6px;">Change Analysis</div>
                                            <div class="legend-row" style="display: flex; align-items: center; margin-bottom: 4px;">
                                                <span class="legend-color" style="display: inline-block; width: 14px; height: 14px; background: rgba(255, 40, 40, 0.8); margin-right: 8px;"></span>
                                                <span style="font-size: 11px;">Detected change</span>
                                            </div>
                                            <div class="legend-row" style="display: flex; align-items: center;">
                                                <span class="legend-neutral" style="display: inline-block; width: 14px; height: 14px; background: rgba(255, 255, 255, 0.3); border: 1px dashed rgba(255,255,255,0.5); margin-right: 8px;"></span>
                                                <span style="font-size: 11px;">Satellite imagery</span>
                                            </div>
                                        `;
                                        L.DomEvent.disableClickPropagation(div);
                                        return div;
                                    };
                                }
                                window.changeLegendControl.addTo(map);
                                
                                map.fitBounds(KANCHA_AOI, { padding: [40, 40] });
                                map.invalidateSize(true);
                                
                                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                                if (vqaLabel) vqaLabel.textContent = "Change Analysis";
                                
                                try {
                                    document.getElementById('inspector-name').textContent = "Change-VQA";
                                    document.getElementById('inspector-sensor').textContent = "Sentinel-2 L2A";
                                    document.getElementById('inspector-band').textContent = "Before: 2025-03-28";
                                    document.getElementById('inspector-dim').textContent = "After: 2025-04-02";
                                    document.getElementById('inspector-dtype').textContent = "Baseline Raster Difference";
                                    document.getElementById('inspector-res').textContent = "0.25 (Threshold)";
                                    document.getElementById('inspector-source-crs').textContent = "-";
                                    document.getElementById('inspector-display-crs').textContent = "-";
                                    document.getElementById('inspector-coord-crs').textContent = "-";
                                    document.getElementById('inspector-bounds').textContent = "-";
                                } catch(e) {}
                            } else {
                                const imgOverlay = L.imageOverlay(evData, changeEv.bounds, {opacity: 1.0, interactive: false});
                                if (changeOverlayLayer) map.removeLayer(changeOverlayLayer);
                                changeOverlayLayer = imgOverlay;
                                
                                if (changeBeforeLayer) map.removeLayer(changeBeforeLayer);
                                if (changeAfterLayer) {
                                    changeAfterLayer.addTo(map);
                                    changeAfterLayer.bringToFront();
                                }
                                changeOverlayLayer.addTo(map);
                                changeOverlayLayer.bringToFront();
                                
                                const rect = L.rectangle(changeEv.bounds, {color: '#ef4444', weight: 2, fill: false});
                                rect.addTo(map);
                            }
                        }
                        
                        const methodFormat = data.method === 'baseline_raster_difference' ? 'Baseline Raster Difference' : data.method;
                        const exec = data.execution || {};
                        ansText = `<div style="font-family: sans-serif; line-height: 1.5; font-size: 13px;">
<strong>CHANGE-VQA</strong><br><br>
<strong>Question:</strong><br>
${data.question || q}<br><br>
<strong>Answer:</strong><br>
${data.answer}<br><br>
<strong>Change detected:</strong><br>
${data.change_percentage.toFixed(2)}%<br><br>
<strong>Changed pixels:</strong><br>
${data.changed_pixel_count.toLocaleString()}<br><br>
<strong>Valid pixels:</strong><br>
${data.total_valid_pixel_count.toLocaleString()}<br><br>
<strong>Before:</strong><br>
${data.before_scene}<br><br>
<strong>After:</strong><br>
${data.after_scene}<br><br>
<strong>Method:</strong><br>
${methodFormat}<br><br>
<strong>Evidence:</strong><br>
Visual overlay on map<br><br>
<strong>Execution:</strong><br>
Task: ${exec.task || 'change_vqa'}<br>
Model: ${exec.model || 'change_interpreter'}<br>
Provider: ${exec.provider || 'local'}<br>
Status: ${exec.status || 'success'}
</div>`;
                    } else {
                        ansText = "Change-VQA failed.<br><br>" + (data.error || "Please check the selected scenes and AOI and try again.");
                    }
                    
                } else if (task === 'ndvi') {
                    if (!currentLayer || !currentLayer.is_stac) throw new Error("NDVI requires Sentinel-2 Red (B04) and Near-Infrared (B08) bands. Please load a Sentinel-2 image first.");
                    
                    document.getElementById('header-status').textContent = 'RUNNING NDVI ANALYSIS...';
                    const source_type = currentLayer.is_stac ? 'stac' : 'local';
                    const res = await loggedFetch(API_BASE + '/analysis/ndvi', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ scene_id: currentLayer.id, source_type: source_type, aoi: aoiData })
                    });
                    
                    if (!res.ok) {
                        const errData = await res.json();
                        throw new Error(errData.detail || errData.message || errData.error || 'Unknown error');
                    }
                    data = await res.json();
                    
                    const stats = data.statistics || {};
                    const mean_val = stats.mean || 0.0;
                    
                    let mean_desc = "indicating very low or no vegetation";
                    if (mean_val > 0.6) mean_desc = "indicating dense, healthy vegetation";
                    else if (mean_val > 0.3) mean_desc = "indicating moderate vegetation";
                    else if (mean_val > 0.1) mean_desc = "indicating sparse vegetation";
                    
                    ansText = `<div style="font-family: sans-serif; line-height: 1.5; font-size: 13px;">
<strong>NDVI ANALYSIS</strong><br><br>
<strong>Mean NDVI:</strong><br>${mean_val.toFixed(3)}<br><br>
<strong>Minimum:</strong><br>${(stats.min || 0).toFixed(3)}<br><br>
<strong>Maximum:</strong><br>${(stats.max || 0).toFixed(3)}<br><br>
<strong>Median:</strong><br>${(stats.median || 0).toFixed(3)}<br><br>
<strong>Valid Pixels:</strong><br>${(stats.valid_pixel_count || 0).toLocaleString()}<br><br>
<strong>Vegetation Pixels:</strong><br>${(stats.vegetation_area_percentage || 0).toFixed(1)}% of valid area<br><br>
<strong>Interpretation:</strong><br>
NDVI analysis completed. The selected AOI has a mean NDVI of ${mean_val.toFixed(2)}, ${mean_desc}. Approximately ${(stats.vegetation_area_percentage || 0).toFixed(1)}% of valid pixels have NDVI &ge; 0.40.<br><br>
<strong>Execution:</strong><br>
Task: ndvi<br>
Model: NDVI spectral analysis<br>
Provider: local<br>
Status: success
</div>`;
                    
                    data.execution = { task: 'ndvi', model: 'NDVI spectral analysis', provider: 'local', status: 'success' };
                    
                    const urlParts = data.image_url.split('/');
                    const resultId = urlParts[urlParts.length - 2];
                    
                    // Create layer
                    const datasetMeta = {
                        id: `analysis:ndvi:${data.scene_id}`,
                        name: `NDVI - ${data.scene_id.includes('_') ? data.scene_id.split('_')[2].split('T')[0] : data.scene_id.substring(0, 8)}`,
                        is_stac: false,
                        is_analysis: true,
                        source_layer_name: currentLayer.name,
                        analysis_data: data,
                        bounds: data.bounds,
                        preview_url: data.image_url,
                        bands: [{ id: 'NDVI', description: 'Vegetation Index' }],
                        metadata: {
                            crs: 'EPSG:4326',
                            source_crs: currentLayer.metadata.source_crs || currentLayer.metadata.crs,
                            resolution: currentLayer.metadata.resolution,
                            dtype: 'float32',
                            driver: 'Analysis'
                        }
                    };
                    
                    const existingIndex = layers.findIndex(l => l.id === datasetMeta.id);
                    if (existingIndex >= 0) {
                        layers[existingIndex] = datasetMeta;
                    } else {
                        layers.push(datasetMeta);
                    }
                    clearLayerList();
                    layers.forEach(addLayerToList);
                    updateNoDataState();
                    selectLayer(datasetMeta.id);
                
                    
                } else if (task === 'grounding' || task === 'vqa') {
                    ctx = getVqaContext();
                    if (!ctx) {
                        let obj = task === 'grounding' ? 'spatial detection' : 'a visual question';
                        throw new Error(`Please select or upload a satellite image before asking for ${obj}.`);
                    }
                    
                    document.getElementById('header-status').textContent = `RUNNING ${task.toUpperCase()}...`;
                    const res = await loggedFetch(API_BASE + '/vqa/query', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            image_id: currentLayer.id,
                            image_type: ctx.image_type,
                            source: ctx.source,
                            modality: ctx.modality,
                            representation: ctx.representation,
                            question: q,
                            mode: task,
                            aoi: aoiData
                        })
                    });
                    data = await res.json();
                    
                    if (data.status === 'success' || data.status === 'unavailable') {
                        ansText = data.answer || data.message || "Unable to complete query.";
                    } else {
                        ansText = `Failed: ${data.detail || data.error || data.message || 'Unknown error'}`;
                    }
                    
                    // Render grounding bounding boxes if available
                    const evidenceEl = document.getElementById('vqa-evidence');
                    if (data.evidence && data.evidence.length > 0) {
                        evidenceEl.innerHTML = '';
                        data.evidence.forEach(ev => {
                            const div = document.createElement('div');
                            div.style.marginBottom = '8px';
                            const scoreStr = ev.confidence !== null && ev.confidence !== undefined 
                                ? `Grounding score: ${ev.confidence.toFixed(2)}` 
                                : '';
                            div.innerHTML = `<strong>${ev.label}</strong><br><span style="font-size: 11px; color: var(--text-secondary);">${scoreStr}</span><br><a href="#" style="font-size:11px;">[Show on map]</a>`;
                            evidenceEl.appendChild(div);
                            
                            const link = div.querySelector('a');
                            link.addEventListener('click', (evClick) => {
                                evClick.preventDefault();
                                if (ev.geometry && ev.geometry.coordinate_system === 'wgs84') {
                                    if (ev.type === 'bbox' && ev.geometry.coordinates.length === 4) {
                                        const [x1, y1, x2, y2] = ev.geometry.coordinates;
                                        const bounds = [[y1, x1], [y2, x2]];
                                        L.rectangle(bounds, {color: '#f00', weight: 2}).bindPopup(ev.label).addTo(vqaEvidenceLayer);
                                    }
                                } else if (ev.geometry && ev.geometry.coordinate_system === 'image_pixel') {
                                      if (currentLayer && currentLayer.bounds) {
                                          if (ev.type === 'bbox' && ev.geometry.coordinates.length === 4) {
                                              const [x1, y1, x2, y2] = ev.geometry.coordinates;
                                              const w = 1024;
                                              const h = 1024;
                                              let bounds = currentLayer.bounds;
                                              if (aoiData) {
                                                  bounds = [[aoiData.south, aoiData.west], [aoiData.north, aoiData.east]];
                                              }
                                              const s = bounds[0][0], w_ = bounds[0][1], n = bounds[1][0], e_ = bounds[1][1];
                                              const lat1 = n - (y1 / h) * (n - s);
                                              const lon1 = w_ + (x1 / w) * (e_ - w_);
                                              const lat2 = n - (y2 / h) * (n - s);
                                              const lon2 = w_ + (x2 / w) * (e_ - w_);
                                            L.rectangle([[lat1, lon1], [lat2, lon2]], {color: '#f00', weight: 2}).bindPopup(`${ev.label} (${scoreStr})`).addTo(vqaEvidenceLayer);
                                        }
                                    } else {
                                        alert("Cannot map pixel coordinates to this image.");
                                    }
                                }
                            });
                        });
                    }
                    
                } else {
                    // unknown task
                    ansText = "I can currently analyze satellite imagery using visual question answering, spatial object detection, vegetation/NDVI analysis, and before/after change analysis. Try asking something like 'Is there water?', 'Show the water bodies', 'Analyze vegetation', or 'Compare these images'.";
                    document.getElementById('header-status').textContent = 'TASK UNKNOWN';
                    data = { execution: { provider: 'system', model: 'router', status: 'success' } };
                }
                
                document.getElementById('vqa-answer').innerHTML = ansText;
                aDiv.innerHTML = `<span style="color: var(--accent);"><i class="fa-solid fa-reply" style="margin-right: 6px;"></i></span>` + ansText;
                
                const statusDiv = document.createElement('div');
                statusDiv.style.fontSize = '11px';
                statusDiv.style.color = 'var(--text-muted)';
                statusDiv.style.marginTop = '8px';
                statusDiv.textContent = `Provider: ${data.execution?.provider || 'remote'} | Model: ${data.execution?.model || 'unknown'} | Status: ${data.execution?.status || 'success'}`;
                historyItem.appendChild(statusDiv);
                if (data.confidence_status === 'not_calibrated') {
                    document.getElementById('vqa-confidence').textContent = "Not calibrated";
                } else if (data.confidence) {
                    document.getElementById('vqa-confidence').textContent = `${data.confidence}`;
                }
                
                if (data.execution) {
                    document.getElementById('vqa-execution').textContent = `Task: ${data.execution.task || task}
Model: ${data.execution.model}
Provider: ${data.execution.provider}
Status: ${data.execution.status}`;
                }
                
            } catch (err) {
                console.error(err);
                document.getElementById('header-status').textContent = 'ERROR';
                const errMsg = err.message || "An unknown error occurred.";
                document.getElementById('vqa-answer').textContent = `Error: ${errMsg}`;
                aDiv.innerHTML = `<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation" style="margin-right: 6px;"></i> ${errMsg}</span>`;
                document.getElementById('vqa-execution').textContent = `Task: unknown
Model: unknown
Provider: local
Status: error

Message:
${errMsg}`;
            } finally {
                btnQueryPanel.disabled = false;
            }
        });
    }

  // ==== BASEMAP TOGGLE ====
  const basemapToggle = document.getElementById('basemap-toggle');
  if (basemapToggle) {
      basemapToggle.addEventListener('change', (e) => {
          if (e.target.checked) {
              basemapLayer.setOpacity(1);
          } else {
              basemapLayer.setOpacity(0);
          }
      });
  }

  // ==== MAP CONTROLS ====
  const mcZoomIn = document.getElementById('mc-zoom-in');
  if (mcZoomIn) mcZoomIn.addEventListener('click', () => map.zoomIn());

  const mcZoomOut = document.getElementById('mc-zoom-out');
  if (mcZoomOut) mcZoomOut.addEventListener('click', () => map.zoomOut());

  const mcLocate = document.getElementById('mc-locate');
  if (mcLocate) mcLocate.addEventListener('click', () => map.locate({setView: true, maxZoom: 16}));

  const mcFitToScreen = document.getElementById('mc-fit-to-screen');
  if (mcFitToScreen) {
      mcFitToScreen.addEventListener('click', () => {
          if (currentAOI && currentAOI.geometry_type === 'Polygon' && drawnItems && drawnItems.getLayers().length > 0) {
              map.fitBounds(drawnItems.getBounds());
          } else if (drawnItems && drawnItems.getLayers().length > 0) {
              map.fitBounds(drawnItems.getBounds());
          } else if (currentLayer && currentLayer.bounds) {
              map.fitBounds(currentLayer.bounds);
          } else {
              const msg = document.createElement('div');
              msg.textContent = "No spatial layer available to fit.";
              msg.style.position = 'absolute';
              msg.style.top = '20px';
              msg.style.left = '50%';
              msg.style.transform = 'translateX(-50%)';
              msg.style.background = 'rgba(26,26,26,0.8)';
              msg.style.color = '#fff';
              msg.style.padding = '8px 16px';
              msg.style.borderRadius = 'var(--radius)';
              msg.style.zIndex = '10000';
              msg.style.fontSize = '12px';
              msg.style.pointerEvents = 'none';
              document.querySelector('.map-area').appendChild(msg);
              setTimeout(() => msg.remove(), 2500);
          }
      });
  }

  const mcFit = document.getElementById('mc-fit');
  if (mcFit) {
      mcFit.addEventListener('click', () => {
          const mapEl = document.getElementById('map');
          if (!document.fullscreenElement) {
              if (mapEl.requestFullscreen) {
                  mapEl.requestFullscreen();
              }
          } else {
              if (document.exitFullscreen) {
                  document.exitFullscreen();
              }
          }
      });
  }

  const mcLayers = document.getElementById('mc-layers');
  if (mcLayers) {
      mcLayers.addEventListener('click', () => {
          document.getElementById('nav-data').click();
      });
  }

  const mcDraw = document.getElementById('mc-draw');
  if (mcDraw) {
      mcDraw.addEventListener('click', () => {
          if (drawnItems && drawnItems.getLayers().length > 0) {
              drawnItems.clearLayers();
              currentAOI = null;
              updateAOIPanel();
          } else {
              new L.Draw.Rectangle(map, { shapeOptions: { color: 'var(--accent)' } }).enable();
          }
      });
  }

  const mcMeasure = document.getElementById('mc-measure');
  if (mcMeasure) mcMeasure.addEventListener('click', () => alert("Measure tool is not connected yet."));

  const mcPixel = document.getElementById('mc-pixel');
  if (mcPixel) {
      mcPixel.addEventListener('click', () => {
          alert("Click anywhere on the map to inspect pixel values.");
      });
  }

  // ==== STAC SEARCH ====
  const caseStudySel = document.getElementById('change-case-study');
    if (caseStudySel) {
        caseStudySel.addEventListener('change', () => {
            if (caseStudySel.value === 'kancha') {
                activateKanchaCaseStudy();
                return;
            }
            changeAnalysisMode = "live";
            updateChangeAnalysisDropdowns();
        });
    }

    const btnBefore = document.getElementById('btn-vis-before');
    const btnAfter = document.getElementById('btn-vis-after');
    const btnChange = document.getElementById('btn-vis-change');
    
    if (btnBefore) {
        btnBefore.addEventListener('click', () => {
            if (changeAnalysisMode === 'case-study') {
                if (caseStudyAfterLayer) map.removeLayer(caseStudyAfterLayer);
                if (caseStudyChangeLayer) map.removeLayer(caseStudyChangeLayer);
                if (caseStudyBeforeLayer) {
                    caseStudyBeforeLayer.addTo(map);
                    caseStudyBeforeLayer.bringToFront();
                }
                if (caseStudyAoiLayer) caseStudyAoiLayer.bringToFront();
                if (window.changeLegendControl) map.removeControl(window.changeLegendControl);
                
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel) vqaLabel.textContent = "Sentinel-2 - 2025-03-28";
                
                const KANCHA_AOI = [[17.41, 78.32], [17.45, 78.36]];
                map.fitBounds(KANCHA_AOI, { padding: [40, 40] });
                map.invalidateSize(true);
            } else {
                if (changeAfterLayer) map.removeLayer(changeAfterLayer);
                if (changeOverlayLayer) map.removeLayer(changeOverlayLayer);
                if (changeBeforeLayer) {
                    changeBeforeLayer.addTo(map);
                    changeBeforeLayer.bringToFront();
                }
                if (window.changeLegendControl) map.removeControl(window.changeLegendControl);
                const beforeId = document.getElementById('change-before-select').value;
                const bLayerData = layers.find(l => l.id === beforeId);
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel && bLayerData) vqaLabel.textContent = `Before: ${bLayerData.name}`;
            }
        });
    }
    
    if (btnAfter) {
        btnAfter.addEventListener('click', () => {
            if (changeAnalysisMode === 'case-study') {
                if (caseStudyBeforeLayer) map.removeLayer(caseStudyBeforeLayer);
                if (caseStudyChangeLayer) map.removeLayer(caseStudyChangeLayer);
                if (caseStudyAfterLayer) {
                    caseStudyAfterLayer.addTo(map);
                    caseStudyAfterLayer.bringToFront();
                }
                if (caseStudyAoiLayer) caseStudyAoiLayer.bringToFront();
                if (window.changeLegendControl) map.removeControl(window.changeLegendControl);
                
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel) vqaLabel.textContent = "Sentinel-2 - 2025-04-02";
                
                const KANCHA_AOI = [[17.41, 78.32], [17.45, 78.36]];
                map.fitBounds(KANCHA_AOI, { padding: [40, 40] });
                map.invalidateSize(true);
            } else {
                if (changeBeforeLayer) map.removeLayer(changeBeforeLayer);
                if (changeOverlayLayer) map.removeLayer(changeOverlayLayer);
                if (changeAfterLayer) {
                    changeAfterLayer.addTo(map);
                    changeAfterLayer.bringToFront();
                }
                if (window.changeLegendControl) map.removeControl(window.changeLegendControl);
                const afterId = document.getElementById('change-after-select').value;
                const aLayerData = layers.find(l => l.id === afterId);
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel && aLayerData) vqaLabel.textContent = `After: ${aLayerData.name}`;
            }
        });
    }
    
    if (btnChange) {
        btnChange.addEventListener('click', () => {
            if (changeAnalysisMode === 'case-study') {
                if (caseStudyBeforeLayer) map.removeLayer(caseStudyBeforeLayer);
                if (caseStudyAfterLayer) {
                    caseStudyAfterLayer.addTo(map);
                    caseStudyAfterLayer.bringToFront();
                }
                if (caseStudyChangeLayer) {
                    caseStudyChangeLayer.addTo(map);
                    caseStudyChangeLayer.bringToFront();
                    if (window.changeLegendControl) window.changeLegendControl.addTo(map);
                }
                if (caseStudyAoiLayer) caseStudyAoiLayer.bringToFront();
                
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel) vqaLabel.textContent = "Change Analysis";
                
                const KANCHA_AOI = [[17.41, 78.32], [17.45, 78.36]];
                map.fitBounds(KANCHA_AOI, { padding: [40, 40] });
                map.invalidateSize(true);
            } else {
                if (changeBeforeLayer) map.removeLayer(changeBeforeLayer);
                if (changeAfterLayer) {
                    changeAfterLayer.addTo(map);
                    changeAfterLayer.bringToFront();
                }
                if (changeOverlayLayer) {
                    changeOverlayLayer.addTo(map);
                    changeOverlayLayer.bringToFront();
                    if (window.changeLegendControl) window.changeLegendControl.addTo(map);
                }
                const vqaLabel = document.getElementById('vqa-selected-image-panel');
                if (vqaLabel) vqaLabel.textContent = "Change Analysis";
            }
        });
    }

    const stacCloudCover = document.getElementById('stac-cloud-cover');
  const stacCloudVal = document.getElementById('stac-cloud-val');
  if (stacCloudCover && stacCloudVal) {
      stacCloudCover.addEventListener('input', (e) => {
          stacCloudVal.textContent = e.target.value;
      });
  }

  const btnSearchStac = document.getElementById('btn-search-stac');
  if (btnSearchStac) {
      btnSearchStac.addEventListener('click', async () => {
          

          const btn = btnSearchStac;
          const origHtml = btn.innerHTML;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right: 6px;"></i> Searching satellite catalog...';
          btn.disabled = true;
          
          const feedback = document.getElementById('stac-search-feedback');
          const container = document.getElementById('stac-results-container');
          
          if (feedback) {
              feedback.style.display = 'block';
              feedback.style.color = 'var(--text)';
              feedback.textContent = 'Searching satellite catalog...';
          }
          if (container) container.innerHTML = '';

          try {
              const bounds = map.getBounds();
              
              let minLon = bounds.getWest();
              let maxLon = bounds.getEast();
              const minLat = bounds.getSouth();
              const maxLat = bounds.getNorth();
              
              // Fix CRS transformation problem: Leaflet continuously adds 360 to longitude 
              // as you pan right. We must wrap it back to standard WGS84 [-180, 180].
              if (maxLon - minLon >= 360) {
                  minLon = -180;
                  maxLon = 180;
              } else {
                  minLon = bounds.getSouthWest().wrap().lng;
                  maxLon = bounds.getNorthEast().wrap().lng;
              }
              
              const bbox = [minLon, minLat, maxLon, maxLat];
              
              // Validate STAC requirements
              if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
                  throw new Error(`Invalid STAC geographic bounding box: [${bbox.join(', ')}]`);
              }
              
              // Date inputs natively provide YYYY-MM-DD
              const startDate = document.getElementById('stac-start-date').value;
              const endDate = document.getElementById('stac-end-date').value;
              const maxCloud = parseFloat(document.getElementById('stac-cloud-cover').value);

              const req = {
                  bbox: bbox,
                  start_date: startDate,
                  end_date: endDate,
                  max_cloud_cover: maxCloud,
                  collection: 'sentinel-2-l2a',
                  limit: 5
              };
              
              console.log("SEARCH REQUEST PAYLOAD", req);

              const resp = await fetch(API_BASE + '/catalog/search', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(req)
              });
              
              console.log("SEARCH HTTP STATUS", resp.status);
              
              if (!resp.ok) {
                  const errText = await resp.text();
                  throw new Error(`HTTP ${resp.status} - ${errText}`);
              }
              const data = await resp.json();
              console.log("SEARCH RESPONSE", data);
              
              if (feedback) feedback.style.display = 'none';
              
              if (data.results.length === 0) {
                  if (feedback) {
                      feedback.style.display = 'block';
                      feedback.style.color = 'var(--text)';
                      feedback.textContent = 'No scenes found matching criteria.';
                  }
              } else {
                  // Add title
                  const title = document.createElement('div');
                  title.className = 'section-title';
                  title.textContent = 'SEARCH RESULTS';
                  title.style.marginTop = '8px';
                  container.appendChild(title);
                  
                  data.results.forEach(scene => {
                      const dateStr = scene.datetime.split('T')[0];
                      const div = document.createElement('div');
                      div.style.border = '1px solid var(--border)';
                      div.style.padding = '8px';
                      div.style.borderRadius = 'var(--radius)';
                      div.style.display = 'flex';
                      div.style.flexDirection = 'column';
                      div.style.gap = '8px';
                      
                      const info = document.createElement('div');
                      info.innerHTML = `
                        <div style="font-weight: 600; color: var(--text);">Sentinel-2</div>
                        <div style="color: var(--muted); font-size: 12px;">${dateStr}</div>
                        <div style="color: var(--muted); font-size: 12px;">Cloud cover: ${scene.cloud_cover.toFixed(1)}%</div>
                      `;
                      
                      const actions = document.createElement('div');
                      actions.style.display = 'flex';
                      actions.style.gap = '8px';
                      
                      const btnPreview = document.createElement('button');
                      btnPreview.className = 'btn btn-secondary';
                      btnPreview.style.flex = '1';
                      btnPreview.textContent = 'Preview';
                      btnPreview.onclick = () => alert(`Metadata:\nScene ID: ${scene.scene_id}\nDate: ${scene.datetime}\nClouds: ${scene.cloud_cover.toFixed(1)}%\nAssets: ${Object.keys(scene.assets).length}`);
                      
                      const btnLoad = document.createElement('button');
                      btnLoad.className = 'btn btn-primary';
                      btnLoad.style.flex = '1';
                      btnLoad.textContent = 'Load';
                      btnLoad.onclick = () => {
                          loadStacScene(scene);
                      };
                      
                      actions.appendChild(btnPreview);
                      actions.appendChild(btnLoad);
                      
                      div.appendChild(info);
                      div.appendChild(actions);
                      container.appendChild(div);
                  });
              }
              
          } catch (err) {
              console.error(err);
              if (feedback) {
                  feedback.style.display = 'block';
                  feedback.style.color = '#ff4a4a'; // Error red
                  feedback.textContent = `Satellite catalog search failed: ${err.message}`;
              }
          } finally {
              btn.innerHTML = origHtml;
              btn.disabled = false;
          }
      });
  }
}

async function loadStacScene(scene) {
    try {
        document.getElementById('header-status').textContent = `Loading STAC scene data...`;
        const res = await fetch(`${API_BASE}/catalog/scene/${scene.scene_id}`);
        if (!res.ok) {
            throw new Error(`HTTP Error: ${res.status}`);
        }
        const data = await res.json();
        
        console.log("SCENE RENDER");
        console.log(`Scene: ${scene.scene_id}`);
        console.log(`Asset: ${data.asset_key}`);
        console.log(`Source CRS: ${data.source_crs}`);
        console.log(`Source dimensions: ${data.source_width} x ${data.source_height}`);
        console.log(`Source bounds: ${JSON.stringify(data.source_bounds)}`);
        console.log(`Display CRS: ${data.display_crs}`);
        console.log(`Display dimensions: ${data.display_width} x ${data.display_height}`);
        console.log(`Display bounds: ${JSON.stringify(data.bounds)}`);
        
        const datasetMeta = {
            id: scene.scene_id,
            name: `Sentinel-2 (${scene.datetime.split('T')[0]})`,
            is_stac: true,
            bounds: data.bounds,
            preview_url: data.image_url,
            bands: [
                { id: 'True Color', description: 'Visual' },
                { id: 'B04', description: 'Red' },
                { id: 'B03', description: 'Green' },
                { id: 'B02', description: 'Blue' },
                { id: 'B08', description: 'NIR' }
            ],
            metadata: {
                crs: data.display_crs,
                width: data.display_width,
                height: data.display_height,
                dtype: 'uint8',
                driver: 'COG',
                resolution: 10,
                p2: 0,
                p98: 3000,
                source_crs: data.source_crs
            },
            scene_info: scene
        };
        
        const existingIndex = layers.findIndex(l => l.id === datasetMeta.id);
        if (existingIndex >= 0) {
            layers[existingIndex] = datasetMeta;
        } else {
            layers.push(datasetMeta);
        }
        clearLayerList();
        layers.forEach(addLayerToList);
        updateNoDataState();
        
        selectLayer(datasetMeta.id);
        document.getElementById('header-status').textContent = `STAC Scene loaded: ${datasetMeta.name}`;
        updateAnalysisSceneDropdown();
        updateChangeAnalysisDropdowns();
    } catch (e) {
        console.error(e);
        document.getElementById('header-status').textContent = `Error loading scene: ${e.message}`;
    }
}

function updateAnalysisSceneDropdown() {
    const sel = document.getElementById('analysis-scene');
    if (!sel) return;
    sel.innerHTML = '';
    const analysisSources = layers.filter(l => !l.is_analysis);
    if (analysisSources.length === 0) {
        sel.innerHTML = '<option value="">No dataset loaded...</option>';
        return;
    }
    analysisSources.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        
        let displayName = l.name;
        if (!l.is_stac) {
            const hasB04 = l.bands && l.bands.some(b => b.id === 'B04');
            const hasB08 = l.bands && l.bands.some(b => b.id === 'B08');
            const isMultiband = l.metadata && l.metadata.bands > 1;
            
            if (hasB04 && hasB08) {
                // If it already has B04 + B08 in the name, don't append it again
                if (!displayName.includes('B04')) {
                    displayName = displayName + " — B04 + B08";
                }
            } else if (isMultiband) {
                if (!displayName.includes('Multiband')) {
                    displayName = displayName + " (Multiband)";
                }
            } else if (hasB04 && !hasB08) {
                displayName = displayName + " — Missing B08";
            } else if (hasB08 && !hasB04) {
                displayName = displayName + " — Missing B04";
            }
        }
        
        opt.textContent = displayName;
        sel.appendChild(opt);
    });
}


const btnCalcNdvi = document.getElementById('btn-calc-ndvi');
if (btnCalcNdvi) {
    btnCalcNdvi.addEventListener('click', async () => {
        const layerId = document.getElementById('analysis-scene').value;
        if (!layerId) {
            alert("Load or upload a raster before calculating NDVI.");
            return;
        }
        
        const selectedLayer = layers.find(l => l.id === layerId);
        const source_type = selectedLayer.is_stac ? 'stac' : 'upload';
        
        btnCalcNdvi.disabled = true;
        btnCalcNdvi.textContent = 'Calculating...';
        document.getElementById('header-status').textContent = 'Calculating NDVI...';
        
        let aoiData = null;
        if (currentAOI) {
            aoiData = {
                type: 'bbox',
                shape: currentAOI.geometry_type,
                area: currentAOI.area_m2 || 0,
                north: currentAOI.bbox.north,
                south: currentAOI.bbox.south,
                east: currentAOI.bbox.east,
                west: currentAOI.bbox.west,
                geometry: currentAOI.geometry
            };
        }
        
        try {
            const res = await fetch(API_BASE + '/analysis/ndvi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scene_id: layerId, source_type: source_type, aoi: aoiData })
            });
            
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || `HTTP Error ${res.status}`);
            }
            
            const data = await res.json();
            
            const parentLayer = layers.find(l => l.id === layerId);
            
            const datasetMeta = {
                id: `analysis:ndvi:${data.scene_id}`,
                name: `NDVI - ${data.scene_id.includes('_') ? data.scene_id.split('_')[2].split('T')[0] : data.scene_id.substring(0, 8)}`,
                  is_stac: false,
                is_analysis: true,
                  source_layer_name: parentLayer ? parentLayer.name : data.scene_id,
                  analysis_data: data,
                bounds: data.bounds,
                preview_url: data.image_url,
                bands: [{ id: 'NDVI', description: 'Vegetation Index' }],
                metadata: {
                    crs: 'EPSG:4326',
                    source_crs: parentLayer ? (parentLayer.metadata.source_crs || parentLayer.metadata.crs) : null,
                    resolution: parentLayer ? parentLayer.metadata.resolution : null,
                    dtype: 'float32',
                    driver: 'Analysis'
                },
                scene_info: parentLayer ? parentLayer.scene_info : null
            };
            
            const existingIndex = layers.findIndex(l => l.id === datasetMeta.id);
            if (existingIndex >= 0) {
                layers[existingIndex] = datasetMeta;
            } else {
                layers.push(datasetMeta);
            }
            clearLayerList();
            layers.forEach(addLayerToList);
            updateNoDataState();
            selectLayer(datasetMeta.id);
            document.getElementById('header-status').textContent = `NDVI calculated`;
            
        } catch (e) {
            console.error(e);
            alert(`NDVI calculation failed:\n${e.message}`);
            document.getElementById('header-status').textContent = 'NDVI failed';
        } finally {
            btnCalcNdvi.disabled = false;
            btnCalcNdvi.textContent = 'Calculate NDVI';
        }
    });
}

const KANCHA_CASE_STUDY = {
    before: {
        id: "S2B_MSIL2A_20250328T050659_R019_T44QKE_20250328T072008"
    },
    after: {
        id: "S2C_MSIL2A_20250402T050711_R019_T44QKE_20250402T101606"
    }
};

function activateKanchaCaseStudy() {
    console.log("CASE STUDY ACTIVATED");
    changeAnalysisMode = "case-study";
    const beforeSel = document.getElementById("change-before-select");
    const afterSel = document.getElementById("change-after-select");
    
    beforeSel.innerHTML = "";
    afterSel.innerHTML = "";
    beforeSel.add(new Option("Sentinel-2 — 2025-03-28 — T44QKE", KANCHA_CASE_STUDY.before.id));
    afterSel.add(new Option("Sentinel-2 — 2025-04-02 — T44QKE", KANCHA_CASE_STUDY.after.id));
    beforeSel.value = KANCHA_CASE_STUDY.before.id;
    afterSel.value = KANCHA_CASE_STUDY.after.id;
    
    caseStudyBeforeScene = KANCHA_CASE_STUDY.before.id;
    caseStudyAfterScene = KANCHA_CASE_STUDY.after.id;

    if (imageOverlay) { map.removeLayer(imageOverlay); imageOverlay = null; }
    if (caseStudyBeforeLayer) { map.removeLayer(caseStudyBeforeLayer); caseStudyBeforeLayer = null; }
    if (caseStudyAfterLayer) { map.removeLayer(caseStudyAfterLayer); caseStudyAfterLayer = null; }
    if (caseStudyChangeLayer) { map.removeLayer(caseStudyChangeLayer); caseStudyChangeLayer = null; }
    if (caseStudyAoiLayer) { map.removeLayer(caseStudyAoiLayer); caseStudyAoiLayer = null; }

    const KANCHA_AOI = [[17.41, 78.32], [17.45, 78.36]];
    map.fitBounds(KANCHA_AOI, { padding: [40, 40] });
    map.invalidateSize(true);
    
    caseStudyAoiLayer = L.rectangle(KANCHA_AOI, {color: '#0066ff', weight: 3, fill: false});
    caseStudyAoiLayer.addTo(map);
    caseStudyAoiLayer.bringToFront();
    
    const boundsObj = L.latLngBounds(KANCHA_AOI);
    currentAOI = {
        geometry_type: 'Polygon',
        type: 'Polygon',
        bbox: { west: boundsObj.getWest(), north: boundsObj.getNorth(), east: boundsObj.getEast(), south: boundsObj.getSouth() },
        bounds: boundsObj,
        geometry: null
    };

    Promise.all([
        loggedFetch(API_BASE + "/catalog/scene/" + caseStudyBeforeScene).then(r => r.json()),
        loggedFetch(API_BASE + "/catalog/scene/" + caseStudyAfterScene).then(r => r.json())
    ]).then(([beforeData, afterData]) => {
        caseStudyBeforeMeta = beforeData;
        caseStudyAfterMeta = afterData;
        
        const beforeUrl = beforeData.preview_url || beforeData.image_url;
        const afterUrl = afterData.preview_url || afterData.image_url;
        
        caseStudyBeforeLayer = L.imageOverlay(beforeUrl, beforeData.bounds, { opacity: 1.0 });
        caseStudyAfterLayer = L.imageOverlay(afterUrl, afterData.bounds, { opacity: 1.0 });
        
        caseStudyBeforeLayer.addTo(map);
        caseStudyBeforeLayer.bringToFront();
        caseStudyAoiLayer.bringToFront();
        
        const toggles = document.getElementById('case-study-vis-toggles');
        if (toggles) toggles.style.display = 'flex';
        
        const vqaLabel = document.getElementById('vqa-selected-image-panel');
        if (vqaLabel) vqaLabel.textContent = "Sentinel-2 — 2025-03-28";
        
        populateInspector({
            id: caseStudyBeforeScene,
            name: "Sentinel-2 — 2025-03-28",
            is_stac: true,
            bounds: caseStudyBeforeMeta.bounds,
            preview_url: caseStudyBeforeMeta.preview_url || caseStudyBeforeMeta.image_url,
            bands: [ { id: 'True Color', description: 'Visual' } ],
            metadata: { crs: caseStudyBeforeMeta.display_crs || 'EPSG:4326' },
            scene_info: { datetime: caseStudyBeforeMeta.datetime || "2025-03-28", scene_id: caseStudyBeforeScene, cloud_cover: caseStudyBeforeMeta["eo:cloud_cover"] }
        });
        
        document.getElementById('change-analysis-message').style.display = 'none';
        document.getElementById('change-analysis-selectors').style.display = 'block';
        document.getElementById('cross-modal-selectors').style.display = 'block';
    });
}

function updateChangeAnalysisDropdowns() {
    if (changeAnalysisMode === 'case-study') return;
    
    const beforeSel = document.getElementById('change-before-select');
    const afterSel = document.getElementById('change-after-select');
    const msg = document.getElementById('change-analysis-message');
    const selectors = document.getElementById('change-analysis-selectors');
    
    const stacLayers = layers.filter(l => l.is_stac);
    if (stacLayers.length >= 2) {
        if (msg) msg.style.display = 'none';
        if (selectors) selectors.style.display = 'block';
    const cmSelectors = document.getElementById('cross-modal-selectors');
    if (cmSelectors) cmSelectors.style.display = 'block';
        
        const bVal = beforeSel.value;
        const aVal = afterSel.value;
        
        beforeSel.innerHTML = '';
        afterSel.innerHTML = '';
        stacLayers.forEach(l => {
            beforeSel.add(new Option(l.name, l.id));
            afterSel.add(new Option(l.name, l.id));
        });
        
        if (bVal && stacLayers.some(l => l.id === bVal)) beforeSel.value = bVal;
        if (aVal && stacLayers.some(l => l.id === aVal)) afterSel.value = aVal;
    } else {
        if (msg) msg.style.display = 'none';
        if (selectors) selectors.style.display = 'block';
    const cmSelectors = document.getElementById('cross-modal-selectors');
    if (cmSelectors) cmSelectors.style.display = 'block';
    }
}
