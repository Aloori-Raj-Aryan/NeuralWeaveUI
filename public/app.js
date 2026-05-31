(function(){
  const blocksListEl = document.getElementById('blocksList');
  const canvas = document.getElementById('canvas');
  const canvasContent = document.getElementById('canvasContent');
  const canvasScrollSizer = document.getElementById('canvasScrollSizer');
  const selectionMarquee = document.getElementById('selectionMarquee');
  const svg = document.getElementById('connectionsSvg');
  const propsEl = document.getElementById('props');
  const propsEmpty = document.getElementById('propsEmpty');
  const exportBtn = document.getElementById('exportBtn');
  const blockSearchInput = document.getElementById('blockSearch');
  const searchDropdown = document.getElementById('searchDropdown');
  const searchResults = document.getElementById('searchResults');
  const zoomLabel = document.getElementById('zoomLabel');
  const savedGraphsListEl = document.getElementById('savedGraphsList');
  const sessionLabelEl = document.getElementById('sessionLabel');
  const SESSION_STORAGE_KEY = 'nwui_session';
  const VERSION_STORAGE_KEY = 'nwui_torch_version';

  let blocks = [];
  let sessionId = null;
  let torchVersion = null;
  let nodes = [];
  let connections = [];
  let selectedNodeIds = new Set();
  let dragging = null;
  let dragOffsets = new Map();
  let didDrag = false;
  let drawingConn = null;
  let lastMousePos = { x: 0, y: 0 };
  let clipboard = null;
  let canvasZoom = 1;
  let pendingPlacement = null;
  let paletteDragStarted = false;
  const ZOOM_MAX = 2.5;
  const ZOOM_STEP = 0.08;

  function closeSearchDropdown(){
    searchDropdown.classList.remove('open');
    blockSearchInput.value = '';
    searchResults.innerHTML = '';
  }

  function scrollToPaletteBlock(blockName){
    const blockItems = document.querySelectorAll('.blockItem');
    let targetEl = null;
    for (const item of blockItems){
      const nameEl = item.querySelector('.blockItemName');
      if (nameEl && nameEl.textContent === blockName){
        targetEl = item;
        break;
      }
    }
    if (targetEl){
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function selectBlockFromSearch(blockDef){
    startBlockPlacement(blockDef);
    closeSearchDropdown();
  }

  function searchBlocks(query){
    if (!query.trim()){
      searchDropdown.classList.remove('open');
      return;
    }
    const lower = query.toLowerCase();
    const results = blocks.filter(b =>
      b.name.toLowerCase().includes(lower) ||
      (b.path || '').toLowerCase().includes(lower) ||
      getBlockCategory(b).toLowerCase().includes(lower)
    );
    
    searchResults.innerHTML = '';
    if (results.length === 0){
      const empty = document.createElement('div');
      empty.className = 'searchResultEmpty';
      empty.textContent = 'No blocks found';
      searchResults.appendChild(empty);
    } else {
      results.forEach(b => {
        const item = document.createElement('div');
        item.className = 'searchResultItem';
        item.innerHTML = `
          <div class="searchResultName">${b.name}</div>
          <div class="searchResultPath">${b.path || ''}</div>
          <div class="searchResultCategory">${getBlockCategory(b)}</div>
        `;
        item.onclick = () => selectBlockFromSearch(b);
        searchResults.appendChild(item);
      });
    }
    searchDropdown.classList.add('open');
  }

  function closeSearchOnClickOutside(e){
    if (!blockSearchInput.contains(e.target) && !searchDropdown.contains(e.target)){
      closeSearchDropdown();
    }
  }

  function fetchBlocks(){
    return apiFetch('/api/blocks').then(r => r.json()).then(r => { blocks = r.blocks || []; renderPalette(); });
  }

  function apiFetch(url, options = {}){
    const headers = Object.assign({}, options.headers || {});
    if (sessionId) headers['X-Session-Id'] = sessionId;
    return fetch(url, Object.assign({}, options, { headers }));
  }

  function updateSessionLabel(){
    if (!sessionLabelEl || !sessionId) return;
    const ver = torchVersion ? ` · PyTorch ${torchVersion.id}` : '';
    sessionLabelEl.textContent = `Session ${sessionId.slice(0, 8)}…${ver} — reload starts a new session`;
  }

  async function readJsonResponse(res){
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        'Server returned a non-JSON response. ' +
        'Make sure you restarted with the latest code: node server.js'
      );
    }
  }

  async function checkServerHealth(){
    const res = await fetch('/api/health');
    const data = await readJsonResponse(res);
    if (!res.ok || !data.ok){
      throw new Error(data.error || `Health check failed (HTTP ${res.status})`);
    }
    if (!data.sessionApi){
      throw new Error('Server is missing session support. Pull the latest code and restart.');
    }
    return data;
  }

  async function initSession(){
    await checkServerHealth();

    const previous = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (previous){
      try {
        await fetch(`/api/session/${previous}`, { method: 'DELETE' });
      } catch (e) { /* ignore */ }
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }

    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanOthers: !previous })
    });
    const data = await readJsonResponse(res);
    if (!res.ok || !data.ok){
      throw new Error(data.error || `Failed to start session (HTTP ${res.status})`);
    }
    if (!data.sessionId){
      throw new Error('Session API did not return a session id');
    }
    sessionId = data.sessionId;
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    updateSessionLabel();
  }

  async function suggestGraphName(){
    const res = await apiFetch('/api/graphs');
    const data = await readJsonResponse(res);
    const names = new Set((data.ok && data.graphs ? data.graphs : []).map(g => g.name));
    let i = 1;
    let candidate = 'graph-1.svg';
    while (names.has(candidate)){
      i += 1;
      candidate = `graph-${i}.svg`;
    }
    return candidate.replace(/\.svg$/i, '');
  }

  async function graphNameExists(name){
    const filename = name.toLowerCase().endsWith('.svg') ? name : `${name}.svg`;
    const res = await apiFetch('/api/graphs');
    const data = await readJsonResponse(res);
    if (!data.ok || !data.graphs) return false;
    return data.graphs.some(g => g.name === filename);
  }

  async function fetchSavedGraphs(){
    if (!savedGraphsListEl) return;
    const res = await apiFetch('/api/graphs');
    const data = await res.json();
    if (!data.ok){
      savedGraphsListEl.innerHTML = '<div class="savedGraphsEmpty">Could not load saved graphs</div>';
      return;
    }
    renderSavedGraphs(data.graphs || []);
  }

  function renderSavedGraphs(graphs){
    savedGraphsListEl.innerHTML = '';
    if (!graphs.length){
      savedGraphsListEl.innerHTML = '<div class="savedGraphsEmpty">No saved graphs in this session</div>';
      return;
    }
    graphs.forEach(g => {
      const row = document.createElement('div');
      row.className = 'savedGraphItem';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.textContent = g.name;
      loadBtn.title = `View ${g.name}`;
      loadBtn.onclick = () => viewSavedGraph(g.name);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'deleteGraphBtn';
      delBtn.textContent = '×';
      delBtn.title = `Delete ${g.name}`;
      delBtn.onclick = () => deleteGraphFromSession(g.name);

      row.appendChild(loadBtn);
      row.appendChild(delBtn);
      savedGraphsListEl.appendChild(row);
    });
  }

  function findBlockDef(name, blockPath){
    return blocks.find(b => b.name === name && (b.path || '') === (blockPath || ''))
      || blocks.find(b => b.name === name);
  }

  function clearCanvas(){
    nodes.forEach(n => {
      const el = nodeElement(n.id);
      if (el) el.remove();
    });
    nodes = [];
    connections = [];
    clearSelection();
    cancelBlockPlacement();
    resizeSvgLayer();
    updateConnections();
    recomputeShapes();
    updateExportButtonState();
  }

  async function viewSavedGraph(name){
    const res = await apiFetch(`/api/graphs/${encodeURIComponent(name)}`);
    if (!res.ok){
      const data = await readJsonResponse(res).catch(() => ({}));
      alert('Failed to open graph: ' + (data.error || res.statusText));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function escapeXml(text){
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildGraphSvg(){
    resizeSvgLayer();
    let maxX = canvas.clientWidth || 800;
    let maxY = canvas.clientHeight || 600;
    nodes.forEach(n => {
      const el = nodeElement(n.id);
      const w = el ? el.offsetWidth : 240;
      const h = el ? el.offsetHeight : 140;
      maxX = Math.max(maxX, n.x + w + 80);
      maxY = Math.max(maxY, n.y + h + 80);
    });

    const width = Math.ceil(maxX);
    const height = Math.ceil(maxY);
    let body = `<rect width="${width}" height="${height}" fill="#eef1f6"/>`;

    connections.forEach(c => {
      const fromNode = nodes.find(n => n.id === c.from);
      const toNode = nodes.find(n => n.id === c.to);
      if (!fromNode || !toNode) return;

      const fromEl = document.querySelector(`.node[data-id='${c.from}'] .handle.output[data-out='${c.fromIndex}']`);
      const toEl = document.querySelector(`.node[data-id='${c.to}'] .handle.input[data-input='${c.toIndex}']`);
      if (!fromEl || !toEl) return;

      const { x: x1, y: y1 } = handleCenter(fromNode, fromEl);
      const { x: x2, y: y2 } = handleCenter(toNode, toEl);
      const curve = connectionCurve(x1, y1, x2, y2);
      body += `<path d="${curve.d}" fill="none" stroke="#22c55e" stroke-width="2.5"/>`;
      const angle = Math.atan2(y2 - curve.endCtrlY, x2 - curve.endCtrlX);
      const size = 10;
      const leftX = x2 - size * Math.cos(angle - Math.PI / 7);
      const leftY = y2 - size * Math.sin(angle - Math.PI / 7);
      const rightX = x2 - size * Math.cos(angle + Math.PI / 7);
      const rightY = y2 - size * Math.sin(angle + Math.PI / 7);
      body += `<polygon points="${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}" fill="#22c55e"/>`;
    });

    nodes.forEach(n => {
      const el = nodeElement(n.id);
      const w = el ? el.offsetWidth : 240;
      const h = el ? el.offsetHeight : 140;
      const kind = (n.block.category || 'Module').toLowerCase();
      const headerFill = isIoInput(n.block) ? '#059669' : (isIoOutput(n.block) ? '#d97706' : (kind === 'function' ? '#0ea5e9' : '#6366f1'));
      const headerH = isIoInput(n.block) ? 68 : 52;

      body += `<rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="10" fill="#ffffff" stroke="#dfe4ee"/>`;
      body += `<rect x="${n.x}" y="${n.y}" width="${w}" height="${headerH}" rx="10" fill="${headerFill}"/>`;
      body += `<rect x="${n.x}" y="${n.y + headerH - 10}" width="${w}" height="10" fill="${headerFill}"/>`;
      body += `<text x="${n.x + 14}" y="${n.y + 22}" fill="#ffffff" font-family="IBM Plex Sans, sans-serif" font-size="14" font-weight="600">${escapeXml(getNodeDisplayName(n))}</text>`;
      body += `<text x="${n.x + 14}" y="${n.y + 38}" fill="#ffffff" font-family="IBM Plex Mono, monospace" font-size="10" opacity="0.9">${escapeXml(isIoBlock(n.block) ? n.block.name : (n.block.path || ''))}</text>`;
      if (isIoInput(n.block)){
        body += `<text x="${n.x + 14}" y="${n.y + 52}" fill="#ffffff" font-family="IBM Plex Mono, monospace" font-size="11" opacity="0.95">${escapeXml(formatShapeDisplay(n.shape))}</text>`;
      }
    });

    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      body +
      '</svg>'
    );
  }

  async function deleteGraphFromSession(name){
    if (!confirm(`Delete saved graph "${name}"?`)) return;
    const res = await apiFetch(`/api/graphs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok){
      alert('Delete failed: ' + (data.error || 'unknown error'));
      return;
    }
    fetchSavedGraphs();
  }

  function formatCategoryName(folder){
    if (folder.toLowerCase() === 'io') return 'IO';
    return folder.replace(/_/g, ' ');
  }

  function isIoBlock(blockDef){
    return blockDef && (blockDef.category === 'IO' || (blockDef.path || '').startsWith('io.'));
  }

  function isIoInput(blockDef){
    return isIoBlock(blockDef) && blockDef.path === 'io.input';
  }

  function isIoOutput(blockDef){
    return isIoBlock(blockDef) && blockDef.path === 'io.output';
  }

  function getNodeDisplayName(node){
    if (isIoBlock(node.block) && node.ioName && node.ioName.trim()){
      return node.ioName.trim();
    }
    return node.block.name;
  }

  function parseShapeInput(text){
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    return trimmed.split(',').map(part => {
      const n = Number(part.trim());
      if (!Number.isInteger(n) || n <= 0) return null;
      return n;
    });
  }

  function isValidShape(shape){
    return Array.isArray(shape) && shape.length > 0 && shape.every(n => Number.isInteger(n) && n > 0);
  }

  function formatShapeDisplay(shape){
    if (!isValidShape(shape)) return '[B, …]';
    return '[B, ' + shape.join(', ') + ']';
  }

  function formatPortShape(shape){
    if (window.NWUI_shape) return window.NWUI_shape.formatShape(shape);
    if (!shape || !shape.length) return '[B, …]';
    return '[' + shape.join(', ') + ']';
  }

  function recomputeShapes(){
    if (window.NWUI_shape) window.NWUI_shape.propagateShapes(nodes, connections);
    nodes.forEach(updateNodeShapeDisplay);
  }

  function updateNodeShapeDisplay(node){
    const el = nodeElement(node.id);
    if (!el) return;

    node.inputs.forEach((_inp, idx) => {
      const shapeEl = el.querySelector(`.portRow.inputPort[data-input="${idx}"] .portShape`);
      if (shapeEl){
        const shape = node.inputShapes && node.inputShapes[idx];
        shapeEl.textContent = formatPortShape(shape);
        shapeEl.classList.toggle('portShapeUnknown', !shape || !window.NWUI_shape || !window.NWUI_shape.isKnownShape(shape));
      }
    });

    node.outputs.forEach((_out, idx) => {
      const shapeEl = el.querySelector(`.portRow.outputPort[data-out="${idx}"] .portShape`);
      if (shapeEl){
        const shape = node.outputShapes && node.outputShapes[idx];
        shapeEl.textContent = formatPortShape(shape);
        shapeEl.classList.toggle('portShapeUnknown', !shape || !window.NWUI_shape || !window.NWUI_shape.isKnownShape(shape));
      }
    });

    if (isIoInput(node.block)){
      const shapeRow = el.querySelector('.ioShapeDisplay');
      if (shapeRow){
        const outShape = node.outputShapes && node.outputShapes[0];
        shapeRow.textContent = outShape
          ? formatPortShape(outShape)
          : formatShapeDisplay(node.shape);
        shapeRow.classList.toggle('ioShapeEmpty', !outShape && !isValidShape(node.shape));
      }
    }
  }

  function portShapeLabel(shape){
    const span = document.createElement('span');
    span.className = 'portShape portShapeUnknown';
    span.textContent = formatPortShape(shape);
    return span;
  }

  function ioNameTaken(name, excludeNodeId){
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    const lower = trimmed.toLowerCase();
    return nodes.some(n =>
      isIoBlock(n.block) &&
      n.id !== excludeNodeId &&
      n.ioName &&
      n.ioName.trim().toLowerCase() === lower
    );
  }

  function getBlockCategory(block){
    const file = block.__file || '';
    const parts = file.split('/');
    return parts.length > 1 ? parts[0] : 'other';
  }

  function groupBlocksByFolder(blockList){
    const groups = {};
    blockList.forEach(b => {
      const cat = getBlockCategory(b);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(b);
    });
    Object.keys(groups).forEach(k => {
      groups[k].sort((a, b) => a.name.localeCompare(b.name));
    });
    return Object.keys(groups).sort((a, b) => {
      if (a === 'io') return -1;
      if (b === 'io') return 1;
      return a.localeCompare(b);
    }).reduce((acc, k) => { acc[k] = groups[k]; return acc; }, {});
  }

  function attachBlockItem(el, b){
    el.onclick = () => {
      if (paletteDragStarted) return;
      startBlockPlacement(b, el);
    };
    el.draggable = true;
    el.addEventListener('dragstart', (ev) => {
      paletteDragStarted = true;
      ev.dataTransfer.setData('application/json', JSON.stringify(b));
      ev.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('dragend', () => {
      setTimeout(() => { paletteDragStarted = false; }, 0);
    });
  }

  const panelHint = document.querySelector('.panelHint');

  function updatePlacementHint(){
    if (!panelHint) return;
    if (pendingPlacement){
      panelHint.textContent = `Placing "${pendingPlacement.name}" — click the canvas (Esc to cancel)`;
      panelHint.classList.add('placementHint');
    } else {
      panelHint.textContent = 'Click a block, then click the canvas to place it';
      panelHint.classList.remove('placementHint');
    }
  }

  function highlightPaletteBlock(blockDef){
    document.querySelectorAll('.blockItem.placementActive, .searchResultItem.placementActive')
      .forEach(e => e.classList.remove('placementActive'));
    if (!blockDef) return;
    document.querySelectorAll('.blockItem').forEach(item => {
      const nameEl = item.querySelector('.blockItemName');
      if (nameEl && nameEl.textContent === blockDef.name) item.classList.add('placementActive');
    });
  }

  function startBlockPlacement(blockDef, paletteEl){
    pendingPlacement = blockDef;
    canvas.classList.add('placementMode');
    highlightPaletteBlock(blockDef);
    if (paletteEl) paletteEl.classList.add('placementActive');
    updatePlacementHint();
    canvas.focus();
  }

  function cancelBlockPlacement(){
    pendingPlacement = null;
    canvas.classList.remove('placementMode');
    highlightPaletteBlock(null);
    updatePlacementHint();
  }

  function placePendingBlock(worldX, worldY){
    if (!pendingPlacement) return;
    const blockDef = pendingPlacement;
    cancelBlockPlacement();
    addNode(blockDef, worldX, worldY);
    selectSingleNode(nodes[nodes.length - 1]);
  }

  function renderPalette(){
    blocksListEl.innerHTML = '';
    const groups = groupBlocksByFolder(blocks);
    Object.keys(groups).forEach(category => {
      const details = document.createElement('details');
      details.className = 'categoryGroup';

      const summary = document.createElement('summary');
      summary.textContent = formatCategoryName(category);
      details.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'categoryBlocks';

      groups[category].forEach(b => {
        const el = document.createElement('div');
        el.className = 'blockItem';
        const kind = (b.category || 'block').toLowerCase();
        el.innerHTML = `
          <div class="blockItemName">${b.name}</div>
          <div class="blockItemPath">${b.path || ''}</div>
          <span class="blockItemKind ${kind}">${b.category || 'Block'}</span>
        `;
        attachBlockItem(el, b);
        list.appendChild(el);
      });

      details.appendChild(list);
      blocksListEl.appendChild(details);
    });
    if (pendingPlacement) highlightPaletteBlock(pendingPlacement);
  }

  function getBlockInputs(blockDef){
    if (isIoInput(blockDef)) return [];
    const fwd = blockDef.forward_arguments || {};
    const tensorInputs = Object.keys(fwd)
      .filter(k => fwd[k].type === 'Tensor')
      .map(name => ({
        name,
        required: fwd[name].required === 'True'
      }));
    return tensorInputs.length ? tensorInputs : [{ name: 'input', required: true }];
  }

  function getBlockOutputs(blockDef){
    if (isIoOutput(blockDef)) return [];
    const outs = Array.isArray(blockDef.output) ? blockDef.output : (blockDef.output ? [blockDef.output] : ['output']);
    return outs.map(name => ({ name }));
  }

  const NODE_MIN_WIDTH = 240;

  function handleCenter(node, handleEl){
    const contentRect = canvasContent.getBoundingClientRect();
    const r = handleEl.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2 - contentRect.left) / canvasZoom,
      y: (r.top + r.height / 2 - contentRect.top) / canvasZoom
    };
  }

  function canvasPoint(clientX, clientY){
    const contentRect = canvasContent.getBoundingClientRect();
    return {
      x: (clientX - contentRect.left) / canvasZoom,
      y: (clientY - contentRect.top) / canvasZoom
    };
  }

  function getContentBounds(){
    if (!nodes.length){
      return { minX: 0, minY: 0, width: canvas.clientWidth || 800, height: canvas.clientHeight || 600 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach(n => {
      const el = nodeElement(n.id);
      const w = el ? el.offsetWidth : NODE_MIN_WIDTH;
      const h = el ? el.offsetHeight : 140;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
    });
    const pad = 80;
    return {
      minX: minX - pad,
      minY: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2
    };
  }

  function getMinZoom(){
    if (!nodes.length) return 0.25;
    const bounds = getContentBounds();
    const pad = 32;
    const fitX = (canvas.clientWidth - pad) / bounds.width;
    const fitY = (canvas.clientHeight - pad) / bounds.height;
    const fitZoom = Math.min(fitX, fitY);
    return Math.max(0.08, Math.min(1, fitZoom));
  }

  function updateCanvasScrollSize(){
    const bounds = getContentBounds();
    canvasContent.style.width = bounds.width + 'px';
    canvasContent.style.height = bounds.height + 'px';
    canvasScrollSizer.style.width = (bounds.width * canvasZoom) + 'px';
    canvasScrollSizer.style.height = (bounds.height * canvasZoom) + 'px';
  }

  function applyCanvasZoom(){
    canvasContent.style.transform = `scale(${canvasZoom})`;
    zoomLabel.textContent = Math.round(canvasZoom * 100) + '%';
    updateCanvasScrollSize();
    resizeSvgLayer();
    updateConnections();
  }

  function clampZoom(value){
    return Math.min(ZOOM_MAX, Math.max(getMinZoom(), value));
  }

  function setCanvasZoom(nextZoom){
    canvasZoom = clampZoom(nextZoom);
    applyCanvasZoom();
  }

  function zoomToAt(clientX, clientY, newZoom){
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const wx = (canvas.scrollLeft + mx) / canvasZoom;
    const wy = (canvas.scrollTop + my) / canvasZoom;
    const oldZoom = canvasZoom;
    setCanvasZoom(newZoom);
    if (canvasZoom === oldZoom) return;
    canvas.scrollLeft = wx * canvasZoom - mx;
    canvas.scrollTop = wy * canvasZoom - my;
  }

  function zoomAt(clientX, clientY, delta){
    zoomToAt(clientX, clientY, canvasZoom + delta);
  }

  function touchDistance(touches){
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function touchCenter(touches){
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  let touchGesture = null;
  let marquee = null;
  const MARQUEE_MIN_PX = 4;

  function endTouchGesture(){
    touchGesture = null;
  }

  function nodeElement(nodeId){
    return document.querySelector(`.node[data-id='${nodeId}']`);
  }

  function resizeSvgLayer(){
    let maxX = canvas.clientWidth || 800;
    let maxY = canvas.clientHeight || 600;
    nodes.forEach(n => {
      const el = nodeElement(n.id);
      const w = el ? el.offsetWidth : NODE_MIN_WIDTH;
      const h = el ? el.offsetHeight : 140;
      maxX = Math.max(maxX, n.x + w + 80);
      maxY = Math.max(maxY, n.y + h + 80);
    });
    svg.setAttribute('width', maxX);
    svg.setAttribute('height', maxY);
    svg.style.width = maxX + 'px';
    svg.style.height = maxY + 'px';
  }

  function connectionCurve(x1, y1, x2, y2){
    const offset = Math.max(50, Math.abs(x2 - x1) * 0.45);
    return {
      d: `M ${x1} ${y1} C ${x1 + offset} ${y1} ${x2 - offset} ${y2} ${x2} ${y2}`,
      endCtrlX: x2 - offset,
      endCtrlY: y2
    };
  }

  function normalizeNodePorts(node){
    node.inputs = (node.inputs || []).map(i =>
      typeof i === 'string' ? { name: i, required: true } : i
    );
    node.outputs = (node.outputs || []).map(o =>
      typeof o === 'string' ? { name: o } : o
    );
  }

  function addNode(blockDef, x, y){
    const id = 'n'+Date.now()+Math.floor(Math.random()*999);
    const outputs = getBlockOutputs(blockDef);
    const inputs = getBlockInputs(blockDef);
    const node = {
      id, block: blockDef, x, y, saved: false,
      init_arguments: Object.assign({}, ...Object.keys(blockDef.init_arguments||{}).map(k=>({[k]: blockDef.init_arguments[k].default}))),
      outputs, inputs
    };
    if (isIoBlock(blockDef)){
      node.ioName = '';
      if (isIoInput(blockDef)) node.shape = [];
    }
    nodes.push(node);
    normalizeNodePorts(node);
    renderNode(node);
    updateExportButtonState();
  }

  function portBadge(required){
    const span = document.createElement('span');
    span.className = 'portBadge ' + (required ? 'required' : 'optional');
    span.textContent = required ? 'required' : 'optional';
    return span;
  }

  function getSelectedNodes(){
    return nodes.filter(n => selectedNodeIds.has(n.id));
  }

  function updateSelectionVisual(){
    document.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
    selectedNodeIds.forEach(id => {
      const el = nodeElement(id);
      if (el) el.classList.add('selected');
    });
  }

  function setSelection(ids){
    selectedNodeIds = new Set(ids);
    updateSelectionVisual();
    updatePropsForSelection();
  }

  function selectSingleNode(node){
    setSelection([node.id]);
  }

  function toggleNodeSelection(node){
    const next = new Set(selectedNodeIds);
    if (next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    setSelection(Array.from(next));
  }

  function selectAllNodes(){
    if (!nodes.length) return;
    setSelection(nodes.map(n => n.id));
  }

  function clearSelection(){
    setSelection([]);
  }

  function updatePropsForSelection(){
    const selected = getSelectedNodes();
    if (selected.length === 1){
      showProps(selected[0]);
      return;
    }
    propsEl.innerHTML = '';
    if (selected.length > 1){
      propsEmpty.style.display = 'none';
      propsEl.style.display = 'block';
      const msg = document.createElement('div');
      msg.className = 'propsMulti';
      msg.textContent = `${selected.length} blocks selected. Drag to box-select, Shift+click to add/remove.`;
      propsEl.appendChild(msg);
      return;
    }
    propsEl.style.display = 'none';
    propsEmpty.style.display = 'block';
  }

  function newNodeId(){
    return 'n' + Date.now() + Math.floor(Math.random() * 999);
  }

  function copySelection(){
    const selected = getSelectedNodes();
    if (!selected.length) return false;
    const idSet = new Set(selected.map(n => n.id));
    clipboard = {
      nodes: selected.map(n => {
        const copy = JSON.parse(JSON.stringify(n));
        delete copy.id;
        return copy;
      }),
      connections: connections
        .filter(c => idSet.has(c.from) && idSet.has(c.to))
        .map(c => ({
          fromIdx: selected.findIndex(n => n.id === c.from),
          fromIndex: c.fromIndex,
          toIdx: selected.findIndex(n => n.id === c.to),
          toIndex: c.toIndex
        }))
    };
    return true;
  }

  function pasteClipboard(){
    if (!clipboard || !clipboard.nodes.length) return;
    const pt = canvasPoint(lastMousePos.x, lastMousePos.y);
    const anchorX = pt.x - 60;
    const anchorY = pt.y - 20;
    const minX = Math.min(...clipboard.nodes.map(n => n.x));
    const minY = Math.min(...clipboard.nodes.map(n => n.y));
    const newIds = [];

    clipboard.nodes.forEach(nodeData => {
      const newId = newNodeId();
      newIds.push(newId);
      const newNode = JSON.parse(JSON.stringify(nodeData));
      newNode.id = newId;
      newNode.x = anchorX + (nodeData.x - minX);
      newNode.y = anchorY + (nodeData.y - minY);
      newNode.saved = false;
      nodes.push(newNode);
      normalizeNodePorts(newNode);
      renderNode(newNode);
    });

    clipboard.connections.forEach(c => {
      connections.push({
        from: newIds[c.fromIdx],
        fromIndex: c.fromIndex,
        to: newIds[c.toIdx],
        toIndex: c.toIndex
      });
    });

    setSelection(newIds);
    updateConnections();
    recomputeShapes();
    updateExportButtonState();
  }

  function cutSelection(){
    if (!copySelection()) return;
    deleteSelectedNodes();
  }

  function deleteSelectedNodes(){
    const ids = Array.from(selectedNodeIds);
    if (!ids.length) return;
    ids.forEach(id => {
      nodes = nodes.filter(n => n.id !== id);
      connections = connections.filter(c => c.from !== id && c.to !== id);
      const el = nodeElement(id);
      if (el) el.remove();
    });
    clearSelection();
    resizeSvgLayer();
    updateConnections();
    recomputeShapes();
    updateExportButtonState();
  }

  function getNodeBounds(node){
    const el = nodeElement(node.id);
    return {
      x: node.x,
      y: node.y,
      w: el ? el.offsetWidth : NODE_MIN_WIDTH,
      h: el ? el.offsetHeight : 140
    };
  }

  function rectsIntersect(a, b){
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function nodesInMarquee(x1, y1, x2, y2){
    const marqueeRect = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1)
    };
    return nodes.filter(n => rectsIntersect(marqueeRect, getNodeBounds(n)));
  }

  function updateMarqueeVisual(x1, y1, x2, y2){
    selectionMarquee.style.display = 'block';
    selectionMarquee.hidden = false;
    selectionMarquee.style.left = Math.min(x1, x2) + 'px';
    selectionMarquee.style.top = Math.min(y1, y2) + 'px';
    selectionMarquee.style.width = Math.abs(x2 - x1) + 'px';
    selectionMarquee.style.height = Math.abs(y2 - y1) + 'px';
  }

  function hideMarquee(){
    selectionMarquee.style.display = 'none';
    selectionMarquee.hidden = true;
  }

  function finishMarquee(clientX, clientY){
    if (!marquee) return;
    const pt = canvasPoint(clientX, clientY);
    const dx = Math.abs(pt.x - marquee.startX);
    const dy = Math.abs(pt.y - marquee.startY);

    if (dx >= MARQUEE_MIN_PX || dy >= MARQUEE_MIN_PX){
      const hits = nodesInMarquee(marquee.startX, marquee.startY, pt.x, pt.y);
      const ids = hits.map(n => n.id);
      if (marquee.additive){
        const next = new Set(selectedNodeIds);
        ids.forEach(id => next.add(id));
        setSelection(Array.from(next));
      } else {
        setSelection(ids);
      }
    } else if (!marquee.additive){
      clearSelection();
    }

    hideMarquee();
    marquee = null;
  }

  function isEditingText(){
    const active = document.activeElement;
    return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  }

  function isCanvasShortcutContext(){
    return document.activeElement === canvas || canvas.contains(document.activeElement);
  }

  function updateIoNodeVisuals(node){
    const el = nodeElement(node.id);
    if (el){
      const nameEl = el.querySelector('.nodeName');
      if (nameEl) nameEl.textContent = getNodeDisplayName(node);
    }
    updateNodeShapeDisplay(node);
  }

  function renderNode(node){
    normalizeNodePorts(node);
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';

    const kind = (node.block.category || 'Module').toLowerCase();
    const ioKind = isIoInput(node.block) ? 'io input' : (isIoOutput(node.block) ? 'io output' : kind);
    const header = document.createElement('div');
    header.className = 'nodeHeader ' + (ioKind === 'io input' || ioKind === 'io output' ? ioKind : (kind === 'function' ? 'function' : 'module'));
    header.innerHTML = `
      <div class="nodeHeaderTop">
        <span class="nodeName">${getNodeDisplayName(node)}</span>
        ${node.saved ? '<span class="savedBadge">saved</span>' : ''}
      </div>
      <div class="nodePath">${isIoBlock(node.block) ? node.block.name : (node.block.path || '')}</div>
    `;

    if (isIoInput(node.block)){
      const shapeRow = document.createElement('div');
      shapeRow.className = 'ioShapeDisplay' + (isValidShape(node.shape) ? '' : ' ioShapeEmpty');
      shapeRow.textContent = formatShapeDisplay(node.shape);
      header.appendChild(shapeRow);
    }

    const ports = document.createElement('div');
    ports.className = 'nodePorts';

    if (node.inputs.length){
      const inLabel = document.createElement('div');
      inLabel.className = 'portSectionLabel';
      inLabel.textContent = 'Inputs';
      ports.appendChild(inLabel);

      node.inputs.forEach((inp, idx) => {
        const row = document.createElement('div');
        row.className = 'portRow inputPort';
        row.dataset.input = idx;

        const handle = document.createElement('div');
        handle.className = 'handle input';
        handle.title = inp.name + (inp.required ? ' (required)' : ' (optional)');
        handle.dataset.input = idx;

        const name = document.createElement('span');
        name.className = 'portName';
        name.textContent = inp.name;

        row.appendChild(handle);
        row.appendChild(name);
        row.appendChild(portShapeLabel(node.inputShapes && node.inputShapes[idx]));
        row.appendChild(portBadge(inp.required));
        ports.appendChild(row);
      });
    }

    if (node.outputs.length){
      const outLabel = document.createElement('div');
      outLabel.className = 'portSectionLabel';
      outLabel.textContent = 'Outputs';
      ports.appendChild(outLabel);

      node.outputs.forEach((out, idx) => {
        const row = document.createElement('div');
        row.className = 'portRow outputPort';
        row.dataset.out = idx;

        const name = document.createElement('span');
        name.className = 'portName';
        name.textContent = out.name;

        const handle = document.createElement('div');
        handle.className = 'handle output';
        handle.title = out.name;
        handle.dataset.out = idx;
        handle.addEventListener('pointerdown', (ev) => startConnection(ev, node.id, idx));

        row.appendChild(name);
        row.appendChild(portShapeLabel(node.outputShapes && node.outputShapes[idx]));
        row.appendChild(handle);
        ports.appendChild(row);
      });
    }

    el.appendChild(header);
    el.appendChild(ports);

    header.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      canvas.focus();
      if (!ev.shiftKey && !selectedNodeIds.has(node.id)){
        selectSingleNode(node);
      }
      if (ev.shiftKey && !selectedNodeIds.has(node.id)) return;

      dragging = node;
      didDrag = false;
      dragOffsets = new Map();
      const pt = canvasPoint(ev.clientX, ev.clientY);
      getSelectedNodes().forEach(n => {
        dragOffsets.set(n.id, { x: pt.x - n.x, y: pt.y - n.y });
      });
      header.setPointerCapture(ev.pointerId);
    });
    header.addEventListener('pointerup', () => { dragging = null; dragOffsets = new Map(); });

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (didDrag) return;
      if (ev.shiftKey) toggleNodeSelection(node);
      else selectSingleNode(node);
    });

    canvasContent.appendChild(el);
    resizeSvgLayer();
    updateConnections();
    recomputeShapes();
  }

  // global pointermove to handle dragging
  document.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    didDrag = true;
    const pt = canvasPoint(ev.clientX, ev.clientY);
    getSelectedNodes().forEach(n => {
      const offset = dragOffsets.get(n.id);
      if (!offset) return;
      n.x = pt.x - offset.x;
      n.y = pt.y - offset.y;
      const elm = nodeElement(n.id);
      if (elm){
        elm.style.left = n.x + 'px';
        elm.style.top = n.y + 'px';
      }
    });
    resizeSvgLayer();
    updateConnections();
  });

  function findInputHandleAt(clientX, clientY){
    const handles = document.querySelectorAll('.handle.input');
    let best = null;
    let bestDist = 20;
    handles.forEach(h => {
      const r = h.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      if (dist < bestDist){ bestDist = dist; best = h; }
    });
    return best;
  }

  function clearDropHighlights(){
    document.querySelectorAll('.handle.input.dropTarget').forEach(h => h.classList.remove('dropTarget'));
  }

  function addConnection(fromNodeId, fromIndex, toNodeId, toIndex){
    if (fromNodeId === toNodeId) return;
    const exists = connections.some(c =>
      c.from === fromNodeId && c.fromIndex === fromIndex &&
      c.to === toNodeId && c.toIndex === toIndex
    );
    if (exists) return;
    connections.push({ from: fromNodeId, fromIndex, to: toNodeId, toIndex });
  }

  function startConnection(ev, fromNodeId, outIndex){
    ev.stopPropagation(); ev.preventDefault();
    const fromEl = ev.currentTarget;
    const fromNode = nodes.find(n => n.id === fromNodeId);
    if (!fromNode) return;

    fromEl.classList.add('connecting');
    fromEl.setPointerCapture(ev.pointerId);
    ensureArrowMarker();

    const start = handleCenter(fromNode, fromEl);
    drawingConn = { fromNodeId, outIndex, startX: start.x, startY: start.y, handle: fromEl };

    createTempLine(start.x, start.y, start.x, start.y);

    function move(e){
      const pt = canvasPoint(e.clientX, e.clientY);
      updateTempLine(pt.x, pt.y);
      clearDropHighlights();
      const target = findInputHandleAt(e.clientX, e.clientY);
      if (target) target.classList.add('dropTarget');
    }

    function up(e){
      if (fromEl.hasPointerCapture(e.pointerId)) fromEl.releasePointerCapture(e.pointerId);
      fromEl.classList.remove('connecting');
      clearDropHighlights();

      let inputHandle = findInputHandleAt(e.clientX, e.clientY);
      if (!inputHandle){
        const elUnder = document.elementFromPoint(e.clientX, e.clientY);
        if (elUnder) inputHandle = elUnder.closest('.handle.input');
      }
      if (inputHandle){
        const toNodeEl = inputHandle.closest('.node');
        if (toNodeEl){
          addConnection(
            drawingConn.fromNodeId,
            drawingConn.outIndex,
            toNodeEl.dataset.id,
            Number(inputHandle.dataset.input || 0)
          );
        }
      }

      removeTempLine();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      drawingConn = null;
      updateConnections();
      recomputeShapes();
    }

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  // temp line helpers
  let tempLine = null;
  function createTempLine(x1, y1, x2, y2){
    tempLine = document.createElementNS('http://www.w3.org/2000/svg','path');
    tempLine.setAttribute('class','connLineTemp');
    svg.appendChild(tempLine);
    updateTempLine(x2, y2, x1, y1);
  }
  function updateTempLine(x2, y2, x1, y1){
    if (!tempLine) return;
    if (x1 === undefined || y1 === undefined){
      const d = tempLine.getAttribute('d') || '';
      const match = d.match(/M\s+([\d.-]+)\s+([\d.-]+)/);
      if (!match) return;
      x1 = Number(match[1]); y1 = Number(match[2]);
    }
    tempLine.setAttribute('d', connectionCurve(x1, y1, x2, y2).d);
  }
  function removeTempLine(){ if (tempLine){ tempLine.remove(); tempLine=null; } }

  function appendArrowHead(x2, y2, endCtrlX, endCtrlY){
    const angle = Math.atan2(y2 - endCtrlY, x2 - endCtrlX);
    const size = 10;
    const tipX = x2;
    const tipY = y2;
    const leftX = tipX - size * Math.cos(angle - Math.PI / 7);
    const leftY = tipY - size * Math.sin(angle - Math.PI / 7);
    const rightX = tipX - size * Math.cos(angle + Math.PI / 7);
    const rightY = tipY - size * Math.sin(angle + Math.PI / 7);
    const head = document.createElementNS('http://www.w3.org/2000/svg','polygon');
    head.setAttribute('class','connArrow');
    head.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
    svg.appendChild(head);
  }

  function updateConnections(){
    svg.querySelectorAll('path.connLine, polygon.connArrow').forEach(el => el.remove());
    ensureArrowMarker();
    resizeSvgLayer();

    connections.forEach(c => {
      const fromNode = nodes.find(n => n.id === c.from);
      const toNode = nodes.find(n => n.id === c.to);
      if (!fromNode || !toNode) return;

      const fromEl = document.querySelector(`.node[data-id='${c.from}'] .handle.output[data-out='${c.fromIndex}']`);
      const toEl = document.querySelector(`.node[data-id='${c.to}'] .handle.input[data-input='${c.toIndex}']`);
      if (!fromEl || !toEl) return;

      const { x: x1, y: y1 } = handleCenter(fromNode, fromEl);
      const { x: x2, y: y2 } = handleCenter(toNode, toEl);
      const curve = connectionCurve(x1, y1, x2, y2);

      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('class','connLine');
      path.setAttribute('d', curve.d);
      svg.appendChild(path);
      appendArrowHead(x2, y2, curve.endCtrlX, curve.endCtrlY);
    });
  }

  function nodeHasRequiredFields(node){
    if (isIoBlock(node.block)){
      const name = (node.ioName || '').trim();
      if (!name || ioNameTaken(name, node.id)) return false;
      if (isIoInput(node.block) && !isValidShape(node.shape)) return false;
      return true;
    }
    const reqs = Object.keys(node.block.init_arguments || {}).filter(k => node.block.init_arguments[k].required === 'True');
    return reqs.every(k => node.init_arguments[k] !== null && node.init_arguments[k] !== '' && node.init_arguments[k] !== undefined);
  }

  function showIoProps(node, form, saveWarning){
    const nameRow = document.createElement('div');
    nameRow.className = 'formRow';
    const nameLabel = document.createElement('label');
    nameLabel.innerHTML = 'Name <span class="req">*</span>';
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.placeholder = isIoInput(node.block) ? 'e.g. images' : 'e.g. logits';
    nameInp.value = node.ioName || '';
    const nameError = document.createElement('div');
    nameError.className = 'fieldError';
    nameError.textContent = 'This name is already used by another IO block';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInp);
    nameRow.appendChild(nameError);
    form.appendChild(nameRow);

    let shapeInp = null;
    let shapePreview = null;
    let shapeError = null;

    if (isIoInput(node.block)){
      const shapeRow = document.createElement('div');
      shapeRow.className = 'formRow';
      const shapeLabel = document.createElement('label');
      shapeLabel.innerHTML = 'Shape <span class="req">*</span> <span style="color:var(--text-muted);font-weight:400">(feature dims, comma-separated)</span>';
      shapeInp = document.createElement('input');
      shapeInp.type = 'text';
      shapeInp.placeholder = '3, 224, 224';
      shapeInp.value = isValidShape(node.shape) ? node.shape.join(', ') : '';
      shapePreview = document.createElement('div');
      shapePreview.className = 'shapePreview';
      shapeError = document.createElement('div');
      shapeError.className = 'fieldError';
      shapeError.textContent = 'Enter one or more positive integer dimensions';
      shapeRow.appendChild(shapeLabel);
      shapeRow.appendChild(shapeInp);
      shapeRow.appendChild(shapePreview);
      shapeRow.appendChild(shapeError);
      form.appendChild(shapeRow);
    }

    function syncShapePreview(){
      if (!shapePreview || !shapeInp) return;
      const parsed = parseShapeInput(shapeInp.value);
      const valid = parsed.length > 0 && !parsed.includes(null);
      shapePreview.textContent = valid ? formatShapeDisplay(parsed) : '[B, …]';
      shapePreview.classList.toggle('shapePreviewInvalid', !valid);
      shapeError.classList.toggle('visible', shapeInp.value.trim() !== '' && !valid);
    }

    function syncNameError(){
      const trimmed = nameInp.value.trim();
      const taken = trimmed && ioNameTaken(trimmed, node.id);
      nameError.classList.toggle('visible', Boolean(taken));
      nameInp.classList.toggle('inputInvalid', Boolean(taken));
    }

    function validateNode(){
      node.ioName = nameInp.value;
      syncNameError();
      if (shapeInp){
        const parsed = parseShapeInput(shapeInp.value);
        const valid = parsed.length > 0 && !parsed.includes(null);
        node.shape = valid ? parsed : [];
        syncShapePreview();
      }
      updateIoNodeVisuals(node);
      if (nodeHasRequiredFields(node)) saveWarning.classList.remove('visible');
      recomputeShapes();
      return nodeHasRequiredFields(node);
    }

    nameInp.oninput = validateNode;
    if (shapeInp) shapeInp.oninput = validateNode;
    syncShapePreview();
    syncNameError();

    return validateNode;
  }

  function allNodesSaved(){
    return nodes.length > 0 && nodes.every(n => n.saved);
  }

  function updateExportButtonState(){
    exportBtn.disabled = !allNodesSaved();
    exportBtn.title = allNodesSaved() ? '' : 'Save all nodes before exporting SVG';
  }

  function ensureArrowMarker(){
    if (svg.querySelector('defs')) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
    svg.appendChild(defs);
  }

  function showProps(node){
    propsEmpty.style.display = 'none';
    propsEl.style.display = 'block';
    propsEl.innerHTML = '';

    const form = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'propsTitle';
    title.innerHTML = `<strong>${getNodeDisplayName(node)}</strong><span>${isIoBlock(node.block) ? node.block.name : (node.block.path || '')}</span>`;
    form.appendChild(title);

    const saveWarning = document.createElement('div');
    saveWarning.className = 'saveWarning';
    saveWarning.textContent = 'Required fields are not filled';

    let validateNode = () => nodeHasRequiredFields(node);

    if (isIoBlock(node.block)){
      validateNode = showIoProps(node, form, saveWarning);
    } else {
      const args = node.block.init_arguments || {};
      const argKeys = Object.keys(args);

      if (!argKeys.length){
        const empty = document.createElement('p');
        empty.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0 0 12px';
        empty.textContent = 'No init arguments for this block.';
        form.appendChild(empty);
      }

      argKeys.forEach(k => {
        const row = document.createElement('div');
        row.className = 'formRow';
        const label = document.createElement('label');
        label.innerHTML = `${k}${args[k].required === 'True' ? ' <span class="req">*</span>' : ' <span style="color:var(--text-muted)">(optional)</span>'}`;
        const inp = document.createElement('input');
        inp.type = (typeof args[k].default === 'number') ? 'number' : 'text';
        inp.value = node.init_arguments[k] != null ? node.init_arguments[k] : (args[k].default != null ? args[k].default : '');
        inp.oninput = () => {
          node.init_arguments[k] = inp.value;
          if (nodeHasRequiredFields(node)) saveWarning.classList.remove('visible');
          recomputeShapes();
        };
        row.appendChild(label);
        row.appendChild(inp);
        form.appendChild(row);
      });

      validateNode = () => nodeHasRequiredFields(node);
    }

    const actions = document.createElement('div');
    actions.className = 'propsActions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.innerText = 'Save Node';
    saveBtn.onclick = () => {
      if (!validateNode() || !nodeHasRequiredFields(node)){
        saveWarning.classList.add('visible');
        return;
      }
      saveWarning.classList.remove('visible');
      node.saved = true;
      updateIoNodeVisuals(node);
      const nel = nodeElement(node.id);
      if (nel){
        const top = nel.querySelector('.nodeHeaderTop');
        if (top && !top.querySelector('.savedBadge')){
          const badge = document.createElement('span');
          badge.className = 'savedBadge';
          badge.textContent = 'saved';
          top.appendChild(badge);
        }
      }
      updateExportButtonState();
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.innerText = 'Delete';
    deleteBtn.onclick = () => deleteSelectedNodes();

    actions.appendChild(saveBtn);
    actions.appendChild(deleteBtn);
    form.appendChild(actions);
    form.appendChild(saveWarning);
    propsEl.appendChild(form);
  }

  function deleteNode(id){
    setSelection([id]);
    deleteSelectedNodes();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.node')) return;

    canvas.focus();

    if (pendingPlacement){
      const pt = canvasPoint(e.clientX, e.clientY);
      placePendingBlock(pt.x, pt.y);
      e.preventDefault();
      return;
    }

    const pt = canvasPoint(e.clientX, e.clientY);
    marquee = {
      startX: pt.x,
      startY: pt.y,
      additive: e.shiftKey,
      pointerId: e.pointerId
    };
    updateMarqueeVisual(pt.x, pt.y, pt.x, pt.y);
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!marquee || e.pointerId !== marquee.pointerId) return;
    const pt = canvasPoint(e.clientX, e.clientY);
    updateMarqueeVisual(marquee.startX, marquee.startY, pt.x, pt.y);
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!marquee || e.pointerId !== marquee.pointerId) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    finishMarquee(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointercancel', (e) => {
    if (!marquee || e.pointerId !== marquee.pointerId) return;
    hideMarquee();
    marquee = null;
  });

  canvas.addEventListener('wheel', (e) => {
    // Trackpad pinch-to-zoom (macOS/Windows send wheel + ctrlKey)
    if (e.ctrlKey){
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomToAt(e.clientX, e.clientY, canvasZoom * factor);
      return;
    }

    // Two-finger scroll on trackpad / mouse wheel scroll
    e.preventDefault();
    canvas.scrollLeft += e.deltaX;
    canvas.scrollTop += e.deltaY;
  }, { passive: false });

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const center = touchCenter(e.touches);
    touchGesture = {
      lastDist: touchDistance(e.touches),
      lastCenter: center
    };
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!touchGesture || e.touches.length !== 2) return;
    e.preventDefault();

    const dist = touchDistance(e.touches);
    const center = touchCenter(e.touches);
    const scaleFactor = dist / touchGesture.lastDist;

    if (Math.abs(scaleFactor - 1) > 0.002){
      zoomToAt(center.x, center.y, canvasZoom * scaleFactor);
    }

    canvas.scrollLeft -= center.x - touchGesture.lastCenter.x;
    canvas.scrollTop -= center.y - touchGesture.lastCenter.y;

    touchGesture.lastDist = dist;
    touchGesture.lastCenter = center;
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) endTouchGesture();
  });

  canvas.addEventListener('touchcancel', endTouchGesture);

  let gestureStartZoom = 1;
  canvas.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureStartZoom = canvasZoom;
  });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    zoomToAt(e.clientX, e.clientY, gestureStartZoom * e.scale);
  });
  canvas.addEventListener('gestureend', (e) => e.preventDefault());

  // accept drops from palette
  canvas.addEventListener('dragover', (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e)=>{
    e.preventDefault();
    try{
      const raw = e.dataTransfer.getData('application/json');
      const b = JSON.parse(raw);
      const pt = canvasPoint(e.clientX, e.clientY);
      addNode(b, pt.x, pt.y);
    }catch(err){ console.warn('drop parse failed', err); }
  });

  // track last mouse position for paste
  document.addEventListener('pointermove', (e)=>{ lastMousePos = {x: e.clientX, y: e.clientY}; });

  // keyboard shortcuts: copy, paste, delete
  document.addEventListener('keydown', (e) => {
    if (isEditingText()) return;

    if (e.key === 'Escape' && pendingPlacement){
      cancelBlockPlacement();
      e.preventDefault();
      return;
    }

    const cmd = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (cmd && key === 'a' && isCanvasShortcutContext()){
      selectAllNodes();
      e.preventDefault();
      return;
    }

    if (cmd && key === 'c' && isCanvasShortcutContext()){
      if (copySelection()) e.preventDefault();
      return;
    }

    if (cmd && key === 'x' && isCanvasShortcutContext()){
      if (getSelectedNodes().length){
        cutSelection();
        e.preventDefault();
      }
      return;
    }

    if (cmd && key === 'v' && isCanvasShortcutContext()){
      if (clipboard && clipboard.nodes.length){
        pasteClipboard();
        e.preventDefault();
      }
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.size && isCanvasShortcutContext()){
      deleteSelectedNodes();
      e.preventDefault();
      return;
    }

    if (isCanvasShortcutContext() && key === '0'){
      setCanvasZoom(1);
      canvas.scrollLeft = 0;
      canvas.scrollTop = 0;
      e.preventDefault();
    }
  });

  // search functionality
  blockSearchInput.addEventListener('input', (e) => {
    searchBlocks(e.target.value);
  });

  blockSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape'){
      closeSearchDropdown();
    }
  });

  document.addEventListener('click', closeSearchOnClickOutside);

  exportBtn.onclick = async () => {
    if (!allNodesSaved()){
      alert('All blocks must be saved before saving the graph.');
      return;
    }
    let defaultName = 'graph-1';
    try {
      defaultName = await suggestGraphName();
    } catch (e) { /* use fallback */ }

    let promptMessage = 'What should the SVG file be named?';
    let filename = null;

    while (!filename){
      const name = prompt(promptMessage, defaultName);
      if (name === null) return;

      const trimmed = name.trim();
      if (!trimmed){
        promptMessage = 'Name cannot be empty. Enter a name:';
        continue;
      }

      const candidate = trimmed.toLowerCase().endsWith('.svg') ? trimmed : `${trimmed}.svg`;
      if (await graphNameExists(candidate)){
        promptMessage = `"${candidate}" already exists in this session. Enter a different name:`;
        defaultName = candidate.replace(/\.svg$/i, '');
        continue;
      }

      filename = candidate;
    }

    const svg = buildGraphSvg();
    apiFetch('/api/save_graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg, name: filename })
    })
      .then(r => r.json())
      .then(j => {
        if (j.ok){
          alert('Saved as ' + j.name);
          fetchSavedGraphs();
        } else {
          alert('Save failed: ' + (j.error || 'unknown error'));
        }
      })
      .catch(e => { alert('Save failed: ' + e.message); });
  };

  async function boot(versionMeta){
    torchVersion = versionMeta || null;
    if (versionMeta && versionMeta.id) {
      sessionStorage.setItem(VERSION_STORAGE_KEY, versionMeta.id);
    }
    try {
      await initSession();
    } catch (err){
      alert('Could not start session: ' + err.message);
      return;
    }
    applyCanvasZoom();
    resizeSvgLayer();
    updateExportButtonState();
    await fetchBlocks();
    await fetchSavedGraphs();
    updateSessionLabel();
  }

  window.NWUI_startEditor = boot;
})();