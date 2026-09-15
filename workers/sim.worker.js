/**
 * @file sim.worker.js
 * @description Background tick loop M3: emits CoAP readings (NON default, CON on
 *              Temp>75 / Pressure>1060 alarms) with 16-bit MID + 32-bit Token,
 *              TTL=5. Applies global lossRate + latency/jitter. Link states,
 *              battery, dedup, routing applied main-thread (has graph).
 *              Message API unchanged + sensors carry sensorType.
 */

'use strict';

let loopId = null;
let tickCount = 0;
let isSurge = false;
let speedMult = 1;

let config = { intervalMs: 800, lossRate: 5, latencyMs: 80, jitterMs: 20, sensors: [] };
let totalSent = 0, totalDelivered = 0, totalDropped = 0;
let latencySamples = [];
let midCounter = Math.floor(Math.random() * 0xFFFF);

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'START':
      config = { ...config, ...msg.config };
      resetMetrics();
      startLoop();
      self.postMessage({ type: 'READY' });
      break;
    case 'PAUSE': stopLoop(); break;
    case 'RESUME': startLoop(); break;
    case 'STOP': stopLoop(); resetMetrics(); break;
    case 'SET_LOSS': config.lossRate = clamp(msg.value, 0, 100); break;
    case 'SET_LATENCY': config.latencyMs = Math.max(0, msg.value); break;
    case 'SET_JITTER': config.jitterMs = Math.max(0, msg.value); break;
    case 'SET_SURGE': isSurge = !!msg.value; break;
    case 'SET_SPEED':
      speedMult = Math.max(0.1, msg.value);
      if (loopId !== null) { stopLoop(); startLoop(); }
      break;
    default: break;
  }
};

function startLoop() {
  if (loopId !== null) return;
  const interval = Math.max(50, config.intervalMs / speedMult);
  loopId = setInterval(tick, interval);
}
function stopLoop() { if (loopId !== null) { clearInterval(loopId); loopId = null; } }
function resetMetrics() { tickCount = 0; totalSent = 0; totalDelivered = 0; totalDropped = 0; latencySamples = []; }

function tick() {
  tickCount++;
  const packets = [];
  config.sensors.forEach(sensor => {
    const count = isSurge ? Math.ceil(Math.random() * 3) + 1 : 1;
    for (let i = 0; i < count; i++) packets.push(generatePacket(sensor));
  });
  const tickDelivered = packets.filter(p => p.status === 'delivered').length;
  const tickDropped = packets.filter(p => p.status === 'dropped').length;
  const tickLatencies = packets.filter(p => p.status === 'delivered').map(p => p.latency);
  totalSent += packets.length; totalDelivered += tickDelivered; totalDropped += tickDropped;
  latencySamples.push(...tickLatencies);
  if (latencySamples.length > 200) latencySamples = latencySamples.slice(-200);
  const avgLatency = latencySamples.length ? latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length : 0;
  const lossPercent = totalSent ? (totalDropped / totalSent) * 100 : 0;
  self.postMessage({
    type: 'TICK', packets,
    metrics: {
      lossPercent: parseFloat(lossPercent.toFixed(2)),
      avgLatency: parseFloat(avgLatency.toFixed(2)),
      totalSent, totalDelivered, totalDropped,
    },
  });
}

let packetIdCounter = 0;
function generatePacket(sensor) {
  packetIdCounter++;
  midCounter = (midCounter + 1) & 0xFFFF;
  const value = generateSensorValue(sensor.sensorType);
  const isAlarm = (sensor.sensorType === 'temperature' && value > 75) || (sensor.sensorType === 'pressure' && value > 1060);
  const lossProb = config.lossRate / 100;
  const isDropped = Math.random() < lossProb;
  const jitter = (Math.random() + Math.random() - 1) * config.jitterMs;
  const latency = Math.max(1, Math.round(config.latencyMs + jitter));
  const token = '0x' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, '0');
  return {
    id: `PKT-${String(packetIdCounter).padStart(5, '0')}`,
    sensorId: sensor.id, sensorType: sensor.sensorType,
    value: parseFloat(value.toFixed(2)), unit: getSensorUnit(sensor.sensorType),
    timestamp: Date.now(),
    status: isDropped ? 'dropped' : 'delivered',
    latency: isDropped ? 0 : latency,
    dropReason: isDropped ? 'packet-loss' : null,
    isAlarm,
    udpSrc: 5683, udpDst: 5683,
    ttl: 5, hops: 0,
    coap: {
      ver: 1, type: isAlarm ? 0 : 1, typeName: isAlarm ? 'CON' : 'NON',
      code: '0.02 POST', mid: midCounter, token,
      uriPath: isAlarm ? '/alerts' : '/telemetry',
      ttl: 5, hops: 0,
      payload: { id: sensor.id, type: sensor.sensorType, val: parseFloat(value.toFixed(2)), unit: getSensorUnit(sensor.sensorType), ts: Math.floor(Date.now() / 1000) },
    },
    coapType: isAlarm ? 'CON' : 'NON',
  };
}

function generateSensorValue(type) {
  switch (type) {
    case 'temperature': return randomInRange(15, 85);
    case 'humidity': return randomInRange(10, 95);
    case 'pressure': return randomInRange(900, 1100);
    default: return randomInRange(0, 100);
  }
}
function getSensorUnit(type) {
  const units = { temperature: '°C', humidity: '%', pressure: 'hPa' };
  return units[type] || '';
}
function randomInRange(min, max) { return Math.random() * (max - min) + min; }
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
