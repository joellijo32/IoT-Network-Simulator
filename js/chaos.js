/**
 * @module chaos
 * @author Jebin Thankachen Sabu
 * @description Chaos Engineering Controls: Wires up UI sliders for live Packet Loss % and
 *              Latency/Jitter adjustments. Provides "Kill Gateway" and "Traffic Surge" fault
 *              injection buttons with auto-recovery timers.
 */

const ChaosEngine = (() => {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────

  let lossRate  = 5;    // 0–100 %
  let latencyMs = 80;   // Base latency in ms
  let jitterMs  = 20;   // ±jitter range in ms
  let isSurge   = false;

  const killedGateways = new Set(); // Set of gateway IDs currently offline
  const surgeTimeouts  = new Map(); // Active restore timers

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Binds all chaos control UI elements to their handlers.
   * Must be called after DOM is ready.
   */
  function init() {
    bindSlider('slider-loss',    onLossChange,    lossRate);
    bindSlider('slider-latency', onLatencyChange, latencyMs);
    bindSlider('slider-jitter',  onJitterChange,  jitterMs);

    const btnKill  = document.getElementById('btn-kill-gateway');
    const btnSurge = document.getElementById('btn-traffic-surge');

    if (btnKill)  btnKill.addEventListener('click',  onKillGateway);
    if (btnSurge) btnSurge.addEventListener('click', onTrafficSurge);
  }

  /**
   * Wires a slider to a handler and sets its initial value.
   * @param {string}   id        - Slider element ID
   * @param {Function} handler   - Change handler
   * @param {number}   initValue - Initial value
   */
  function bindSlider(id, handler, initValue) {
    const slider = document.getElementById(id);
    const output = document.getElementById(id + '-val');
    if (!slider) return;
    slider.value = initValue;
    if (output) output.textContent = formatSliderValue(id, initValue);
    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (output) output.textContent = formatSliderValue(id, val);
      handler(val);
    });
  }

  /**
   * Formats slider display values with appropriate units.
   */
  function formatSliderValue(id, val) {
    if (id === 'slider-loss')    return val.toFixed(0) + '%';
    if (id === 'slider-latency') return val.toFixed(0) + ' ms';
    if (id === 'slider-jitter')  return val.toFixed(0) + ' ms';
    return val;
  }

  // ─── Slider handlers ─────────────────────────────────────────────────────────

  function onLossChange(val) {
    lossRate = val;
    SimEngine.setLoss(val);
    updateLossVisual(val);
    Terminal.log(`🎚 Packet Loss Rate → ${val.toFixed(0)}%`, 'debug');
  }

  function onLatencyChange(val) {
    latencyMs = val;
    SimEngine.setLatency(val);
    Terminal.log(`🎚 Base Latency → ${val.toFixed(0)} ms`, 'debug');
  }

  function onJitterChange(val) {
    jitterMs = val;
    SimEngine.setJitter(val);
    Terminal.log(`🎚 Jitter → ±${val.toFixed(0)} ms`, 'debug');
  }

  /**
   * Updates the loss slider track colour based on severity.
   */
  function updateLossVisual(val) {
    const slider = document.getElementById('slider-loss');
    if (!slider) return;
    if (val < 20)       slider.style.accentColor = '#4CAF50';
    else if (val < 50)  slider.style.accentColor = '#FF9800';
    else                slider.style.accentColor = '#F44336';
  }

  // ─── Fault injection ─────────────────────────────────────────────────────────

  /**
   * Kills the first non-killed gateway. Auto-restores after 8 seconds.
   */
  function onKillGateway() {
    const nodes   = CanvasEngine.getNodes();
    const gateways = nodes.filter(n => n.type === 'gateway' && !killedGateways.has(n.id));

    if (gateways.length === 0) {
      Terminal.log('⚠️  No active gateways to kill', 'warn');
      return;
    }

    // Cycle through gateways in order
    const gw = gateways[0];
    killGateway(gw.id);
  }

  /**
   * Deactivates a gateway node for 8 seconds, then auto-restores.
   * @param {string} gwId
   */
  function killGateway(gwId) {
    if (killedGateways.has(gwId)) return;

    killedGateways.add(gwId);
    GatewayQueue.killGateway(gwId);
    SimEngine.markGatewayKilled(gwId, true);

    Terminal.log(`💀 FAULT INJECTED — Gateway "${gwId}" killed (8s)`, 'error');

    // Auto-restore after 8 seconds
    const timer = setTimeout(() => {
      restoreGateway(gwId);
    }, 8000);
    surgeTimeouts.set(gwId, timer);

    updateKillButton();
  }

  /**
   * Restores a killed gateway.
   * @param {string} gwId
   */
  function restoreGateway(gwId) {
    killedGateways.delete(gwId);
    GatewayQueue.restoreGateway(gwId);
    SimEngine.markGatewayKilled(gwId, false);
    Terminal.log(`✅ Gateway "${gwId}" restored`, 'success');
    updateKillButton();
  }

  /**
   * Spikes all sensor emission rates 10× for 6 seconds.
   */
  function onTrafficSurge() {
    if (isSurge) {
      Terminal.log('⚠️  Traffic surge already active', 'warn');
      return;
    }

    isSurge = true;
    SimEngine.setSurge(true);
    Terminal.log('🚨 TRAFFIC SURGE — 10× emission rate for 6s!', 'error');

    const btn = document.getElementById('btn-traffic-surge');
    if (btn) {
      btn.classList.add('active');
      btn.disabled = true;
    }

    setTimeout(() => {
      isSurge = false;
      SimEngine.setSurge(false);
      Terminal.log('✅ Traffic surge ended — returning to normal rate', 'success');
      if (btn) {
        btn.classList.remove('active');
        btn.disabled = false;
      }
    }, 6000);
  }

  /**
   * Updates Kill Gateway button text to reflect current state.
   */
  function updateKillButton() {
    const btn = document.getElementById('btn-kill-gateway');
    if (!btn) return;
    const allGateways = CanvasEngine.getNodes().filter(n => n.type === 'gateway');
    const anyKilled   = allGateways.some(n => killedGateways.has(n.id));
    btn.textContent   = anyKilled ? '♻️ Restore Gateway' : '💀 Kill Gateway';
    btn.onclick       = anyKilled ? onRestoreAll : onKillGateway;
  }

  function onRestoreAll() {
    [...killedGateways].forEach(id => {
      clearTimeout(surgeTimeouts.get(id));
      surgeTimeouts.delete(id);
      restoreGateway(id);
    });
  }

  /**
   * Resets all chaos state (used on simulation reset).
   */
  function resetAll() {
    onRestoreAll();
    isSurge = false;
    SimEngine.setSurge(false);
    // Reset sliders to default values via synthetic events if needed
  }

  /**
   * Applies chaos config programmatically (used by Scenarios module).
   * @param {{ loss: number, latency: number, jitter: number }} config
   */
  function applyConfig({ loss = 5, latency = 80, jitter = 20 } = {}) {
    // Update internal state
    lossRate  = loss;
    latencyMs = latency;
    jitterMs  = jitter;

    // Sync sliders
    setSlider('slider-loss',    loss);
    setSlider('slider-latency', latency);
    setSlider('slider-jitter',  jitter);

    // Apply to sim engine
    SimEngine.setLoss(loss);
    SimEngine.setLatency(latency);
    SimEngine.setJitter(jitter);
    updateLossVisual(loss);
  }

  function setSlider(id, val) {
    const slider = document.getElementById(id);
    const output = document.getElementById(id + '-val');
    if (slider) slider.value = val;
    if (output) output.textContent = formatSliderValue(id, val);
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    init,
    applyConfig,
    resetAll,
    killGateway,
    restoreGateway,
    isKilled:    (id) => killedGateways.has(id),
    getLoss:     () => lossRate,
    getLatency:  () => latencyMs,
    getJitter:   () => jitterMs,
    isSurging:   () => isSurge,
  };
})();
