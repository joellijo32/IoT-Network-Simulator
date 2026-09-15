/**
 * @module drag
 * @description Tools + drag/select. Modes: pointer, add-sensor/gateway/
 *              server, link (source->target validated), scissors (sever/
 *              restore + cycle up/flapping/down), delete. Click select -> drawer.
 */

const DragEngine = (() => {
  'use strict';

  let canvas = null;
  let dragging = null, offsetX = 0, offsetY = 0, hoveredNode = null;
  let tool = 'pointer';
  let linkSource = null;

  function bindEvents(canvasEl) {
    canvas = canvasEl;
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('mouseleave', onPointerUp);
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKey);
    document.querySelectorAll('#studio-toolbar .tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    setTool('pointer');
  }
  function setTool(t) {
    tool = t; linkSource = null;
    try { CanvasEngine.setDraftLink(null); } catch (e) {}
    document.querySelectorAll('#studio-toolbar .tool-btn[data-tool]').forEach(b => {
      b.classList.toggle('active-tool', b.dataset.tool === t);
    });
    const hint = document.getElementById('link-draft-hint');
    if (hint) hint.classList.remove('show');
    updateStatusbar();
  }
  function getTool() { return tool; }

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
  }
  function hitTest(px, py) {
    const nodes = CanvasEngine.getNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (isWithinNode(node, px, py)) return node;
    }
    return null;
  }
  function isWithinNode(node, px, py) {
    const dx = px - node.x, dy = py - node.y;
    if (node.type === 'sensor') return (dx * dx + dy * dy) <= (30 * 30);
    if (node.type === 'gateway') return (Math.abs(dx) + Math.abs(dy)) <= 44;
    if (node.type === 'server') return Math.abs(dx) <= 40 && Math.abs(dy) <= 30;
    return (dx * dx + dy * dy) <= (28 * 28);
  }
  /** Distance point->segment for link hit-testing (12px tolerance). */
  function hitLink(px, py) {
    const nodes = CanvasEngine.getNodes(), links = CanvasEngine.getLinks();
    let best = null, bestD = 14;
    links.forEach(l => {
      const a = Array.isArray(l) ? l[0] : l.source, b = Array.isArray(l) ? l[1] : l.target;
      const A = nodes.find(n => n.id === a), B = nodes.find(n => n.id === b);
      if (!A || !B) return;
      const d = ptSeg(px, py, A.x, A.y, B.x, B.y);
      if (d < bestD) { bestD = d; best = Array.isArray(l) ? null : l; }
    });
    return best;
  }
  function ptSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function onPointerDown(e) {
    const pos = getCanvasPos(e);
    // Add-node tools: place at click (clamped), but not on top of existing node
    if (tool.startsWith('add-')) {
      if (hitTest(pos.x, pos.y)) return;
      const type = tool.replace('add-', '');
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      const x = Math.max(50, Math.min(w - 50, pos.x)), y = Math.max(50, Math.min(h - 50, pos.y));
      const sensorTypes = ['temperature', 'humidity', 'pressure'];
      const st = type === 'sensor' ? sensorTypes[GraphStore.getNodes().filter(n => n.type === 'sensor').length % 3] : undefined;
      const n = GraphStore.addNode(type, x, y, st ? { sensorType: st } : {});
      if (n) { syncTopologyToEngines(); Inspector.openNode(n.id); }
      e.preventDefault();
      return;
    }
    const node = hitTest(pos.x, pos.y);
    const link = !node ? hitLink(pos.x, pos.y) : null;

    if (tool === 'link') {
      if (node) {
        if (!linkSource) {
          linkSource = node;
          const hint = document.getElementById('link-draft-hint');
          if (hint) hint.classList.add('show');
          try { CanvasEngine.setDraftLink({ x1: node.x, y1: node.y, x2: pos.x, y2: pos.y }); } catch (err) {}
        } else {
          if (linkSource.id !== node.id) {
            const r = GraphStore.addLink(linkSource.id, node.id);
            if (r.ok) { syncTopologyToEngines(); Inspector.openLink(r.link.id); }
          }
          linkSource = null;
          try { CanvasEngine.setDraftLink(null); } catch (err) {}
          const hint = document.getElementById('link-draft-hint');
          if (hint) hint.classList.remove('show');
        }
      }
      return;
    }
    if (tool === 'scissors') {
      // Prefer link cut; clicking a node with scissors does nothing
      const lk = link || (node ? null : null);
      const target = lk || hitLink(pos.x, pos.y);
      if (target) {
        const st = GraphStore.cycleLinkState(target.id); // up->flapping->down->up
        syncTopologyToEngines();
        try { ChaosEngine.onLinkStateChanged?.(target.id, st); } catch (err) {}
        try { if (st === 'down') SimEngine.killParticlesOnLink?.(target.id); } catch (err) {}
        Inspector.openLink(target.id);
      }
      return;
    }
    if (tool === 'delete') {
      if (node) { GraphStore.removeNode(node.id); syncTopologyToEngines(); Inspector.close(); }
      else if (link) { GraphStore.removeLink(link.id); syncTopologyToEngines(); Inspector.close(); }
      return;
    }
    // pointer: select + drag
    if (node) {
      dragging = node; offsetX = pos.x - node.x; offsetY = pos.y - node.y;
      node.highlighted = true; canvas.style.cursor = 'grabbing';
      try { CanvasEngine.setSelected('node', node.id); } catch (err) {}
      Inspector.openNode(node.id);
      try { CanvasEngine.renderNow(); } catch (err) {}
      e.preventDefault();
    } else if (link) {
      try { CanvasEngine.setSelected('link', link.id); } catch (err) {}
      Inspector.openLink(link.id);
      try { CanvasEngine.renderNow(); } catch (err) {}
    } else {
      try { CanvasEngine.setSelected(null, null); } catch (err) {}
      Inspector.close();
      try { CanvasEngine.renderNow(); } catch (err) {}
    }
  }

  function onPointerMove(e) {
    const pos = getCanvasPos(e);
    if (tool === 'link' && linkSource) {
      try { CanvasEngine.setDraftLink({ x1: linkSource.x, y1: linkSource.y, x2: pos.x, y2: pos.y }); } catch (err) {}
      try { CanvasEngine.renderNow(); } catch (err) {}
      return;
    }
    if (dragging) {
      dragging.x = pos.x - offsetX; dragging.y = pos.y - offsetY;
      const margin = 40;
      const w = canvas.offsetWidth || 800, h = canvas.offsetHeight || 600;
      dragging.x = Math.max(margin, Math.min(w - margin, dragging.x));
      dragging.y = Math.max(margin, Math.min(h - margin, dragging.y));
      updateStatusbar();
      // Repaint live while dragging even when sim is stopped
      try { CanvasEngine.renderNow(); } catch (err) {}
      return;
    }
    const hovered = hitTest(pos.x, pos.y);
    if (hovered !== hoveredNode) {
      if (hoveredNode) hoveredNode.highlighted = false;
      hoveredNode = hovered;
      if (hoveredNode) hoveredNode.highlighted = true;
    }
    const lk = !hovered ? hitLink(pos.x, pos.y) : null;
    canvas.style.cursor = (tool === 'scissors' && lk) ? 'crosshair' : hovered ? 'grab' : (lk ? 'pointer' : 'default');
  }
  function onPointerUp() {
    if (dragging) { dragging.highlighted = false; dragging = null; try { GraphStore.emit({ kind: 'move' }); } catch (e) {} }
    canvas.style.cursor = 'default';
  }
  function onTouchStart(e) { if (e.touches.length === 1) onPointerDown(e.touches[0]); }
  function onTouchMove(e) { if (e.touches.length === 1) { e.preventDefault(); onPointerMove(e.touches[0]); } }
  function onTouchEnd() { onPointerUp(); }
  function onKey(e) {
    if (e.key === 'Escape') {
      linkSource = null; try { CanvasEngine.setDraftLink(null); } catch (err) {}
      const hint = document.getElementById('link-draft-hint'); if (hint) hint.classList.remove('show');
      Inspector.close(); try { CanvasEngine.setSelected(null, null); } catch (err) {}
      if (tool !== 'pointer') setTool('pointer');
      try { CanvasEngine.renderNow(); } catch (err) {}
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement.tagName !== 'INPUT') {
      try {
        const sel = CanvasEngine.getSelected();
        if (sel.kind === 'node') { GraphStore.removeNode(sel.id); syncTopologyToEngines(); Inspector.close(); }
        else if (sel.kind === 'link') { GraphStore.removeLink(sel.id); syncTopologyToEngines(); Inspector.close(); }
      } catch (err) {}
    } else if (e.key === '1' || e.key === '2' || e.key === '3') {
      try { UIController.switchView(e.key === '1' ? 'studio' : e.key === '2' ? 'observability' : 'inspector'); } catch (err) {}
    } else if (e.key.toLowerCase() === 'v') setTool('pointer');
    else if (e.key.toLowerCase() === 'l') setTool('link');
    else if (e.key.toLowerCase() === 'x') setTool('scissors');
  }

  function updateStatusbar() {
    const sn = document.getElementById('status-nodes'), sl = document.getElementById('status-links');
    const st = document.getElementById('status-tool'), ss = document.getElementById('status-sel');
    try {
      if (sn) sn.textContent = `${GraphStore.getNodes().length} nodes`;
      if (sl) sl.textContent = `${GraphStore.getLinks().length} links`;
      if (st) st.textContent = `tool: ${tool}`;
      const sel = CanvasEngine.getSelected();
      if (ss) ss.textContent = `sel: ${sel.kind ? sel.kind + ':' + sel.id : '—'}`;
    } catch (e) {}
  }

  /** Push GraphStore -> Canvas/Gateway/SLA without restarting a run unless structure changed. */
  function syncTopologyToEngines() {
    try {
      const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
      CanvasEngine.setTopology(nodes, links);
      // Rebuild queues for gateway set (preserve active flags)
      const ids = nodes.filter(n => n.type === 'gateway').map(n => n.id);
      const prev = new Map();
      try { GatewayQueue.getAllQueues().forEach((q, id) => prev.set(id, { active: q.active })); } catch (e) {}
      GatewayQueue.clearAll();
      ids.forEach(id => {
        GatewayQueue.createQueue(id, 20);
        if (prev.get(id)?.active === false) GatewayQueue.killGateway(id);
      });
      GraphStore.recomputeOrphans();
      updateStatusbar();
      try { Inspector.refresh?.(); } catch (e) {}
      // Force immediate repaint even while sim is stopped (blank-canvas fix)
      try { CanvasEngine.renderNow(); } catch (e) {}
    } catch (e) { console.warn('[Drag] sync failed', e); }
  }

  return { bindEvents, hitTest, isDragging: () => dragging !== null, setTool, getTool, syncTopologyToEngines, updateStatusbar };
})();
