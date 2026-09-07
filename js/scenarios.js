/**
 * @module scenarios
 * @author Adithyan Sreekumar
 * @description Preset Scenarios & Topologies: Defines pre-configured topology templates
 *              for one-click network environment setup. Each scenario specifies a complete
 *              node layout with positions, connection links, and chaos engineering defaults.
 */

const Scenarios = (() => {
  'use strict';

  // ─── Preset definitions ──────────────────────────────────────────────────────

  const presets = {

    /**
     * Smart Factory: Stable industrial sensor network with moderate traffic.
     * 4 Sensors → 2 Gateways → 1 Cloud Server
     */
    'smart-factory': {
      name:        'Smart Factory',
      description: 'Industrial IoT with temperature & pressure sensors',
      icon:        '🏭',
      nodes: [
        { id: 's1', type: 'sensor',  label: 'Temp-A',   sensorType: 'temperature', x: 110, y: 140 },
        { id: 's2', type: 'sensor',  label: 'Hum-B',    sensorType: 'humidity',    x: 110, y: 280 },
        { id: 's3', type: 'sensor',  label: 'Press-C',  sensorType: 'pressure',    x: 110, y: 420 },
        { id: 's4', type: 'sensor',  label: 'Temp-D',   sensorType: 'temperature', x: 110, y: 560 },
        { id: 'g1', type: 'gateway', label: 'GW-Alpha',                            x: 360, y: 210 },
        { id: 'g2', type: 'gateway', label: 'GW-Beta',                             x: 360, y: 490 },
        { id: 'sv', type: 'server',  label: 'Cloud Server',                        x: 610, y: 350 },
      ],
      links: [
        ['s1', 'g1'], ['s2', 'g1'],
        ['s3', 'g2'], ['s4', 'g2'],
        ['g1', 'sv'], ['g2', 'sv'],
      ],
      chaos: { loss: 5, latency: 80, jitter: 20 },
    },

    /**
     * Unstable Wireless: High-loss, high-jitter network for stress testing.
     * 5 Sensors → 2 Gateways → 1 Server
     */
    'unstable-wireless': {
      name:        'Unstable Wireless',
      description: 'High packet loss & jitter — stress test scenario',
      icon:        '📡',
      nodes: [
        { id: 's1', type: 'sensor',  label: 'Temp-1',  sensorType: 'temperature', x: 100, y: 120 },
        { id: 's2', type: 'sensor',  label: 'Hum-2',   sensorType: 'humidity',    x: 100, y: 240 },
        { id: 's3', type: 'sensor',  label: 'Press-3', sensorType: 'pressure',    x: 100, y: 360 },
        { id: 's4', type: 'sensor',  label: 'Temp-4',  sensorType: 'temperature', x: 100, y: 480 },
        { id: 's5', type: 'sensor',  label: 'Hum-5',   sensorType: 'humidity',    x: 100, y: 600 },
        { id: 'g1', type: 'gateway', label: 'GW-North',                            x: 370, y: 240 },
        { id: 'g2', type: 'gateway', label: 'GW-South',                            x: 370, y: 480 },
        { id: 'sv', type: 'server',  label: 'Edge Server',                         x: 630, y: 360 },
      ],
      links: [
        ['s1', 'g1'], ['s2', 'g1'], ['s3', 'g1'],
        ['s4', 'g2'], ['s5', 'g2'],
        ['g1', 'sv'], ['g2', 'sv'],
      ],
      chaos: { loss: 40, latency: 250, jitter: 100 },
    },

    /**
     * Smart City: Large-scale urban monitoring grid.
     * 8 Sensors → 3 Gateways → 1 Central Server
     */
    'smart-city': {
      name:        'Smart City',
      description: 'Urban IoT grid — traffic, air quality & noise sensors',
      icon:        '🌆',
      nodes: [
        { id: 's1', type: 'sensor',  label: 'AQ-N1',    sensorType: 'pressure',    x: 90,  y: 100 },
        { id: 's2', type: 'sensor',  label: 'Temp-N2',  sensorType: 'temperature', x: 90,  y: 210 },
        { id: 's3', type: 'sensor',  label: 'Hum-C1',   sensorType: 'humidity',    x: 90,  y: 340 },
        { id: 's4', type: 'sensor',  label: 'Press-C2', sensorType: 'pressure',    x: 90,  y: 450 },
        { id: 's5', type: 'sensor',  label: 'Temp-S1',  sensorType: 'temperature', x: 90,  y: 570 },
        { id: 's6', type: 'sensor',  label: 'Hum-S2',   sensorType: 'humidity',    x: 90,  y: 660 },
        { id: 's7', type: 'sensor',  label: 'AQ-E1',    sensorType: 'pressure',    x: 230, y: 150 },
        { id: 's8', type: 'sensor',  label: 'AQ-E2',    sensorType: 'pressure',    x: 230, y: 600 },
        { id: 'g1', type: 'gateway', label: 'GW-North',                             x: 400, y: 155 },
        { id: 'g2', type: 'gateway', label: 'GW-Central',                           x: 400, y: 390 },
        { id: 'g3', type: 'gateway', label: 'GW-South',                             x: 400, y: 625 },
        { id: 'sv', type: 'server',  label: 'City Hub',                             x: 620, y: 390 },
      ],
      links: [
        ['s1', 'g1'], ['s2', 'g1'], ['s7', 'g1'],
        ['s3', 'g2'], ['s4', 'g2'],
        ['s5', 'g3'], ['s6', 'g3'], ['s8', 'g3'],
        ['g1', 'sv'], ['g2', 'sv'], ['g3', 'sv'],
      ],
      chaos: { loss: 15, latency: 120, jitter: 50 },
    },
  };

  // ─── Icon map for sensor types ───────────────────────────────────────────────

  const SENSOR_ICONS = {
    temperature: '🌡️',
    humidity:    '💧',
    pressure:    '🔵',
  };

  // ─── Load scenario ───────────────────────────────────────────────────────────

  /**
   * Loads a preset topology into the simulation.
   * @param {string} presetKey - One of 'smart-factory' | 'unstable-wireless' | 'smart-city'
   */
  function load(presetKey) {
    const preset = presets[presetKey];
    if (!preset) {
      Terminal.log(`⚠️  Unknown preset: ${presetKey}`, 'warn');
      return;
    }

    // Annotate sensor nodes with icons
    const annotatedNodes = preset.nodes.map(node => ({
      ...node,
      icon:      node.type === 'sensor' ? SENSOR_ICONS[node.sensorType] || '📡' : undefined,
      killed:    false,
      queueFill: 0,
      received:  node.type === 'server' ? 0 : undefined,
    }));

    // Apply to canvas
    CanvasEngine.setTopology(annotatedNodes, preset.links);

    // Rebuild gateway queues
    GatewayQueue.clearAll();
    annotatedNodes
      .filter(n => n.type === 'gateway')
      .forEach(gw => GatewayQueue.createQueue(gw.id));

    // Apply chaos settings
    ChaosEngine.applyConfig(preset.chaos);

    // Reset chart data
    ChartEngine.clear();

    Terminal.log(`📐 Preset loaded: ${preset.icon} ${preset.name} — ${annotatedNodes.length} nodes`, 'info');
    Terminal.log(`   Links: ${preset.links.length}  |  Chaos: Loss=${preset.chaos.loss}%, Latency=${preset.chaos.latency}ms ±${preset.chaos.jitter}ms`, 'debug');

    // Tell SimEngine about the new topology
    SimEngine.onTopologyChanged(annotatedNodes, preset.links);
  }

  /**
   * Returns the list of available preset keys.
   * @returns {string[]}
   */
  function getPresetKeys() {
    return Object.keys(presets);
  }

  /**
   * Returns the full preset descriptor for a key.
   * @param {string} key
   * @returns {Object}
   */
  function getPreset(key) {
    return presets[key] || null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    load,
    getPresetKeys,
    getPreset,
    presets,
    SENSOR_ICONS,
  };
})();
