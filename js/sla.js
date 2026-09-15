/**
 * @module sla
 * @description Availability integrals (M3). availability = (nominal + 0.5*degraded)/elapsed*100.
 *              Clock runs on sim ticks only (frozen while paused). Session-only, reset wipes.
 *              States: up | degraded (flapping link path / low-power) | down.
 */

const SLAEngine = (() => {
  'use strict';

  const nodes = new Map(); // id -> {nominal, degraded, down, incidents, lastDownStart, state, mttrSamples}
  let elapsedTicks = 0;
  let tickMs = 800;
  let running = false;

  function ensure(id) {
    if (!nodes.has(id)) nodes.set(id, { nominal: 0, degraded: 0, down: 0, incidents: 0, lastDownStart: null, state: 'up', mttrSamples: [] });
    return nodes.get(id);
  }
  function setTickMs(ms) { tickMs = ms; }
  function start() { running = true; }
  function pause() { running = false; }
  function reset() { nodes.clear(); elapsedTicks = 0; running = false; }
  function removeNode(id) { nodes.delete(id); }

  /** Derive node state from graph + battery + kill flags. Called once per tick per node. */
  function deriveState(node, links) {
    if (!node) return 'up';
    if (node.type === 'server') return 'up';
    if (node.dead) return 'down';
    if (node.killed) return 'down';
    if (node.type === 'sensor' && node.orphan) return 'down';
    // Link-based: if all out-links down -> down; any flapping -> degraded
    const outs = links.filter(l => l.source === node.id);
    if (outs.length && outs.every(l => l.state === 'down')) return 'down';
    if (outs.some(l => l.state === 'flapping')) return 'degraded';
    if (node.lowPower) return 'degraded';
    return 'up';
  }

  /** Advance one tick for a set of nodes. Must be called only while running (not paused). */
  function tick(nodeList, linkList) {
    if (!running) return;
    elapsedTicks++;
    nodeList.forEach(n => {
      const s = ensure(n.id);
      const next = deriveState(n, linkList);
      if (s.state !== next) {
        if (next === 'down' && s.state !== 'down') { s.incidents++; s.lastDownStart = elapsedTicks; }
        if (s.state === 'down' && next !== 'down' && s.lastDownStart !== null) {
          s.mttrSamples.push((elapsedTicks - s.lastDownStart) * tickMs / 1000);
          if (s.mttrSamples.length > 50) s.mttrSamples.shift();
          s.lastDownStart = null;
        }
        s.state = next;
      }
      if (next === 'up') s.nominal++;
      else if (next === 'degraded') s.degraded++;
      else s.down++;
      n.slaState = next;
    });
  }

  function stats(id) {
    const s = ensure(id);
    const total = s.nominal + s.degraded + s.down;
    const avail = total ? ((s.nominal + 0.5 * s.degraded) / total) * 100 : 100;
    const downtimeS = (s.down * tickMs) / 1000;
    const mttr = s.mttrSamples.length ? s.mttrSamples.reduce((a, b) => a + b, 0) / s.mttrSamples.length : 0;
    return { availability: avail, downtimeS, incidents: s.incidents, mttr, state: s.state, ticks: total };
  }
  function systemAvailability(nodeList) {
    const ids = nodeList.filter(n => n.type !== 'server').map(n => n.id);
    if (!ids.length) return 100;
    return ids.reduce((a, id) => a + stats(id).availability, 0) / ids.length;
  }
  function activeCount(nodeList) {
    const up = nodeList.filter(n => (n.slaState || 'up') === 'up').length;
    return { up, total: nodeList.length };
  }

  return {
    setTickMs, start, pause, reset, removeNode, tick, stats, systemAvailability, activeCount,
    getElapsedTicks: () => elapsedTicks,
  };
})();
