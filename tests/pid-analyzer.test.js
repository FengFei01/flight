/**
 * Tests for pid-analyzer.js — PID recommendation engine.
 * Covers: recommendAxis with D_Max, generateTuningNotes, generateCLICommands.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzePIDs, generateCLICommands, generateTuningNotes } = require('../services/pid-analyzer');

// Helper: minimal parsed data structure for analyzePIDs
function makeParsedData(pids) {
  return {
    header: {
      firmware: 'Betaflight',
      firmwareVersion: '4.5.0',
      craftName: 'Test',
      currentPIDs: pids || {
        roll:  { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
        pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
        yaw:   { p: 45, i: 90, d: 0,  f: 75,  dMax: 0 },
      },
      currentRates: { roll: {}, pitch: {}, yaw: {} },
      gyroFilter: {},
      dtermFilter: {},
    },
    frames: {
      gyro: {
        roll: Array(200).fill(0).map(() => Math.round((Math.random() - 0.5) * 30)),
        pitch: Array(200).fill(0).map(() => Math.round((Math.random() - 0.5) * 30)),
        yaw: Array(200).fill(0).map(() => Math.round((Math.random() - 0.5) * 20)),
      },
      motor: [
        Array(200).fill(1400),
        Array(200).fill(1400),
        Array(200).fill(1400),
        Array(200).fill(1400),
      ],
      count: 200,
    },
  };
}

describe('analyzePIDs', () => {
  it('returns recommended values with dMax field for all axes', () => {
    const result = analyzePIDs(makeParsedData());
    assert.ok(result.recommended.roll.hasOwnProperty('dMax'));
    assert.ok(result.recommended.pitch.hasOwnProperty('dMax'));
    assert.ok(result.recommended.yaw.hasOwnProperty('dMax'));
  });

  it('dMax is clamped within 0-80 range', () => {
    const result = analyzePIDs(makeParsedData());
    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.ok(result.recommended[axis].dMax >= 0);
      assert.ok(result.recommended[axis].dMax <= 80);
    }
  });

  it('recommended values include p, i, d, f, dMax for each axis', () => {
    const result = analyzePIDs(makeParsedData());
    for (const axis of ['roll', 'pitch', 'yaw']) {
      for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
        assert.ok(result.recommended[axis].hasOwnProperty(param), `${axis} missing ${param}`);
      }
    }
  });

  it('yaw dMax defaults to 0 when input has no dMax', () => {
    const pids = {
      roll: { p: 45, i: 80, d: 30, f: 120 },
      pitch: { p: 47, i: 84, d: 32, f: 125 },
      yaw: { p: 45, i: 90, d: 0, f: 75 },
    };
    const result = analyzePIDs(makeParsedData(pids));
    assert.ok(result.recommended.yaw.dMax >= 0);
  });
});

describe('generateCLICommands', () => {
  it('includes d_max_roll, d_max_pitch, d_max_yaw for BF 4.3 (default)', () => {
    const result = analyzePIDs(makeParsedData());
    const cli = generateCLICommands(result);
    assert.ok(cli.includes('d_max_roll'), 'Missing d_max_roll');
    assert.ok(cli.includes('d_max_pitch'), 'Missing d_max_pitch');
    assert.ok(cli.includes('d_max_yaw'), 'Missing d_max_yaw');
  });

  it('includes all PID params in CLI output for BF 4.3', () => {
    const result = analyzePIDs(makeParsedData());
    const cli = generateCLICommands(result, '4.3');
    assert.ok(cli.includes('set p_roll'));
    assert.ok(cli.includes('set i_roll'));
    assert.ok(cli.includes('set d_roll'));
    assert.ok(cli.includes('set f_roll'));
    assert.ok(cli.includes('set d_max_roll'));
    assert.ok(cli.includes('save'));
  });

  it('BF 4.5 omits d_max and uses lpf1_static filter names', () => {
    const result = analyzePIDs(makeParsedData());
    const cli = generateCLICommands(result, '4.5');
    assert.ok(!cli.includes('d_max_roll'), 'Should not contain d_max_roll');
    assert.ok(!cli.includes('d_max_pitch'), 'Should not contain d_max_pitch');
    assert.ok(cli.includes('gyro_lpf1_static_hz'), 'Should use gyro_lpf1_static_hz');
    assert.ok(cli.includes('dterm_lpf1_static_hz'), 'Should use dterm_lpf1_static_hz');
    assert.ok(cli.includes('set p_roll'), 'Should still include base PIDs');
  });

  it('BF 4.2 uses legacy filter param names', () => {
    const result = analyzePIDs(makeParsedData());
    const cli = generateCLICommands(result, '4.2');
    assert.ok(cli.includes('gyro_lowpass_hz'), 'Should use gyro_lowpass_hz');
    assert.ok(cli.includes('dterm_lowpass_hz'), 'Should use dterm_lowpass_hz');
    assert.ok(cli.includes('d_max_roll'), 'Should include d_max_roll');
  });
});

describe('generateTuningNotes', () => {
  it('returns empty array when current equals recommended', () => {
    const pids = { roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(pids, pids);
    assert.deepStrictEqual(notes, []);
  });

  it('generates note for positive P change with percentage', () => {
    const current = { roll: { p: 40, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 46, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].includes('Roll P'));
    assert.ok(notes[0].includes('+6'));
    assert.ok(notes[0].includes('+15%'));
    assert.ok(notes[0].includes('锁定感更强'));
  });

  it('generates note for negative D change', () => {
    const current = { roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 45, i: 80, d: 25, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].includes('Roll D'));
    assert.ok(notes[0].includes('-5'));
    assert.ok(notes[0].includes('减少高速抖动'));
  });

  it('generates note for D_Max change', () => {
    const current = { roll: { p: 45, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 45, i: 80, d: 30, f: 120, dMax: 34 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].includes('Roll D_Max'));
    assert.ok(notes[0].includes('-6'));
    assert.ok(notes[0].includes('降低动态D上限'));
  });

  it('generates notes for FF increase', () => {
    const current = { roll: { p: 45, i: 80, d: 30, f: 100, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 45, i: 80, d: 30, f: 130, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].includes('Roll FF'));
    assert.ok(notes[0].includes('+30'));
    assert.ok(notes[0].includes('前馈增强'));
  });

  it('handles zero current value (no percentage)', () => {
    const current = { roll: { p: 45, i: 80, d: 0, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 45, i: 80, d: 10, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].includes('Roll D (Base) +10'));
    assert.ok(!notes[0].includes('%'), 'Should not have percentage when current is 0');
  });

  it('generates multiple notes for multiple changes', () => {
    const current = { roll: { p: 40, i: 80, d: 30, f: 120, dMax: 40 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const recommended = { roll: { p: 50, i: 90, d: 25, f: 130, dMax: 35 }, pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 }, yaw: { p: 45, i: 90, d: 0, f: 75, dMax: 0 } };
    const notes = generateTuningNotes(current, recommended);
    assert.strictEqual(notes.length, 5); // p, i, d, f, dMax all changed for roll
  });
});
