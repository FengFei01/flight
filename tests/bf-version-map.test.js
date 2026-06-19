const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapParam, detectBfVersion, generateCLIFromAnalysis, BF_VERSIONS } = require('../public/js/bf-version-map');

describe('BF_VERSIONS', () => {
  it('contains 4.2 through 4.5', () => {
    assert.deepStrictEqual(BF_VERSIONS, ['4.2', '4.3', '4.4', '4.5']);
  });
});

describe('mapParam', () => {
  it('d_max_roll on BF 4.3 returns d_max_roll', () => {
    assert.strictEqual(mapParam('d_max_roll', '4.3'), 'd_max_roll');
  });

  it('d_max_roll on BF 4.5 returns null', () => {
    assert.strictEqual(mapParam('d_max_roll', '4.5'), null);
  });

  it('d_max_pitch on BF 4.4 returns d_max_pitch', () => {
    assert.strictEqual(mapParam('d_max_pitch', '4.4'), 'd_max_pitch');
  });

  it('d_max_pitch on BF 4.5 returns null', () => {
    assert.strictEqual(mapParam('d_max_pitch', '4.5'), null);
  });

  it('d_max_yaw on BF 4.2 returns d_max_yaw', () => {
    assert.strictEqual(mapParam('d_max_yaw', '4.2'), 'd_max_yaw');
  });

  it('d_max_yaw on BF 4.5 returns null', () => {
    assert.strictEqual(mapParam('d_max_yaw', '4.5'), null);
  });

  it('gyro_lowpass_hz on BF 4.2 returns gyro_lowpass_hz', () => {
    assert.strictEqual(mapParam('gyro_lowpass_hz', '4.2'), 'gyro_lowpass_hz');
  });

  it('gyro_lowpass_hz on BF 4.3 returns gyro_lpf1_static_hz', () => {
    assert.strictEqual(mapParam('gyro_lowpass_hz', '4.3'), 'gyro_lpf1_static_hz');
  });

  it('gyro_lowpass_hz on BF 4.5 returns gyro_lpf1_static_hz', () => {
    assert.strictEqual(mapParam('gyro_lowpass_hz', '4.5'), 'gyro_lpf1_static_hz');
  });

  it('dterm_lowpass_hz on BF 4.4 returns dterm_lpf1_static_hz', () => {
    assert.strictEqual(mapParam('dterm_lowpass_hz', '4.4'), 'dterm_lpf1_static_hz');
  });

  it('dterm_lowpass_hz on BF 4.2 returns dterm_lowpass_hz', () => {
    assert.strictEqual(mapParam('dterm_lowpass_hz', '4.2'), 'dterm_lowpass_hz');
  });

  it('unknown param returns the input name', () => {
    assert.strictEqual(mapParam('p_roll', '4.5'), 'p_roll');
  });
});

describe('detectBfVersion', () => {
  it('parses "4.5.1" → "4.5"', () => {
    assert.strictEqual(detectBfVersion('4.5.1'), '4.5');
  });

  it('parses "4.3.0" → "4.3"', () => {
    assert.strictEqual(detectBfVersion('4.3.0'), '4.3');
  });

  it('parses "BTFL 4.4.2" → "4.4"', () => {
    assert.strictEqual(detectBfVersion('BTFL 4.4.2'), '4.4');
  });

  it('parses "4.2.11" → "4.2"', () => {
    assert.strictEqual(detectBfVersion('4.2.11'), '4.2');
  });

  it('defaults to "4.3" for "Unknown"', () => {
    assert.strictEqual(detectBfVersion('Unknown'), '4.3');
  });

  it('defaults to "4.3" for empty string', () => {
    assert.strictEqual(detectBfVersion(''), '4.3');
  });

  it('defaults to "4.3" for null', () => {
    assert.strictEqual(detectBfVersion(null), '4.3');
  });

  it('defaults to "4.3" for undefined', () => {
    assert.strictEqual(detectBfVersion(undefined), '4.3');
  });

  it('defaults to "4.3" for unrecognized major version', () => {
    assert.strictEqual(detectBfVersion('3.5.7'), '4.3');
  });
});

