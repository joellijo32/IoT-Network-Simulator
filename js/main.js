/**
 * @file main.js
 * @author Joel Lijo Mathew (Team Lead)
 * @description Application Bootstrap & Web Worker Architecture: Initialises all modules in the
 *              correct dependency order, manages the Web Worker communication bridge, processes
 *              TICK messages from the worker, and routes packet events to the particle engine,
 *              gateway queues, chart engine, HUD, and terminal log.
 *
 *              This is the central orchestrator — it owns the global simulation state and exposes
 *              the SimEngine API that other modules call to control the simulation.
 */

/* global CanvasEngine, ParticleEngine, DragEngine, TelemetryEngine, GatewayQueue,
          UIController, ChartEngine, ChaosEngine, Scenarios, Terminal */

const SimEngine = (() => {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────

  let worker        = null;
  let workerReady   = false;
  let isRunning     = false;
  let isPaused      = false;

  let currentNodes  = [];
  let currentLinks  = [];

  // Config (mirrored from chaos sliders)
  let cfg = {
    intervalMs: 800,
    lossRate:   5,
    latencyMs:  80,
    jitterMs:   20,
    speedMult:  1,
    isSurge:    false,
  };

  // Cumulative metrics (updated each TICK)
  let metrics = {
    totalSent:      0,
    totalDelivered: 0,
    totalDropped:   0,
    avgLatency:     0,
  };

  // Chart update throttle (update charts every 3 ticks)
  let ticksSinceChartUpdate = 0;
  const CHART_UPDATE_EVERY  = 3;

  // ─── Worker initialisation ───────────────────────────────────────────────────

  /**
   * Creates the Web Worker with a file:// fallback.
   */
  function initWorker() {
    try {
      worker = new Worker('workers/sim.worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror   = onWorkerError;
      workerReady      = true;
      Terminal.log('🔧 Web Worker initialised (multi-threaded mode)', 'info');
    } catch (err) {
      // Fallback: simulate inline using setTimeout (file:// protocol restriction)
      workerReady = false;
      Terminal.log('⚠️  Web Worker unavailable — using fallback mode', 'warn');
      Terminal.log('   Tip: Serve via "python3 -m http.server" for full features', 'debug');
    }
  }

  // ─── Worker message handlers ──────────────────────────────────────────────────

  /**
   * Processes messages from the Web Worker.
   * @param {MessageEvent} e
   */
  function onWorkerMessage(e) {
    const msg = e.data;

    switch (msg.type) {
      case 'READY':
        Terminal.log('✅ Worker ready — simulation engine online', 'success');
        break;

      case 'TICK':
        processTick(msg.packets, msg.metrics);
        break;

      default:
        break;
    }
  }

  function onWorkerError(err) {
    Terminal.log(`❌ Worker error: ${err.message}`, 'error');
  }

  // ─── Tick processing ──────────────────────────────────────────────────────────

  /**
   * Central tick handler. Routes packet outcomes to particles, queues, charts, HUD, terminal.
   * @param {Object[]} packets
   * @param {Object}   tickMetrics
   */
  function processTick(packets, tickMetrics) {
    // Update cumulative metrics from worker
    metrics.totalSent      = tickMetrics.totalSent;
    metrics.totalDelivered = tickMetrics.totalDelivered;
    metrics.totalDropped   = tickMetrics.totalDropped;
    metrics.avgLatency     = tickMetrics.avgLatency;

    // Process each packet
    packets.forEach(pkt => routePacket(pkt));

    // Process gateway dequeue (forward buffered packets onward)
    processGatewayDequeue();

    // Update HUD counters
    UIController.updateHUD(metrics);

    // Update charts (throttled)
    ticksSinceChartUpdate++;
    if (ticksSinceChartUpdate >= CHART_UPDATE_EVERY) {
      ChartEngine.update(tickMetrics.lossPercent, tickMetrics.avgLatency);
      ticksSinceChartUpdate = 0;
    }

    // Update gateway node visual state (queue fill bars)
    updateGatewayVisuals();
  }

  /**
   * Routes a single packet: finds its source sensor, gateway, and server,
   * then creates the appropriate particle animation.
   * @param {Object} pkt
   */
  function routePacket(pkt) {
    const sensorNode = currentNodes.find(n => n.id === pkt.sensorId);
    if (!sensorNode) return;

    // Find which gateway this sensor connects to
    const gwLink = currentLinks.find(([from]) => from === pkt.sensorId);
    const gwId   = gwLink ? gwLink[1] : null;
    const gwNode = gwId ? currentNodes.find(n => n.id === gwId) : null;

    // Find the server
    const serverNode = currentNodes.find(n => n.type === 'server');

    if (pkt.status === 'dropped') {
      // ── Dropped at source (packet loss) ───────────────────────────────────
      if (gwNode) {
        // Animate partial journey, then drop
        ParticleEngine.createParticle(sensorNode, gwNode, 'dropped', pkt);
        ParticleEngine.createDropBurst(
          (sensorNode.x + gwNode.x) / 2,
          (sensorNode.y + gwNode.y) / 2
        );
      } else {
        ParticleEngine.createDropBurst(sensorNode.x, sensorNode.y);
      }

      Terminal.log(
        `🔴 DROP  [${pkt.id}] ${sensorNode.label} — packet-loss`,
        'warn',
        pkt
      );

    } else if (pkt.status === 'delivered' && gwNode) {
      // ── Enqueue into gateway ─────────────────────────────────────────────
      const enqueued = GatewayQueue.enqueue(gwId, pkt);

      // Sensor → Gateway particle
      ParticleEngine.createParticle(sensorNode, gwNode, 'in-transit', pkt);

      if (!enqueued) {
        // Buffer overflow or gateway killed
        ParticleEngine.createDropBurst(gwNode.x, gwNode.y);
        Terminal.log(
          `🔴 DROP  [${pkt.id}] ${sensorNode.label} → ${gwNode.label} — ${pkt.dropReason || 'overflow'}`,
          'warn',
          pkt
        );
        metrics.totalDropped++;
        metrics.totalDelivered--;
      } else {
        Terminal.log(
          `🟡 QUEUE [${pkt.id}] ${sensorNode.label} → ${gwNode.label} | val=${pkt.value}${pkt.unit} lat=${pkt.latency}ms`,
          'info',
          pkt
        );
      }
    }
  }

  /**
   * Processes gateway queues: dequeues packets and animates them toward the server.
   */
  function processGatewayDequeue() {
    const serverNode = currentNodes.find(n => n.type === 'server');
    if (!serverNode) return;

    currentNodes.filter(n => n.type === 'gateway').forEach(gw => {
      const batch = GatewayQueue.dequeue(gw.id);
      batch.forEach(pkt => {
        // Gateway → Server particle
        ParticleEngine.createParticle(gw, serverNode, 'delivered', pkt);

        serverNode.received = (serverNode.received || 0) + 1;

        Terminal.log(
          `🟢 DLVR  [${pkt.id}] ${gw.label} → ${serverNode.label} | val=${pkt.value}${pkt.unit} lat=${pkt.latency}ms`,
          'success',
          pkt
        );
      });
    });
  }

  /**
   * Syncs gateway node visual properties (queue fill %, count, killed status)
   * so CanvasEngine can render indicators.
   */
  function updateGatewayVisuals() {
    currentNodes.forEach(node => {
      if (node.type === 'gateway') {
        const q = GatewayQueue.getQueue(node.id);
        if (q) {
          node.queueFill  = GatewayQueue.getFillPercent(node.id);
          node.queueCount = q.buffer.length;
          node.killed     = !q.active;
        }
      }
    });
  }

  // ─── Simulation control ───────────────────────────────────────────────────────

  /**
   * Starts the simulation. Sends START to the worker with current config + sensor list.
   */
  function start() {
    if (isRunning) return;
    isRunning = true;
    isPaused  = false;

    const sensors = currentNodes
      .filter(n => n.type === 'sensor')
      .map(n => ({ id: n.id, sensorType: n.sensorType || 'temperature' }));

    if (sensors.length === 0) {
      Terminal.log('⚠️  No sensor nodes in topology', 'warn');
      return;
    }

    const workerConfig = {
      intervalMs: cfg.intervalMs,
      lossRate:   cfg.lossRate,
      latencyMs:  cfg.latencyMs,
      jitterMs:   cfg.jitterMs,
      sensors,
    };

    if (workerReady && worker) {
      worker.postMessage({ type: 'START', config: workerConfig });
    } else {
      // Fallback inline simulation (no worker)
      startFallbackLoop(workerConfig);
    }
  }

  /**
   * Pauses the simulation.
   */
  function pause() {
    if (!isRunning || isPaused) return;
    isPaused = true;
    if (workerReady && worker) {
      worker.postMessage({ type: 'PAUSE' });
    } else {
      stopFallbackLoop();
    }
  }

  /**
   * Resumes a paused simulation.
   */
  function resume() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    if (workerReady && worker) {
      worker.postMessage({ type: 'RESUME' });
    } else {
      startFallbackLoop({ ...cfg });
    }
  }

  /**
   * Stops and resets the simulation.
   */
  function stop() {
    isRunning = false;
    isPaused  = false;
    if (workerReady && worker) {
      worker.postMessage({ type: 'STOP' });
    } else {
      stopFallbackLoop();
    }
    metrics = { totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 };
    GatewayQueue.clearAll();
    currentNodes.filter(n => n.type === 'gateway').forEach(gw => {
      GatewayQueue.createQueue(gw.id);
      gw.queueFill  = 0;
      gw.queueCount = 0;
      gw.killed     = false;
    });
    const serverNode = currentNodes.find(n => n.type === 'server');
    if (serverNode) serverNode.received = 0;
  }

  // ─── Config setters (forwarded to worker) ────────────────────────────────────

  function setLoss(val) {
    cfg.lossRate = val;
    postToWorker('SET_LOSS', val);
  }

  function setLatency(val) {
    cfg.latencyMs = val;
    postToWorker('SET_LATENCY', val);
  }

  function setJitter(val) {
    cfg.jitterMs = val;
    postToWorker('SET_JITTER', val);
  }

  function setSurge(val) {
    cfg.isSurge = val;
    postToWorker('SET_SURGE', val);
  }

  function setSpeed(mult) {
    cfg.speedMult = mult;
    postToWorker('SET_SPEED', mult);
  }

  function markGatewayKilled(gwId, killed) {
    const node = currentNodes.find(n => n.id === gwId);
    if (node) node.killed = killed;
  }

  function postToWorker(type, value) {
    if (workerReady && worker) {
      worker.postMessage({ type, value });
    }
  }

  // ─── Topology management ──────────────────────────────────────────────────────

  /**
   * Called by Scenarios when a new topology is loaded.
   * @param {Object[]} nodes
   * @param {Array[]}  links
   */
  function onTopologyChanged(nodes, links) {
    currentNodes = nodes;
    currentLinks = links;
    if (isRunning) {
      // Restart worker with new sensor list
      stop();
    }
  }

  // ─── Fallback simulation (no Web Worker) ─────────────────────────────────────

  let fallbackLoopId   = null;
  let fallbackCounters = { totalSent: 0, totalDelivered: 0, totalDropped: 0, latencies: [] };

  function startFallbackLoop(config) {
    stopFallbackLoop();
    const interval = Math.max(50, config.intervalMs / (cfg.speedMult || 1));

    fallbackLoopId = setInterval(() => {
      const packets = [];

      config.sensors.forEach(sensor => {
        const pkt = generateFallbackPacket(sensor);
        packets.push(pkt);
        fallbackCounters.totalSent++;
        if (pkt.status === 'dropped') {
          fallbackCounters.totalDropped++;
        } else {
          fallbackCounters.totalDelivered++;
          fallbackCounters.latencies.push(pkt.latency);
          if (fallbackCounters.latencies.length > 100) {
            fallbackCounters.latencies.shift();
          }
        }
      });

      const avgLatency   = fallbackCounters.latencies.length > 0
        ? fallbackCounters.latencies.reduce((a, b) => a + b, 0) / fallbackCounters.latencies.length
        : 0;
      const lossPercent  = fallbackCounters.totalSent > 0
        ? (fallbackCounters.totalDropped / fallbackCounters.totalSent) * 100
        : 0;

      processTick(packets, {
        lossPercent:    parseFloat(lossPercent.toFixed(2)),
        avgLatency:     parseFloat(avgLatency.toFixed(2)),
        totalSent:      fallbackCounters.totalSent,
        totalDelivered: fallbackCounters.totalDelivered,
        totalDropped:   fallbackCounters.totalDropped,
      });
    }, interval);
  }

  function stopFallbackLoop() {
    if (fallbackLoopId !== null) {
      clearInterval(fallbackLoopId);
      fallbackLoopId = null;
      fallbackCounters = { totalSent: 0, totalDelivered: 0, totalDropped: 0, latencies: [] };
    }
  }

  let fallbackPktId = 0;
  function generateFallbackPacket(sensor) {
    fallbackPktId++;
    const lossProb = cfg.lossRate / 100;
    const isDropped = Math.random() < lossProb;
    const jitter  = (Math.random() + Math.random() - 1) * cfg.jitterMs;
    const latency = Math.max(1, Math.round(cfg.latencyMs + jitter));
    const valueRanges = { temperature: [15, 85], humidity: [10, 95], pressure: [900, 1100] };
    const [min, max]  = valueRanges[sensor.sensorType] || [0, 100];
    const units = { temperature: '°C', humidity: '%', pressure: 'hPa' };

    return {
      id:         `PKT-${String(fallbackPktId).padStart(5, '0')}`,
      sensorId:   sensor.id,
      sensorType: sensor.sensorType,
      value:      parseFloat((Math.random() * (max - min) + min).toFixed(2)),
      unit:       units[sensor.sensorType] || '',
      timestamp:  Date.now(),
      status:     isDropped ? 'dropped' : 'delivered',
      latency:    isDropped ? 0 : latency,
      dropReason: isDropped ? 'packet-loss' : null,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    initWorker,
    start,
    pause,
    resume,
    stop,
    setLoss,
    setLatency,
    setJitter,
    setSurge,
    setSpeed,
    markGatewayKilled,
    onTopologyChanged,
    getMetrics:  () => ({ ...metrics }),
    isActive:    () => isRunning && !isPaused,
  };
})();

// ─── App Bootstrap ────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // 1. Initialise canvas engine (George)
  CanvasEngine.init('networkCanvas');

  // 2. Bind drag and drop (Naveen)
  DragEngine.bindEvents(document.getElementById('networkCanvas'));

  // 3. Initialise terminal first (Ameen) — so all subsequent logs appear
  Terminal.init();

  // 4. Initialise charts (Aditya)
  ChartEngine.init();

  // 5. Initialise UI controls (Levin)
  UIController.init();

  // 6. Initialise chaos controls (Jebin)
  ChaosEngine.init();

  // 7. Load default preset — Smart Factory (Adithyan)
  //    This calls CanvasEngine.setTopology(), GatewayQueue.createQueue(), ChaosEngine.applyConfig()
  Scenarios.load('smart-factory');

  // 8. Start Web Worker (Joel)
  SimEngine.initWorker();

  // 9. Start particle animation loop (Abhiram)
  //    Loop starts but pauses immediately; Start button triggers it
  ParticleEngine.start();
  ParticleEngine.pause(); // Wait for user to press Start

  Terminal.log('🚀 IoT Network Simulator ready — press ▶ Start to begin', 'success');
  Terminal.log('   Team: Joel · George · Abhiram · Naveen · Abhishek · Anand · Levin · Aditya · Jebin · Adithyan · Ameen', 'debug');
});
