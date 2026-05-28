(function(){
  const blocksListEl = document.getElementById('blocksList');
  const canvas = document.getElementById('canvas');
  const canvasContent = document.getElementById('canvasContent');
  const svg = document.getElementById('connectionsSvg');
  const propsEl = document.getElementById('props');
  const propsEmpty = document.getElementById('propsEmpty');
  const exportBtn = document.getElementById('exportBtn');
  const reloadBlocksBtn = document.getElementById('reloadBlocksBtn');
  const blockSearchInput = document.getElementById('blockSearch');
  const searchDropdown = document.getElementById('searchDropdown');
  const searchResults = document.getElementById('searchResults');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomLabel = document.getElementById('zoomLabel');

  let blocks = [];
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
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2.5;
  const ZOOM_STEP = 0.1;

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
    addNode(blockDef);
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
    return fetch('/api/blocks').then(r=>r.json()).then(r=>{ blocks = r.blocks || []; renderPalette(); });
  }

  function formatCategoryName(folder){
    return folder.replace(/_/g, ' ');
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
    return Object.keys(groups).sort().reduce((acc, k) => { acc[k] = groups[k]; return acc; }, {});
  }

  function attachBlockItem(el, b){
    el.onclick = () => addNode(b);
    el.draggable = true;
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/json', JSON.stringify(b));
      ev.dataTransfer.effectAllowed = 'copy';
    });
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
  }

  function getBlockInputs(blockDef){
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

  function clampZoom(value){
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  }

  function applyCanvasZoom(){
    canvasContent.style.transform = `scale(${canvasZoom})`;
    zoomLabel.textContent = Math.round(canvasZoom * 100) + '%';
    resizeSvgLayer();
    updateConnections();
  }

  function setCanvasZoom(nextZoom){
    canvasZoom = clampZoom(nextZoom);
    applyCanvasZoom();
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

  function addNode(blockDef, x=60, y=60){
    const id = 'n'+Date.now()+Math.floor(Math.random()*999);
    const outputs = getBlockOutputs(blockDef);
    const inputs = getBlockInputs(blockDef);
    const node = {
      id, block: blockDef, x, y, saved: false,
      init_arguments: Object.assign({}, ...Object.keys(blockDef.init_arguments||{}).map(k=>({[k]: blockDef.init_arguments[k].default}))),
      outputs, inputs
    };
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
      msg.textContent = `${selected.length} blocks selected. Use ⌘/Ctrl+A to select all, copy, cut, paste, or delete.`;
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
    updateExportButtonState();
  }

  function isEditingText(){
    const active = document.activeElement;
    return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  }

  function isCanvasShortcutContext(){
    return document.activeElement === canvas || canvas.contains(document.activeElement);
  }

  function renderNode(node){
    normalizeNodePorts(node);
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';

    const kind = (node.block.category || 'Module').toLowerCase();
    const header = document.createElement('div');
    header.className = 'nodeHeader ' + (kind === 'function' ? 'function' : 'module');
    header.innerHTML = `
      <div class="nodeHeaderTop">
        <span class="nodeName">${node.block.name}</span>
        ${node.saved ? '<span class="savedBadge">saved</span>' : ''}
      </div>
      <div class="nodePath">${node.block.path || ''}</div>
    `;

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
        row.appendChild(handle);
        ports.appendChild(row);
      });
    }

    el.appendChild(header);
    el.appendChild(ports);

    header.addEventListener('pointerdown', (ev) => {
      canvas.focus();
      if (!selectedNodeIds.has(node.id)){
        selectSingleNode(node);
      }
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
      if (!didDrag) selectSingleNode(node);
    });

    canvasContent.appendChild(el);
    resizeSvgLayer();
    updateConnections();
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
    const reqs = Object.keys(node.block.init_arguments || {}).filter(k => node.block.init_arguments[k].required === 'True');
    return reqs.every(k => node.init_arguments[k] !== null && node.init_arguments[k] !== '' && node.init_arguments[k] !== undefined);
  }

  function allNodesSaved(){
    return nodes.length > 0 && nodes.every(n => n.saved);
  }

  function updateExportButtonState(){
    exportBtn.disabled = !allNodesSaved();
    exportBtn.title = allNodesSaved() ? '' : 'Save all nodes before saving the graph';
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
    title.innerHTML = `<strong>${node.block.name}</strong><span>${node.block.path || ''}</span>`;
    form.appendChild(title);

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
      inp.oninput = () => { node.init_arguments[k] = inp.value; validateNode(); };
      row.appendChild(label);
      row.appendChild(inp);
      form.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'propsActions';

    const saveWarning = document.createElement('div');
    saveWarning.className = 'saveWarning';
    saveWarning.textContent = 'Required fields are not filled';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.innerText = 'Save Node';
    saveBtn.onclick = () => {
      if (!nodeHasRequiredFields(node)){
        saveWarning.classList.add('visible');
        return;
      }
      saveWarning.classList.remove('visible');
      node.saved = true;
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

    function validateNode(){
      if (nodeHasRequiredFields(node)) saveWarning.classList.remove('visible');
    }
  }

  function deleteNode(id){
    setSelection([id]);
    deleteSelectedNodes();
  }

  canvas.addEventListener('mousedown', () => canvas.focus());

  canvas.addEventListener('click', () => {
    clearSelection();
  });

  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    changeCanvasZoom(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
  }, { passive: false });

  zoomInBtn.onclick = () => changeCanvasZoom(ZOOM_STEP);
  zoomOutBtn.onclick = () => changeCanvasZoom(-ZOOM_STEP);

  // accept drops from palette
  canvas.addEventListener('dragover', (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e)=>{
    e.preventDefault();
    try{
      const raw = e.dataTransfer.getData('application/json');
      const b = JSON.parse(raw);
      const pt = canvasPoint(e.clientX, e.clientY);
      addNode(b, pt.x - 60, pt.y - 20);
    }catch(err){ console.warn('drop parse failed', err); }
  });

  // track last mouse position for paste
  document.addEventListener('pointermove', (e)=>{ lastMousePos = {x: e.clientX, y: e.clientY}; });

  // keyboard shortcuts: copy, paste, delete
  document.addEventListener('keydown', (e) => {
    if (isEditingText()) return;
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

    if (isCanvasShortcutContext()){
      if (key === '=' || key === '+'){
        changeCanvasZoom(ZOOM_STEP);
        e.preventDefault();
      } else if (key === '-'){
        changeCanvasZoom(-ZOOM_STEP);
        e.preventDefault();
      } else if (key === '0'){
        setCanvasZoom(1);
        e.preventDefault();
      }
    }
  });

  // reload palette from disk
  reloadBlocksBtn.onclick = () => fetchBlocks();

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

  // export graph
  exportBtn.onclick = () => {
    if (!allNodesSaved()){
      alert('All blocks must be saved before saving the graph.');
      return;
    }
    const name = prompt('What should be the name of the graph?', 'my-graph');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed){
      alert('Graph name cannot be empty.');
      return;
    }
    const filename = trimmed.endsWith('.json') ? trimmed : trimmed + '.json';
    const graph = { nodes: nodes.map(n=>({ id:n.id, block: n.block.name, path:n.block.path, x:n.x, y:n.y, init_arguments:n.init_arguments, outputs:n.outputs, inputs:n.inputs })), connections };
    fetch('/api/save_graph', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ graph, name: filename }) })
      .then(r => r.json())
      .then(j => { if (j.ok) alert('Saved to ' + j.path); else alert('Save failed'); })
      .catch(e => { alert('Save failed: ' + e.message); });
  };

  // init
  applyCanvasZoom();
  resizeSvgLayer();
  updateExportButtonState();
  fetchBlocks();
})();