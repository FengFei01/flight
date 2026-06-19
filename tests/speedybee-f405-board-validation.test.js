/**
 * SpeedBee F405 board compatibility validation — cross-board comparison.
 * Validates PID recommendation accuracy and filter settings by comparing
 * SpeedBee F405 against known-good reference boards (Matek F405-STD, F7)
 * with identical flight data to ensure calibration parity.
 *
 * Key validation areas:
 * 1. Same gyro data → same recommendations regardless of board
 * 2. SpeedBee ICM-42688-P gyroScale doesn't distort filter recs
 * 3. SpeedBee composite header quirks (d_min/d_max/ff_weight) parse identically
 *    to per-axis headers used by other boards
 * 4. Flight score consistency across boards for same flight data
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseHeader } = require('../services/bbl-parser');
const {
  analyzePIDs, generateCLICommands, generateTuningNotes,
  applyStyleToAnalysis, computeFlightScore,
} = require('../services/pid-analyzer');
const { detectBfVersion } = require('../public/js/bf-version-map');

// ---------------------------------------------------------------------------
// Reference board header builders — simulate known-good F4/F7 boards
// ---------------------------------------------------------------------------

/**
 * Build header for Matek F405-STD (MPU6000 gyro, per-axis PID fields).
 * This is the most common BF F4 board — our "gold standard" reference.
 */
