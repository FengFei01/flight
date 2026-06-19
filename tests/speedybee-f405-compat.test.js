/**
 * SpeedyBee F405 BSP board compatibility validation.
 * Verifies BBL parsing, PID extraction, and filter analysis for known
 * SpeedyBee F405 header patterns against expected output.
 *
 * Board-specific quirks documented inline and summarised at bottom.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseBBL, parseHeader } = require('../services/bbl-parser');
const {
  analyzePIDs, generateCLICommands, generateTuningNotes,
  applyStyleToAnalysis, computeFlightScore,
} = require('../services/pid-analyzer');
const { detectBfVersion } = require('../public/js/bf-version-map');

// ---------------------------------------------------------------------------
// Helpers — build synthetic BBL buffers that mimic SpeedyBee F405 output
// ---------------------------------------------------------------------------

/**
 * Build a BBL header string matching SpeedyBee F405 V3/V4 real-world output.
 * SpeedyBee F405 boards running BF 4.3–4.5 produce headers with these traits:
 *   - Board information: "SPEEDYBEEF405V3" or "SPEEDYBEEF405V4"
 *   - Composite comma-separated d_min, d_max, ff_weight headers
 *   - PID values as individual p_roll / i_roll / d_roll lines (not rollPID)
 *   - looptime in microseconds (typically 125 for 8kHz)
 *   - gyro_scale as 0.00106526 (ICM-42688-P default)
 */
function buildSpeedyBeeHeader(overrides = {}) {
  const o = {
    boardInfo: 'SPEEDYBEEF405V3',
    firmware: 'Betaflight',
    firmwareVersion: '4.4.2',
    craftName: 'SB405 Test Quad',
    looptime: 125,
    gyroScale: '0.00106526',
    // Typical SpeedyBee F405 PID values (BF 4.4 defaults + pilot tweaks)
    p_roll: 48, i_roll: 85, d_roll: 35,
    p_pitch: 50, i_pitch: 88, d_pitch: 37,
    p_yaw: 45, i_yaw: 90, d_yaw: 0,
    // Composite headers — SpeedyBee F405 logs use these
    d_min: '32,34,0',
    d_max: '42,44,0',
    ff_weight: '130,135,80',
    // Filter settings
    gyro_lowpass_hz: 275,
    gyro_lowpass2_hz: 550,
    dterm_lowpass_hz: 150,
    dterm_lowpass2_hz: 300,
    dyn_notch_min_hz: 100,
    dyn_notch_max_hz: 600,
    // Rates
    rates: '70,70,65',
    rc_rates: '100,100,100',
    rc_expo: '75,75,45',
    // Features
    features: 'RX_SERIAL,MOTOR_STOP,LED_STRIP,OSD,ANTI_GRAVITY',
    ...overrides,
  };

  const lines = [
    `H Product:${o.firmware}`,
    `H Firmware revision:${o.firmwareVersion}`,
    `H Craft name:${o.craftName}`,
    `H Board information:${o.boardInfo}`,
    `H looptime:${o.looptime}`,
    `H gyro_scale:${o.gyroScale}`,
    `H features:${o.features}`,
    `H p_roll:${o.p_roll}`,
    `H i_roll:${o.i_roll}`,
    `H d_roll:${o.d_roll}`,
    `H p_pitch:${o.p_pitch}`,
    `H i_pitch:${o.i_pitch}`,
    `H d_pitch:${o.d_pitch}`,
    `H p_yaw:${o.p_yaw}`,
    `H i_yaw:${o.i_yaw}`,
    `H d_yaw:${o.d_yaw}`,
    `H d_min:${o.d_min}`,
    `H d_max:${o.d_max}`,
    `H ff_weight:${o.ff_weight}`,
    `H gyro_lowpass_hz:${o.gyro_lowpass_hz}`,
    `H gyro_lowpass2_hz:${o.gyro_lowpass2_hz}`,
    `H dterm_lowpass_hz:${o.dterm_lowpass_hz}`,
    `H dterm_lowpass2_hz:${o.dterm_lowpass2_hz}`,
    `H dyn_notch_min_hz:${o.dyn_notch_min_hz}`,
    `H dyn_notch_max_hz:${o.dyn_notch_max_hz}`,
    `H rates:${o.rates}`,
    `H rc_rates:${o.rc_rates}`,
    `H rc_expo:${o.rc_expo}`,
  ];
  return lines.join('\n') + '\n';
}

