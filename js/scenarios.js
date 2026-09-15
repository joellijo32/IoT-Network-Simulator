/**
 * @module scenarios
 * @description Preset topologies (M2: routed through GraphStore with auto IP/MAC).
 */

const Scenarios = (() => {
  'use strict';

  const presets = {
    'smart-factory': {
      name: 'Smart Factory', description: 'Industrial IoT with temperature & pressure sensors', icon: '🏭',
      nodes: [
        { id: 's1', type: 'sensor', label: 'Temp-A', sensorType: 'temperature', x: 110, y: 140 },
        { id: 's2', type: 'sensor', label: 'Hum-B', sensorType: 'humidity', x: 110, y: 280 },
        { id: 's3', type: 'sensor', label: 'Press-C', sensorType: 'pressure', x: 110, y: 420 },
        { id: 's4', type: 'sensor', label: 'Temp-D', sensorType: 'temperature', x: 110, y: 560 },
        { id: 'g1', type: 'gateway', label: 'GW-Alpha', x: 360, y: 210 },
        { id: 'g2', type: 'gateway', label: 'GW-Beta', x: 360, y: 490 },
        { id: 'sv', type: 'server', label: 'Cloud Server', x: 610, y: 350 },
      ],
      links: [['s1', 'g1'], ['s2', 'g1'], ['s3', 'g2'], ['s4', 'g2'], ['g1', 'sv'], ['g2', 'sv']],
      chaos: { loss: 5, latency: 80, jitter: 20 },
    },
    'unstable-wireless': {
      name: 'Unstable Wireless', description: 'High packet loss & jitter — stress test', icon: '📡',
      nodes: [
        { id: 's1', type: 'sensor', label: 'Temp-1', sensorType: 'temperature', x: 100, y: 120 },
        { id: 's2', type: 'sensor', label: 'Hum-2', sensorType: 'humidity', x: 100, y: 240 },
        { id: 's3', type: 'sensor', label: 'Press-3', sensorType: 'pressure', x: 100, y: 360 },
        { id: 's4', type: 'sensor', label: 'Temp-4', sensorType: 'temperature', x: 100, y: 480 },
        { id: 's5', type: 'sensor', label: 'Hum-5', sensorType: 'humidity', x: 100, y: 600 },
        { id: 'g1', type: 'gateway', label: 'GW-North', x: 370, y: 240 },
        { id: 'g2', type: 'gateway', label: 'GW-South', x: 370, y: 480 },
        { id: 'sv', type: 'server', label: 'Edge Server', x: 630, y: 360 },
      ],
      links: [['s1', 'g1'], ['s2', 'g1'], ['s3', 'g1'], ['s4', 'g2'], ['s5', 'g2'], ['g1', 'sv'], ['g2', 'sv']],
      chaos: { loss: 40, latency: 250, jitter: 100 },
    },
    'smart-city': {
      name: 'Smart City', description: 'Urban IoT grid', icon: '🌆',
      nodes: [
        { id: 's1', type: 'sensor', label: 'AQ-N1', sensorType: 'pressure', x: 90, y: 100 },
        { id: 's2', type: 'sensor', label: 'Temp-N2', sensorType: 'temperature', x: 90, y: 210 },
        { id: 's3', type: 'sensor', label: 'Hum-C1', sensorType: 'humidity', x: 90, y: 340 },
        { id: 's4', type: 'sensor', label: 'Press-C2', sensorType: 'pressure', x: 90, y: 450 },
        { id: 's5', type: 'sensor', label: 'Temp-S1', sensorType: 'temperature', x: 90, y: 570 },
        { id: 's6', type: 'sensor', label: 'Hum-S2', sensorType: 'humidity', x: 90, y: 660 },
        { id: 's7', type: 'sensor', label: 'AQ-E1', sensorType: 'pressure', x: 230, y: 150 },
        { id: 's8', type: 'sensor', label: 'AQ-E2', sensorType: 'pressure', x: 230, y: 600 },
        { id: 'g1', type: 'gateway', label: 'GW-North', x: 400, y: 155 },
        { id: 'g2', type: 'gateway', label: 'GW-Central', x: 400, y: 390 },
        { id: 'g3', type: 'gateway', label: 'GW-South', x: 400, y: 625 },
        { id: 'sv', type: 'server', label: 'City Hub', x: 620, y: 390 },
      ],
      links: [
        ['s1', 'g1'], ['s2', 'g1'], ['s7', 'g1'], ['s3', 'g2'], ['s4', 'g2'],
        ['s5', 'g3'], ['s6', 'g3'], ['s8', 'g3'],
        ['g1', 'sv'], ['g2', 'sv'], ['g3', 'sv'],
      ],
      chaos: { loss: 15, latency: 120, jitter: 50 },
    },
  };

  const SENSOR_ICONS = { temperature: '🌡️', humidity: '💧', pressure: '🔵' };

  function load(presetKey) {
    // Custom topology passthrough
    if (presetKey === '__custom') {
      const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
      if (!nodes.length) { Terminal.log('⚠️ Custom topology empty — build in Studio first', 'warn'); return; }
      applyToEngines(presetKey, { name: 'Custom', icon: '🧩' }, nodes, links, { loss: 5, latency: 80, jitter: 20 });
      return;
    }
    const preset = presets[presetKey];
    if (!preset) { Terminal.log(`⚠️ Unknown preset: ${presetKey}`, 'warn'); return; }
    GraphStore.setTopology(preset.nodes, preset.links);
    const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
    applyToEngines(presetKey, preset, nodes, links, preset.chaos);
  }

  function applyToEngines(key, preset, nodes, links, chaos) {
    CanvasEngine.setTopology(nodes, links);
    GatewayQueue.clearAll();
    nodes.filter(n => n.type === 'gateway')
      .forEach(gw => GatewayQueue.createQueue(gw.id, 20));
    try { CoAP.clearDedup(); } catch (e) {}
    try { BatteryEngine.resetAll(); } catch (e) {}
    try {
      nodes.filter(n => n.type === 'sensor').forEach(n => { n.battery = 100; n.dead = false; n.lowPower = false; });
    } catch (e) {}
    ChaosEngine.applyConfig(chaos);
    try { ChartEngine.clear(); } catch (e) {}
    try { DashboardEngine.clear?.(); } catch (e) {}
    try { MetricsRegistry.setTopology(key.replace(/-/g, '')); MetricsRegistry.reset(); } catch (e) {}
    try { SLAEngine.reset(); SLAEngine.setTickMs(800); } catch (e) {}
    try { Inspector.close?.(); } catch (e) {}
    try { DragEngine.updateStatusbar?.(); } catch (e) {}
    Terminal.log(`📐 Preset loaded: ${preset.icon} ${preset.name} — ${nodes.length} nodes`, 'info');
    Terminal.log(`   Links: ${links.length}  |  Chaos: Loss=${chaos.loss}%, Latency=${chaos.latency}ms ±${chaos.jitter}ms`, 'debug');
    SimEngine.onTopologyChanged(nodes, links);
    // Paint immediately — RAF loop is paused until Start (blank-canvas fix)
    try { CanvasEngine.renderNow(); } catch (e) {}
  }

  return { load, getPresetKeys: () => Object.keys(presets), getPreset: (k) => presets[k] || null, presets, SENSOR_ICONS };
})();
