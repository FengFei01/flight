/**
 * Browser-side BBL parser for throttle-range FFT analysis.
 * Owns: reading a cached BBL Blob/ArrayBuffer, extracting coarse gyro + motor frames.
 * Does NOT own: server rendering or FFT analysis.
 */

/* global window */
(function (exports) {
  'use strict';

  var HEADER_SCAN_LIMIT = 256 * 1024;
  var MAX_SAMPLES = 5000;

  function parseFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return Promise.reject(new Error('Invalid BBL file.'));
    }
    return file.arrayBuffer().then(parseArrayBuffer);
  }

  function parseArrayBuffer(arrayBuffer) {
    var headerText = decodeLatin1(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, HEADER_SCAN_LIMIT));
    var header = parseHeader(headerText);
    var frames = parseFrames(arrayBuffer, header, headerText);
    return { header: header, frames: frames };
  }

  function parseHeader(raw) {
    var header = {
      firmware: 'Unknown',
      firmwareVersion: 'Unknown',
      craftName: 'Unknown',
      boardInfo: 'Unknown',
      gyroScale: 1,
      motorOutput: [0, 0],
      currentPIDs: { roll: {}, pitch: {}, yaw: {} },
      currentRates: { roll: {}, pitch: {}, yaw: {} },
      looptime: 0,
      features: [],
      dtermFilter: {},
      gyroFilter: {}
    };

    var lines = raw.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.startsWith('H ')) continue;

      var colonIdx = line.indexOf(':', 2);
      if (colonIdx === -1) continue;

      var key = line.substring(2, colonIdx).trim();
      var val = line.substring(colonIdx + 1).trim();

      switch (key) {
        case 'Firmware type':
        case 'Product':
          header.firmware = val;
          break;
        case 'Firmware revision':
        case 'Firmware version':
          header.firmwareVersion = val;
          break;
        case 'Craft name':
          header.craftName = val || 'Unnamed';
          break;
        case 'Board information':
          header.boardInfo = val;
          break;
        case 'gyro_scale':
          header.gyroScale = parseFloat(val) || 1;
          break;
        case 'motorOutput':
          header.motorOutput = val.split(',').map(Number);
          break;
        case 'looptime':
          header.looptime = parseInt(val, 10) || 0;
          break;
        case 'features':
          header.features = val.split(',').map(function (feature) { return feature.trim(); });
          break;
        case 'rollPID':
          parsePIDLine(val, header.currentPIDs, 'roll');
          break;
        case 'pitchPID':
          parsePIDLine(val, header.currentPIDs, 'pitch');
          break;
        case 'yawPID':
          parsePIDLine(val, header.currentPIDs, 'yaw');
          break;
        case 'p_roll': header.currentPIDs.roll.p = parseInt(val, 10); break;
        case 'i_roll': header.currentPIDs.roll.i = parseInt(val, 10); break;
        case 'd_roll': header.currentPIDs.roll.d = parseInt(val, 10); break;
        case 'f_roll': header.currentPIDs.roll.f = parseInt(val, 10); break;
        case 'p_pitch': header.currentPIDs.pitch.p = parseInt(val, 10); break;
        case 'i_pitch': header.currentPIDs.pitch.i = parseInt(val, 10); break;
        case 'd_pitch': header.currentPIDs.pitch.d = parseInt(val, 10); break;
        case 'f_pitch': header.currentPIDs.pitch.f = parseInt(val, 10); break;
        case 'p_yaw': header.currentPIDs.yaw.p = parseInt(val, 10); break;
        case 'i_yaw': header.currentPIDs.yaw.i = parseInt(val, 10); break;
        case 'd_yaw': header.currentPIDs.yaw.d = parseInt(val, 10); break;
        case 'f_yaw': header.currentPIDs.yaw.f = parseInt(val, 10); break;
        case 'rates':
          parseRatesLine(val, header.currentRates, 'rate');
          break;
        case 'rc_rates':
          parseRatesLine(val, header.currentRates, 'rcRate');
          break;
        case 'rc_expo':
          parseRatesLine(val, header.currentRates, 'expo');
          break;
        case 'gyro_lowpass_hz':
          header.gyroFilter.lowpass = parseInt(val, 10);
          break;
        case 'gyro_lowpass2_hz':
          header.gyroFilter.lowpass2 = parseInt(val, 10);
          break;
        case 'dterm_lowpass_hz':
          header.dtermFilter.lowpass = parseInt(val, 10);
          break;
        case 'dterm_lowpass2_hz':
          header.dtermFilter.lowpass2 = parseInt(val, 10);
          break;
        case 'dyn_notch_min_hz':
          header.gyroFilter.dynNotchMin = parseInt(val, 10);
          break;
        case 'dyn_notch_max_hz':
          header.gyroFilter.dynNotchMax = parseInt(val, 10);
          break;
      }
    }

    return header;
  }

  function parsePIDLine(val, pids, axis) {
    var parts = val.split(',').map(Number);
    if (parts.length < 3) return;
    pids[axis] = {
      p: parts[0],
      i: parts[1],
      d: parts[2],
      f: parts[3] || 0
    };
  }

  function parseRatesLine(val, rates, field) {
    var parts = val.split(',').map(Number);
    if (parts.length < 3) return;
    rates.roll[field] = parts[0];
    rates.pitch[field] = parts[1];
    rates.yaw[field] = parts[2];
  }

  function parseFrames(arrayBuffer, header, headerText) {
    var frames = {
      gyro: { roll: [], pitch: [], yaw: [] },
      motor: [[], [], [], []],
      setpoint: { roll: [], pitch: [], yaw: [] },
      count: 0
    };

    var dataStart = findDataStart(headerText);
    if (dataStart === 0 || dataStart >= arrayBuffer.byteLength - 12) {
      return generateSyntheticFrames(header);
    }

    var view = new DataView(arrayBuffer);
    var binaryLen = arrayBuffer.byteLength - dataStart;
    var sampleInterval = Math.max(1, Math.floor(binaryLen / MAX_SAMPLES));
    var sampleCount = 0;

    for (var i = dataStart; i < arrayBuffer.byteLength - 12; i += sampleInterval) {
      var g1 = readInt16LE(view, i);
      var g2 = readInt16LE(view, i + 2);
      var g3 = readInt16LE(view, i + 4);

      if (Math.abs(g1) >= 32000 || Math.abs(g2) >= 32000 || Math.abs(g3) >= 32000) {
        continue;
      }

      frames.gyro.roll.push(g1);
      frames.gyro.pitch.push(g2);
      frames.gyro.yaw.push(g3);

      frames.motor[0].push(readMotorValue(view, i + 6));
      frames.motor[1].push(readMotorValue(view, i + 8));
      frames.motor[2].push(readMotorValue(view, i + 10));
      frames.motor[3].push(readMotorValue(view, i + 12));

      sampleCount++;
      if (sampleCount >= MAX_SAMPLES) break;
    }

    frames.count = sampleCount;

    if (sampleCount < 50) {
      return generateSyntheticFrames(header);
    }

    frames.effectiveSampleRate = estimateEffectiveSampleRate(
      arrayBuffer, dataStart, sampleCount, header.looptime
    );

    return frames;
  }

  function findDataStart(headerText) {
    var lines = headerText.split('\n');
    var bytePos = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      bytePos += line.length + 1;
      if (!line.startsWith('H ') && line.length > 0 && bytePos > 100) {
        return bytePos;
      }
    }

    return 0;
  }

  function estimateEffectiveSampleRate(arrayBuffer, dataStart, sampleCount, looptime) {
    if (looptime <= 0 || sampleCount < 2) return 4000;

    var nominalRate = 1e6 / looptime;
    var view = new DataView(arrayBuffer);
    var iFrameCount = 0;

    for (var i = dataStart; i < arrayBuffer.byteLength; i++) {
      if (view.getUint8(i) !== 0x49) continue;

      if (i + 1 < arrayBuffer.byteLength) {
        var next = view.getUint8(i + 1);
        if (next >= 0x20 && next <= 0x7E && next !== 0x49 && next !== 0x50) {
          continue;
        }
      }
      iFrameCount++;
    }

    var I_INTERVAL = 32;
    var P_INTERVAL_DENOM = 2;

    if (iFrameCount < 2) {
      return Math.min(nominalRate, 500);
    }

    var totalPIDIterations = iFrameCount * I_INTERVAL * P_INTERVAL_DENOM;
    var durationSec = totalPIDIterations * looptime / 1e6;
    if (durationSec <= 0) return Math.min(nominalRate, 500);

    var effectiveRate = sampleCount / durationSec;
    return Math.max(10, Math.min(effectiveRate, nominalRate));
  }

  function generateSyntheticFrames(header) {
    var frames = {
      gyro: { roll: [], pitch: [], yaw: [] },
      motor: [[], [], [], []],
      setpoint: { roll: [], pitch: [], yaw: [] },
      count: 500,
      synthetic: true
    };

    var pRoll = (header.currentPIDs.roll && header.currentPIDs.roll.p) || 45;
    var pPitch = (header.currentPIDs.pitch && header.currentPIDs.pitch.p) || 47;

    for (var i = 0; i < 500; i++) {
      var noiseScale = 1 + (pRoll / 100);
      frames.gyro.roll.push(Math.round((Math.random() - 0.5) * 40 * noiseScale));
      frames.gyro.pitch.push(Math.round((Math.random() - 0.5) * 42 * noiseScale));
      frames.gyro.yaw.push(Math.round((Math.random() - 0.5) * 30));

      frames.motor[0].push(1200 + Math.round(Math.random() * 400));
      frames.motor[1].push(1200 + Math.round(Math.random() * 400));
      frames.motor[2].push(1200 + Math.round(Math.random() * 400));
      frames.motor[3].push(1200 + Math.round(Math.random() * 400));
    }

    return frames;
  }

  function readInt16LE(view, offset) {
    if (offset < 0 || offset + 1 >= view.byteLength) return 0;
    return view.getInt16(offset, true);
  }

  function readUInt16LE(view, offset) {
    if (offset < 0 || offset + 1 >= view.byteLength) return 0;
    return view.getUint16(offset, true);
  }

  function readMotorValue(view, offset) {
    var value = readUInt16LE(view, offset);
    if (value < 500 || value >= 2500) return null;
    return value;
  }

  function decodeLatin1(arrayBuffer, start, end) {
    var slice = arrayBuffer.slice(start || 0, end || arrayBuffer.byteLength);
    return new TextDecoder('iso-8859-1').decode(slice);
  }

  exports.BBLClientParser = {
    parseFile: parseFile,
    parseArrayBuffer: parseArrayBuffer,
    parseHeader: parseHeader
  };
})(typeof window !== 'undefined' ? window : module.exports);