describe('generateCLIFromAnalysis', () => {
  const testData = {
    recommended: {
      roll:  { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
      pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
      yaw:   { p: 45, i: 90, d: 0,  f: 75,  dMax: 0 },
    },
    filters: { gyro_lowpass_hz: 250, dterm_lowpass_hz: 150 },
    header: { firmware: 'Betaflight', firmwareVersion: '4.5.0', craftName: 'TestQuad' },
  };

  it('BF 4.5 omits d_max_* lines', () => {
    const cli = generateCLIFromAnalysis(testData, '4.5');
    assert.ok(!cli.includes('d_max_roll'), 'Should not contain d_max_roll');
    assert.ok(!cli.includes('d_max_pitch'), 'Should not contain d_max_pitch');
    assert.ok(!cli.includes('d_max_yaw'), 'Should not contain d_max_yaw');
  });

  it('BF 4.5 includes Simplified Tuning note', () => {
    const cli = generateCLIFromAnalysis(testData, '4.5');
    assert.ok(cli.includes('Simplified Tuning'), 'Should mention Simplified Tuning');
  });

  it('BF 4.5 uses gyro_lpf1_static_hz', () => {
    const cli = generateCLIFromAnalysis(testData, '4.5');
    assert.ok(cli.includes('gyro_lpf1_static_hz'), 'Should use gyro_lpf1_static_hz');
    assert.ok(!cli.includes('gyro_lowpass_hz'), 'Should not use gyro_lowpass_hz');
  });

  it('BF 4.5 uses dterm_lpf1_static_hz', () => {
    const cli = generateCLIFromAnalysis(testData, '4.5');
    assert.ok(cli.includes('dterm_lpf1_static_hz'), 'Should use dterm_lpf1_static_hz');
    assert.ok(!cli.includes('dterm_lowpass_hz'), 'Should not use dterm_lowpass_hz');
  });

  it('BF 4.2 includes d_max_* lines', () => {
    const cli = generateCLIFromAnalysis(testData, '4.2');
    assert.ok(cli.includes('set d_max_roll = 40'), 'Should include d_max_roll');
    assert.ok(cli.includes('set d_max_pitch = 42'), 'Should include d_max_pitch');
  });

  it('BF 4.2 uses gyro_lowpass_hz', () => {
    const cli = generateCLIFromAnalysis(testData, '4.2');
    assert.ok(cli.includes('set gyro_lowpass_hz = 250'), 'Should use gyro_lowpass_hz');
    assert.ok(cli.includes('set dterm_lowpass_hz = 150'), 'Should use dterm_lowpass_hz');
  });

  it('BF 4.3 includes d_max_* and uses gyro_lpf1_static_hz', () => {
    const cli = generateCLIFromAnalysis(testData, '4.3');
    assert.ok(cli.includes('d_max_roll'), 'Should include d_max_roll');
    assert.ok(cli.includes('gyro_lpf1_static_hz'), 'Should use gyro_lpf1_static_hz');
  });

  it('always includes base PID params regardless of version', () => {
    for (const ver of ['4.2', '4.3', '4.4', '4.5']) {
      const cli = generateCLIFromAnalysis(testData, ver);
      assert.ok(cli.includes('set p_roll = 45'), `BF ${ver}: missing p_roll`);
      assert.ok(cli.includes('set i_roll = 80'), `BF ${ver}: missing i_roll`);
      assert.ok(cli.includes('set d_roll = 30'), `BF ${ver}: missing d_roll`);
      assert.ok(cli.includes('set f_roll = 120'), `BF ${ver}: missing f_roll`);
    }
  });

  it('includes target BF version in header', () => {
    const cli = generateCLIFromAnalysis(testData, '4.4');
    assert.ok(cli.includes('# Target: Betaflight 4.4'));
  });

  it('always ends with save', () => {
    const cli = generateCLIFromAnalysis(testData, '4.5');
    assert.ok(cli.trimEnd().endsWith('save'));
  });
});