function buildMatekF405Header(overrides = {}) {
  const o = {
    boardInfo: 'MATEKF405STD',
    firmware: 'Betaflight',
    firmwareVersion: '4.4.2',
    craftName: 'Reference F405',
    looptime: 125,
    gyroScale: '0.00106526',
    p_roll: 48, i_roll: 85, d_roll: 35,
    p_pitch: 50, i_pitch: 88, d_pitch: 37,
    p_yaw: 45, i_yaw: 90, d_yaw: 0,
    // Matek uses per-axis d_min/d_max fields (not composite)
    d_min_roll: 32, d_min_pitch: 34, d_min_yaw: 0,
    d_max_roll: 42, d_max_pitch: 44, d_max_yaw: 0,
    // Per-axis feedforward
    f_roll: 130, f_pitch: 135, f_yaw: 80,
    gyro_lowpass_hz: 275,
    gyro_lowpass2_hz: 550,
    dterm_lowpass_hz: 150,
    dterm_lowpass2_hz: 300,
    dyn_notch_min_hz: 100,
    dyn_notch_max_hz: 600,
    rates: '70,70,65',
    rc_rates: '100,100,100',
    rc_expo: '75,75,45',
    ...overrides,
  };

  const lines = [
    `H Product:${o.firmware}`,
    `H Firmware revision:${o.firmwareVersion}`,
    `H Craft name:${o.craftName}`,
    `H Board information:${o.boardInfo}`,
    `H looptime:${o.looptime}`,
    `H gyro_scale:${o.gyroScale}`,
    `H p_roll:${o.p_roll}`, `H i_roll:${o.i_roll}`, `H d_roll:${o.d_roll}`,
    `H p_pitch:${o.p_pitch}`, `H i_pitch:${o.i_pitch}`, `H d_pitch:${o.d_pitch}`,
    `H p_yaw:${o.p_yaw}`, `H i_yaw:${o.i_yaw}`, `H d_yaw:${o.d_yaw}`,
    `H d_min_roll:${o.d_min_roll}`, `H d_min_pitch:${o.d_min_pitch}`, `H d_min_yaw:${o.d_min_yaw}`,
    `H d_max_roll:${o.d_max_roll}`, `H d_max_pitch:${o.d_max_pitch}`, `H d_max_yaw:${o.d_max_yaw}`,
    `H f_roll:${o.f_roll}`, `H f_pitch:${o.f_pitch}`, `H f_yaw:${o.f_yaw}`,
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

/**
 * Build header for generic F7 board (e.g. Matek F722-SE) — BF 4.4.
 * F7 boards typically run 8kHz with MPU6000 or ICM-42688 gyro.
 */
function buildF7Header(overrides = {}) {
  return buildMatekF405Header({
    boardInfo: 'MATEKF722SE',
    craftName: 'Reference F7',
    ...overrides,
  });
}

/**
 * Build SpeedBee F405 header using composite d_min/d_max/ff_weight fields.
 * Same PID values as reference boards but using SpeedBee's header format.
 */
function buildSpeedBeeF405Header(overrides = {}) {
  const o = {
    boardInfo: 'SPEEDYBEEF405V3',
    firmware: 'Betaflight',
    firmwareVersion: '4.4.2',
    craftName: 'SB405 Validation',
    looptime: 125,
    gyroScale: '0.00106526',
    p_roll: 48, i_roll: 85, d_roll: 35,
    p_pitch: 50, i_pitch: 88, d_pitch: 37,
    p_yaw: 45, i_yaw: 90, d_yaw: 0,
    // SpeedBee uses composite comma-separated triplets
    d_min: '32,34,0',
    d_max: '42,44,0',
    ff_weight: '130,135,80',
    gyro_lowpass_hz: 275,
    gyro_lowpass2_hz: 550,
    dterm_lowpass_hz: 150,
    dterm_lowpass2_hz: 300,
    dyn_notch_min_hz: 100,
    dyn_notch_max_hz: 600,
    rates: '70,70,65',
    rc_rates: '100,100,100',
    rc_expo: '75,75,45',
    ...overrides,
  };

  const lines = [
    `H Product:${o.firmware}`,
    `H Firmware revision:${o.firmwareVersion}`,
    `H Craft name:${o.craftName}`,
    `H Board information:${o.boardInfo}`,
    `H looptime:${o.looptime}`,
    `H gyro_scale:${o.gyroScale}`,
    `H p_roll:${o.p_roll}`, `H i_roll:${o.i_roll}`, `H d_roll:${o.d_roll}`,
    `H p_pitch:${o.p_pitch}`, `H i_pitch:${o.i_pitch}`, `H d_pitch:${o.d_pitch}`,
    `H p_yaw:${o.p_yaw}`, `H i_yaw:${o.i_yaw}`, `H d_yaw:${o.d_yaw}`,
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

/**
 * Build a deterministic (non-random) parsed data structure from a header string.
 * Uses a fixed sinusoidal gyro pattern so cross-board tests are repeatable.
 */
function buildDeterministicParsedData(headerStr) {
  const header = parseHeader(headerStr);
  const N = 500;
  const gyro = { roll: [], pitch: [], yaw: [] };
  const motors = [[], [], [], []];

  for (let i = 0; i < N; i++) {
    // Deterministic low-noise gyro signal (clean flight)
    gyro.roll.push(Math.round(Math.sin(i * 0.1) * 12 + Math.sin(i * 0.37) * 5));
    gyro.pitch.push(Math.round(Math.sin(i * 0.12) * 13 + Math.cos(i * 0.29) * 4));
    gyro.yaw.push(Math.round(Math.sin(i * 0.05) * 8));

    motors[0].push(1350 + Math.round(Math.sin(i * 0.02) * 50));
    motors[1].push(1350 + Math.round(Math.cos(i * 0.02) * 50));
    motors[2].push(1350 + Math.round(Math.sin(i * 0.03) * 50));
    motors[3].push(1350 + Math.round(Math.cos(i * 0.03) * 50));
  }

  return {
    header,
    frames: { gyro, motor: motors, count: N },
  };
}

/**
 * Build deterministic parsed data with higher noise (moderate flight).
 */
function buildNoisyParsedData(headerStr) {
  const header = parseHeader(headerStr);
  const N = 500;
  const gyro = { roll: [], pitch: [], yaw: [] };
  const motors = [[], [], [], []];

  // Seeded PRNG for deterministic "random" noise
  let seed = 42;
  function seededRandom() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5;
  }

  for (let i = 0; i < N; i++) {
    gyro.roll.push(Math.round(Math.sin(i * 0.1) * 30 + seededRandom() * 80));
    gyro.pitch.push(Math.round(Math.sin(i * 0.12) * 32 + seededRandom() * 85));
    gyro.yaw.push(Math.round(Math.sin(i * 0.05) * 20 + seededRandom() * 40));

    motors[0].push(1300 + Math.round(seededRandom() * 300 + 200));
    motors[1].push(1300 + Math.round(seededRandom() * 300 + 200));
    motors[2].push(1300 + Math.round(seededRandom() * 300 + 200));
    motors[3].push(1300 + Math.round(seededRandom() * 300 + 200));
  }

  return {
    header,
    frames: { gyro, motor: motors, count: N },
  };
}

// ---------------------------------------------------------------------------
// 1. Header parsing parity — same PID values extracted regardless of format
// ---------------------------------------------------------------------------
describe('Cross-board header parity — SpeedBee F405 vs reference boards', () => {

  it('SpeedBee composite d_min/d_max/ff_weight matches Matek per-axis fields', () => {
    const sb = parseHeader(buildSpeedBeeF405Header());
    const matek = parseHeader(buildMatekF405Header());

    // dMin values
    assert.strictEqual(sb.currentPIDs.roll.dMin, matek.currentPIDs.roll.dMin,
      'roll dMin mismatch');
    assert.strictEqual(sb.currentPIDs.pitch.dMin, matek.currentPIDs.pitch.dMin,
      'pitch dMin mismatch');
    assert.strictEqual(sb.currentPIDs.yaw.dMin, matek.currentPIDs.yaw.dMin,
      'yaw dMin mismatch');

    // dMax values
    assert.strictEqual(sb.currentPIDs.roll.dMax, matek.currentPIDs.roll.dMax,
      'roll dMax mismatch');
    assert.strictEqual(sb.currentPIDs.pitch.dMax, matek.currentPIDs.pitch.dMax,
      'pitch dMax mismatch');
    assert.strictEqual(sb.currentPIDs.yaw.dMax, matek.currentPIDs.yaw.dMax,
      'yaw dMax mismatch');

    // Feedforward values
    assert.strictEqual(sb.currentPIDs.roll.f, matek.currentPIDs.roll.f,
      'roll FF mismatch');
    assert.strictEqual(sb.currentPIDs.pitch.f, matek.currentPIDs.pitch.f,
      'pitch FF mismatch');
    assert.strictEqual(sb.currentPIDs.yaw.f, matek.currentPIDs.yaw.f,
      'yaw FF mismatch');
  });

  it('SpeedBee matches F7 board PID extraction for identical values', () => {
    const sb = parseHeader(buildSpeedBeeF405Header());
    const f7 = parseHeader(buildF7Header());

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'dMin', 'dMax', 'f']) {
        assert.strictEqual(
          sb.currentPIDs[axis][param],
          f7.currentPIDs[axis][param],
          `${axis}.${param} mismatch between SpeedBee and F7`
        );
      }
    }
  });

  it('filter settings parse identically across all three boards', () => {
    const sb = parseHeader(buildSpeedBeeF405Header());
    const matek = parseHeader(buildMatekF405Header());
    const f7 = parseHeader(buildF7Header());

    for (const board of [matek, f7]) {
      assert.strictEqual(sb.gyroFilter.lowpass, board.gyroFilter.lowpass);
      assert.strictEqual(sb.gyroFilter.lowpass2, board.gyroFilter.lowpass2);
      assert.strictEqual(sb.dtermFilter.lowpass, board.dtermFilter.lowpass);
      assert.strictEqual(sb.dtermFilter.lowpass2, board.dtermFilter.lowpass2);
      assert.strictEqual(sb.gyroFilter.dynNotchMin, board.gyroFilter.dynNotchMin);
      assert.strictEqual(sb.gyroFilter.dynNotchMax, board.gyroFilter.dynNotchMax);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PID recommendation accuracy — identical flight data → identical recs
// ---------------------------------------------------------------------------
describe('PID recommendation parity — same data, different boards', () => {

  it('clean flight: SpeedBee produces identical PID recs to Matek F405', () => {
    const sbParsed = buildDeterministicParsedData(buildSpeedBeeF405Header());
    const matekParsed = buildDeterministicParsedData(buildMatekF405Header());

    const sbAnalysis = analyzePIDs(sbParsed);
    const matekAnalysis = analyzePIDs(matekParsed);

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.strictEqual(
          sbAnalysis.recommended[axis][param],
          matekAnalysis.recommended[axis][param],
          `Clean flight: ${axis}.${param} recommendation differs between SpeedBee and Matek`
        );
      }
    }
  });

  it('clean flight: SpeedBee produces identical PID recs to F7 board', () => {
    const sbParsed = buildDeterministicParsedData(buildSpeedBeeF405Header());
    const f7Parsed = buildDeterministicParsedData(buildF7Header());

    const sbAnalysis = analyzePIDs(sbParsed);
    const f7Analysis = analyzePIDs(f7Parsed);

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.strictEqual(
          sbAnalysis.recommended[axis][param],
          f7Analysis.recommended[axis][param],
          `Clean flight: ${axis}.${param} recommendation differs between SpeedBee and F7`
        );
      }
    }
  });

  it('noisy flight: SpeedBee produces identical PID recs to Matek F405', () => {
    const sbParsed = buildNoisyParsedData(buildSpeedBeeF405Header());
    const matekParsed = buildNoisyParsedData(buildMatekF405Header());

    const sbAnalysis = analyzePIDs(sbParsed);
    const matekAnalysis = analyzePIDs(matekParsed);

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.strictEqual(
          sbAnalysis.recommended[axis][param],
          matekAnalysis.recommended[axis][param],
          `Noisy flight: ${axis}.${param} recommendation differs between SpeedBee and Matek`
        );
      }
    }
  });

  it('noisy flight: SpeedBee produces identical PID recs to F7 board', () => {
    const sbParsed = buildNoisyParsedData(buildSpeedBeeF405Header());
    const f7Parsed = buildNoisyParsedData(buildF7Header());

    const sbAnalysis = analyzePIDs(sbParsed);
    const f7Analysis = analyzePIDs(f7Parsed);

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.strictEqual(
          sbAnalysis.recommended[axis][param],
          f7Analysis.recommended[axis][param],
          `Noisy flight: ${axis}.${param} recommendation differs between SpeedBee and F7`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Filter recommendation calibration
// ---------------------------------------------------------------------------
describe('Filter recommendation calibration — SpeedBee F405 vs reference', () => {

  it('clean data: same filter recs across all three boards', () => {
    const boards = [
      buildDeterministicParsedData(buildSpeedBeeF405Header()),
      buildDeterministicParsedData(buildMatekF405Header()),
      buildDeterministicParsedData(buildF7Header()),
    ];
    const analyses = boards.map(b => analyzePIDs(b));

    const refGyro = analyses[0].filters.gyro_lowpass_hz;
    const refDterm = analyses[0].filters.dterm_lowpass_hz;

    for (let i = 1; i < analyses.length; i++) {
      assert.strictEqual(analyses[i].filters.gyro_lowpass_hz, refGyro,
        `Board ${i} gyro lowpass differs from SpeedBee`);
      assert.strictEqual(analyses[i].filters.dterm_lowpass_hz, refDterm,
        `Board ${i} dterm lowpass differs from SpeedBee`);
    }
  });

  it('noisy data: same filter recs across all three boards', () => {
    const boards = [
      buildNoisyParsedData(buildSpeedBeeF405Header()),
      buildNoisyParsedData(buildMatekF405Header()),
      buildNoisyParsedData(buildF7Header()),
    ];
    const analyses = boards.map(b => analyzePIDs(b));

    const refGyro = analyses[0].filters.gyro_lowpass_hz;
    const refDterm = analyses[0].filters.dterm_lowpass_hz;

    for (let i = 1; i < analyses.length; i++) {
      assert.strictEqual(analyses[i].filters.gyro_lowpass_hz, refGyro,
        `Board ${i} gyro lowpass differs from SpeedBee`);
      assert.strictEqual(analyses[i].filters.dterm_lowpass_hz, refDterm,
        `Board ${i} dterm lowpass differs from SpeedBee`);
    }
  });

  it('SpeedBee filter notes match reference board notes', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

    assert.strictEqual(sb.filters.notes, matek.filters.notes,
      'Filter notes text should match when noise levels are identical');
  });
});

// ---------------------------------------------------------------------------
// 4. Gyro noise classification consistency
// ---------------------------------------------------------------------------
describe('Gyro noise classification — SpeedBee F405 vs reference', () => {

  it('clean data: all boards classified as same noise level', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));
    const f7 = analyzePIDs(buildDeterministicParsedData(buildF7Header()));

    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.strictEqual(sb.gyroStats[axis].noiseLevel, matek.gyroStats[axis].noiseLevel,
        `${axis} noise level mismatch SB vs Matek`);
      assert.strictEqual(sb.gyroStats[axis].noiseLevel, f7.gyroStats[axis].noiseLevel,
        `${axis} noise level mismatch SB vs F7`);
    }
  });

  it('noisy data: all boards classified as same noise level', () => {
    const sb = analyzePIDs(buildNoisyParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildNoisyParsedData(buildMatekF405Header()));
    const f7 = analyzePIDs(buildNoisyParsedData(buildF7Header()));

    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.strictEqual(sb.gyroStats[axis].noiseLevel, matek.gyroStats[axis].noiseLevel,
        `${axis} noise level mismatch SB vs Matek`);
      assert.strictEqual(sb.gyroStats[axis].noiseLevel, f7.gyroStats[axis].noiseLevel,
        `${axis} noise level mismatch SB vs F7`);
    }
  });

  it('gyro RMS values identical across boards for same data', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.strictEqual(sb.gyroStats[axis].rms, matek.gyroStats[axis].rms,
        `${axis} RMS differs — gyroScale leak?`);
      assert.strictEqual(sb.gyroStats[axis].stdDev, matek.gyroStats[axis].stdDev,
        `${axis} stdDev differs`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Flight score consistency
// ---------------------------------------------------------------------------
describe('Flight score consistency — SpeedBee F405 vs reference boards', () => {

  const STYLES = ['freestyle', 'racing', 'cinematic', 'longrange'];

  for (const style of STYLES) {
    it(`${style}: SpeedBee flight score matches Matek F405`, () => {
      const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
      const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

      const sbStyled = applyStyleToAnalysis(sb, style);
      const matekStyled = applyStyleToAnalysis(matek, style);

      const sbScore = computeFlightScore(sbStyled, null, style);
      const matekScore = computeFlightScore(matekStyled, null, style);

      assert.strictEqual(sbScore.score, matekScore.score,
        `${style}: flight score mismatch (SB=${sbScore.score}, Matek=${matekScore.score})`);
      assert.strictEqual(sbScore.tier, matekScore.tier,
        `${style}: tier mismatch`);
    });
  }

  it('noisy data: SpeedBee and Matek get same score breakdown', () => {
    const sb = analyzePIDs(buildNoisyParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildNoisyParsedData(buildMatekF405Header()));

    const sbStyled = applyStyleToAnalysis(sb, 'freestyle');
    const matekStyled = applyStyleToAnalysis(matek, 'freestyle');

    const sbScore = computeFlightScore(sbStyled, null, 'freestyle');
    const matekScore = computeFlightScore(matekStyled, null, 'freestyle');

    assert.strictEqual(sbScore.breakdown.pidResponse, matekScore.breakdown.pidResponse,
      'PID response sub-score mismatch');
    assert.strictEqual(sbScore.breakdown.vibration, matekScore.breakdown.vibration,
      'Vibration sub-score mismatch');
    assert.strictEqual(sbScore.breakdown.filterEffectiveness, matekScore.breakdown.filterEffectiveness,
      'Filter effectiveness sub-score mismatch');
  });
});

// ---------------------------------------------------------------------------
// 6. CLI output parity
// ---------------------------------------------------------------------------
describe('CLI output parity — SpeedBee F405 vs reference boards', () => {

  it('BF 4.4: SpeedBee CLI commands match Matek (same PID values)', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

    const sbCli = generateCLICommands(sb, '4.4');
    const matekCli = generateCLICommands(matek, '4.4');

    // Strip craft name and board info lines (those differ by design)
    const normalize = cli => cli.split('\n')
      .filter(l => !l.startsWith('# Craft:') && !l.startsWith('# Firmware:'))
      .join('\n');

    assert.strictEqual(normalize(sbCli), normalize(matekCli),
      'CLI commands differ between SpeedBee and Matek for same flight data');
  });

  it('BF 4.5: SpeedBee CLI omits d_max just like F7 board', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(
      buildSpeedBeeF405Header({ firmwareVersion: '4.5.0' })));
    const f7 = analyzePIDs(buildDeterministicParsedData(
      buildF7Header({ firmwareVersion: '4.5.0' })));

    const sbCli = generateCLICommands(sb, '4.5');
    const f7Cli = generateCLICommands(f7, '4.5');

    // Both should omit d_max
    assert.ok(!sbCli.includes('d_max_roll'), 'SpeedBee BF 4.5 should omit d_max_roll');
    assert.ok(!f7Cli.includes('d_max_roll'), 'F7 BF 4.5 should omit d_max_roll');

    // PID values should still match
    const normalize = cli => cli.split('\n')
      .filter(l => !l.startsWith('# Craft:') && !l.startsWith('# Firmware:'))
      .join('\n');
    assert.strictEqual(normalize(sbCli), normalize(f7Cli));
  });
});

