/**
 * @module coap
 * @description CoAP PDU encoder/decoder (M3). UDP 5683, Ver=1. Types CON=0/NON=1/ACK=2/RST=3.
 *              Codes: 0.00 Empty, 0.02 POST, 2.04 Changed, 5.03 Service Unavailable.
 *              16-bit MID, 32-bit Token hex. URI-Path /telemetry vs /alerts.
 *              Gateway dedup: rolling (source_mac, MID) ring with 10s TTL.
 */

const CoAP = (() => {
  'use strict';

  const VER = 1;
  const TYPES = { CON: 0, NON: 1, ACK: 2, RST: 3 };
  const TYPE_NAMES = ['CON', 'NON', 'ACK', 'RST'];
  const CODES = { EMPTY: '0.00', POST: '0.02', CHANGED: '2.04', UNAVAIL: '5.03' };
  const ACK_TIMEOUT_MS = 2000;
  const MAX_RETRANSMIT = 1;
  const DEDUP_TTL_MS = 10000;
  const TEMP_ALARM = 75;      // °C -> CON /alerts
  const PRESS_ALARM = 1060;   // hPa -> CON /alerts

  let midCounter = Math.floor(Math.random() * 0xFFFF);

  function nextMID() { midCounter = (midCounter + 1) & 0xFFFF; return midCounter; }
  function nextToken() {
    const v = Math.floor(Math.random() * 0xFFFFFFFF);
    return '0x' + v.toString(16).toUpperCase().padStart(8, '0');
  }
  function isAlarm(sensorType, value) {
    if (sensorType === 'temperature' && value > TEMP_ALARM) return true;
    if (sensorType === 'pressure' && value > PRESS_ALARM) return true;
    return false;
  }
  /** Build a CoAP frame descriptor for a telemetry reading. No raw byte packing (demo-readable). */
  function encode({ sensorId, sensorType, value, unit, srcMac, srcIp, dstMac, dstIp, ttl = 5 }) {
    const alarm = isAlarm(sensorType, value);
    return {
      ver: VER,
      type: alarm ? TYPES.CON : TYPES.NON,
      typeName: alarm ? 'CON' : 'NON',
      code: CODES.POST,
      mid: nextMID(),
      token: nextToken(),
      uriPath: alarm ? '/alerts' : '/telemetry',
      srcMac, srcIp, dstMac, dstIp,
      udpSrc: 5683, udpDst: 5683,
      etherType: '0x86DD',
      ttl, hops: 0,
      payload: { id: sensorId, type: sensorType, val: value, unit, ts: Math.floor(Date.now() / 1000) },
      retries: 0,
    };
  }

  // ─── Gateway dedup ring ───
  const seen = new Map(); // key `${mac}:${mid}` -> expiry ts
  function _gc(now) {
    for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  }
  /** Returns true if duplicate (drop + count), false if first-seen. */
  function checkDuplicate(srcMac, mid, now = Date.now()) {
    _gc(now);
    const k = `${srcMac}:${mid}`;
    if (seen.has(k)) return true;
    seen.set(k, now + DEDUP_TTL_MS);
    return false;
  }
  function clearDedup() { seen.clear(); }

  return {
    VER, TYPES, TYPE_NAMES, CODES, ACK_TIMEOUT_MS, MAX_RETRANSMIT, DEDUP_TTL_MS,
    TEMP_ALARM, PRESS_ALARM,
    nextMID, nextToken, isAlarm, encode, checkDuplicate, clearDedup,
  };
})();
