/**
 * @module graph
 * @description Editable topology graph. Adjacency-list model with validation,
 *              auto IP/MAC addressing, 25-node / 40-link caps, localStorage autosave.
 *              Node: {id,label,type: sensor|gateway|server,...}
 *              Link: {id,source,target,state:up|flapping|down,...}
 *              Allowed: sensor->gateway, gateway->server. Legacy router nodes
 *              auto-migrate to gateways on ingest (schema v1).
 */

const GraphStore = (() => {
  'use strict';

  const MAX_NODES = 25;
  const MAX_LINKS = 40;
  const LS_KEY = 'iot-sim-topology-v1';

  const SENSOR_ICONS = { temperature: '🌡️', humidity: '💧', pressure: '🔵' };
  const TYPE_META = {
    sensor: { prefix: 's', buffer: 0 },
    gateway: { prefix: 'g', buffer: 20 },
    server: { prefix: 'sv', buffer: 0 },
  };

  let nodes = []; // array of node objects (canvas order)
  let links = []; // array of {id,source,target,state,...}
  let linkSeq = 0;
  let listeners = [];

  function onChange(fn) { listeners.push(fn); }
  function emit(what) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(exportJSON())); } catch (e) { /* private mode */ }
    listeners.forEach(fn => { try { fn(what); } catch (e) { console.warn(e); } });
  }

  function _usedIps() { return new Set(nodes.map(n => n.ip)); }
  function allocIp() {
    const used = _usedIps();
    for (let i = 10; i <= 254; i++) { const ip = `192.168.1.${i}`; if (!used.has(ip)) return ip; }
    return '192.168.1.254';
  }
  function allocMac() {
    const used = new Set(nodes.map(n => n.mac));
    for (let i = 1; i <= 254; i++) {
      const mac = `02:00:00:00:00:${i.toString(16).padStart(2, '0')}`;
      if (!used.has(mac)) return mac;
    }
    return '02:00:00:00:00:ff';
  }
  function ipv6For(ip, id) {
    const tail = (ip || '192.168.1.10').split('.').pop() || '10';
    const h = id.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'node';
    return `fd00::${tail}:${h}`;
  }
  function nextId(type) {
    const prefix = (TYPE_META[type] || {}).prefix || 'n';
    let i = 1;
    const ids = new Set(nodes.map(n => n.id));
    while (ids.has(prefix === 'sv' ? `sv${i === 1 ? '' : i}` : `${prefix}${i}`)) i++;
    return prefix === 'sv' ? `sv${i === 1 ? '' : i}` : `${prefix}${i}`;
  }

  function canLink(srcType, dstType) {
    if (srcType === 'sensor') return dstType === 'gateway';
    if (srcType === 'gateway') return dstType === 'server';
    return false;
  }
  function validateLink(srcId, dstId) {
    const src = nodes.find(n => n.id === srcId);
    const dst = nodes.find(n => n.id === dstId);
    if (!src || !dst) return { ok: false, reason: 'Unknown endpoint' };
    if (srcId === dstId) return { ok: false, reason: 'Cannot link node to itself' };
    if (!canLink(src.type, dst.type)) return { ok: false, reason: `${src.type} → ${dst.type} not allowed` };
    if (links.some(l => l.source === srcId && l.target === dstId)) return { ok: false, reason: 'Link already exists' };
    if (links.length >= MAX_LINKS) return { ok: false, reason: `Link cap ${MAX_LINKS} reached` };
    return { ok: true };
  }

  function addNode(type, x, y, opts = {}) {
    if (nodes.length >= MAX_NODES) { Terminal.log(`⚠️ Node cap ${MAX_NODES} reached`, 'warn'); return null; }
    if (!TYPE_META[type]) return null;
    const id = opts.id || nextId(type);
    const ip = opts.ip || allocIp();
    const mac = opts.mac || allocMac();
    const node = {
      id, type,
      label: opts.label || (type === 'sensor' ? `Sensor-${id.toUpperCase()}` : type === 'gateway' ? `GW-${id.toUpperCase()}` : 'Cloud Server'),
      sensorType: opts.sensorType || (type === 'sensor' ? 'temperature' : undefined),
      ip, mac, ipv6: ipv6For(ip, id),
      x: Math.round(x), y: Math.round(y),
      icon: type === 'sensor' ? (SENSOR_ICONS[opts.sensorType || 'temperature'] || '📡') : undefined,
      battery: type === 'sensor' ? 100 : Infinity,
      lowPower: false, dead: false,
      killed: false, queueFill: 0, queueCount: 0,
      received: type === 'server' ? 0 : undefined,
      orphan: false,
    };
    nodes.push(node);
    emit({ kind: 'add-node', id });
    return node;
  }

  function removeNode(id) {
    const n = nodes.find(x => x.id === id);
    if (!n) return false;
    if (n.type === 'server' && nodes.filter(x => x.type === 'server').length === 1) {
      Terminal.log('⚠️ Cannot delete the last server', 'warn');
      return false;
    }
    nodes = nodes.filter(x => x.id !== id);
    const cut = links.filter(l => l.source === id || l.target === id).length;
    links = links.filter(l => l.source !== id && l.target !== id);
    recomputeOrphans();
    try { GatewayQueue.removeQueue?.(id); } catch (e) {}
    try { BatteryEngine?.resetNode?.(id); } catch (e) {}
    try { SLAEngine?.removeNode?.(id); } catch (e) {}
    emit({ kind: 'remove-node', id, cut });
    Terminal.log(`🗑 Removed node ${id} (+${cut} links)`, 'info');
    return true;
  }

  function addLink(srcId, dstId, opts = {}) {
    const v = validateLink(srcId, dstId);
    if (!v.ok) { Terminal.log(`⚠️ Link rejected: ${v.reason}`, 'warn'); return { ok: false, reason: v.reason }; }
    const link = {
      id: opts.id || `l${++linkSeq}`,
      source: srcId, target: dstId,
      state: opts.state || 'up',
      bandwidthKbps: opts.bandwidthKbps || 250,
      latencyMs: opts.latencyMs ?? null,
      lossRate: opts.lossRate ?? null,
    };
    links.push(link);
    recomputeOrphans();
    emit({ kind: 'add-link', id: link.id });
    return { ok: true, link };
  }

  function removeLink(id) {
    const before = links.length;
    links = links.filter(l => l.id !== id);
    if (links.length !== before) { recomputeOrphans(); emit({ kind: 'remove-link', id }); return true; }
    return false;
  }
  function removeLinkByEndpoints(a, b) {
    const l = links.find(x => (x.source === a && x.target === b) || (x.source === b && x.target === a));
    return l ? removeLink(l.id) : false;
  }
  function setLinkState(id, state) {
    const l = links.find(x => x.id === id);
    if (!l || !['up', 'flapping', 'down'].includes(state)) return false;
    l.state = state;
    recomputeOrphans();
    emit({ kind: 'link-state', id, state });
    return true;
  }
  function cycleLinkState(id) {
    const l = links.find(x => x.id === id);
    if (!l) return null;
    l.state = l.state === 'up' ? 'flapping' : l.state === 'flapping' ? 'down' : 'up';
    recomputeOrphans();
    emit({ kind: 'link-state', id, state: l.state });
    return l.state;
  }
  function findLink(a, b) { return links.find(l => l.source === a && l.target === b) || null; }

  /** Sensors with no UP-path to a gateway/server are orphaned (amber, NO_ROUTE). */
  function recomputeOrphans() {
    const upAdj = new Map();
    links.filter(l => l.state !== 'down').forEach(l => {
      if (!upAdj.has(l.source)) upAdj.set(l.source, []);
      upAdj.get(l.source).push(l.target);
    });
    const canReach = (startId) => {
      const seen = new Set([startId]);
      const q = [startId];
      while (q.length) {
        const cur = q.shift();
        const curNode = nodes.find(n => n.id === cur);
        if (curNode && (curNode.type === 'gateway' || curNode.type === 'server') && cur !== startId) return true;
        // gateway itself with server edge counts
        if (curNode && curNode.type === 'gateway' && cur === startId) {
          const outs = upAdj.get(cur) || [];
          if (outs.some(t => (nodes.find(n => n.id === t) || {}).type === 'server')) return true;
        }
        (upAdj.get(cur) || []).forEach(t => { if (!seen.has(t)) { seen.add(t); q.push(t); } });
      }
      // A gateway with a direct up-link to server is not orphan
      const self = nodes.find(n => n.id === startId);
      if (self && self.type === 'gateway') {
        return (upAdj.get(startId) || []).some(t => (nodes.find(n => n.id === t) || {}).type === 'server');
      }
      if (self && self.type === 'server') return true;
      return false;
    };
    nodes.forEach(n => {
      n.orphan = n.type === 'sensor' ? !canReach(n.id) : false;
    });
  }

  function setTopology(newNodes, newLinks) {
    // Schema migration: legacy router nodes silently upgrade to gateways (keep IDs/links).
    let migrated = 0;
    nodes = newNodes.map(n => {
      if (n.type !== 'router') return { ...n };
      migrated++;
      const c = { ...n, type: 'gateway' };
      if (typeof c.label === 'string') c.label = c.label.replace(/^Router-/i, 'GW-');
      delete c.icon;
      return c;
    });
    // Normalize links: accept [a,b] pairs or objects
    links = (newLinks || []).map((l, i) => Array.isArray(l)
      ? { id: `l${i + 1}`, source: l[0], target: l[1], state: 'up', bandwidthKbps: 250, latencyMs: null, lossRate: null }
      : { state: 'up', bandwidthKbps: 250, latencyMs: null, lossRate: null, ...l, id: l.id || `l${i + 1}` });
    linkSeq = links.length;
    // Ensure addressing on all nodes
    const usedIp = new Set(), usedMac = new Set();
    nodes.forEach(n => {
      if (!n.ip) { let ip = allocIp(); while (usedIp.has(ip)) ip = allocIp(); n.ip = ip; }
      if (!n.mac) n.mac = allocMac();
      usedIp.add(n.ip); usedMac.add(n.mac);
      if (!n.ipv6) n.ipv6 = ipv6For(n.ip, n.id);
      if (n.type === 'sensor' && n.battery === undefined) n.battery = 100;
      if (n.icon === undefined && n.type === 'sensor') n.icon = SENSOR_ICONS[n.sensorType] || '📡';
      if (n.received === undefined && n.type === 'server') n.received = 0;
    });
    recomputeOrphans();
    emit({ kind: 'set-topology' });
    if (migrated > 0) {
      try { Terminal.log(`🔄 Migrated ${migrated} legacy router(s) → gateways (capacity 20)`, 'info'); } catch (e) {}
    }
  }

  function exportJSON() {
    return { version: 1, nodes: nodes.map(n => ({ ...n })), links: links.map(l => ({ ...l })) };
  }
  function importJSON(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) throw new Error('Bad topology JSON: need {nodes[], links[]}');
    if (data.nodes.length > MAX_NODES) throw new Error(`Too many nodes (${data.nodes.length}/${MAX_NODES})`);
    if (data.links.length > MAX_LINKS) throw new Error(`Too many links (${data.links.length}/${MAX_LINKS})`);
    setTopology(data.nodes, data.links);
  }
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      importJSON(data);
      return true;
    } catch (e) { return null; }
  }

  // CanvasEngine-compatible views
  function toCanvasLinks() { return links.map(l => ({ ...l })); }
  function toLegacyPairs() { return links.map(l => [l.source, l.target]); }

  return {
    MAX_NODES, MAX_LINKS, SENSOR_ICONS,
    onChange, emit, addNode, removeNode, addLink, removeLink, removeLinkByEndpoints,
    setLinkState, cycleLinkState, findLink, validateLink, canLink,
    setTopology, exportJSON, importJSON, loadAutosave, recomputeOrphans,
    toCanvasLinks, toLegacyPairs,
    getNodes: () => nodes, getLinks: () => links,
    getNode: (id) => nodes.find(n => n.id === id) || null,
    getLink: (id) => links.find(l => l.id === id) || null,
  };
})();
