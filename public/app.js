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
  let dragging = null;
  let dragOffset = {x:0,y:0};
  let drawingConn = null; // {fromNodeId, outIndex}

  function fetchBlocks(){
    return fetch('/api/blocks').then(r=>r.json()).then(r=>{ blocks = r.blocks || []; renderPalette(); });
  }

  function renderPalette(){
    blocksListEl.innerHTML = '';
    blocks.forEach(b=>{
      const el = document.createElement('div'); el.className='blockItem';
      el.innerHTML = `<strong>${b.name}</strong><div style="font-size:12px;color:#666">${b.path||''}</div>`;
      el.onclick = ()=> addNode(b);
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
      h.onmousedown = (ev)=> startConnection(ev, node.id, idx);
      el.appendChild(h);
    });
    // create input handle
    const hin = document.createElement('div'); hin.className='handle input';
    hin.style.top = '20px'; hin.dataset.input = 0;
    hin.onmouseup = (ev)=> finishConnection(ev, node.id, 0);
    el.appendChild(hin);

    // event for selecting and dragging
    const header = el.querySelector('.nodeHeader');
    header.onpointerdown = (ev)=>{
      selectedNode = node; showProps(node); dragging = node; dragOffset.x = ev.clientX - node.x; dragOffset.y = ev.clientY - node.y; header.setPointerCapture(ev.pointerId);
    };
    header.onpointerup = (ev)=>{
      if (dragging) dragging = null;
    };

    document.addEventListener('pointermove', (ev)=>{
      if (dragging && dragging.id===node.id){
        dragging.x = ev.clientX - dragOffset.x;
        dragging.y = ev.clientY - dragOffset.y;
        const elm = document.querySelector(`.node[data-id='${node.id}']`);
        if (elm){ elm.style.left = dragging.x + 'px'; elm.style.top = dragging.y + 'px'; updateConnections(); }
      }
    });

    el.onclick = (ev)=>{ ev.stopPropagation(); selectedNode = node; showProps(node); }

    canvas.appendChild(el);
    updateConnections();
  }

  function startConnection(ev, fromNodeId, outIndex){
    ev.stopPropagation(); drawingConn = {fromNodeId, outIndex};
    const p = getSvgPoint(ev.clientX, ev.clientY);
    createTempLine(p.x,p.y,p.x,p.y);

    function move(e){ const pt = getSvgPoint(e.clientX,e.clientY); updateTempLine(pt.x,pt.y); }
    function up(e){ removeTempLine(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); drawingConn=null; }
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
  function createTempLine(x1,y1,x2,y2){ tempLine = document.createElementNS('http://www.w3.org/2000/svg','path'); tempLine.setAttribute('class','connLine'); svg.appendChild(tempLine); tempLine.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`); }
  function updateTempLine(x2,y2){ if (!tempLine) return; const from = tempLine.getAttribute('d').split('L')[0].replace('M','').trim(); const [x1,y1] = from.split(' ').map(Number); tempLine.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`); }
  function removeTempLine(){ if (tempLine){ tempLine.remove(); tempLine=null; } }

  function getSvgPoint(clientX, clientY){ const r = svg.getBoundingClientRect(); return { x: clientX - r.left, y: clientY - r.top }; }

  function updateConnections(){
    // clear and redraw
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    connections.forEach((c,idx)=>{
      const fromEl = document.querySelector(`.node[data-id='${c.from}'] .handle.output[data-out='${c.fromIndex}']`);
      const toEl = document.querySelector(`.node[data-id='${c.to}'] .handle.input[data-input='${c.toIndex}']`);
      if (!fromEl || !toEl) return;
      const fromRect = fromEl.getBoundingClientRect(); const toRect = toEl.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const x1 = fromRect.left + fromRect.width/2 - svgRect.left; const y1 = fromRect.top + fromRect.height/2 - svgRect.top;
      const x2 = toRect.left + toRect.width/2 - svgRect.left; const y2 = toRect.top + toRect.height/2 - svgRect.top;
      const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('class','connLine'); path.setAttribute('d', `M ${x1} ${y1} C ${x1+40} ${y1} ${x2-40} ${y2} ${x2} ${y2}`);
      svg.appendChild(path);
    });
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

  // export graph
  exportBtn.onclick = ()=>{
    const graph = { nodes: nodes.map(n=>({ id:n.id, block: n.block.name, path:n.block.path, x:n.x, y:n.y, init_arguments:n.init_arguments, outputs:n.outputs })), connections };
    fetch('/api/save_graph', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ graph, name: 'graph-'+Date.now()+'.json' }) }).then(r=>r.json()).then(j=>{ if (j.ok) alert('Saved to '+j.path); else alert('Save failed'); }).catch(e=>{ alert('Save failed: '+e.message); });
  }

  // init
  fetchBlocks();
})();