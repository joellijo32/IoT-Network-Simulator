/**
 * @module telemetry
 * @author Abhishek V
 * @description Telemetry Generator: Synthetic sensor payload creation with unique packet IDs.
 *              Defines the packet object model and assigns sensor-type-aware data ranges.
 */

const TelemetryEngine = (() => {
  'use strict';

  let packetCounter = 0;

  /** Sensor value ranges and units per sensor type */
  const sensorRanges = {
    temperature: { min: 15,  max: 85,   unit: '°C',  icon: '🌡️' },
    humidity:    { min: 10,  max: 95,   unit: '%',   icon: '💧' },
    pressure:    { min: 900, max: 1100, unit: 'hPa', icon: '🔵' },
  };

  /**
   * Returns a random float within [min, max], rounded to 2 decimal places.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function randomInRange(min, max) {
    return parseFloat((Math.random() * (max - min) + min).toFixed(2));
  }

  /**
   * Generates a new telemetry packet for a given sensor.
   * @param {string} sensorId - Unique ID of the sensor node (e.g. 's1')
   * @param {string} sensorType - One of 'temperature' | 'humidity' | 'pressure'
   * @returns {Object} Packet object
   */
  function generatePacket(sensorId, sensorType) {
    const range = sensorRanges[sensorType] || sensorRanges.temperature;
    return {
      id:          `PKT-${String(++packetCounter).padStart(5, '0')}`,
      sensorId,
      sensorType,
      value:       randomInRange(range.min, range.max),
      unit:        range.unit,
      icon:        range.icon,
      timestamp:   Date.now(),
      status:      'in-transit',  // → 'delivered' | 'dropped' | 'queued'
      latency:     0,             // Filled by sim engine
    };
  }

  /**
   * Resets the packet counter (used on simulation reset).
   */
  function resetCounter() {
    packetCounter = 0;
  }

  /**
   * Returns the sensor display label for a given type.
   * @param {string} sensorType
   * @returns {string}
   */
  function getSensorIcon(sensorType) {
    return (sensorRanges[sensorType] || sensorRanges.temperature).icon;
  }

  return {
    generatePacket,
    resetCounter,
    getSensorIcon,
    getSensorTypes: () => Object.keys(sensorRanges),
  };
})();
