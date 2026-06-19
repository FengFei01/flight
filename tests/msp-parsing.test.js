/**
 * Tests for MSP PID/PID_ADVANCED parsing logic.
 * The parse functions live in fc-pid-reader.js (client-side), so we replicate
 * the exact logic here to test byte-level parsing correctness.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Replicate parsePidResponse from fc-pid-reader.js
function parsePidResponse(payload) {
  var pids = { roll: {}, pitch: {}, yaw: {} };
  var axes = ['roll', 'pitch', 'yaw'];
  for (var a = 0; a < 3; a++) {
    var offset = a * 3;
    pids[axes[a]].p = payload[offset] || 0;
    pids[axes[a]].i = payload[offset + 1] || 0;
    pids[axes[a]].d = payload[offset + 2] || 0;
    pids[axes[a]].f = 0;
  }
  return pids;
}

// Replicate parsePidAdvancedResponse from fc-pid-reader.js
function parsePidAdvancedResponse(payload, pids) {
  if (payload.length < 42) return;
  pids.roll.f  = payload[32] | (payload[33] << 8);
  pids.pitch.f = payload[34] | (payload[35] << 8);
  pids.yaw.f   = payload[36] | (payload[37] << 8);
  pids.roll.dMax  = payload[39];
  pids.pitch.dMax = payload[40];
  pids.yaw.dMax   = payload[41];
}

// Replicate verification logic from fc-pid-reader.js
function verifyWriteBack(fcPids, targetPids) {
  var allMatch = true;
  var mismatchList = [];
  var axes = ['roll', 'pitch', 'yaw'];
  var verifyParams = ['p', 'i', 'd', 'f', 'dMax'];
  for (var a = 0; a < axes.length; a++) {
    for (var p = 0; p < verifyParams.length; p++) {
      var vp = verifyParams[p];
      var wrote = targetPids[axes[a]][vp] || 0;
      var readBack = fcPids[axes[a]][vp] || 0;
      if (wrote !== readBack) {
        allMatch = false;
        mismatchList.push(axes[a] + '.' + vp);
      }
    }
  }
  return { allMatch, mismatchList };
}

describe('parsePidResponse (MSP_PID cmd 112)', () => {
  it('parses 3-byte stride correctly for 3 axes', () => {
    const payload = [45, 80, 30, 47, 84, 32, 45, 90, 0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    const pids = parsePidResponse(payload);
    assert.deepStrictEqual(pids.roll, { p: 45, i: 80, d: 30, f: 0 });
    assert.deepStrictEqual(pids.pitch, { p: 47, i: 84, d: 32, f: 0 });
    assert.deepStrictEqual(pids.yaw, { p: 45, i: 90, d: 0, f: 0 });
  });

  it('handles max byte values (255)', () => {
    const payload = [255, 255, 255, 255, 255, 255, 255, 255, 255];
    const pids = parsePidResponse(payload);
    assert.strictEqual(pids.roll.p, 255);
    assert.strictEqual(pids.roll.i, 255);
    assert.strictEqual(pids.roll.d, 255);
  });

  it('handles zero payload (all zeros)', () => {
    const payload = new Array(30).fill(0);
    const pids = parsePidResponse(payload);
    assert.deepStrictEqual(pids.roll, { p: 0, i: 0, d: 0, f: 0 });
    assert.deepStrictEqual(pids.pitch, { p: 0, i: 0, d: 0, f: 0 });
    assert.deepStrictEqual(pids.yaw, { p: 0, i: 0, d: 0, f: 0 });
  });

  it('handles empty payload gracefully', () => {
    const payload = [];
    const pids = parsePidResponse(payload);
    assert.deepStrictEqual(pids.roll, { p: 0, i: 0, d: 0, f: 0 });
  });

  it('only reads first 9 bytes (3 axes x 3 params)', () => {
    const payload = [45, 80, 30, 47, 84, 32, 45, 90, 0, 99, 99, 99];
    const pids = parsePidResponse(payload);
    assert.strictEqual(pids.roll.p, 45);
    assert.strictEqual(pids.yaw.d, 0);
  });
});

describe('parsePidAdvancedResponse (MSP_PID_ADVANCED cmd 94)', () => {
  it('reads FF U16 LE at offsets 32,34,36 and D_Max U8 at 39,40,41', () => {
    const payload = new Array(42).fill(0);
    payload[32] = 0x78; payload[33] = 0x00; // FF roll = 120
    payload[34] = 0x2C; payload[35] = 0x01; // FF pitch = 300
    payload[36] = 0x4B; payload[37] = 0x00; // FF yaw = 75
    payload[39] = 40; payload[40] = 42; payload[41] = 0;

    const pids = { roll: {}, pitch: {}, yaw: {} };
    parsePidAdvancedResponse(payload, pids);

    assert.strictEqual(pids.roll.f, 120);
    assert.strictEqual(pids.pitch.f, 300);
    assert.strictEqual(pids.yaw.f, 75);
    assert.strictEqual(pids.roll.dMax, 40);
    assert.strictEqual(pids.pitch.dMax, 42);
    assert.strictEqual(pids.yaw.dMax, 0);
  });

  it('handles large U16 feedforward values', () => {
    const payload = new Array(42).fill(0);
    payload[32] = 0xF4; payload[33] = 0x01; // 500
    payload[34] = 0xFF; payload[35] = 0xFF; // 65535
    payload[36] = 0x00; payload[37] = 0x00; // 0

    const pids = { roll: {}, pitch: {}, yaw: {} };
    parsePidAdvancedResponse(payload, pids);

    assert.strictEqual(pids.roll.f, 500);
    assert.strictEqual(pids.pitch.f, 65535);
    assert.strictEqual(pids.yaw.f, 0);
  });

  it('skips parsing when payload is too short (<42 bytes)', () => {
    const payload = new Array(30).fill(99);
    const pids = { roll: { f: 0 }, pitch: { f: 0 }, yaw: { f: 0 } };
    parsePidAdvancedResponse(payload, pids);
    assert.strictEqual(pids.roll.f, 0);
    assert.strictEqual(pids.roll.dMax, undefined);
  });

  it('D_Max max value is 255 (U8)', () => {
    const payload = new Array(42).fill(0);
    payload[39] = 255; payload[40] = 255; payload[41] = 255;

    const pids = { roll: {}, pitch: {}, yaw: {} };
    parsePidAdvancedResponse(payload, pids);

    assert.strictEqual(pids.roll.dMax, 255);
    assert.strictEqual(pids.pitch.dMax, 255);
    assert.strictEqual(pids.yaw.dMax, 255);
  });
});

// Replicate parseFilterConfig from fc-notch-writer.js
function parseFilterConfig(payload) {
  if (!payload || payload.length < 17) return null;
  return {
    gyro_lowpass_hz: payload[0],
    dterm_lowpass_hz: payload[1] | (payload[2] << 8),
    yaw_lowpass_hz: payload[3] | (payload[4] << 8),
    gyro_notch_hz_1: payload[5] | (payload[6] << 8),
    gyro_notch_cutoff_1: payload[7] | (payload[8] << 8),
    dterm_notch_hz: payload[9] | (payload[10] << 8),
    dterm_notch_cutoff: payload[11] | (payload[12] << 8),
    gyro_notch_hz_2: payload[13] | (payload[14] << 8),
    gyro_notch_cutoff_2: payload[15] | (payload[16] << 8),
  };
}

// Replicate buildFilterPayload from fc-notch-writer.js
function buildFilterPayload(basePayload, notch) {
  if (!basePayload || basePayload.length < 17) return null;
  var payload = basePayload.slice();
  var hz1 = notch.notch_hz_1 || 0;
  payload[5] = hz1 & 0xFF; payload[6] = (hz1 >> 8) & 0xFF;
  var cut1 = notch.notch_cutoff_1 || 0;
  payload[7] = cut1 & 0xFF; payload[8] = (cut1 >> 8) & 0xFF;
  var hz2 = notch.notch_hz_2 || 0;
  payload[13] = hz2 & 0xFF; payload[14] = (hz2 >> 8) & 0xFF;
  var cut2 = notch.notch_cutoff_2 || 0;
  payload[15] = cut2 & 0xFF; payload[16] = (cut2 >> 8) & 0xFF;
  return payload;
}

describe('parseFilterConfig (MSP_FILTER_CONFIG cmd 92)', () => {
  it('parses notch fields correctly from U16 LE bytes', () => {
    const payload = new Array(28).fill(0);
    // gyro_lowpass_hz = 200
    payload[0] = 200;
    // dterm_lowpass_hz = 100 (U16 LE)
    payload[1] = 100; payload[2] = 0;
    // gyro_notch_hz_1 = 165 (U16 LE)
    payload[5] = 0xA5; payload[6] = 0x00;
    // gyro_notch_cutoff_1 = 132 (U16 LE)
    payload[7] = 0x84; payload[8] = 0x00;
    // gyro_notch_hz_2 = 122 (U16 LE)
    payload[13] = 0x7A; payload[14] = 0x00;
    // gyro_notch_cutoff_2 = 98 (U16 LE)
    payload[15] = 0x62; payload[16] = 0x00;

    const config = parseFilterConfig(payload);
    assert.equal(config.gyro_lowpass_hz, 200);
    assert.equal(config.dterm_lowpass_hz, 100);
    assert.equal(config.gyro_notch_hz_1, 165);
    assert.equal(config.gyro_notch_cutoff_1, 132);
    assert.equal(config.gyro_notch_hz_2, 122);
    assert.equal(config.gyro_notch_cutoff_2, 98);
  });

  it('returns null for payload < 17 bytes', () => {
    assert.equal(parseFilterConfig(new Array(10).fill(0)), null);
    assert.equal(parseFilterConfig(null), null);
    assert.equal(parseFilterConfig([]), null);
  });

  it('handles zero notch values (disabled)', () => {
    const payload = new Array(28).fill(0);
    const config = parseFilterConfig(payload);
    assert.equal(config.gyro_notch_hz_1, 0);
    assert.equal(config.gyro_notch_hz_2, 0);
  });
});

describe('buildFilterPayload (MSP_SET_FILTER_CONFIG cmd 29)', () => {
  it('patches only notch fields, preserves others', () => {
    const base = new Array(28).fill(0);
    base[0] = 200; // gyro_lowpass
    base[1] = 100; base[2] = 0; // dterm_lowpass
    base[9] = 50; base[10] = 0; // dterm_notch_hz

    const notch = { notch_hz_1: 165, notch_cutoff_1: 132, notch_hz_2: 122, notch_cutoff_2: 98 };
    const result = buildFilterPayload(base, notch);

    // Notch fields should be patched
    assert.equal(result[5] | (result[6] << 8), 165);
    assert.equal(result[7] | (result[8] << 8), 132);
    assert.equal(result[13] | (result[14] << 8), 122);
    assert.equal(result[15] | (result[16] << 8), 98);

    // Non-notch fields should be preserved
    assert.equal(result[0], 200, 'gyro_lowpass should be preserved');
    assert.equal(result[1], 100, 'dterm_lowpass should be preserved');
    assert.equal(result[9], 50, 'dterm_notch should be preserved');
  });

  it('returns null for payload < 17 bytes', () => {
    assert.equal(buildFilterPayload(new Array(10).fill(0), { notch_hz_1: 100 }), null);
    assert.equal(buildFilterPayload(null, { notch_hz_1: 100 }), null);
  });

  it('handles single notch (second notch = 0)', () => {
    const base = new Array(28).fill(0);
    const notch = { notch_hz_1: 200, notch_cutoff_1: 160, notch_hz_2: 0, notch_cutoff_2: 0 };
    const result = buildFilterPayload(base, notch);

    assert.equal(result[5] | (result[6] << 8), 200);
    assert.equal(result[7] | (result[8] << 8), 160);
    assert.equal(result[13] | (result[14] << 8), 0);
    assert.equal(result[15] | (result[16] << 8), 0);
  });

  it('round-trips: build → parse → values match', () => {
    const base = new Array(28).fill(0);
    base[0] = 150; // gyro_lowpass
    const notch = { notch_hz_1: 300, notch_cutoff_1: 240, notch_hz_2: 180, notch_cutoff_2: 144 };
    const built = buildFilterPayload(base, notch);
    const parsed = parseFilterConfig(built);

    assert.equal(parsed.gyro_notch_hz_1, 300);
    assert.equal(parsed.gyro_notch_cutoff_1, 240);
    assert.equal(parsed.gyro_notch_hz_2, 180);
    assert.equal(parsed.gyro_notch_cutoff_2, 144);
    assert.equal(parsed.gyro_lowpass_hz, 150, 'Non-notch fields preserved');
  });
});

describe('write-back verification logic', () => {
  it('returns match when all values are identical', () => {
    const pids = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const result = verifyWriteBack(pids, pids);
    assert.strictEqual(result.allMatch, true);
    assert.deepStrictEqual(result.mismatchList, []);
  });

  it('detects P mismatch on roll', () => {
    const readBack = {
      roll: { p: 44, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const target = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const result = verifyWriteBack(readBack, target);
    assert.strictEqual(result.allMatch, false);
    assert.ok(result.mismatchList.includes('roll.p'));
  });

  it('detects dMax mismatch', () => {
    const readBack = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 38 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const target = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const result = verifyWriteBack(readBack, target);
    assert.strictEqual(result.allMatch, false);
    assert.ok(result.mismatchList.includes('roll.dMax'));
  });

  it('detects multiple mismatches', () => {
    const readBack = {
      roll: { p: 44, i: 80, d: 30, f: 119, dMax: 38 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const target = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 },
    };
    const result = verifyWriteBack(readBack, target);
    assert.strictEqual(result.allMatch, false);
    assert.ok(result.mismatchList.includes('roll.p'));
    assert.ok(result.mismatchList.includes('roll.f'));
    assert.ok(result.mismatchList.includes('roll.dMax'));
  });

  it('treats missing fields as zero (match with 0)', () => {
    const readBack = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90 },
    };
    const target = {
      roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw: { p: 45, i: 90, d: 0, f: 0, dMax: 0 },
    };
    const result = verifyWriteBack(readBack, target);
    assert.strictEqual(result.allMatch, true);
  });
});
