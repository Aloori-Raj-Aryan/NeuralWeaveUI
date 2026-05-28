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

  function addNode(blockDef, x=60, y=60){
    const id = 'n'+Date.now()+Math.floor(Math.random()*999);
    const outputs = Array.isArray(blockDef.output) ? blockDef.output : (blockDef.output ? [blockDef.output] : ["output"]);
    const node = {
      id, block: blockDef, x, y, saved: false,
      init_arguments: Object.assign({}, ...Object.keys(blockDef.init_arguments||{}).map(k=>({[k]: blockDef.init_arguments[k].default}))),
      outputs, inputs: [{name:'input'}]
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
    // create input handle
    const hin = document.createElement('div'); hin.className='handle input';
    hin.style.top = '20px'; hin.dataset.input = 0;
    el.appendChild(hin);

    // event for selecting and dragging (set dragging state; global listener handles movement)
    const header = el.querySelector('.nodeHeader');
    header.addEventListener('pointerdown', (ev)=>{
      selectedNode = node; showProps(node); dragging = node; dragOffset.x = ev.clientX - node.x; dragOffset.y = ev.clientY - node.y; ev.target.setPointerCapture(ev.pointerId);
    });
    header.addEventListener('pointerup', ()=>{ dragging = null; });

    el.addEventListener('click', (ev)=>{ ev.stopPropagation(); selectedNode = node; showProps(node); })

    canvas.appendChild(el);
    updateConnections();
  }

  // global pointermove to handle dragging
  document.addEventListener('pointermove', (ev)=>{
    if (dragging){
      dragging.x = ev.clientX - dragOffset.x;
      dragging.y = ev.clientY - dragOffset.y;
      const elm = document.querySelector(`.node[data-id='${dragging.id}']`);
      if (elm){ elm.style.left = dragging.x + 'px'; elm.style.top = dragging.y + 'px'; updateConnections(); }
    }
  });

  function startConnection(ev, fromNodeId, outIndex){
    ev.stopPropagation(); ev.preventDefault();
    const fromEl = document.querySelector(`.node[data-id='${fromNodeId}'] .handle.output[data-out='${outIndex}']`);
    const svgRect = svg.getBoundingClientRect();
    let start = getSvgPoint(ev.clientX, ev.clientY);
    if (fromEl){ const r = fromEl.getBoundingClientRect(); start = { x: r.left + r.width/2 - svgRect.left, y: r.top + r.height/2 - svgRect.top }; }
    drawingConn = {fromNodeId, outIndex, startX: start.x, startY: start.y};
    createTempLine(start.x,start.y,start.x,start.y);

    function move(e){ const pt = getSvgPoint(e.clientX,e.clientY); updateTempLine(pt.x,pt.y); }
    function up(e){
      // try to detect an input handle under the pointer and create connection
      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      if (elUnder){
        const inputHandle = elUnder.closest('.handle.input');
        if (inputHandle){
          const toNodeEl = inputHandle.closest('.node');
          if (toNodeEl){
            const toNodeId = toNodeEl.dataset.id;
            const toIndex = Number(inputHandle.dataset.input || 0);
            const conn = { from: drawingConn.fromNodeId, fromIndex: drawingConn.outIndex, to: toNodeId, toIndex };
            connections.push(conn);
          }
        }
      }
      removeTempLine(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); drawingConn=null; updateConnections();
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function finishConnection(ev, toNodeId, inputIndex){
    if (!drawingConn) return; // only accept if started on output
    const conn = { from: drawingConn.fromNodeId, fromIndex: drawingConn.outIndex, to: toNodeId, toIndex: inputIndex };
    connections.push(conn);
    removeTempLine(); drawingConn = null; updateConnections();
  }

  // temp line helpers
  let tempLine = null;
  function createTempLine(x1,y1,x2,y2){ tempLine = document.createElementNS('http://www.w3.org/2000/svg','path'); tempLine.setAttribute('class','connLine'); tempLine.setAttribute('marker-end','url(#arrow)'); svg.appendChild(tempLine); tempLine.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`); }
  function updateTempLine(x2,y2){ if (!tempLine) return; const d = tempLine.getAttribute('d'); const from = d.split('L')[0].replace('M','').trim(); const [x1,y1] = from.split(' ').map(Number); tempLine.setAttribute('d', `M ${x1} ${y1} C ${x1+40} ${y1} ${x2-40} ${y2} ${x2} ${y2}`); }
  function removeTempLine(){ if (tempLine){ tempLine.remove(); tempLine=null; } }

  function getSvgPoint(clientX, clientY){ const r = svg.getBoundingClientRect(); return { x: clientX - r.left, y: clientY - r.top }; }

  function updateConnections(){
    // clear and redraw
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    ensureArrowMarker();
    connections.forEach((c,idx)=>{
      const fromEl = document.querySelector(`.node[data-id='${c.from}'] .handle.output[data-out='${c.fromIndex}']`);
      const toEl = document.querySelector(`.node[data-id='${c.to}'] .handle.input[data-input='${c.toIndex}']`);
      if (!fromEl || !toEl) return;
      const fromRect = fromEl.getBoundingClientRect(); const toRect = toEl.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width/2 - svgRect.left; const y1 = fromRect.top + fromRect.height/2 - svgRect.top;
      const x2 = toRect.left + toRect.width/2 - svgRect.left; const y2 = toRect.top + toRect.height/2 - svgRect.top;
      const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('class','connLine'); path.setAttribute('d', `M ${x1} ${y1} C ${x1+40} ${y1} ${x2-40} ${y2} ${x2} ${y2}`);
      path.setAttribute('marker-end','url(#arrow)');
      svg.appendChild(path);
    });
  }

  function ensureArrowMarker(){
    if (svg.querySelector('defs')) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg','marker');
    marker.setAttribute('id','arrow');
    marker.setAttribute('viewBox','0 0 10 10');
    marker.setAttribute('refX','10');
    marker.setAttribute('refY','5');
    marker.setAttribute('markerUnits','strokeWidth');
    marker.setAttribute('markerWidth','8');
    marker.setAttribute('markerHeight','6');
    marker.setAttribute('orient','auto');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M 0 0 L 10 5 L 0 10 z');
    path.setAttribute('fill','#2b9cff');
    marker.appendChild(path);
    defs.appendChild(marker);
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

  function deleteNode(id){ nodes = nodes.filter(n=>n.id!==id); connections = connections.filter(c=> c.from!==id && c.to!==id); const el = document.querySelector(`.node[data-id='${id}']`); if (el) el.remove(); propsEl.innerHTML=''; propsEl.style.display='none'; propsEmpty.style.display='block'; updateConnections(); }

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
      const x = e.clientX - rect.left - 60; const y = e.clientY - rect.top - 20;
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
        const x = lastMousePos.x - rect.left - 60; const y = lastMousePos.y - rect.top - 20;
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
    const graph = { nodes: nodes.map(n=>({ id:n.id, block: n.block.name, path:n.block.path, x:n.x, y:n.y, init_arguments:n.init_arguments, outputs:n.outputs })), connections };
    fetch('/api/save_graph', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ graph, name: 'graph-'+Date.now()+'.json' }) }).then(r=>r.json()).then(j=>{ if (j.ok) alert('Saved to '+j.path); else alert('Save failed'); }).catch(e=>{ alert('Save failed: '+e.message); });
  }

  // init
  fetchBlocks();
})();