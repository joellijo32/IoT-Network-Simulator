/**
 * @module canvas
 * @author George S Thuruthippillil
 * @description Canvas Engine: High-DPI canvas setup, static node rendering (Sensors, Gateways,
 *              Server), connection link drawing with directional arrows, and scene management.
 *              Uses the 2D rendering context with devicePixelRatio scaling for crisp display
 *              on retina/high-DPI screens.
 */

const CanvasEngine = (() => {
  'use strict';

  let canvas = null;
  let ctx    = null;
  let dpr    = 1;
  let nodes  = [];
  let links  = [];

  // ─── Visual constants ────────────────────────────────────────────────────────

  const NODE_STYLES = {
    sensor: {
      fillColor:   '#1b5e20',
      strokeColor: '#4CAF50',
      glowColor:   '#66BB6A',
      textColor:   '#E8F5E9',
      radius:      26,
    },
    gateway: {
      fillColor:   '#e65100',
      strokeColor: '#FF9800',
      glowColor:   '#FFB74D',
      textColor:   '#FFF3E0',
      size:        32,  // hexagon circumradius
    },
    server: {
      fillColor:   '#0d47a1',
      strokeColor: '#2196F3',
      glowColor:   '#64B5F6',
      textColor:   '#E3F2FD',
      width:       70,
      height:      48,
      radius:      10, // border-radius
    },
  };

  const LINK_COLOR_ACTIVE   = 'rgba(0, 230, 255, 0.7)';
  const LINK_COLOR_INACTIVE = 'rgba(255,255,255,0.15)';
  const LINK_DASH           = [8, 4];

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Initialises the canvas element with high-DPI scaling.
   * @param {string} canvasId - DOM id of the <canvas> element
   */
  function init(canvasId) {
    canvas = document.getElementById(canvasId);
    ctx    = canvas.getContext('2d');
    dpr    = window.devicePixelRatio || 1;

    resize();
    window.addEventListener('resize', resize);
  }

  /**
   * Resizes the canvas to fill its container, accounting for device pixel ratio.
   */
  function resize() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ─── Scene data ──────────────────────────────────────────────────────────────

  /**
   * Updates the node and link data used by drawAll().
   * @param {Object[]} newNodes
   * @param {Array[]}  newLinks  - Array of [fromId, toId] pairs
   */
  function setTopology(newNodes, newLinks) {
    nodes = newNodes;
    links = newLinks;
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────────

  /**
   * Full scene repaint. Called on every animation frame.
   * @param {Object[]} particles - Active packet particles to draw
   */
  function drawAll(particles = []) {
    if (!ctx) return;

    const w = canvas.width  / dpr;
    const h = canvas.height / dpr;

    // Background
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);

    // Links (behind nodes)
    links.forEach(([fromId, toId]) => {
      const from = nodes.find(n => n.id === fromId);
      const to   = nodes.find(n => n.id === toId);
      if (from && to) drawLink(from, to);
    });

    // Particles (between nodes)
    particles.forEach(p => drawParticle(p));

    // Nodes (on top)
    nodes.forEach(node => drawNode(node));
  }

  /**
   * Draws the subtle dot-grid background.
   */
  function drawGrid(w, h) {
    const spacing = 40;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let x = 0; x < w; x += spacing) {
      for (let y = 0; y < h; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Dispatches node drawing based on its type.
   * @param {Object} node
   */
  function drawNode(node) {
    switch (node.type) {
      case 'sensor':  drawSensor(node);  break;
      case 'gateway': drawGateway(node); break;
      case 'server':  drawServer(node);  break;
    }
  }

  /**
   * Draws a Sensor node as a glowing circle.
   */
  function drawSensor(node) {
    const s = NODE_STYLES.sensor;
    const { x, y } = node;

    // Outer glow
    const grd = ctx.createRadialGradient(x, y, 4, x, y, s.radius + 10);
    grd.addColorStop(0, s.glowColor + '44');
    grd.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(x, y, s.radius + 10, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.arc(x, y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = s.fillColor;
    ctx.fill();
    ctx.strokeStyle = node.highlighted ? '#fff' : s.strokeColor;
    ctx.lineWidth = node.highlighted ? 3 : 2;
    ctx.stroke();

    // Icon + Label
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = s.textColor;
    ctx.fillText(node.icon || '📡', x, y - 4);

    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText(node.label, x, y + s.radius + 12);

    // Queue fill indicator (small bar below label)
    if (node.queueFill !== undefined) {
      drawMiniBar(x, y + s.radius + 22, 44, 4, node.queueFill / 100, '#FF9800');
    }
  }

  /**
   * Draws a Gateway node as a hexagon.
   */
  function drawGateway(node) {
    const s = NODE_STYLES.gateway;
    const { x, y } = node;
    const r = s.size;
    const isKilled = node.killed;

    // Glow
    if (!isKilled) {
      const grd = ctx.createRadialGradient(x, y, 4, x, y, r + 12);
      grd.addColorStop(0, s.glowColor + '33');
      grd.addColorStop(1, 'transparent');
      ctx.beginPath();
      hexagonPath(x, y, r + 12);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Hexagon body
    ctx.beginPath();
    hexagonPath(x, y, r);
    ctx.fillStyle   = isKilled ? '#212121' : s.fillColor;
    ctx.fill();
    ctx.strokeStyle = isKilled ? '#f44336' : (node.highlighted ? '#fff' : s.strokeColor);
    ctx.lineWidth   = isKilled ? 3 : 2;
    ctx.setLineDash(isKilled ? [4, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isKilled ? '#f44336' : s.textColor;
    ctx.fillText(isKilled ? '💀' : '⬡', x, y - 5);
    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = '#ccc';
    ctx.fillText(node.label, x, y + r + 12);

    // Buffer fill bar
    const fill = node.queueFill || 0;
    drawMiniBar(x, y + r + 22, 52, 5, fill / 100,
      fill > 80 ? '#f44336' : fill > 50 ? '#FF9800' : '#4CAF50');

    // Packet count badge
    if (node.queueCount !== undefined && node.queueCount > 0) {
      ctx.beginPath();
      ctx.arc(x + r - 4, y - r + 4, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#f44336';
      ctx.fill();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.queueCount, x + r - 4, y - r + 4);
    }
  }

  /**
   * Draws the Server/Cloud node as a rounded rectangle.
   */
  function drawServer(node) {
    const s = NODE_STYLES.server;
    const { x, y } = node;
    const hw = s.width  / 2;
    const hh = s.height / 2;

    // Glow
    ctx.shadowColor = s.glowColor;
    ctx.shadowBlur  = 20;

    // Rounded rect body
    ctx.beginPath();
    roundedRect(x - hw, y - hh, s.width, s.height, s.radius);
    ctx.fillStyle   = s.fillColor;
    ctx.fill();
    ctx.strokeStyle = node.highlighted ? '#fff' : s.strokeColor;
    ctx.lineWidth   = 2;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Icon + label
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = s.textColor;
    ctx.fillText('☁️', x, y - 6);
    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText(node.label, x, y + hh + 12);

    // Packets received counter
    if (node.received !== undefined) {
      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = '#64B5F6';
      ctx.fillText(`↓ ${node.received}`, x, y + 6);
    }
  }

  /**
   * Draws a directional link between two nodes.
   * @param {Object} from
   * @param {Object} to
   */
  function drawLink(from, to) {
    ctx.save();

    const dx    = to.x - from.x;
    const dy    = to.y - from.y;
    const angle = Math.atan2(dy, dx);
    const dist  = Math.sqrt(dx * dx + dy * dy);

    // Shorten so line ends at node edge
    const shrink = 32;
    const x1 = from.x + Math.cos(angle) * shrink;
    const y1 = from.y + Math.sin(angle) * shrink;
    const x2 = to.x   - Math.cos(angle) * shrink;
    const y2 = to.y   - Math.sin(angle) * shrink;

    if (dist < shrink * 2 + 10) { ctx.restore(); return; }

    // Line
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = LINK_COLOR_ACTIVE;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash(LINK_DASH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead
    const arrowLen = 10;
    const arrowAngle = 0.4;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrowLen * Math.cos(angle - arrowAngle),
               y2 - arrowLen * Math.sin(angle - arrowAngle));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - arrowLen * Math.cos(angle + arrowAngle),
               y2 - arrowLen * Math.sin(angle + arrowAngle));
    ctx.strokeStyle = LINK_COLOR_ACTIVE;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draws a single packet particle.
   * @param {Object} p - Particle object from ParticleEngine
   */
  function drawParticle(p) {
    ctx.save();
    ctx.globalAlpha = p.alpha || 1;

    // Glow halo
    const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 3);
    grd.addColorStop(0, p.color + 'cc');
    grd.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius * 3, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draws a small horizontal fill bar (used for queue indicators).
   */
  function drawMiniBar(cx, cy, width, height, fraction, color) {
    const x = cx - width / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, cy, width, height);
    ctx.fillStyle = color;
    ctx.fillRect(x, cy, width * Math.min(fraction, 1), height);
  }

  /**
   * Helper: traces a regular hexagon path centered at (cx, cy).
   */
  function hexagonPath(cx, cy, r) {
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * Helper: traces a rounded rectangle path.
   */
  function roundedRect(x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    init,
    resize,
    setTopology,
    drawAll,
    getCanvas:  () => canvas,
    getCtx:     () => ctx,
    getNodes:   () => nodes,
    getLinks:   () => links,
    NODE_STYLES,
  };
})();
