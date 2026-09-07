/**
 * @file sim.worker.js
 * @author Joel Lijo Mathew (Team Lead)
 * @description Background Web Worker: Runs the simulation physics loop off the main thread,
 *              preventing UI jank. Manages packet generation timing, applies loss rate
 *              probability, calculates latency with jitter, and posts TICK results back to
 *              the main thread every interval cycle.
 *
 *              Message API (from main → worker):
 *                { type: 'START',       config: { intervalMs, lossRate, latencyMs, jitterMs, sensors: [] } }
 *                { type: 'PAUSE'  }
 *                { type: 'RESUME' }
 *                { type: 'STOP'   }
 *                { type: 'SET_LOSS',    value: number }   // 0–100
 *                { type: 'SET_LATENCY', value: number }   // ms
 *                { type: 'SET_JITTER',  value: number }   // ms
 *                { type: 'SET_SURGE',   value: boolean }
 *                { type: 'SET_SPEED',   value: number }   // multiplier
 *
 *              Message API (worker → main):
 *                { type: 'TICK',    packets: [...], metrics: { lossPercent, avgLatency, totalSent, totalDelivered, totalDropped } }
 *                { type: 'READY' }
 */

'use strict';

// ─── Worker state ─────────────────────────────────────────────────────────────

let loopId       = null;
let tickCount    = 0;
let isSurge      = false;
let speedMult    = 1;

let config = {
  intervalMs: 800,
  lossRate:   5,     // 0–100 %
  latencyMs:  80,    // base latency
  jitterMs:   20,    // ±jitter
  sensors:    [],    // [{ id, sensorType }]
};

// Running metrics (reset on stop/start)
let totalSent      = 0;
let totalDelivered = 0;
let totalDropped   = 0;
let latencySamples = [];

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const msg = e.data;

  switch (msg.type) {
    case 'START':
      config = { ...config, ...msg.config };
      resetMetrics();
      startLoop();
      self.postMessage({ type: 'READY' });
      break;

    case 'PAUSE':
      stopLoop();
      break;

    case 'RESUME':
      startLoop();
      break;

    case 'STOP':
      stopLoop();
      resetMetrics();
      break;

    case 'SET_LOSS':
      config.lossRate = clamp(msg.value, 0, 100);
      break;

    case 'SET_LATENCY':
      config.latencyMs = Math.max(0, msg.value);
      break;

    case 'SET_JITTER':
      config.jitterMs = Math.max(0, msg.value);
      break;

    case 'SET_SURGE':
      isSurge = !!msg.value;
      break;

    case 'SET_SPEED':
      speedMult = Math.max(0.1, msg.value);
      // Restart loop with adjusted interval
      if (loopId !== null) {
        stopLoop();
        startLoop();
      }
      break;

    default:
      // Unknown message — ignore
      break;
  }
};

// ─── Loop management ──────────────────────────────────────────────────────────

function startLoop() {
  if (loopId !== null) return; // Already running
  const interval = Math.max(50, config.intervalMs / speedMult);
  loopId = setInterval(tick, interval);
}

function stopLoop() {
  if (loopId !== null) {
    clearInterval(loopId);
    loopId = null;
  }
}

function resetMetrics() {
  tickCount      = 0;
  totalSent      = 0;
  totalDelivered = 0;
  totalDropped   = 0;
  latencySamples = [];
}

// ─── Tick logic ───────────────────────────────────────────────────────────────

/**
 * Called every interval. Generates packets for all sensors, applies physics,
 * and posts results back to main thread.
 */
function tick() {
  tickCount++;

  const surgeMultiplier = isSurge ? 10 : 1;
  const packets = [];

  config.sensors.forEach(sensor => {
    // Under surge: multiple packets per tick per sensor
    const count = isSurge ? Math.ceil(Math.random() * 3) + 1 : 1;

    for (let i = 0; i < count; i++) {
      const pkt = generatePacket(sensor);
      packets.push(pkt);
    }
  });

  // Calculate aggregated metrics for this tick
  const tickDelivered  = packets.filter(p => p.status === 'delivered').length;
  const tickDropped    = packets.filter(p => p.status === 'dropped').length;
  const tickLatencies  = packets.filter(p => p.status === 'delivered').map(p => p.latency);

  totalSent      += packets.length;
  totalDelivered += tickDelivered;
  totalDropped   += tickDropped;
  latencySamples.push(...tickLatencies);

  // Keep latency samples bounded
  if (latencySamples.length > 200) {
    latencySamples = latencySamples.slice(-200);
  }

  const avgLatency   = latencySamples.length > 0
    ? latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length
    : 0;

  const lossPercent  = totalSent > 0
    ? (totalDropped / totalSent) * 100
    : 0;

  // Post tick to main thread
  self.postMessage({
    type: 'TICK',
    packets,
    metrics: {
      lossPercent:    parseFloat(lossPercent.toFixed(2)),
      avgLatency:     parseFloat(avgLatency.toFixed(2)),
      totalSent,
      totalDelivered,
      totalDropped,
    },
  });
}

// ─── Packet physics ───────────────────────────────────────────────────────────

let packetIdCounter = 0;

/**
 * Generates a single packet for a sensor, applying loss probability and latency.
 * @param {{ id: string, sensorType: string }} sensor
 * @returns {Object} Packet
 */
function generatePacket(sensor) {
  packetIdCounter++;

  // Value ranges per sensor type
  const value = generateSensorValue(sensor.sensorType);

  // Loss rate check (as probability)
  const lossProb = config.lossRate / 100;
  const isDropped = Math.random() < lossProb;

  // Latency with jitter (Gaussian-like using 2× uniform sum)
  const jitter  = (Math.random() + Math.random() - 1) * config.jitterMs;
  const latency = Math.max(1, Math.round(config.latencyMs + jitter));

  return {
    id:         `PKT-${String(packetIdCounter).padStart(5, '0')}`,
    sensorId:   sensor.id,
    sensorType: sensor.sensorType,
    value:      parseFloat(value.toFixed(2)),
    unit:       getSensorUnit(sensor.sensorType),
    timestamp:  Date.now(),
    status:     isDropped ? 'dropped' : 'delivered',
    latency:    isDropped ? 0 : latency,
    dropReason: isDropped ? 'packet-loss' : null,
  };
}

/**
 * Generates a realistic sensor value within the appropriate range.
 */
function generateSensorValue(type) {
  switch (type) {
    case 'temperature': return randomInRange(15, 85);
    case 'humidity':    return randomInRange(10, 95);
    case 'pressure':    return randomInRange(900, 1100);
    default:            return randomInRange(0, 100);
  }
}

function getSensorUnit(type) {
  const units = { temperature: '°C', humidity: '%', pressure: 'hPa' };
  return units[type] || '';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