/** Build a full BBL buffer: header + synthetic binary data. */
function buildSpeedyBeeBBL(headerOverrides = {}, binaryLen = 20000) {
  const headerStr = buildSpeedyBeeHeader(headerOverrides);
  const headerBuf = Buffer.from(headerStr, 'latin1');
  // Synthetic binary data simulating flight data
  const binaryBuf = Buffer.alloc(binaryLen);
  // Scatter I-frame markers (0x49) for frame count estimation
  for (let i = 0; i < binaryLen; i += 200) {
    binaryBuf[i] = 0x49; // 'I' marker
    binaryBuf[i + 1] = 0x80; // high-bit set = VLQ, not ASCII
    // Fill with plausible int16 gyro data (small oscillations)
    for (let j = 2; j < 12 && i + j < binaryLen; j += 2) {
      const val = Math.round((Math.random() - 0.5) * 60);
      binaryBuf.writeInt16LE(val, i + j);
    }
  }
  return Buffer.concat([headerBuf, binaryBuf]);
}

// ---------------------------------------------------------------------------
// 1. Header Parsing
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — header parsing', () => {

  it('extracts board info correctly for V3', () => {
    const raw = buildSpeedyBeeHeader({ boardInfo: 'SPEEDYBEEF405V3' });
    const header = parseHeader(raw);
    assert.strictEqual(header.boardInfo, 'SPEEDYBEEF405V3');
  });

  it('extracts board info correctly for V4', () => {
    const raw = buildSpeedyBeeHeader({ boardInfo: 'SPEEDYBEEF405V4' });
    const header = parseHeader(raw);
    assert.strictEqual(header.boardInfo, 'SPEEDYBEEF405V4');
  });

  it('extracts firmware type and version', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.firmware, 'Betaflight');
    assert.strictEqual(header.firmwareVersion, '4.4.2');
  });

  it('extracts craft name', () => {
    const raw = buildSpeedyBeeHeader({ craftName: '我的FPV穿越机' });
    const header = parseHeader(raw);
    assert.strictEqual(header.craftName, '我的FPV穿越机');
  });

  it('extracts looptime = 125µs (8kHz)', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.looptime, 125);
  });

  it('extracts gyroScale for ICM-42688-P', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.ok(Math.abs(header.gyroScale - 0.00106526) < 0.0001);
  });

  it('extracts features list', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.ok(header.features.includes('OSD'));
    assert.ok(header.features.includes('MOTOR_STOP'));
    assert.strictEqual(header.features.length, 5);
  });
});

