/**
 * @module battery
 * @description Sensor discharge physics (M3). Sensors only; gateways/servers mains.
 *              0.5%/tx, <15% low-power (20% TX rate, opacity 0.4), 0% dead grey halt.
 *              Fast-Drain 10x toggle for demos. Instant Replace Battery -> 100%.
 */

const BatteryEngine = (() => {
  'use strict';

  const DRAIN_PER_TX = 0.5;
  const LOW_THRESHOLD = 15;
  const LOW_TX_DIVISOR = 5; // 20% frequency
  let fastDrain = false;
  let txCounts = new Map();

  function isMains(node) { return node && node.type !== 'sensor'; }
  function getBattery(node) { return isMains(node) ? Infinity : (node.battery ?? 100); }

  /** Returns {allowed, reason} — called per emission. Handles drain + low-power gating. */
  function beforeTransmit(node, tickCount) {
    if (!node || isMains(node)) return { allowed: true };
    if (node.dead || node.battery <= 0) { node.battery = 0; node.dead = true; return { allowed: false, reason: 'battery-dead' }; }
    if (node.lowPower) {
      if ((tickCount % LOW_TX_DIVISOR) !== 0) return { allowed: false, reason: 'low-power-skip' };
    }
    return { allowed: true };
  }
  function afterTransmit(node) {
    if (!node || isMains(node)) return;
    const drain = DRAIN_PER_TX * (fastDrain ? 10 : 1);
    node.battery = Math.max(0, parseFloat(((node.battery ?? 100) - drain).toFixed(2)));
    txCounts.set(node.id, (txCounts.get(node.id) || 0) + 1);
    if (node.battery <= 0) { node.dead = true; node.lowPower = false; }
    else if (node.battery < LOW_THRESHOLD) { node.lowPower = true; }
    try { MetricsRegistry.setGauge('iot_node_battery', { topology: MetricsRegistry.getTopology(), node_id: node.id }, node.battery); } catch (e) {}
  }
  function replaceBattery(id) {
    const n = GraphStore.getNode(id);
    if (!n || isMains(n)) return false;
    n.battery = 100; n.dead = false; n.lowPower = false;
    try { MetricsRegistry.setGauge('iot_node_battery', { topology: MetricsRegistry.getTopology(), node_id: id }, 100); } catch (e) {}
    Terminal.log(`🔋 Battery replaced on ${id} → 100%`, 'success');
    return true;
  }
  function resetNode(id) { txCounts.delete(id); }
  function resetAll() { txCounts.clear(); fastDrain = false; }
  function setFastDrain(v) {
    fastDrain = !!v;
    Terminal.log(`🔋 Fast-Drain ${fastDrain ? 'ON (10×)' : 'OFF'}`, 'debug');
    return fastDrain;
  }

  return {
    DRAIN_PER_TX, LOW_THRESHOLD, beforeTransmit, afterTransmit,
    replaceBattery, resetNode, resetAll, setFastDrain,
    isFastDrain: () => fastDrain, isMains, getBattery,
  };
})();
