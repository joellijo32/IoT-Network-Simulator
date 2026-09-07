/**
 * @module drag
 * @author Naveen S
 * @description Drag-and-Drop & Interactivity: Mouse and touch event listeners for dragging
 *              nodes around the canvas and dynamically redrawing connection links as nodes move.
 *              Supports both desktop (mousedown/mousemove/mouseup) and touch devices
 *              (touchstart/touchmove/touchend).
 */

const DragEngine = (() => {
  'use strict';

  let dragging  = null;  // Currently dragged node object
  let offsetX   = 0;
  let offsetY   = 0;
  let canvas    = null;
  let hoveredNode = null;

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Binds all mouse and touch events to the canvas element.
   * @param {HTMLCanvasElement} canvasEl
   */
  function bindEvents(canvasEl) {
    canvas = canvasEl;

    // Mouse
    canvas.addEventListener('mousedown',  onPointerDown);
    canvas.addEventListener('mousemove',  onPointerMove);
    canvas.addEventListener('mouseup',    onPointerUp);
    canvas.addEventListener('mouseleave', onPointerUp);

    // Touch
    canvas.addEventListener('touchstart',  onTouchStart,  { passive: true });
    canvas.addEventListener('touchmove',   onTouchMove,   { passive: false });
    canvas.addEventListener('touchend',    onTouchEnd,    { passive: true });
  }

  // ─── Coordinate helpers ───────────────────────────────────────────────────────

  /**
   * Converts a mouse/touch event's client coordinates to canvas-logical coordinates.
   * @param {MouseEvent|Touch} e
   * @returns {{ x: number, y: number }}
   */
  function getCanvasPos(e) {
    const rect  = canvas.getBoundingClientRect();
    const dpr   = window.devicePixelRatio || 1;
    // CSS coords (already divided by dpr because getBoundingClientRect is in CSS px)
    return {
      x: (e.clientX - rect.left),
      y: (e.clientY - rect.top),
    };
  }

  // ─── Hit-testing ─────────────────────────────────────────────────────────────

  /**
   * Returns the node that contains the point (px, py), or null.
   * @param {number} px
   * @param {number} py
   * @returns {Object|null}
   */
  function hitTest(px, py) {
    const nodes = CanvasEngine.getNodes();
    // Iterate in reverse so top-drawn nodes are hit first
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (isWithinNode(node, px, py)) return node;
    }
    return null;
  }

  /**
   * Checks if a point is within the clickable area of a node.
   * @param {Object} node
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  function isWithinNode(node, px, py) {
    const dx = px - node.x;
    const dy = py - node.y;

    switch (node.type) {
      case 'sensor':
        return (dx * dx + dy * dy) <= (30 * 30);
      case 'gateway':
        return (Math.abs(dx) + Math.abs(dy)) <= 44; // Diamond approximation for hexagon
      case 'server':
        return Math.abs(dx) <= 40 && Math.abs(dy) <= 30;
      default:
        return (dx * dx + dy * dy) <= (28 * 28);
    }
  }

  // ─── Mouse handlers ───────────────────────────────────────────────────────────

  function onPointerDown(e) {
    const pos  = getCanvasPos(e);
    const node = hitTest(pos.x, pos.y);

    if (node) {
      dragging       = node;
      offsetX        = pos.x - node.x;
      offsetY        = pos.y - node.y;
      node.highlighted = true;
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  }

  function onPointerMove(e) {
    const pos = getCanvasPos(e);

    if (dragging) {
      dragging.x = pos.x - offsetX;
      dragging.y = pos.y - offsetY;

      // Clamp to canvas bounds
      const margin = 40;
      const w = parseInt(canvas.style.width)  || canvas.offsetWidth;
      const h = parseInt(canvas.style.height) || canvas.offsetHeight;
      dragging.x = Math.max(margin, Math.min(w - margin, dragging.x));
      dragging.y = Math.max(margin, Math.min(h - margin, dragging.y));

      return; // Particle engine will redraw on next frame
    }

    // Update hover state
    const hovered = hitTest(pos.x, pos.y);
    if (hovered !== hoveredNode) {
      if (hoveredNode) hoveredNode.highlighted = false;
      hoveredNode = hovered;
      if (hoveredNode) hoveredNode.highlighted = true;
    }
    canvas.style.cursor = hovered ? 'grab' : 'default';
  }

  function onPointerUp() {
    if (dragging) {
      dragging.highlighted = false;
      dragging = null;
    }
    canvas.style.cursor = hoveredNode ? 'grab' : 'default';
  }

  // ─── Touch handlers ───────────────────────────────────────────────────────────

  function onTouchStart(e) {
    if (e.touches.length === 1) {
      onPointerDown(e.touches[0]);
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 1) {
      e.preventDefault();
      onPointerMove(e.touches[0]);
    }
  }

  function onTouchEnd() {
    onPointerUp();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    bindEvents,
    hitTest,
    isDragging: () => dragging !== null,
  };
})();