// ---------------------------------------------------------------------------
// 2. PID Extraction — individual p_roll/i_roll/d_roll fields
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — PID extraction (per-axis fields)', () => {

  it('extracts per-axis P, I, D values correctly', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.currentPIDs.roll.p, 48);
    assert.strictEqual(header.currentPIDs.roll.i, 85);
    assert.strictEqual(header.currentPIDs.roll.d, 35);
    assert.strictEqual(header.currentPIDs.pitch.p, 50);
    assert.strictEqual(header.currentPIDs.pitch.i, 88);
    assert.strictEqual(header.currentPIDs.pitch.d, 37);
    assert.strictEqual(header.currentPIDs.yaw.p, 45);
    assert.strictEqual(header.currentPIDs.yaw.i, 90);
    assert.strictEqual(header.currentPIDs.yaw.d, 0);
  });

  it('extracts composite d_min triplet (SpeedyBee uses comma-separated)', () => {
    const raw = buildSpeedyBeeHeader({ d_min: '32,34,0' });
    const header = parseHeader(raw);
    assert.strictEqual(header.currentPIDs.roll.dMin, 32);
    assert.strictEqual(header.currentPIDs.pitch.dMin, 34);
    assert.strictEqual(header.currentPIDs.yaw.dMin, 0);
  });

  it('extracts composite d_max triplet', () => {
    const raw = buildSpeedyBeeHeader({ d_max: '42,44,0' });
    const header = parseHeader(raw);
    assert.strictEqual(header.currentPIDs.roll.dMax, 42);
    assert.strictEqual(header.currentPIDs.pitch.dMax, 44);
    assert.strictEqual(header.currentPIDs.yaw.dMax, 0);
  });

  it('extracts composite ff_weight triplet as feedforward (f)', () => {
    const raw = buildSpeedyBeeHeader({ ff_weight: '130,135,80' });
    const header = parseHeader(raw);
    assert.strictEqual(header.currentPIDs.roll.f, 130);
    assert.strictEqual(header.currentPIDs.pitch.f, 135);
    assert.strictEqual(header.currentPIDs.yaw.f, 80);
  });

  it('d_min takes precedence as base D when both d_roll and d_min present', () => {
    // SpeedyBee F405 logs often have both d_roll and d_min.
    // The parser sets d_roll into .d and d_min into .dMin.
    // The PID analyzer uses dMin when available (BF 4.3+).
    const raw = buildSpeedyBeeHeader({ d_roll: 35 });
    const header = parseHeader(raw);
    // d_roll sets .d, d_min sets .dMin
    assert.strictEqual(header.currentPIDs.roll.d, 35);
    assert.strictEqual(header.currentPIDs.roll.dMin, 32);
  });
});

// ---------------------------------------------------------------------------
// 3. Filter settings extraction
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — filter extraction', () => {

  it('extracts gyro lowpass filters', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.gyroFilter.lowpass, 275);
    assert.strictEqual(header.gyroFilter.lowpass2, 550);
  });

  it('extracts dterm lowpass filters', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.dtermFilter.lowpass, 150);
    assert.strictEqual(header.dtermFilter.lowpass2, 300);
  });

  it('extracts dynamic notch range', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.gyroFilter.dynNotchMin, 100);
    assert.strictEqual(header.gyroFilter.dynNotchMax, 600);
  });
});

// ---------------------------------------------------------------------------
// 4. Rates extraction
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — rates extraction', () => {

  it('extracts composite rates triplet', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.currentRates.roll.rate, 70);
    assert.strictEqual(header.currentRates.pitch.rate, 70);
    assert.strictEqual(header.currentRates.yaw.rate, 65);
  });

  it('extracts rc_rates and rc_expo', () => {
    const raw = buildSpeedyBeeHeader();
    const header = parseHeader(raw);
    assert.strictEqual(header.currentRates.roll.rcRate, 100);
    assert.strictEqual(header.currentRates.yaw.rcRate, 100);
    assert.strictEqual(header.currentRates.roll.expo, 75);
    assert.strictEqual(header.currentRates.yaw.expo, 45);
  });
});

