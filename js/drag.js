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

  function isTouchDevice(e) {
    if (e && e.pointerType === 'touch') return true;
    return ('ontouchstart' in window) || (window.innerWidth <= 768);
  }

  function updateInstructionTexts() {
    const badge = document.getElementById('canvas-badge');
    const isTouch = isTouchDevice();
    if (badge) {
      badge.textContent = isTouch
        ? 'Move: drag nodes · Link: tap source→target · Cut: tap link'
        : 'Move: drag nodes · Link: source→target · Cut: click link';
    }
    const hint = document.getElementById('link-draft-hint');
    if (hint && linkSource) {
      hint.textContent = isTouch
        ? 'Tap a target node to complete link — Esc cancels'
        : 'Click a target node to complete link — Esc cancels';
    }
  }

  function bindEvents(canvasEl) {
    canvas = canvasEl;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', updateInstructionTexts);
    window.addEventListener('keydown', onKey);

    document.querySelectorAll('#studio-toolbar .tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    setTool('pointer');
    updateInstructionTexts();
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
    updateInstructionTexts();
  }

  function getTool() { return tool; }

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
  }

  function hitTest(px, py, isTouch = false) {
    const nodes = CanvasEngine.getNodes();
    const pad = isTouch ? 14 : 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (isWithinNode(node, px, py, pad)) return node;
    }
    return null;
  }

  function isWithinNode(node, px, py, pad = 0) {
    const dx = px - node.x, dy = py - node.y;
    if (node.type === 'sensor') return (dx * dx + dy * dy) <= ((30 + pad) * (30 + pad));
    if (node.type === 'gateway') return (Math.abs(dx) + Math.abs(dy)) <= (44 + pad);
    if (node.type === 'server') return Math.abs(dx) <= (40 + pad) && Math.abs(dy) <= (30 + pad);
    return (dx * dx + dy * dy) <= ((28 + pad) * (28 + pad));
  }

  /** Distance point->segment for link hit-testing (increased tolerance on touch). */
  function hitLink(px, py, isTouch = false) {
    const nodes = CanvasEngine.getNodes(), links = CanvasEngine.getLinks();
    let best = null, bestD = isTouch ? 28 : 14;
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
    const isTouch = isTouchDevice(e);
    const pos = getCanvasPos(e);

    if (e.pointerId !== undefined && canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }

    // Add-node tools: place at pointer pos (clamped), but not on top of existing node
    if (tool.startsWith('add-')) {
      if (hitTest(pos.x, pos.y, isTouch)) return;
      const type = tool.replace('add-', '');
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      const x = Math.max(50, Math.min(w - 50, pos.x)), y = Math.max(50, Math.min(h - 50, pos.y));
      const sensorTypes = ['temperature', 'humidity', 'pressure'];
      const st = type === 'sensor' ? sensorTypes[GraphStore.getNodes().filter(n => n.type === 'sensor').length % 3] : undefined;
      const n = GraphStore.addNode(type, x, y, st ? { sensorType: st } : {});
      if (n) { syncTopologyToEngines(); Inspector.openNode(n.id); }
      if (e.cancelable) e.preventDefault();
      return;
    }

    const node = hitTest(pos.x, pos.y, isTouch);
    const link = !node ? hitLink(pos.x, pos.y, isTouch) : null;

    if (tool === 'link') {
      if (node) {
        if (!linkSource) {
          linkSource = node;
          const hint = document.getElementById('link-draft-hint');
          if (hint) {
            hint.classList.add('show');
            hint.textContent = isTouch ? 'Tap a target node to complete link — Esc cancels' : 'Click a target node to complete link — Esc cancels';
          }
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
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (tool === 'scissors') {
      const target = link || (node ? null : hitLink(pos.x, pos.y, isTouch));
      if (target) {
        const st = GraphStore.cycleLinkState(target.id); // up->flapping->down->up
        syncTopologyToEngines();
        try { ChaosEngine.onLinkStateChanged?.(target.id, st); } catch (err) {}
        try { if (st === 'down') SimEngine.killParticlesOnLink?.(target.id); } catch (err) {}
        Inspector.openLink(target.id);
      }
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (tool === 'delete') {
      if (node) { GraphStore.removeNode(node.id); syncTopologyToEngines(); Inspector.close(); }
      else if (link) { GraphStore.removeLink(link.id); syncTopologyToEngines(); Inspector.close(); }
      if (e.cancelable) e.preventDefault();
      return;
    }

    // Pointer mode: select + drag node
    if (node) {
      dragging = node; offsetX = pos.x - node.x; offsetY = pos.y - node.y;
      node.highlighted = true; canvas.style.cursor = 'grabbing';
      try { CanvasEngine.setSelected('node', node.id); } catch (err) {}
      Inspector.openNode(node.id);
      try { CanvasEngine.renderNow(); } catch (err) {}
      if (e.cancelable) e.preventDefault();
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
    const isTouch = isTouchDevice(e);
    const pos = getCanvasPos(e);
    if (tool === 'link' && linkSource) {
      try { CanvasEngine.setDraftLink({ x1: linkSource.x, y1: linkSource.y, x2: pos.x, y2: pos.y }); } catch (err) {}
      try { CanvasEngine.renderNow(); } catch (err) {}
      return;
    }
    if (dragging) {
      dragging.x = pos.x - offsetX; dragging.y = pos.y - offsetY;
      const margin = 30;
      const w = canvas.offsetWidth || 800, h = canvas.offsetHeight || 600;
      dragging.x = Math.max(margin, Math.min(w - margin, dragging.x));
      dragging.y = Math.max(margin, Math.min(h - margin, dragging.y));
      updateStatusbar();
      // Repaint live while dragging even when sim is stopped
      try { CanvasEngine.renderNow(); } catch (err) {}
      if (e.cancelable) e.preventDefault();
      return;
    }
    const hovered = hitTest(pos.x, pos.y, isTouch);
    if (hovered !== hoveredNode) {
      if (hoveredNode) hoveredNode.highlighted = false;
      hoveredNode = hovered;
      if (hoveredNode) hoveredNode.highlighted = true;
    }
    const lk = !hovered ? hitLink(pos.x, pos.y, isTouch) : null;
    canvas.style.cursor = (tool === 'scissors' && lk) ? 'crosshair' : hovered ? 'grab' : (lk ? 'pointer' : 'default');
  }

  function onPointerUp(e) {
    if (e && e.pointerId !== undefined && canvas.releasePointerCapture) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    if (dragging) { dragging.highlighted = false; dragging = null; try { GraphStore.emit({ kind: 'move' }); } catch (e) {} }
    canvas.style.cursor = 'default';
  }

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

  return { bindEvents, hitTest, isDragging: () => dragging !== null, setTool, getTool, syncTopologyToEngines, updateStatusbar, updateInstructionTexts };
})();
