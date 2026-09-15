/**
 * @module gateway
 * @author Anand S
 * @description Gateway Queue Logic: Client-side FIFO array queue per gateway node.
 *              Handles rate-limiting, processing speeds, and buffer overflow drop logic.
 */

const GatewayQueue = (() => {
  'use strict';

  /** Maximum number of packets a gateway buffer can hold before dropping */
  const DEFAULT_GATEWAY_CAP = 20;

  /** How many packets a gateway processes per dequeue call (rate limiting) */
  const PROCESS_BATCH = 3;

  /** Map of gatewayId → queue state object */
  const queues = new Map();
  const capacities = new Map(); // id -> capacity

  /**
   * Creates and registers a new FIFO queue for a gateway.
   * @param {string} gatewayId
   * @param {number} [capacity] - defaults to 20
   */
  function createQueue(gatewayId, capacity) {
    const cap = capacity || DEFAULT_GATEWAY_CAP;
    capacities.set(gatewayId, cap);
    queues.set(gatewayId, {
      id:        gatewayId,
      buffer:    [],       // Packet array (FIFO)
      dropped:   0,        // Cumulative overflow drops
      processed: 0,        // Cumulative packets forwarded
      active:    true,     // false when gateway is killed
      capacity:  cap,
    });
  }

  function removeQueue(gatewayId) {
    queues.delete(gatewayId);
    capacities.delete(gatewayId);
  }

  function getCapacity(gatewayId) {
    if (capacities.has(gatewayId)) return capacities.get(gatewayId);
    const q = queues.get(gatewayId);
    return q ? (q.capacity || DEFAULT_GATEWAY_CAP) : DEFAULT_GATEWAY_CAP;
  }

  /**
   * Removes all queues (used on reset).
   */
  function clearAll() {
    queues.clear();
  }

  /**
   * Attempts to enqueue a packet into the gateway's buffer.
   * @param {string} gatewayId
   * @param {Object} packet
   * @returns {boolean} true if enqueued, false if dropped due to overflow / gateway killed
   */
  function enqueue(gatewayId, packet) {
    const queue = queues.get(gatewayId);
    if (!queue) return false;

    // CoAP dedup: (source_mac, MID) 10s ring — duplicates never forward
    try {
      if (packet && packet.coap && packet.coap.mid !== undefined && packet.srcMac) {
        if (CoAP.checkDuplicate(packet.srcMac, packet.coap.mid)) {
          packet.status = 'dropped';
          packet.dropReason = 'coap-duplicate';
          packet.coapDuplicate = true;
          queue.dropped++;
          return false;
        }
      }
    } catch (e) { /* CoAP not loaded in some contexts */ }

    // If gateway is killed, drop the packet
    if (!queue.active) {
      packet.status = 'dropped';
      packet.dropReason = 'gateway-killed';
      queue.dropped++;
      return false;
    }

    // Buffer overflow check (capacity 20)
    const cap = queue.capacity || getCapacity(gatewayId);
    if (queue.buffer.length >= cap) {
      packet.status = 'dropped';
      packet.dropReason = 'buffer-overflow';
      queue.dropped++;
      return false;
    }

    packet.status = 'queued';
    queue.buffer.push(packet);
    return true;
  }

  /**
   * Dequeues up to PROCESS_BATCH packets from a gateway (FIFO order).
   * @param {string} gatewayId
   * @returns {Object[]} Array of processed packets (may be empty)
   */
  function dequeue(gatewayId) {
    const queue = queues.get(gatewayId);
    if (!queue || !queue.active) return [];

    const batch = [];
    for (let i = 0; i < PROCESS_BATCH; i++) {
      const pkt = queue.buffer.shift();
      if (!pkt) break;
      pkt.status = 'delivered';
      queue.processed++;
      batch.push(pkt);
    }
    return batch;
  }

  /**
   * Returns the current queue state for a gateway.
   * @param {string} gatewayId
   * @returns {Object|null}
   */
  function getQueue(gatewayId) {
    return queues.get(gatewayId) || null;
  }

  /**
   * Returns current buffer fill percentage for a gateway (0–100).
   * @param {string} gatewayId
   * @returns {number}
   */
  function getFillPercent(gatewayId) {
    const queue = queues.get(gatewayId);
    if (!queue) return 0;
    const cap = queue.capacity || getCapacity(gatewayId);
    return Math.round((queue.buffer.length / cap) * 100);
  }

  /**
   * Kills a gateway (sets active = false, drops all buffered packets).
   * @param {string} gatewayId
   */
  function killGateway(gatewayId) {
    const queue = queues.get(gatewayId);
    if (!queue) return;
    queue.active = false;
    queue.dropped += queue.buffer.length;
    queue.buffer = [];
  }

  /**
   * Restores a previously killed gateway.
   * @param {string} gatewayId
   */
  function restoreGateway(gatewayId) {
    const queue = queues.get(gatewayId);
    if (!queue) return;
    queue.active = true;
  }

  /**
   * Returns aggregate stats across all gateways.
   * @returns {{ totalQueued: number, totalDropped: number, totalProcessed: number }}
   */
  function getAggregateStats() {
    let totalQueued = 0, totalDropped = 0, totalProcessed = 0;
    queues.forEach(q => {
      totalQueued    += q.buffer.length;
      totalDropped   += q.dropped;
      totalProcessed += q.processed;
    });
    return { totalQueued, totalDropped, totalProcessed };
  }

  return {
    createQueue,
    removeQueue,
    getCapacity,
    clearAll,
    enqueue,
    dequeue,
    getQueue,
    getFillPercent,
    killGateway,
    restoreGateway,
    getAggregateStats,
    QUEUE_CAPACITY: DEFAULT_GATEWAY_CAP,
    getAllQueues: () => queues,
  };
})();