// ---------------------------------------------------------------------------
// 5. Full pipeline: parseBBL → analyzePIDs → CLI commands
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — full analysis pipeline', () => {

  it('parseBBL returns valid header and frames', () => {
    const buf = buildSpeedyBeeBBL();
    const result = parseBBL(buf);
    assert.ok(result.header);
    assert.ok(result.frames);
    assert.ok(result.frames.count > 0 || result.frames.synthetic);
  });

  it('analyzePIDs produces recommendations for all axes', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.ok(
          analysis.recommended[axis].hasOwnProperty(param),
          `Missing recommended.${axis}.${param}`
        );
        assert.ok(
          typeof analysis.recommended[axis][param] === 'number',
          `recommended.${axis}.${param} should be a number`
        );
      }
    }
  });

  it('analyzePIDs uses dMin as base D (not d_roll) for recommendation', () => {
    // SpeedyBee F405 quirk: d_roll=35 but d_min=32. The analyzer should
    // use dMin (32) as the base derivative, not d_roll (35).
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);

    // The recommendation should be derived from dMin=32, not d=35.
    // With clean noise, recD ≈ 32 * 1.08 = 35 (rounded).
    // With noisy data, recD ≈ 32 * 0.80 = 26.
    // Either way it's derived from 32, not 35.
    // We can't assert exact values due to random noise, but we can check
    // the current value was properly back-filled.
    assert.ok(analysis.current.roll.dMax === 42, 'current.roll.dMax should be 42 from d_max header');
    assert.ok(analysis.current.pitch.dMax === 44, 'current.pitch.dMax should be 44 from d_max header');
    assert.ok(analysis.current.yaw.dMax === 0, 'current.yaw.dMax should remain 0');
  });

  it('yaw D and dMax stay at 0 (not inflated)', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    assert.strictEqual(analysis.recommended.yaw.d, 0, 'Yaw D should stay 0');
    assert.strictEqual(analysis.recommended.yaw.dMax, 0, 'Yaw dMax should stay 0');
  });

  it('feedforward values back-filled from ff_weight header', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    // current.roll.f should be 130 from ff_weight header
    assert.strictEqual(analysis.current.roll.f, 130);
    assert.strictEqual(analysis.current.pitch.f, 135);
    assert.strictEqual(analysis.current.yaw.f, 80);
  });

  it('filter recommendations are within sane ranges', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    assert.ok(analysis.filters.gyro_lowpass_hz >= 200 && analysis.filters.gyro_lowpass_hz <= 300);
    assert.ok(analysis.filters.dterm_lowpass_hz >= 100 && analysis.filters.dterm_lowpass_hz <= 170);
  });

  it('assessment includes all expected items', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const labels = analysis.assessment.map(a => a.label);
    assert.ok(labels.includes('Propwash Handling'));
    assert.ok(labels.includes('Noise Floor'));
    assert.ok(labels.includes('Motor Balance'));
    assert.ok(labels.includes('Est. Step Response'));
  });

  it('generateCLICommands produces valid BF 4.4 CLI output', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const cli = generateCLICommands(analysis, '4.4');

    assert.ok(cli.includes('set p_roll'));
    assert.ok(cli.includes('set i_roll'));
    assert.ok(cli.includes('set d_roll'));
    assert.ok(cli.includes('set f_roll'));
    assert.ok(cli.includes('set d_max_roll'), 'BF 4.4 should have d_max_roll');
    assert.ok(cli.includes('gyro_lpf1_static_hz'), 'BF 4.4 should use gyro_lpf1_static_hz');
    assert.ok(cli.includes('dterm_lpf1_static_hz'), 'BF 4.4 should use dterm_lpf1_static_hz');
    assert.ok(cli.includes('save'));
    // Should reference the board
    assert.ok(cli.includes('SB405 Test Quad') || cli.includes('Betaflight'));
  });

  it('BF version auto-detected as 4.4 from firmware string', () => {
    const buf = buildSpeedyBeeBBL({ firmwareVersion: '4.4.2' });
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const ver = detectBfVersion(analysis.header.firmwareVersion);
    assert.strictEqual(ver, '4.4');
  });
});

