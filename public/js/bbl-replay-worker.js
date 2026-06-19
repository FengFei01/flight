/**
 * Web Worker for heavy BBL/BFL binary parsing.
 * Owns: reading raw ArrayBuffer, extracting gyro/RC/motor/attitude time-series.
 * Does NOT own: rendering, playback, or UI interaction.
 */
/* eslint-env worker */
'use strict';

var HEADER_SCAN_LIMIT = 256 * 1024;
var RAD_TO_DEG = 180 / Math.PI;

if (typeof self !== 'undefined') {
  self.onmessage = function (e) {
    try {
      var result = parseBBLForReplay(e.data.buffer);
      self.postMessage({ ok: true, data: result });
    } catch (err) {
      self.postMessage({ ok: false, error: err.message });
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseBBLForReplay: parseBBLForReplay,
    parseHeader: parseHeader,
    resolveGyroScaleFactor: resolveGyroScaleFactor,
    scaleGyroSample: scaleGyroSample
  };
}

function parseBBLForReplay(arrayBuffer) {
  try {
    var headerText = decodeLatin1(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, HEADER_SCAN_LIMIT));
    var header = parseHeader(headerText);
    var frames = extractReplayFrames(arrayBuffer, header, headerText);
    return { header: header, frames: frames };
  } catch (err) {
    throw err;
  }
}

function parseHeader(raw) {
  var header = {
    firmware: 'Unknown', craftName: 'Unknown', boardInfo: 'Unknown',
    looptime: 0, motorOutput: [1000, 2000], gyroScale: 1
  };
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.startsWith('H ')) continue;
    var ci = line.indexOf(':', 2);
    if (ci === -1) continue;
    var key = line.substring(2, ci).trim();
    var val = line.substring(ci + 1).trim();
    switch (key) {
      case 'Firmware type': case 'Product': header.firmware = val; break;
      case 'Craft name': header.craftName = val || 'Unnamed'; break;
      case 'Board information': header.boardInfo = val; break;
      case 'looptime': header.looptime = parseInt(val, 10) || 0; break;
      case 'gyro_scale': header.gyroScale = parseFloat(val) || 1; break;
      case 'motorOutput': header.motorOutput = val.split(',').map(Number); break;
    }
  }
  return header;
}

function extractReplayFrames(arrayBuffer, header, headerText) {
  var dataStart = findDataStart(headerText);
  var view = new DataView(arrayBuffer);
  var len = arrayBuffer.byteLength;

  // Target ~60fps playback. Extract up to 30000 frames (~8 min at 60fps)
  var MAX_FRAMES = 30000;
  var gyroRoll = [], gyroPitch = [], gyroYaw = [];
  var motor0 = [], motor1 = [], motor2 = [], motor3 = [];
  var throttle = [];
  var count = 0;
  var gyroScaleFactor = resolveGyroScaleFactor(header);

  if (dataStart === 0 || dataStart >= len - 14) {
    // No valid data section — return empty
    return {
      gyroRoll: [], gyroPitch: [], gyroYaw: [],
      motor: [[], [], [], []], throttle: [],
      count: 0, sampleRateHz: 0, durationSec: 0,
      gyroScaleFactor: gyroScaleFactor
    };
  }

  // Each "frame" we extract: 3 gyro int16 + 4 motor uint16 + 1 throttle (rcCommand[3]) = 16 bytes
  // We'll subsample to keep within MAX_FRAMES
  var bytesPerSample = 14; // 6 gyro + 8 motor
  var totalSamples = Math.floor((len - dataStart) / bytesPerSample);
  var step = Math.max(1, Math.floor(totalSamples / MAX_FRAMES));

  for (var i = dataStart; i < len - 14; i += bytesPerSample * step) {
    var g1 = readInt16LE(view, i);
    var g2 = readInt16LE(view, i + 2);
    var g3 = readInt16LE(view, i + 4);

    // Skip corrupted frames
    if (Math.abs(g1) >= 32000 || Math.abs(g2) >= 32000 || Math.abs(g3) >= 32000) continue;

    var m0 = clampMotor(readUInt16LE(view, i + 6));
    var m1 = clampMotor(readUInt16LE(view, i + 8));
    var m2 = clampMotor(readUInt16LE(view, i + 10));
    var m3 = clampMotor(readUInt16LE(view, i + 12));

    gyroRoll.push(scaleGyroSample(g1, gyroScaleFactor));
    gyroPitch.push(scaleGyroSample(g2, gyroScaleFactor));
    gyroYaw.push(scaleGyroSample(g3, gyroScaleFactor));
    motor0.push(m0);
    motor1.push(m1);
    motor2.push(m2);
    motor3.push(m3);

    // Estimate throttle from average motor output
    var avgMotor = (m0 + m1 + m2 + m3) / 4;
    var minM = header.motorOutput[0] || 1000;
    var maxM = header.motorOutput[1] || 2000;
    var thr = Math.max(0, Math.min(1, (avgMotor - minM) / (maxM - minM)));
    throttle.push(thr);

    count++;
    if (count >= MAX_FRAMES) break;
  }

  // Estimate duration
  var nominalRate = header.looptime > 0 ? 1e6 / header.looptime : 4000;
  var effectiveRate = nominalRate / step;
  var durationSec = count / Math.max(1, effectiveRate);

  return {
    gyroRoll: gyroRoll, gyroPitch: gyroPitch, gyroYaw: gyroYaw,
    motor: [motor0, motor1, motor2, motor3],
    throttle: throttle,
    count: count,
    sampleRateHz: effectiveRate,
    durationSec: Math.max(durationSec, 0.1),
    gyroScaleFactor: gyroScaleFactor
  };
}

function resolveGyroScaleFactor(header) {
  var scale = Number(header && header.gyroScale);
  if (!isFinite(scale) || scale <= 0) return 1;

  // Betaflight logs commonly store gyro_scale as radians/sec per raw ADC tick
  // (for example 0.00106526). Replay uses degrees/sec everywhere.
  if (scale < 0.01) return scale * RAD_TO_DEG;

  // Some exported logs/tools may already provide degrees/sec per tick.
  return scale;
}

function scaleGyroSample(rawValue, scaleFactor) {
  var value = rawValue * scaleFactor;
  return isFinite(value) ? value : 0;
}

function findDataStart(headerText) {
  var lines = headerText.split('\n');
  var bytePos = 0;
  for (var i = 0; i < lines.length; i++) {
    bytePos += lines[i].length + 1;
    if (!lines[i].startsWith('H ') && lines[i].length > 0 && bytePos > 100) {
      return bytePos;
    }
  }
  return 0;
}

function readInt16LE(view, offset) {
  if (offset + 1 >= view.byteLength) return 0;
  return view.getInt16(offset, true);
}

function readUInt16LE(view, offset) {
  if (offset + 1 >= view.byteLength) return 0;
  return view.getUint16(offset, true);
}

function clampMotor(val) {
  return (val < 500 || val > 2500) ? 1000 : val;
}

function decodeLatin1(buf, start, end) {
  return new TextDecoder('iso-8859-1').decode(buf.slice(start || 0, end || buf.byteLength));
}
