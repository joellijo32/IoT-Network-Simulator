/**
 * @file main.js
 * @description SimEngine orchestrator M2-M5: graph routing (multi-hop sensor->
 *              gateway->server), CoAP framing, link states, battery,
 *              TTL, SLA, metrics registry, trace, ACK particles, stepper.
 */

/* global CanvasEngine, ParticleEngine, DragEngine, TelemetryEngine, GatewayQueue,
          UIController, ChartEngine, ChaosEngine, Scenarios, Terminal,
          GraphStore, CoAP, BatteryEngine, SLAEngine, MetricsRegistry, TraceStore,
          DashboardEngine, Inspector, TraceTable */

const SimEngine = (() => {
  'use strict';

  let worker = null;
  let workerReady = false;
  let isRunning = false;
  let isPaused = false;

  let currentNodes = [];
  let currentLinks = []; // canvas link objects [{id,source,target,state}]

  let cfg = { intervalMs: 800, lossRate: 5, latencyMs: 80, jitterMs: 20, speedMult: 1, isSurge: false };
  let metrics = { totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 };
  let topologyName = 'smartfactory';

  let ticksSinceChartUpdate = 0;
  const CHART_UPDATE_EVERY = 2; // ~1.5s @800ms tick (spec: batch render)
  let tickCount = 0;
  let pendingRetries = []; // CON retry queue [{sensorId, attempts}]

  // ─── Worker ───
  function initWorker() {
    try {
      worker = new Worker('workers/sim.worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = onWorkerError;
      workerReady = true;
      Terminal.log('🔧 Web Worker initialised (multi-threaded mode)', 'info');
    } catch (err) {
      workerReady = false;
      Terminal.log('⚠️  Web Worker unavailable — using fallback mode', 'warn');
      Terminal.log('   Tip: Serve via "python3 -m http.server" for full features', 'debug');
    }
  }
  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'READY') Terminal.log('✅ Worker ready — simulation engine online', 'success');
    else if (msg.type === 'TICK') processTick(msg.packets, msg.metrics);
  }
  function onWorkerError(err) { Terminal.log(`❌ Worker error: ${err.message}`, 'error'); }

  // ─── Path resolution (BFS over up/flapping links toward server) ───
  function outLinksOf(id) {
    return currentLinks.filter(l => {
      const s = Array.isArray(l) ? l[0] : l.source;
      return s === id;
    }).map(l => Array.isArray(l) ? { id: null, source: l[0], target: l[1], state: 'up' } : l);
  }
  function linkState(a, b) {
    const l = currentLinks.find(x => Array.isArray(x) ? (x[0] === a && x[1] === b) : (x.source === a && x.target === b));
    if (!l) return 'down';
    return Array.isArray(l) ? 'up' : (l.state || 'up');
  }
  /** BFS shortest path (node id list) from start to any server, traversing up+flapping links. */
  function findPath(startId) {
    const prev = new Map([[startId, null]]);
    const q = [startId];
    const isServer = (id) => (currentNodes.find(n => n.id === id) || {}).type === 'server';
    if (isServer(startId)) return [startId];
    while (q.length) {
      const cur = q.shift();
      if (isServer(cur)) {
        const path = []; let c = cur;
        while (c) { path.unshift(c); c = prev.get(c); }
        return path;
      }
      outLinksOf(cur).forEach(l => {
        if (l.state === 'down') return;
        if (!prev.has(l.target)) { prev.set(l.target, cur); q.push(l.target); }
      });
    }
    return null;
  }

  // ─── Tick ───
  function processTick(packets, tickMetrics) {
    metrics.totalSent = tickMetrics.totalSent;
    metrics.totalDelivered = tickMetrics.totalDelivered;
    metrics.totalDropped = tickMetrics.totalDropped;
    metrics.avgLatency = tickMetrics.avgLatency;
    tickCount++;

    packets.forEach(pkt => routePacket(pkt));
    // CON retries (max 1 extra attempt, next packets array inline)
    if (pendingRetries.length) {
      const retry = pendingRetries.splice(0, pendingRetries.length);
      retry.forEach(r => {
        const node = currentNodes.find(n => n.id === r.sensorId);
        if (!node) return;
        const pkt = buildLocalPacket(node, { isRetry: true, forceType: 'CON' });
        if (pkt) {
          metrics.totalSent++;
          routePacket(pkt);
        }
      });
    }
    processForwarderDequeue();

    // SLA advance (frozen while paused — processTick only fires when running)
    try {
      SLAEngine.setTickMs(cfg.intervalMs);
      SLAEngine.tick(currentNodes, currentLinks.map(l => Array.isArray(l) ? { source: l[0], target: l[1], state: 'up' } : l));
    } catch (e) {}

    // Metrics registry
    try {
      const queueDepths = currentNodes
        .filter(n => n.type === 'gateway')
        .map(n => {
          const q = GatewayQueue.getQueue(n.id);
          return { nodeId: n.id, depth: q ? q.buffer.length : 0, capacity: GatewayQueue.getCapacity(n.id) };
        });
      const nodeStates = currentNodes.map(n => ({ nodeId: n.id, state: slaToMetric(n) }));
      MetricsRegistry.recordTick(packets, metrics, queueDepths, nodeStates);
    } catch (e) {}

    UIController.updateHUD(metrics);
    ticksSinceChartUpdate++;
    if (ticksSinceChartUpdate >= CHART_UPDATE_EVERY) {
      ChartEngine.update(tickMetrics.lossPercent, tickMetrics.avgLatency);
      ticksSinceChartUpdate = 0;
    }
    try { DashboardEngine.onTick(metrics); } catch (e) {}
    updateNodeVisuals();
    if (tickCount % 4 === 0) { try { Inspector.refresh(); } catch (e) {} }
  }
  function slaToMetric(n) {
    if (n.dead || n.killed) return 'down';
    if (n.orphan) return 'down';
    const s = n.slaState || 'up';
    return s === 'up' ? 'up' : s === 'degraded' ? 'degraded' : 'down';
  }

  /** Enrich worker packet with graph addressing + CoAP defaults (worker sends lean frame). */
  function enrichPacket(pkt) {
    const node = currentNodes.find(n => n.id === pkt.sensorId);
    if (!node) return pkt;
    pkt.srcMac = pkt.srcMac || node.mac;
    pkt.srcIp = pkt.srcIp || node.ipv6 || node.ip;
    pkt.nodeType = 'sensor';
    if (!pkt.coap) {
      pkt.coap = {
        ver: 1, type: pkt.isAlarm ? 0 : 1, typeName: pkt.isAlarm ? 'CON' : 'NON',
        code: '0.02 POST', mid: pkt.mid ?? Math.floor(Math.random() * 0xFFFF),
        token: pkt.token || ('0x' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0')),
        uriPath: pkt.isAlarm ? '/alerts' : '/telemetry',
        ttl: 5, hops: 0,
        payload: { id: pkt.sensorId, type: pkt.sensorType, val: pkt.value, unit: pkt.unit, ts: Math.floor((pkt.timestamp || Date.now()) / 1000) },
      };
      pkt.coapType = pkt.coap.typeName;
      pkt.isAlarm = !!pkt.isAlarm;
      pkt.ttl = 5; pkt.hops = 0;
    } else {
      pkt.coapType = pkt.coap.typeName;
    }
    // Destination addressing: first-hop target
    const path = findPath(pkt.sensorId);
    if (path && path.length > 1) {
      const next = currentNodes.find(n => n.id === path[1]);
      const srv = currentNodes.find(n => n.type === 'server');
      pkt.gatewayId = (next && next.type === 'gateway') ? next.id : pkt.gatewayId;
      pkt.dstMac = next ? next.mac : pkt.dstMac;
      pkt.dstIp = srv ? (srv.ipv6 || srv.ip) : pkt.dstIp;
      pkt.pathTrace = path;
    }
    return pkt;
  }

  function routePacket(rawPkt) {
    const pkt = enrichPacket(rawPkt);
    const sensorNode = currentNodes.find(n => n.id === pkt.sensorId);
    if (!sensorNode) return;

    // 1. Battery gate (dead -> grey drop, low-power skips already applied worker-side? enforce here)
    if (sensorNode.dead || (sensorNode.battery ?? 100) <= 0) {
      dropPacket(pkt, sensorNode, null, 'battery-dead', '🔋 BATT', 'dead');
      return;
    }
    // 2. Path
    const path = findPath(pkt.sensorId);
    if (!path || path.length < 2) {
      sensorNode.orphan = true;
      dropPacket(pkt, sensorNode, null, 'no-route', 'NO_ROUTE', 'dead');
      Terminal.log(`🟠 NOROUTE [${pkt.id}] ${sensorNode.label} — no UP path to server`, 'warn', pkt);
      return;
    }
    // 3. TTL (hops = edges)
    const hops = path.length - 1;
    if (hops > (pkt.coap?.ttl ?? 5)) {
      dropPacket(pkt, sensorNode, pathNode(path[1]), 'ttl-expired', 'TTL_EXPIRED', 'dropped');
      return;
    }
    pkt.hops = hops;
    if (pkt.coap) pkt.coap.hops = hops;
    // 4. Link states along path
    for (let i = 0; i < path.length - 1; i++) {
      const st = linkState(path[i], path[i + 1]);
      if (st === 'down') {
        dropAtMidpoint(pkt, pathNode(path[i]), pathNode(path[i + 1]), 'link-down', `✂ LINK_DOWN [${pkt.id}] ${path[i]}→${path[i + 1]} @hop${i}`);
        queueRetryIfCON(pkt);
        return;
      }
      if (st === 'flapping') {
        // 50% drop + extra jitter ±80ms
        if (Math.random() < 0.5) {
          dropAtMidpoint(pkt, pathNode(path[i]), pathNode(path[i + 1]), 'link-down', `〰 FLAP-DROP [${pkt.id}] ${path[i]}→${path[i + 1]}`);
          queueRetryIfCON(pkt);
          return;
        }
        pkt.latency = Math.max(1, pkt.latency + Math.round((Math.random() + Math.random() - 1) * 80));
      }
    }
    // 5. Worker global loss (packet-loss) — CON gets 1 retry
    if (pkt.status === 'dropped' && (pkt.dropReason === 'packet-loss' || !pkt.dropReason)) {
      pkt.dropReason = 'packet-loss';
      dropPacket(pkt, sensorNode, pathNode(path[1]), 'packet-loss', 'DROP', 'dropped');
      queueRetryIfCON(pkt);
      return;
    }
    if (pkt.status === 'dropped') {
      dropPacket(pkt, sensorNode, pathNode(path[1]), pkt.dropReason || 'packet-loss', 'DROP', 'dropped');
      queueRetryIfCON(pkt);
      return;
    }
    // 6. Drain battery per emission
    try { BatteryEngine.afterTransmit(sensorNode); } catch (e) {}

    // 7. First-hop enqueue (gateway)
    const firstId = path[1];
    const firstNode = pathNode(firstId);
    const isFwd = firstNode && firstNode.type === 'gateway';
    const status = pkt.coapType === 'CON' ? 'con' : 'in-transit';
    if (isFwd) {
      const enqueued = GatewayQueue.enqueue(firstId, pkt);
      ParticleEngine.createParticle(sensorNode, firstNode, enqueued ? status : 'dropped', { ...pkt, lowPower: !!sensorNode.lowPower });
      if (!enqueued) {
        ParticleEngine.createDropBurst(firstNode.x, firstNode.y);
        const reason = pkt.dropReason || 'buffer-overflow';
        metrics.totalDropped++; metrics.totalDelivered--;
        Terminal.log(`🔴 DROP  [${pkt.id}] ${sensorNode.label} → ${firstNode.label} — ${reason}`, 'warn', pkt);
        queueRetryIfCON(pkt);
      } else {
        pkt.status = 'queued'; pkt.pathIdx = 1;
        Terminal.log(
          `${pkt.coapType === 'CON' ? '🟡 CON ' : '🟡 QUEUE'} [${pkt.id}] ${sensorNode.label} → ${firstNode.label} | ${pkt.coap?.uriPath || ''} MID=${midHex(pkt)} val=${pkt.value}${pkt.unit} lat=${pkt.latency}ms`,
          'info', pkt);
        // CON: reverse ACK particle on successful gateway accept
        if (pkt.coapType === 'CON') {
          ParticleEngine.createParticle(firstNode, sensorNode, 'ack', { ...pkt, status: 'ack' });
          Terminal.log(`🔵 ACK   [${pkt.id}] ${firstNode.label} → ${sensorNode.label} | MID=${midHex(pkt)} 2.04 Changed`, 'info', { ...pkt, status: 'ack' });
        }
      }
    } else if (firstNode && firstNode.type === 'server') {
      // Direct sensor->server (custom topo): deliver
      ParticleEngine.createParticle(sensorNode, firstNode, 'delivered', pkt);
      firstNode.received = (firstNode.received || 0) + 1;
      Terminal.log(`🟢 DLVR  [${pkt.id}] ${sensorNode.label} → ${firstNode.label} | val=${pkt.value}${pkt.unit}`, 'success', pkt);
    }
  }

  function queueRetryIfCON(pkt) {
    if (pkt.coapType === 'CON' && !pkt.isRetry && (pendingRetries.length < 8)) {
      pendingRetries.push({ sensorId: pkt.sensorId });
      Terminal.log(`🟠 RETRY [${pkt.id}] CON scheduled (1×, 2s ACK timeout)`, 'warn', pkt);
    }
  }
  function pathNode(id) { return currentNodes.find(n => n.id === id) || null; }
  function midHex(pkt) {
    const m = pkt.coap?.mid;
    return m !== undefined ? '0x' + m.toString(16).toUpperCase().padStart(4, '0') : '—';
  }
  function dropPacket(pkt, fromNode, toNode, reason, tag, pstatus) {
    pkt.status = 'dropped'; pkt.dropReason = reason;
    if (toNode) {
      ParticleEngine.createParticle(fromNode, toNode, pstatus === 'dead' ? 'dropped' : 'dropped', { ...pkt, lowPower: !!fromNode.lowPower });
      ParticleEngine.createDropBurst((fromNode.x + toNode.x) / 2, (fromNode.y + toNode.y) / 2);
    } else {
      ParticleEngine.createDropBurst(fromNode.x, fromNode.y);
    }
    const pretty = { 'battery-dead': 'battery-dead', 'no-route': 'no-route', 'ttl-expired': 'TTL_EXPIRED', 'packet-loss': 'packet-loss', 'link-down': 'link-down', 'buffer-overflow': 'buffer-overflow', 'gateway-killed': 'gateway-killed' }[reason] || reason;
    Terminal.log(`🔴 ${tag} [${pkt.id}] ${fromNode.label}${toNode ? ' → ' + toNode.label : ''} — ${pretty}`, 'warn', pkt);
  }
  function dropAtMidpoint(pkt, a, b, reason, msg) {
    pkt.status = 'dropped'; pkt.dropReason = reason;
    if (a && b) {
      // Immediately at current interpolation coordinate ≈ midpoint for fresh packets
      ParticleEngine.createDropBurst((a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (a) {
      ParticleEngine.createDropBurst(a.x, a.y);
    }
    Terminal.log(msg || `🔴 DROP [${pkt.id}] — ${reason}`, 'warn', pkt);
  }

  /** Advance each gateway queue one hop toward server. */
  function processForwarderDequeue() {
    const serverNode = currentNodes.find(n => n.type === 'server');
    if (!serverNode) return;
    currentNodes.filter(n => n.type === 'gateway').forEach(fw => {
      const batch = GatewayQueue.dequeue(fw.id);
      batch.forEach(pkt => {
        const path = pkt.pathTrace && pkt.pathTrace.length ? pkt.pathTrace : findPath(pkt.sensorId);
        let nextId = null;
        if (path) {
          const idx = path.indexOf(fw.id);
          nextId = idx >= 0 ? path[idx + 1] : null;
        }
        if (!nextId) {
          // Fallback: any up-link toward server
          const outs = outLinksOf(fw.id).filter(l => l.state !== 'down');
          nextId = outs.length ? outs[0].target : null;
        }
        const next = nextId ? pathNode(nextId) : null;
        if (!next) {
          pkt.status = 'dropped'; pkt.dropReason = 'no-route';
          metrics.totalDropped++; metrics.totalDelivered--;
          Terminal.log(`🔴 DROP  [${pkt.id}] ${fw.label} — no next hop`, 'warn', pkt);
          return;
        }
        if (next.type === 'server') {
          ParticleEngine.createParticle(fw, next, 'delivered', pkt);
          next.received = (next.received || 0) + 1;
          Terminal.log(`🟢 DLVR  [${pkt.id}] ${fw.label} → ${next.label} | val=${pkt.value}${pkt.unit} lat=${pkt.latency}ms hops=${pkt.hops ?? '?'}`, 'success', pkt);
        } else {
          // Forward to next gateway (TTL guard)
          const nextHops = (pkt.hops ?? 0) + 1;
          if (nextHops > (pkt.coap?.ttl ?? 5)) {
            pkt.status = 'dropped'; pkt.dropReason = 'ttl-expired';
            metrics.totalDropped++; metrics.totalDelivered--;
            ParticleEngine.createDropBurst(fw.x, fw.y);
            Terminal.log(`🔴 TTL_EXPIRED [${pkt.id}] at ${fw.label} (hops>${pkt.coap?.ttl ?? 5})`, 'warn', pkt);
            return;
          }
          pkt.hops = nextHops; if (pkt.coap) pkt.coap.hops = nextHops;
          const ok = GatewayQueue.enqueue(next.id, pkt);
          ParticleEngine.createParticle(fw, next, ok ? 'in-transit' : 'dropped', pkt);
          if (!ok) {
            ParticleEngine.createDropBurst(next.x, next.y);
            metrics.totalDropped++; metrics.totalDelivered--;
            Terminal.log(`🔴 DROP  [${pkt.id}] ${fw.label} → ${next.label} — ${pkt.dropReason || 'buffer-overflow'}`, 'warn', pkt);
          } else {
            Terminal.log(`🔀 FWD   [${pkt.id}] ${fw.label} → ${next.label} | hop ${nextHops}`, 'info', pkt);
          }
        }
      });
    });
  }

  function updateNodeVisuals() {
    currentNodes.forEach(node => {
      if (node.type === 'gateway') {
        const q = GatewayQueue.getQueue(node.id);
        if (q) {
          const cap = GatewayQueue.getCapacity(node.id);
          node.queueFill = Math.round((q.buffer.length / cap) * 100);
          node.queueCount = q.buffer.length;
          node.killed = !q.active;
          node._congestion = node.queueFill;
        }
      }
    });
  }

  // ─── Control ───
  function start() {
    if (isRunning) return;
    const sensors = currentNodes.filter(n => n.type === 'sensor');
    if (sensors.length === 0) { Terminal.log('⚠️  No sensor nodes in topology', 'warn'); return; }
    const orphans = sensors.filter(n => n.orphan);
    if (orphans.length) Terminal.log(`⚠️ ${orphans.length} orphaned sensor(s) will drop NO_ROUTE`, 'warn');
    isRunning = true; isPaused = false;
    try { SLAEngine.start(); } catch (e) {}
    const workerSensors = sensors.map(n => ({ id: n.id, sensorType: n.sensorType || 'temperature' }));
    const workerConfig = { intervalMs: cfg.intervalMs, lossRate: cfg.lossRate, latencyMs: cfg.latencyMs, jitterMs: cfg.jitterMs, sensors: workerSensors };
    if (workerReady && worker) worker.postMessage({ type: 'START', config: workerConfig });
    else startFallbackLoop(workerConfig);
  }
  function pause() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    try { SLAEngine.pause(); } catch (e) {}
    if (workerReady && worker) worker.postMessage({ type: 'PAUSE' });
    else stopFallbackLoop();
  }
  function resume() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    try { SLAEngine.start(); } catch (e) {}
    if (workerReady && worker) worker.postMessage({ type: 'RESUME' });
    else startFallbackLoop({ intervalMs: cfg.intervalMs, lossRate: cfg.lossRate, latencyMs: cfg.latencyMs, jitterMs: cfg.jitterMs, sensors: currentNodes.filter(n => n.type === 'sensor').map(n => ({ id: n.id, sensorType: n.sensorType })) });
  }
  function stop() {
    isRunning = false; isPaused = false;
    if (workerReady && worker) worker.postMessage({ type: 'STOP' });
    else stopFallbackLoop();
    metrics = { totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 };
    tickCount = 0; pendingRetries = [];
    try { MetricsRegistry.reset(); } catch (e) {}
    try { SLAEngine.reset(); } catch (e) {}
    try { CoAP.clearDedup(); } catch (e) {}
    GatewayQueue.clearAll();
    currentNodes.filter(n => n.type === 'gateway').forEach(gw => {
      GatewayQueue.createQueue(gw.id, 20);
      gw.queueFill = 0; gw.queueCount = 0; gw.killed = false; gw._congestion = 0;
    });
    currentNodes.filter(n => n.type === 'sensor').forEach(s => { s.battery = 100; s.dead = false; s.lowPower = false; });
    try { BatteryEngine.resetAll(); } catch (e) {}
    const serverNode = currentNodes.find(n => n.type === 'server');
    if (serverNode) serverNode.received = 0;
    // Kill in-flight particles referencing dead topology
    try { ParticleEngine.reset(); ParticleEngine.start(); ParticleEngine.pause(); } catch (e) {}
  }

  /** Step exactly 1 tick synchronously (spec). Pauses worker-driven loop first. */
  function stepOnce() {
    const sensors = currentNodes.filter(n => n.type === 'sensor');
    if (!sensors.length) { Terminal.log('⚠️  No sensors to step', 'warn'); return; }
    // Build one packet per eligible sensor (battery-gated), like worker would
    const packets = [];
    sensors.forEach(sn => {
      const gate = (() => { try { return BatteryEngine.beforeTransmit(sn, tickCount); } catch (e) { return { allowed: true }; } })();
      if (!gate.allowed) {
        if (gate.reason === 'battery-dead') {
          tickCount++;
          const pkt = buildLocalPacket(sn, { dead: true });
          if (pkt) { metrics.totalSent++; routePacket(pkt); }
        }
        return;
      }
      const pkt = buildLocalPacket(sn, {});
      if (pkt) packets.push(pkt);
    });
    // Apply global loss roll here (worker parity)
    packets.forEach(p => {
      if (Math.random() < cfg.lossRate / 100) { p.status = 'dropped'; p.dropReason = 'packet-loss'; p.latency = 0; }
    });
    const tickDelivered = packets.filter(p => p.status !== 'dropped').length;
    const tickDropped = packets.filter(p => p.status === 'dropped').length;
    // Merge into cumulative (worker-style)
    metrics.totalSent += packets.length;
    metrics.totalDelivered += tickDelivered;
    metrics.totalDropped += tickDropped;
    // Feed through same pipeline (routePacket handles the rest, but avoid double-count)
    const base = { ...metrics };
    // Temporarily neutralize double count: routePacket doesn't touch totals except overflow adjustments
    packets.forEach(pkt => routePacket(pkt));
    if (pendingRetries.length) {
      const retry = pendingRetries.splice(0, pendingRetries.length);
      retry.forEach(r => {
        const node = currentNodes.find(n => n.id === r.sensorId);
        if (!node) return;
        const pkt = buildLocalPacket(node, { isRetry: true, forceType: 'CON' });
        if (pkt) { metrics.totalSent++; routePacket(pkt); }
      });
    }
    processForwarderDequeue();
    try { SLAEngine.setTickMs(cfg.intervalMs); SLAEngine.start(); SLAEngine.tick(currentNodes, currentLinks.map(l => Array.isArray(l) ? { source: l[0], target: l[1], state: 'up' } : l)); SLAEngine.pause(); } catch (e) {}
    try {
      const queueDepths = currentNodes.filter(n => n.type === 'gateway')
        .map(n => { const q = GatewayQueue.getQueue(n.id); return { nodeId: n.id, depth: q ? q.buffer.length : 0, capacity: GatewayQueue.getCapacity(n.id) }; });
      const nodeStates = currentNodes.map(n => ({ nodeId: n.id, state: slaToMetric(n) }));
      MetricsRegistry.recordTick(packets, metrics, queueDepths, nodeStates);
    } catch (e) {}
    // Recompute loss/avg for HUD/charts parity
    const lossPercent = metrics.totalSent ? (metrics.totalDropped / metrics.totalSent) * 100 : 0;
    UIController.updateHUD(metrics);
    try { ChartEngine.update(lossPercent, metrics.avgLatency); } catch (e) {}
    try { DashboardEngine.onTick(metrics); } catch (e) {}
    updateNodeVisuals();
    tickCount++;
    void base;
  }

  /** Build a CoAP reading packet locally (stepper + fallback path). */
  let localPktId = 0;
  function buildLocalPacket(sensorNode, opts = {}) {
    if (sensorNode.dead && !opts.dead) return null;
    localPktId++;
    const ranges = { temperature: [15, 85, '°C'], humidity: [10, 95, '%'], pressure: [900, 1100, 'hPa'] };
    const [min, max, unit] = ranges[sensorNode.sensorType] || [0, 100, ''];
    const value = parseFloat((Math.random() * (max - min) + min).toFixed(2));
    const alarm = opts.forceType === 'CON' || (!opts.dead && ((sensorNode.sensorType === 'temperature' && value > 75) || (sensorNode.sensorType === 'pressure' && value > 1060)));
    const jitter = (Math.random() + Math.random() - 1) * cfg.jitterMs;
    const latency = Math.max(1, Math.round(cfg.latencyMs + jitter));
    const mid = (localPktId * 7919) & 0xFFFF;
    const token = '0x' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0');
    return {
      id: `PKT-${String(90000 + localPktId).padStart(5, '0')}`,
      sensorId: sensorNode.id, sensorType: sensorNode.sensorType || 'temperature',
      value, unit, timestamp: Date.now(),
      status: opts.dead ? 'dropped' : 'delivered',
      latency: opts.dead ? 0 : latency,
      dropReason: opts.dead ? 'battery-dead' : null,
      isAlarm: alarm, isRetry: !!opts.isRetry,
      srcMac: sensorNode.mac, srcIp: sensorNode.ipv6 || sensorNode.ip,
      udpSrc: 5683, udpDst: 5683,
      ttl: 5, hops: 0,
      coap: {
        ver: 1, type: alarm ? 0 : 1, typeName: alarm ? 'CON' : 'NON',
        code: '0.02 POST', mid, token,
        uriPath: alarm ? '/alerts' : '/telemetry',
        ttl: 5, hops: 0,
        payload: { id: sensorNode.id, type: sensorNode.sensorType, val: value, unit, ts: Math.floor(Date.now() / 1000) },
      },
      coapType: alarm ? 'CON' : 'NON',
      lowPower: !!sensorNode.lowPower,
    };
  }

  // ─── Config ───
  function setLoss(v) { cfg.lossRate = v; postToWorker('SET_LOSS', v); }
  function setLatency(v) { cfg.latencyMs = v; postToWorker('SET_LATENCY', v); }
  function setJitter(v) { cfg.jitterMs = v; postToWorker('SET_JITTER', v); }
  function setSurge(v) { cfg.isSurge = v; postToWorker('SET_SURGE', v); }
  function setSpeed(mult) { cfg.speedMult = mult; postToWorker('SET_SPEED', mult); }
  function markGatewayKilled(gwId, killed) {
    const node = currentNodes.find(n => n.id === gwId);
    if (node) node.killed = killed;
    // Repaint kill/restore instantly even while stopped
    try { CanvasEngine.renderNow(); } catch (e) {}
  }
  function postToWorker(type, value) { if (workerReady && worker) worker.postMessage({ type, value }); }

  function onTopologyChanged(nodes, links) {
    currentNodes = nodes; currentLinks = links;
    topologyName = 'custom';
    try { GraphStore.recomputeOrphans(); } catch (e) {}
    if (isRunning) stop();
    try { DragEngine.updateStatusbar?.(); } catch (e) {}
  }
  function killParticlesOnLink(linkId) {
    try {
      const link = currentLinks.find(l => !Array.isArray(l) && l.id === linkId);
      if (!link) return;
      const a = pathNode(link.source), b = pathNode(link.target);
      if (!a || !b) return;
      ParticleEngine.getParticles().forEach(p => {
        if (p.done || p.burst) return;
        // If particle travels a->b (either direction), burst at current pos
        const near = (p.startX === a.x && p.startY === a.y && p.endX === b.x && p.endY === b.y)
          || (p.startX === b.x && p.startY === b.y && p.endX === a.x && p.endY === a.y);
        if (near) {
          p.done = true;
          ParticleEngine.createDropBurst(p.x, p.y);
          if (p.meta && p.meta.id) Terminal.log(`✂ LINK_DOWN [${p.meta.id}] dropped mid-transit @(${(p.x | 0)},${(p.y | 0)})`, 'warn', p.meta);
        }
      });
    } catch (e) {}
  }

  // ─── Fallback loop (no worker) ───
  let fallbackLoopId = null;
  let fallbackCounters = { totalSent: 0, totalDelivered: 0, totalDropped: 0, latencies: [] };
  function startFallbackLoop(config) {
    stopFallbackLoop();
    const interval = Math.max(50, config.intervalMs / (cfg.speedMult || 1));
    fallbackLoopId = setInterval(() => {
      const packets = [];
      (config.sensors || []).forEach(s => {
        const node = currentNodes.find(n => n.id === s.id);
        if (!node) return;
        let gate = { allowed: true };
        try { gate = BatteryEngine.beforeTransmit(node, tickCount); } catch (e) {}
        if (!gate.allowed) {
          if (gate.reason === 'battery-dead') {
            const pkt = buildLocalPacket(node, { dead: true });
            if (pkt) { packets.push(pkt); fallbackCounters.totalSent++; fallbackCounters.totalDropped++; }
          }
          return;
        }
        const pkt = buildLocalPacket(node, {});
        if (!pkt) return;
        if (Math.random() < cfg.lossRate / 100) { pkt.status = 'dropped'; pkt.dropReason = 'packet-loss'; pkt.latency = 0; }
        packets.push(pkt);
        fallbackCounters.totalSent++;
        if (pkt.status === 'dropped') fallbackCounters.totalDropped++;
        else { fallbackCounters.totalDelivered++; fallbackCounters.latencies.push(pkt.latency); }
      });
      if (fallbackCounters.latencies.length > 100) fallbackCounters.latencies = fallbackCounters.latencies.slice(-100);
      const avg = fallbackCounters.latencies.length ? fallbackCounters.latencies.reduce((a, b) => a + b, 0) / fallbackCounters.latencies.length : 0;
      const loss = fallbackCounters.totalSent ? (fallbackCounters.totalDropped / fallbackCounters.totalSent) * 100 : 0;
      // Surge: extra packets
      if (cfg.isSurge) {
        const extra = [];
        (config.sensors || []).forEach(s => {
          const node = currentNodes.find(n => n.id === s.id);
          if (!node || node.dead) return;
          for (let i = 0; i < 2; i++) {
            const pkt = buildLocalPacket(node, {});
            if (pkt) { extra.push(pkt); fallbackCounters.totalSent++; fallbackCounters.totalDelivered++; fallbackCounters.latencies.push(pkt.latency); }
          }
        });
        packets.push(...extra);
      }
      processTick(packets, {
        lossPercent: parseFloat(loss.toFixed(2)), avgLatency: parseFloat(avg.toFixed(2)),
        totalSent: fallbackCounters.totalSent, totalDelivered: fallbackCounters.totalDelivered, totalDropped: fallbackCounters.totalDropped,
      });
    }, interval);
  }
  function stopFallbackLoop() {
    if (fallbackLoopId !== null) { clearInterval(fallbackLoopId); fallbackLoopId = null; fallbackCounters = { totalSent: 0, totalDelivered: 0, totalDropped: 0, latencies: [] }; }
  }

  return {
    initWorker, start, pause, resume, stop, stepOnce,
    setLoss, setLatency, setJitter, setSurge, setSpeed,
    markGatewayKilled, onTopologyChanged, killParticlesOnLink,
    getMetrics: () => ({ ...metrics }),
    isActive: () => isRunning && !isPaused,
    getNodes: () => currentNodes, getLinks: () => currentLinks,
    getTopologyName: () => topologyName,
  };
})();

// ─── App Bootstrap ───
window.addEventListener('DOMContentLoaded', () => {
  'use strict';
  CanvasEngine.init('networkCanvas');
  DragEngine.bindEvents(document.getElementById('networkCanvas'));
  Terminal.init();
  try { Inspector.init(); } catch (e) { console.warn(e); }
  ChartEngine.init();
  try { DashboardEngine.init(); } catch (e) { console.warn(e); }
  UIController.init();
  ChaosEngine.init();
  // Autosave restore, else default preset
  let restored = false;
  try { restored = GraphStore.loadAutosave() && GraphStore.getNodes().length > 0; } catch (e) {}
  if (restored) {
    const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
    CanvasEngine.setTopology(nodes, links);
    GatewayQueue.clearAll();
    nodes.filter(n => n.type === 'gateway').forEach(n => GatewayQueue.createQueue(n.id, 20));
    try { MetricsRegistry.setTopology('custom'); } catch (e) {}
    SimEngine.onTopologyChanged(nodes, links);
    const sel = document.getElementById('scenario-select');
    if (sel) sel.value = '__custom';
    Terminal.log(`💾 Restored autosaved topology — ${nodes.length} nodes`, 'info');
  } else {
    Scenarios.load('smart-factory');
  }
  SimEngine.initWorker();
  ParticleEngine.start();
  ParticleEngine.pause();
  // Initial paint after layout settles — RAF loop stays paused (blank-canvas fix)
  requestAnimationFrame(() => {
    try { CanvasEngine.resize(); } catch (e) {}
    try { CanvasEngine.renderNow(); } catch (e) {}
  });
  // Canvas click -> PDU for particles (pointer tool only)
  try {
    document.getElementById('networkCanvas').addEventListener('click', (ev) => {
      if (DragEngine.getTool() !== 'pointer') return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const p = ParticleEngine.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (p && p.meta && p.meta.id) { try { Inspector.openPDU(p.meta); } catch (e) {} }
    });
  } catch (e) {}
  // SLA tick length follows interval
  try { SLAEngine.setTickMs(800); } catch (e) {}
  Terminal.log('🚀 IoT Network Simulator ready — press ▶ Start to begin', 'success');
  Terminal.log('   Keys: 1 Studio · 2 Observability · 3 Inspector · V/Move L/Link X/Cut · Click packet = PDU', 'debug');
});