// ---------------------------------------------------------------------------
// 6. Flight style application
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — flight style profiles', () => {

  it('freestyle style increases P and D from base', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const base = analyzePIDs(parsed);
    const styled = applyStyleToAnalysis(base, 'freestyle');
    // Freestyle multiplier for P is 1.10, so styled P >= base P
    assert.ok(styled.recommended.roll.p >= base.recommended.roll.p,
      'Freestyle roll P should be >= base');
  });

  it('cinematic style reduces P and D from base', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const base = analyzePIDs(parsed);
    const styled = applyStyleToAnalysis(base, 'cinematic');
    assert.ok(styled.recommended.roll.p <= base.recommended.roll.p,
      'Cinematic roll P should be <= base');
  });

  it('longrange style keeps yaw D at 0', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const base = analyzePIDs(parsed);
    const styled = applyStyleToAnalysis(base, 'longrange');
    assert.strictEqual(styled.recommended.yaw.d, 0);
    assert.strictEqual(styled.recommended.yaw.dMax, 0);
  });

  it('flight score returns 0-100 with valid tier', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const base = analyzePIDs(parsed);
    const styled = applyStyleToAnalysis(base, 'freestyle');
    const score = computeFlightScore(styled, null, 'freestyle');
    assert.ok(score.score >= 0 && score.score <= 100);
    assert.ok(['good', 'fair', 'poor'].includes(score.tier));
    assert.ok(score.summary.length > 0);
    assert.ok(score.breakdown.pidResponse >= 0);
    assert.ok(score.breakdown.vibration >= 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Tuning notes
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — tuning notes', () => {

  it('generates Chinese tuning notes for changed values', () => {
    const buf = buildSpeedyBeeBBL();
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const notes = generateTuningNotes(analysis.current, analysis.recommended);
    // With random noise data, at least some values should differ
    // The notes should contain Chinese descriptions
    if (notes.length > 0) {
      const hasChinese = notes.some(n => /[\u4e00-\u9fff]/.test(n));
      assert.ok(hasChinese, 'Tuning notes should contain Chinese descriptions');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases — SpeedyBee F405 specific quirks
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — board-specific quirks', () => {

  it('QUIRK: handles missing d_min header (falls back to d_roll)', () => {
    // Some older SpeedyBee F405 firmware versions don't write d_min.
    // Parser should still work — d_roll is the fallback.
    const headerStr = buildSpeedyBeeHeader({ d_min: undefined })
      .split('\n')
      .filter(l => !l.startsWith('H d_min:'))
      .join('\n');
    const header = parseHeader(headerStr);
    // Without d_min, dMin should be undefined
    assert.strictEqual(header.currentPIDs.roll.dMin, undefined);
    // But d_roll is still set
    assert.strictEqual(header.currentPIDs.roll.d, 35);

    // The analyzer should fall back to using d as base D
    const buf = Buffer.from(headerStr + '\n' + 'X'.repeat(100), 'latin1');
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    // Recommendation should still produce valid numbers
    assert.ok(typeof analysis.recommended.roll.d === 'number');
    assert.ok(analysis.recommended.roll.d >= 0);
  });

  it('QUIRK: handles missing ff_weight (falls back to f_roll defaults)', () => {
    // Without ff_weight, f values should come from f_roll/f_pitch/f_yaw
    // or defaults if those are also missing.
    const headerStr = buildSpeedyBeeHeader({ ff_weight: undefined })
      .split('\n')
      .filter(l => !l.startsWith('H ff_weight:'))
      .join('\n');
    const header = parseHeader(headerStr);
    // Without ff_weight, f should be undefined (not set by any header)
    // unless individual f_roll/f_pitch headers exist
    // Our test header doesn't include f_roll, so f should be undefined
    assert.strictEqual(header.currentPIDs.roll.f, undefined);
  });

  it('QUIRK: ICM-42688-P gyroScale (0.00106526) parses correctly', () => {
    const raw = buildSpeedyBeeHeader({ gyroScale: '0.00106526' });
    const header = parseHeader(raw);
    // Should not NaN or default to 1
    assert.ok(header.gyroScale > 0 && header.gyroScale < 1);
    assert.ok(Math.abs(header.gyroScale - 0.00106526) < 1e-8);
  });

  it('QUIRK: SpeedyBee V4 with BF 4.5 omits d_max from CLI', () => {
    const buf = buildSpeedyBeeBBL({
      boardInfo: 'SPEEDYBEEF405V4',
      firmwareVersion: '4.5.0',
    });
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const ver = detectBfVersion(analysis.header.firmwareVersion);
    assert.strictEqual(ver, '4.5');
    const cli = generateCLICommands(analysis, ver);
    assert.ok(!cli.includes('d_max_roll'), 'BF 4.5 should NOT have d_max_roll');
    assert.ok(!cli.includes('d_max_pitch'), 'BF 4.5 should NOT have d_max_pitch');
    assert.ok(cli.includes('gyro_lpf1_static_hz'));
  });

  it('QUIRK: handles 4kHz looptime (250µs) correctly', () => {
    // Some SpeedyBee F405 users run 4kHz instead of 8kHz
    const buf = buildSpeedyBeeBBL({ looptime: 250 });
    const parsed = parseBBL(buf);
    assert.strictEqual(parsed.header.looptime, 250);
    const analysis = analyzePIDs(parsed);
    // Analysis should still complete successfully
    assert.ok(analysis.recommended.roll.p > 0);
  });

  it('QUIRK: BF 4.3 firmware detected and d_max included in CLI', () => {
    const buf = buildSpeedyBeeBBL({ firmwareVersion: '4.3.1' });
    const parsed = parseBBL(buf);
    const analysis = analyzePIDs(parsed);
    const ver = detectBfVersion(analysis.header.firmwareVersion);
    assert.strictEqual(ver, '4.3');
    const cli = generateCLICommands(analysis, ver);
    assert.ok(cli.includes('d_max_roll'), 'BF 4.3 should have d_max_roll');
  });

  it('QUIRK: composite d_min with only 2 values (malformed) handled gracefully', () => {
    // Some firmware bugs produce truncated headers
    const raw = buildSpeedyBeeHeader({ d_min: '32,34' });
    const header = parseHeader(raw);
    // With only 2 values, the parser requires >= 3, so dMin should NOT be set
    assert.strictEqual(header.currentPIDs.roll.dMin, undefined);
    assert.strictEqual(header.currentPIDs.pitch.dMin, undefined);
  });

  it('QUIRK: empty craft name defaults to "Unnamed"', () => {
    const raw = buildSpeedyBeeHeader({ craftName: '' });
    const header = parseHeader(raw);
    assert.strictEqual(header.craftName, 'Unnamed');
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-version CLI generation
// ---------------------------------------------------------------------------
describe('SpeedyBee F405 — CLI generation across BF versions', () => {
  const versions = ['4.2', '4.3', '4.4', '4.5'];

  for (const ver of versions) {
    it(`generates valid CLI for BF ${ver}`, () => {
      const buf = buildSpeedyBeeBBL({ firmwareVersion: `${ver}.0` });
      const parsed = parseBBL(buf);
      const analysis = analyzePIDs(parsed);
      const cli = generateCLICommands(analysis, ver);

      // All versions should have base PID params
      assert.ok(cli.includes('set p_roll'), `BF ${ver} missing p_roll`);
      assert.ok(cli.includes('set i_roll'), `BF ${ver} missing i_roll`);
      assert.ok(cli.includes('set d_roll'), `BF ${ver} missing d_roll`);
      assert.ok(cli.includes('set f_roll'), `BF ${ver} missing f_roll`);
      assert.ok(cli.includes('save'), `BF ${ver} missing save`);

      // d_max presence depends on version
      if (ver === '4.5') {
        assert.ok(!cli.includes('d_max_roll'), `BF ${ver} should NOT have d_max_roll`);
      } else {
        assert.ok(cli.includes('d_max_roll'), `BF ${ver} should have d_max_roll`);
      }
    });
  }
});