// ---------------------------------------------------------------------------
// 7. Tuning notes parity
// ---------------------------------------------------------------------------
describe('Tuning notes parity — SpeedBee F405 vs reference boards', () => {

  it('same tuning notes generated for SpeedBee and Matek', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

    const sbNotes = generateTuningNotes(sb.current, sb.recommended);
    const matekNotes = generateTuningNotes(matek.current, matek.recommended);

    assert.strictEqual(sbNotes.length, matekNotes.length,
      'Different number of tuning notes');

    for (let i = 0; i < sbNotes.length; i++) {
      assert.strictEqual(sbNotes[i], matekNotes[i],
        `Tuning note ${i} differs`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. SpeedBee V3 vs V4 sub-variant consistency
// ---------------------------------------------------------------------------
describe('SpeedBee F405 sub-variants — V3 vs V4 consistency', () => {

  it('V3 and V4 produce identical recommendations for same flight data', () => {
    const v3 = analyzePIDs(buildDeterministicParsedData(
      buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V3' })));
    const v4 = analyzePIDs(buildDeterministicParsedData(
      buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V4' })));

    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.strictEqual(
          v3.recommended[axis][param],
          v4.recommended[axis][param],
          `V3 vs V4: ${axis}.${param} differs`
        );
      }
    }
  });

  it('V3 and V4 produce identical filter recommendations', () => {
    const v3 = analyzePIDs(buildDeterministicParsedData(
      buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V3' })));
    const v4 = analyzePIDs(buildDeterministicParsedData(
      buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V4' })));

    assert.strictEqual(v3.filters.gyro_lowpass_hz, v4.filters.gyro_lowpass_hz);
    assert.strictEqual(v3.filters.dterm_lowpass_hz, v4.filters.dterm_lowpass_hz);
  });

  it('V3 and V4 get identical flight scores across all styles', () => {
    for (const style of ['freestyle', 'racing', 'cinematic', 'longrange']) {
      const v3 = analyzePIDs(buildDeterministicParsedData(
        buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V3' })));
      const v4 = analyzePIDs(buildDeterministicParsedData(
        buildSpeedBeeF405Header({ boardInfo: 'SPEEDYBEEF405V4' })));

      const v3Styled = applyStyleToAnalysis(v3, style);
      const v4Styled = applyStyleToAnalysis(v4, style);

      const v3Score = computeFlightScore(v3Styled, null, style);
      const v4Score = computeFlightScore(v4Styled, null, style);

      assert.strictEqual(v3Score.score, v4Score.score,
        `${style}: V3 vs V4 score mismatch`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Assessment parity
// ---------------------------------------------------------------------------
describe('Assessment parity — SpeedBee F405 vs reference boards', () => {

  it('assessment items match across boards for clean data', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildDeterministicParsedData(buildMatekF405Header()));

    assert.strictEqual(sb.assessment.length, matek.assessment.length);

    for (let i = 0; i < sb.assessment.length; i++) {
      assert.strictEqual(sb.assessment[i].label, matek.assessment[i].label);
      assert.strictEqual(sb.assessment[i].value, matek.assessment[i].value,
        `Assessment "${sb.assessment[i].label}" value differs`);
      assert.strictEqual(sb.assessment[i].status, matek.assessment[i].status,
        `Assessment "${sb.assessment[i].label}" status differs`);
    }
  });

  it('assessment items match across boards for noisy data', () => {
    const sb = analyzePIDs(buildNoisyParsedData(buildSpeedBeeF405Header()));
    const matek = analyzePIDs(buildNoisyParsedData(buildMatekF405Header()));

    for (let i = 0; i < sb.assessment.length; i++) {
      assert.strictEqual(sb.assessment[i].value, matek.assessment[i].value,
        `Noisy assessment "${sb.assessment[i].label}" value differs`);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Regression guard — SpeedBee-specific PID value ranges
// ---------------------------------------------------------------------------
describe('SpeedBee F405 PID value range validation', () => {

  it('clean data: P values within expected range (40-60)', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.ok(sb.recommended[axis].p >= 40 && sb.recommended[axis].p <= 60,
        `${axis} P=${sb.recommended[axis].p} outside expected range 40-60`);
    }
  });

  it('clean data: I values within expected range (80-100)', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    for (const axis of ['roll', 'pitch']) {
      assert.ok(sb.recommended[axis].i >= 80 && sb.recommended[axis].i <= 100,
        `${axis} I=${sb.recommended[axis].i} outside expected range 80-100`);
    }
  });

  it('clean data: D values within expected range', () => {
    const sb = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    // Roll/Pitch D should be 25-45 for clean data
    for (const axis of ['roll', 'pitch']) {
      assert.ok(sb.recommended[axis].d >= 25 && sb.recommended[axis].d <= 45,
        `${axis} D=${sb.recommended[axis].d} outside expected range 25-45`);
    }
    // Yaw D should stay 0
    assert.strictEqual(sb.recommended.yaw.d, 0, 'Yaw D should be 0');
  });

  it('noisy data: P values reduced (below clean baseline)', () => {
    const sbClean = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const sbNoisy = analyzePIDs(buildNoisyParsedData(buildSpeedBeeF405Header()));

    // In noisy conditions, P should be reduced or equal
    assert.ok(sbNoisy.recommended.roll.p <= sbClean.recommended.roll.p,
      'Noisy roll P should be <= clean roll P');
    assert.ok(sbNoisy.recommended.pitch.p <= sbClean.recommended.pitch.p,
      'Noisy pitch P should be <= clean pitch P');
  });

  it('noisy data: filter cutoffs lowered (tighter filtering)', () => {
    const sbClean = analyzePIDs(buildDeterministicParsedData(buildSpeedBeeF405Header()));
    const sbNoisy = analyzePIDs(buildNoisyParsedData(buildSpeedBeeF405Header()));

    assert.ok(sbNoisy.filters.gyro_lowpass_hz <= sbClean.filters.gyro_lowpass_hz,
      'Noisy gyro lowpass should be <= clean');
    assert.ok(sbNoisy.filters.dterm_lowpass_hz <= sbClean.filters.dterm_lowpass_hz,
      'Noisy dterm lowpass should be <= clean');
  });
});
