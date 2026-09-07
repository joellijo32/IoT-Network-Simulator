/**
 * @module particles
 * @author Abhiram Ranjith
 * @description Particle Animation Loop: Implements the requestAnimationFrame rendering loop
 *              for smooth 60 FPS animated packet particles. Each packet is represented as a
 *              coloured dot that moves along a vector path from source to destination node.
 *              Status colours: Green = Delivered, Orange = Queued, Red = Dropped.
 */

const ParticleEngine = (() => {
  'use strict';

  let particles   = [];
  let animFrameId = null;
  let isRunning   = false;

  // Status → colour mapping
  const STATUS_COLORS = {
    'in-transit': '#29B6F6',  // Blue (travelling)
    'queued':     '#FF9800',  // Orange (in gateway buffer)
    'delivered':  '#4CAF50',  // Green (reached server)
    'dropped':    '#F44336',  // Red (packet lost)
  };

  const PARTICLE_RADIUS   = 5;
  const PARTICLE_SPEED    = 120; // Logical pixels per second at 1× speed
  let   speedMultiplier   = 1;

  let lastTimestamp = 0;

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Starts the animation loop.
   */
  function start() {
    if (isRunning) return;
    isRunning = true;
    lastTimestamp = performance.now();
    animFrameId = requestAnimationFrame(tick);
  }

  /**
   * Pauses the animation loop (preserves particles).
   */
  function pause() {
    isRunning = false;
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  /**
   * Clears all particles and stops the loop.
   */
  function reset() {
    pause();
    particles = [];
  }

  /**
   * Sets the global animation speed multiplier.
   * @param {number} mult - e.g. 0.5, 1, 2, 5
   */
  function setSpeed(mult) {
    speedMultiplier = mult;
  }

  // ─── Particle management ─────────────────────────────────────────────────────

  /**
   * Creates and enqueues a new animated particle.
   * @param {Object} fromNode - Source node { x, y }
   * @param {Object} toNode   - Target node { x, y }
   * @param {string} status   - 'in-transit' | 'queued' | 'delivered' | 'dropped'
   * @param {Object} [packetMeta] - Optional packet metadata (id, sensorType, value)
   */
  function createParticle(fromNode, toNode, status, packetMeta = {}) {
    const dx   = toNode.x - fromNode.x;
    const dy   = toNode.y - fromNode.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    particles.push({
      x:        fromNode.x,
      y:        fromNode.y,
      startX:   fromNode.x,
      startY:   fromNode.y,
      endX:     toNode.x,
      endY:     toNode.y,
      dx,
      dy,
      dist,
      progress: 0,          // 0 → 1
      speed:    PARTICLE_SPEED,
      color:    STATUS_COLORS[status] || STATUS_COLORS['in-transit'],
      status,
      radius:   PARTICLE_RADIUS,
      alpha:    1,
      meta:     packetMeta,
      done:     false,
    });
  }

  /**
   * Creates a "drop burst" effect at a given position (stationary red flash).
   * @param {number} x
   * @param {number} y
   */
  function createDropBurst(x, y) {
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 * i) / 5;
      const r = 18 + Math.random() * 10;
      particles.push({
        x, y,
        startX: x, startY: y,
        endX:   x + Math.cos(angle) * r,
        endY:   y + Math.sin(angle) * r,
        dx: Math.cos(angle) * r, dy: Math.sin(angle) * r,
        dist: r,
        progress: 0,
        speed: PARTICLE_SPEED * 2,
        color: '#F44336',
        status: 'dropped',
        radius: 3,
        alpha: 1,
        meta: {},
        done: false,
        burst: true,
      });
    }
  }

  // ─── Animation tick ──────────────────────────────────────────────────────────

  /**
   * The main animation loop tick. Called by requestAnimationFrame.
   * @param {DOMHighResTimeStamp} timestamp
   */
  function tick(timestamp) {
    if (!isRunning) return;

    const delta = (timestamp - lastTimestamp) / 1000; // seconds
    lastTimestamp = timestamp;

    // Advance particles
    particles.forEach(p => {
      if (p.done) return;

      p.progress += (p.speed * speedMultiplier * delta) / p.dist;

      if (p.progress >= 1) {
        p.progress = 1;
        p.done = true;
        p.alpha = 1;
      }

      // Fade out burst particles as they expand
      if (p.burst) {
        p.alpha = 1 - p.progress;
      }

      p.x = p.startX + p.dx * p.progress;
      p.y = p.startY + p.dy * p.progress;
    });

    // Remove completed non-burst particles (keep briefly for visibility)
    particles = particles.filter(p => !(p.done && (p.burst || p.progress >= 1)));

    // Trigger canvas redraw with current particle list
    CanvasEngine.drawAll(particles);

    // Schedule next frame
    animFrameId = requestAnimationFrame(tick);
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    start,
    pause,
    reset,
    setSpeed,
    createParticle,
    createDropBurst,
    getParticles:     () => particles,
    STATUS_COLORS,
  };
})();
