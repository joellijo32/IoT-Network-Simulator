/**
 * @module canvas
 * @description Canvas Engine M2/M3: HiDPI setup, node rendering (sensor/
 *              gateway/server), link states (up/flapping/down with severed style),
 *              congestion thickening, battery glyphs + status LEDs. Numbers/queue
 *              bars stripped to Inspector Drawer — canvas keeps labels + LEDs only.
 */

const CanvasEngine = (() => {
  'use strict';

  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let nodes = [];
  let links = []; // [{id,source,target,state,...}] or legacy [a,b]
  let selected = { kind: null, id: null };
  let draftLink = null; // {x1,y1,x2,y2}
  let pulseT = 0;

  const NODE_STYLES = {
    sensor: { fillColor: '#1b5e20', strokeColor: '#4CAF50', glowColor: '#66BB6A', textColor: '#E8F5E9', radius: 24 },
    gateway: { fillColor: '#e65100', strokeColor: '#FF9800', glowColor: '#FFB74D', textColor: '#FFF3E0', size: 30 },
    server: { fillColor: '#0d47a1', strokeColor: '#2196F3', glowColor: '#64B5F6', textColor: '#E3F2FD', width: 70, height: 48, radius: 10 },
  };

  function init(canvasId) {
    canvas = document.getElementById(canvasId);
    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;
    resize();
    window.addEventListener('resize', resize);
  }
  function resize() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function setTopology(newNodes, newLinks) { nodes = newNodes; links = newLinks; pulseT = 0; }
  function setSelected(kind, id) { selected = { kind, id }; }
  function getSelected() { return { ...selected }; }
  function setDraftLink(d) { draftLink = d; }

  function linkEndpoints(l) {
    const a = Array.isArray(l) ? l[0] : l.source;
    const b = Array.isArray(l) ? l[1] : l.target;
    return { a, b, state: Array.isArray(l) ? 'up' : (l.state || 'up'), link: l };
  }

  function drawAll(particles) {
    if (!ctx) return;
    // Fall back to live particle list when omitted (safe if particles.js not loaded yet)
    const pkts = particles !== undefined
      ? particles
      : (typeof ParticleEngine !== 'undefined' ? ParticleEngine.getParticles() : []);
    pulseT += 0.05;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);
    links.forEach(l => {
      const { a, b } = linkEndpoints(l);
      const from = nodes.find(n => n.id === a), to = nodes.find(n => n.id === b);
      if (from && to) drawLink(from, to, l);
    });
    pkts.forEach(p => drawParticle(p));
    nodes.forEach(node => drawNode(node));
    if (draftLink) drawDraftLink();
  }

  /**
   * Synchronous one-frame repaint for when the RAF loop is paused
   * (boot, stopped edits, tab switches). Never starts the loop.
   */
  function renderNow() {
    if (!ctx || !canvas) return;
    // Guard zero-size (hidden tab / pre-layout): re-measure first
    try {
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 &&
          (Math.abs(canvas.offsetWidth - rect.width) > 1 || Math.abs(canvas.offsetHeight - rect.height) > 1)) {
        resize();
      }
    } catch (e) { /* ignore */ }
    drawAll();
  }

  function drawGrid(w, h) {
    const spacing = 40;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let x = 0; x < w; x += spacing) for (let y = 0; y < h; y += spacing) {
      ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawNode(node) {
    if (node.type === 'sensor') drawSensor(node);
    else if (node.type === 'gateway') drawGateway(node);
    else if (node.type === 'server') drawServer(node);
    else if (node.type === 'router') drawGateway({ ...node, type: 'gateway' }); // stale pre-migration node
    else drawSensor(node);
  }

  /** Status LED color: green nominal, amber degraded/low-power/flapping/orphan, red down/dead/killed, grey no-route. */
  function ledColor(node) {
    if (node.dead) return '#9AA6BC';
    if (node.killed) return '#F44336';
    if (node.orphan) return '#FFB300';
    if (node.slaState === 'down') return '#F44336';
    if (node.slaState === 'degraded' || node.lowPower) return '#FFB300';
    return '#4CAF50';
  }
  function drawLED(x, y, color, isSel) {
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.strokeStyle = isSel ? '#fff' : 'rgba(0,0,0,0.6)'; ctx.stroke();
  }

  function drawSensor(node) {
    const s = NODE_STYLES.sensor, { x, y } = node;
    const dead = !!node.dead, low = !!node.lowPower;
    const pulse = node.queueCongested ? (Math.sin(pulseT * 4) * 0.5 + 0.5) : 0;
    if (!dead) {
      const grd = ctx.createRadialGradient(x, y, 4, x, y, s.radius + 10 + pulse * 6);
      grd.addColorStop(0, (low ? '#FFB300' : s.glowColor) + '44');
      grd.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(x, y, s.radius + 10 + pulse * 6, 0, Math.PI * 2);
      ctx.fillStyle = grd; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = dead ? '#2a3140' : low ? '#4a3a00' : s.fillColor; ctx.fill();
    const isSel = selected.kind === 'node' && selected.id === node.id;
    ctx.strokeStyle = dead ? '#9AA6BC' : node.orphan ? '#FFB300' : (node.highlighted || isSel) ? '#fff' : s.strokeColor;
    ctx.lineWidth = (node.highlighted || isSel) ? 3 : 2;
    if (node.orphan && !dead) ctx.setLineDash([4, 3]);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '14px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = dead ? '#9AA6BC' : s.textColor;
    ctx.fillText(dead ? '✕' : (node.icon || '📡'), x, y - 4);
    ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#9AA6BC';
    ctx.fillText(node.label, x, y + s.radius + 12);
    // Status LED (top-right of node)
    drawLED(x + s.radius - 2, y - s.radius + 2, ledColor(node), isSel);
    // Miniature vertical battery glyph adjacent (sensors only)
    if (node.type === 'sensor') drawBatteryGlyph(x - s.radius - 12, y - 14, node.battery);
    if (node.orphan && !dead) {
      ctx.font = 'bold 8px monospace'; ctx.fillStyle = '#FFB300';
      ctx.fillText('NO ROUTE', x, y + s.radius + 22);
    }
  }

  function drawBatteryGlyph(x, y, pct) {
    const w = 8, h = 28;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#9AA6BC';
    ctx.fillRect(x + 2, y - 3, w - 4, 2); // cap
    const p = Math.max(0, Math.min(100, pct === Infinity ? 100 : pct)) / 100;
    const color = pct >= 50 ? '#4CAF50' : pct >= 15 ? '#FFB300' : '#F44336';
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + h * (1 - p) + 1, w - 2, h * p - 2);
  }

  function drawGateway(node) {
    const s = NODE_STYLES.gateway, { x, y } = node, r = s.size;
    const isKilled = node.killed;
    const congested = (node.queueFill || 0) >= 80;
    const pulse = congested && !isKilled ? (Math.sin(pulseT * 5) * 0.5 + 0.5) : 0;
    if (!isKilled) {
      const grd = ctx.createRadialGradient(x, y, 4, x, y, r + 12 + pulse * 8);
      grd.addColorStop(0, (congested ? '#F44336' : s.glowColor) + '44');
      grd.addColorStop(1, 'transparent');
      ctx.beginPath(); hexagonPath(x, y, r + 12 + pulse * 8); ctx.fillStyle = grd; ctx.fill();
    }
    ctx.beginPath(); hexagonPath(x, y, r);
    ctx.fillStyle = isKilled ? '#212121' : congested ? '#7a2d00' : s.fillColor; ctx.fill();
    const isSel = selected.kind === 'node' && selected.id === node.id;
    ctx.strokeStyle = isKilled ? '#F44336' : (node.highlighted || isSel) ? '#fff' : congested ? '#F44336' : s.strokeColor;
    ctx.lineWidth = isKilled ? 3 : 2;
    ctx.setLineDash(isKilled ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isKilled ? '#F44336' : s.textColor;
    ctx.fillText(isKilled ? '💀' : '⬡', x, y - 5);
    ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#9AA6BC';
    ctx.fillText(node.label, x, y + r + 12);
    drawLED(x + r - 2, y - r + 2, ledColor(node), isSel);
  }

  function drawServer(node) {
    const s = NODE_STYLES.server, { x, y } = node, hw = s.width / 2, hh = s.height / 2;
    const isSel = selected.kind === 'node' && selected.id === node.id;
    ctx.shadowColor = s.glowColor; ctx.shadowBlur = 18;
    ctx.beginPath(); roundedRect(x - hw, y - hh, s.width, s.height, s.radius);
    ctx.fillStyle = s.fillColor; ctx.fill();
    ctx.strokeStyle = node.highlighted || isSel ? '#fff' : s.strokeColor; ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = '16px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = s.textColor; ctx.fillText('☁️', x, y - 6);
    ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#9AA6BC';
    ctx.fillText(node.label, x, y + hh + 12);
    drawLED(x + hw - 2, y - hh + 2, ledColor(node), isSel);
  }

  function drawLink(from, to, raw) {
    const { state, link } = linkEndpoints(raw);
    const linkId = Array.isArray(raw) ? null : raw.id;
    const isSel = selected.kind === 'link' && selected.id === linkId;
    ctx.save();
    const dx = to.x - from.x, dy = to.y - from.y;
    const angle = Math.atan2(dy, dx), dist = Math.sqrt(dx * dx + dy * dy);
    const shrink = 30;
    const x1 = from.x + Math.cos(angle) * shrink, y1 = from.y + Math.sin(angle) * shrink;
    const x2 = to.x - Math.cos(angle) * shrink, y2 = to.y - Math.sin(angle) * shrink;
    if (dist < shrink * 2 + 10) { ctx.restore(); return; }

    if (state === 'down') {
      // Jagged severed red dashed line with × marker
      ctx.beginPath(); ctx.moveTo(x1, y1);
      const segs = 7;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs, mx = x1 + (x2 - x1) * t, my = y1 + (y2 - y1) * t;
        const off = (i % 2 === 0 ? 5 : -5) * (i === segs ? 0 : 1);
        ctx.lineTo(mx + -Math.sin(angle) * off, my + Math.cos(angle) * off);
      }
      ctx.strokeStyle = isSel ? '#fff' : 'rgba(244,67,54,0.9)';
      ctx.lineWidth = isSel ? 3 : 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#2a0e0e'; ctx.fill();
      ctx.strokeStyle = '#F44336'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#F44336'; ctx.fillText('×', mx, my);
    } else if (state === 'flapping') {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = isSel ? '#fff' : 'rgba(255,179,0,0.85)';
      ctx.lineWidth = isSel ? 3 : 2; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
      drawArrow(x2, y2, angle, isSel ? '#fff' : 'rgba(255,179,0,0.9)');
    } else {
      // UP: congestion thickening — caller sets from._congestion via updateGatewayVisuals
      const cong = from._congestion || 0;
      const wdt = isSel ? 3 : cong >= 100 ? 4 : cong >= 80 ? 3 : 1.5;
      const col = isSel ? '#fff' : cong >= 100 ? 'rgba(244,67,54,0.9)' : cong >= 80 ? 'rgba(255,179,0,0.9)' : 'rgba(0,229,255,0.7)';
      const pulse = cong >= 80 ? (Math.sin(pulseT * 5) * 0.5 + 0.5) : 0;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = col; ctx.lineWidth = wdt + pulse;
      ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]);
      drawArrow(x2, y2, angle, col);
    }
    // Make wide invisible hit-path? Hit-testing done geometrically in drag.js; nothing to draw.
    ctx.restore();
  }
  function drawArrow(x2, y2, angle, color) {
    const arrowLen = 10, aa = 0.4;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrowLen * Math.cos(angle - aa), y2 - arrowLen * Math.sin(angle - aa));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrowLen * Math.cos(angle + aa), y2 - arrowLen * Math.sin(angle + aa));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }
  function drawDraftLink() {
    if (!draftLink) return;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(draftLink.x1, draftLink.y1); ctx.lineTo(draftLink.x2, draftLink.y2);
    ctx.strokeStyle = '#00E5FF'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(draftLink.x2, draftLink.y2, 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#00E5FF'; ctx.stroke();
    ctx.restore();
  }

  function drawParticle(p) {
    ctx.save();
    ctx.globalAlpha = (p.alpha !== undefined ? p.alpha : 1) * (p.lowPower ? 0.4 : 1);
    const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 3);
    grd.addColorStop(0, p.color + 'cc'); grd.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * 3, 0, Math.PI * 2);
    ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = p.color; ctx.fill();
    // CON outline ring for critical alarms
    if (p.coapType === 'CON') {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#FFB300'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  }

  function hexagonPath(cx, cy, r) {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  function diamondPath(cx, cy, r) {
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
  }
  function roundedRect(x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  return {
    init, resize, setTopology, drawAll, renderNow,
    setSelected, getSelected, setDraftLink,
    getCanvas: () => canvas, getCtx: () => ctx,
    getNodes: () => nodes, getLinks: () => links,
    NODE_STYLES,
  };
})();
