(function(){
  const blocksListEl = document.getElementById('blocksList');
  const canvas = document.getElementById('canvas');
  const svg = document.getElementById('connectionsSvg');
  const propsEl = document.getElementById('props');
  const propsEmpty = document.getElementById('propsEmpty');
  const exportBtn = document.getElementById('exportBtn');

  let blocks = [];
  let nodes = [];
  let connections = [];
  let selectedNode = null;
  let dragging = null; // node being dragged
  let dragOffset = {x:0,y:0};
  let drawingConn = null; // {fromNodeId, outIndex, startX, startY}
  let lastMousePos = {x:0,y:0};
  let clipboardNode = null;

  function fetchBlocks(){
    return fetch('/api/blocks').then(r=>r.json()).then(r=>{ blocks = r.blocks || []; renderPalette(); });
  }

  function renderPalette(){
    blocksListEl.innerHTML = '';
    blocks.forEach(b=>{
      const el = document.createElement('div'); el.className='blockItem';
      el.innerHTML = `<strong>${b.name}</strong><div style="font-size:12px;color:#666">${b.path||''}</div>`;
      el.onclick = ()=> addNode(b);
      // enable drag from palette
      el.draggable = true;
      el.addEventListener('dragstart', (ev)=>{
        ev.dataTransfer.setData('application/json', JSON.stringify(b));
        ev.dataTransfer.effectAllowed = 'copy';
      });
      blocksListEl.appendChild(el);
    });
  }

  function getBlockInputs(blockDef){
    const fwd = blockDef.forward_arguments || {};
    const tensorInputs = Object.keys(fwd).filter(k => fwd[k].type === 'Tensor').map(name => ({ name }));
    return tensorInputs.length ? tensorInputs : [{ name: 'input' }];
  }

  function getBlockOutputs(blockDef){
    return Array.isArray(blockDef.output) ? blockDef.output : (blockDef.output ? [blockDef.output] : ['output']);
  }

  const NODE_WIDTH = 220;
  const HANDLE_SIZE = 12;

  function handleCenter(node, handleEl){
    const idx = Number(handleEl.classList.contains('output') ? handleEl.dataset.out : handleEl.dataset.input) || 0;
    const y = node.y + 20 + idx * 18 + HANDLE_SIZE / 2;
    const x = handleEl.classList.contains('output') ? node.x + NODE_WIDTH : node.x;
    return { x, y };
  }

  function resizeSvgLayer(){
    let maxX = canvas.clientWidth || 800;
    let maxY = canvas.clientHeight || 600;
    nodes.forEach(n => {
      maxX = Math.max(maxX, n.x + NODE_WIDTH + 80);
      maxY = Math.max(maxY, n.y + 140);
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
  function canvasPoint(clientX, clientY){
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left + canvas.scrollLeft, y: clientY - rect.top + canvas.scrollTop };
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
    renderNode(node);
  }

  function renderNode(node){
    const el = document.createElement('div'); el.className='node'; el.dataset.id=node.id;
    el.style.left = node.x + 'px'; el.style.top = node.y + 'px';

    el.innerHTML = `
      <div class="nodeHeader">${node.block.name} <span style="float:right">`+(node.saved?'<span class="savedBadge">saved</span>':'')+`</span></div>
      <div class="nodeBody"></div>
    `;
    const body = el.querySelector('.nodeBody');
    // create outputs
    node.outputs.forEach((o, idx)=>{
      const h = document.createElement('div'); h.className='handle output';
      h.title = o;
      h.style.top = (20 + idx*18) + 'px';
      h.dataset.out = idx;
      h.addEventListener('pointerdown', (ev)=> startConnection(ev, node.id, idx));
      el.appendChild(h);
    });
    node.inputs.forEach((inp, idx)=>{
      const hin = document.createElement('div');
      hin.className = 'handle input';
      hin.title = inp.name;
      hin.style.top = (20 + idx * 18) + 'px';
      hin.dataset.input = idx;
      el.appendChild(hin);
    });

    const header = el.querySelector('.nodeHeader');
    header.addEventListener('pointerdown', (ev)=>{
      selectedNode = node; showProps(node); dragging = node;
      const pt = canvasPoint(ev.clientX, ev.clientY);
      dragOffset.x = pt.x - node.x; dragOffset.y = pt.y - node.y;
      header.setPointerCapture(ev.pointerId);
    });
    header.addEventListener('pointerup', ()=>{ dragging = null; });

    el.addEventListener('click', (ev)=>{ ev.stopPropagation(); selectedNode = node; showProps(node); })

    canvas.appendChild(el);
    resizeSvgLayer();
    updateConnections();
  }

  // global pointermove to handle dragging
  document.addEventListener('pointermove', (ev)=>{
    if (dragging){
      const pt = canvasPoint(ev.clientX, ev.clientY);
      dragging.x = pt.x - dragOffset.x;
      dragging.y = pt.y - dragOffset.y;
      const elm = document.querySelector(`.node[data-id='${dragging.id}']`);
      if (elm){ elm.style.left = dragging.x + 'px'; elm.style.top = dragging.y + 'px'; resizeSvgLayer(); updateConnections(); }
    }
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

  function ensureArrowMarker(){
    if (svg.querySelector('defs')) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
    svg.appendChild(defs);
  }

  // selection & props
  function showProps(node){ propsEmpty.style.display='none'; propsEl.style.display='block'; propsEl.innerHTML='';
    const form = document.createElement('div');
    const title = document.createElement('div'); title.innerHTML = `<strong>${node.block.name}</strong> <div style="font-size:12px;color:#666">${node.block.path||''}</div>`;
    form.appendChild(title);
    const args = node.block.init_arguments||{};
    Object.keys(args).forEach(k=>{
      const row = document.createElement('div'); row.className='formRow';
      const label = document.createElement('label'); label.innerText = `${k} ${args[k].required==='True'?'*':''}`;
      const inp = document.createElement('input'); inp.type = (typeof args[k].default === 'number')? 'number':'text'; inp.value = node.init_arguments[k] ?? (args[k].default ?? '');
      inp.oninput = (ev)=>{ node.init_arguments[k] = inp.value; validateNode(node); }
      row.appendChild(label); row.appendChild(inp); form.appendChild(row);
    });
    const saveBtn = document.createElement('button'); saveBtn.className='primary'; saveBtn.innerText='Save Node'; saveBtn.onclick = ()=>{ node.saved = true; document.querySelectorAll('.node').forEach(nel=>{ if (nel.dataset.id===node.id) nel.querySelector('.nodeHeader span').innerHTML='<span class="savedBadge">saved</span>'; }); }
    saveBtn.disabled = !validateNode(node);
    form.appendChild(saveBtn);

    const deleteBtn = document.createElement('button'); deleteBtn.className='secondary'; deleteBtn.style.marginLeft='8px'; deleteBtn.innerText='Delete Node'; deleteBtn.onclick = ()=>{ deleteNode(node.id) };
    form.appendChild(deleteBtn);

    propsEl.appendChild(form);

    function validateNode(n){
      const reqs = Object.keys(n.block.init_arguments||{}).filter(k=>n.block.init_arguments[k].required==='True');
      const ok = reqs.every(k=> n.init_arguments[k] !== null && n.init_arguments[k] !== '' && n.init_arguments[k] !== undefined);
      saveBtn.disabled = !ok;
      return ok;
    }
  }

  function deleteNode(id){ nodes = nodes.filter(n=>n.id!==id); connections = connections.filter(c=> c.from!==id && c.to!==id); const el = document.querySelector(`.node[data-id='${id}']`); if (el) el.remove(); propsEl.innerHTML=''; propsEl.style.display='none'; propsEmpty.style.display='block'; resizeSvgLayer(); updateConnections(); }

  // canvas click to deselect
  canvas.addEventListener('click', ()=>{ selectedNode=null; propsEl.style.display='none'; propsEmpty.style.display='block'; });

  // accept drops from palette
  canvas.addEventListener('dragover', (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e)=>{
    e.preventDefault();
    try{
      const raw = e.dataTransfer.getData('application/json');
      const b = JSON.parse(raw);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + canvas.scrollLeft - 60;
      const y = e.clientY - rect.top + canvas.scrollTop - 20;
      addNode(b, x, y);
    }catch(err){ console.warn('drop parse failed', err); }
  });

  // track last mouse position for paste
  document.addEventListener('pointermove', (e)=>{ lastMousePos = {x: e.clientX, y: e.clientY}; });

  // keyboard shortcuts: copy, paste, delete
  document.addEventListener('keydown', (e)=>{
    const cmd = e.metaKey || e.ctrlKey;
    // copy
    if (cmd && e.key.toLowerCase()==='c'){
      if (selectedNode){ clipboardNode = JSON.parse(JSON.stringify(selectedNode)); delete clipboardNode.id; e.preventDefault(); }
    }
    // paste
    if (cmd && e.key.toLowerCase()==='v'){
      if (clipboardNode){
        const rect = canvas.getBoundingClientRect();
        const x = lastMousePos.x - rect.left + canvas.scrollLeft - 60;
        const y = lastMousePos.y - rect.top + canvas.scrollTop - 20;
        const newId = 'n'+Date.now()+Math.floor(Math.random()*999);
        const newNode = JSON.parse(JSON.stringify(clipboardNode));
        newNode.id = newId; newNode.x = x; newNode.y = y; newNode.saved = false;
        nodes.push(newNode); renderNode(newNode); e.preventDefault();
      }
    }
    // delete
    if ((e.key==='Delete' || e.key==='Backspace') && selectedNode){ deleteNode(selectedNode.id); selectedNode=null; }
  });

  // export graph
  exportBtn.onclick = ()=>{
    const graph = { nodes: nodes.map(n=>({ id:n.id, block: n.block.name, path:n.block.path, x:n.x, y:n.y, init_arguments:n.init_arguments, outputs:n.outputs, inputs:n.inputs })), connections };
    fetch('/api/save_graph', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ graph, name: 'graph-'+Date.now()+'.json' }) }).then(r=>r.json()).then(j=>{ if (j.ok) alert('Saved to '+j.path); else alert('Save failed'); }).catch(e=>{ alert('Save failed: '+e.message); });
  }

  // init
  resizeSvgLayer();
  fetchBlocks();
})();