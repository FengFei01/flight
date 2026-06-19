'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMotorHealth, analyzeSymmetry } = require('../lib/motor-health');

function makeAxisSpectrum({ frequencies, magnitudesDB, peaks } = {}) {
  const N = 256;
  const defaultFreqs = new Array(N);
  const defaultDB = new Array(N);
  for (let i = 0; i < N; i++) {
    defaultFreqs[i] = i * 2;   // 0–510 Hz
    // Realistic healthy spectrum: low-freq around -30 dB, high-freq drops to -50 dB
    defaultDB[i] = defaultFreqs[i] <= 300 ? -30 : -50;
  }
  return {
    frequencies: frequencies || defaultFreqs,
    magnitudesDB: magnitudesDB || defaultDB,
    peaks: peaks || [],
  };
}

function makeBand({ avgThrottle, rollSpectrum, pitchSpectrum, yawSpectrum, valid } = {}) {
  return {
    valid: valid !== false,
    averageThrottle: avgThrottle || 50,
    spectrum: {
      axes: {
        roll: rollSpectrum || makeAxisSpectrum(),
        pitch: pitchSpectrum || makeAxisSpectrum(),
        yaw: yawSpectrum || makeAxisSpectrum(),
      },
      sampleRate: 1000,
      nyquist: 500,
    },
    axisSummaries: {
      roll: { peaks: [], motorPeaks: [], primaryPeak: null },
      pitch: { peaks: [], motorPeaks: [], primaryPeak: null },
      yaw: { peaks: [], motorPeaks: [], primaryPeak: null },
    },
  };
}

function makeThrottleAnalysis(bands) {
  return {
    bands,
    sampleRate: 1000,
    nyquist: 500,
    windowSize: 1024,
    minSamples: 1024,
    totalSamples: 4096,
  };
}

describe('analyzeMotorHealth', () => {
  it('returns all Healthy for normal flat spectra', () => {
    const bands = [
      makeBand({ avgThrottle: 12.5 }),
      makeBand({ avgThrottle: 37.5 }),
      makeBand({ avgThrottle: 62.5 }),
      makeBand({ avgThrottle: 87.5 }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.ok(result.axes[axis].score >= 80, `${axis} score ${result.axes[axis].score} should be >= 80`);
      assert.equal(result.axes[axis].rating, 'healthy');
      assert.equal(result.axes[axis].issues.length, 0);
    }
    assert.equal(result.overall.rating, 'healthy');
  });

  it('detects Bearing Wear when high-freq noise floor is elevated', () => {
    const N = 256;
    const frequencies = new Array(N);
    const magnitudesDB = new Array(N);
    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2;
      magnitudesDB[i] = frequencies[i] <= 300 ? -30 : -35;
    }

    const badSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB });
    const bands = [
      makeBand({ avgThrottle: 50, rollSpectrum: badSpectrum }),
      makeBand({ avgThrottle: 75, rollSpectrum: badSpectrum }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    const rollIssues = result.axes.roll.issues;
    assert.ok(rollIssues.some(i => i.type === 'bearing_wear'), 'Should detect bearing wear');
    assert.ok(result.axes.roll.rating === 'warning' || result.axes.roll.rating === 'critical',
      'Roll should be warning or critical');
  });

  it('detects Imbalance from a 1x RPM peak', () => {
    const avgThrottle = 50;
    const rpm = 3000 + (avgThrottle / 100) * 27000; // 16500
    const f1x = rpm / 60; // 275 Hz

    const peaks = [{ freq: 275, db: -15, prominence: 14, bandwidth: 10, label: '电机谐振' }];
    const rollSpectrum = makeAxisSpectrum({ peaks });

    const bands = [makeBand({ avgThrottle, rollSpectrum })];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    const rollIssues = result.axes.roll.issues;
    assert.ok(rollIssues.some(i => i.type === 'imbalance'), 'Should detect imbalance');
    const imbIssue = rollIssues.find(i => i.type === 'imbalance');
    assert.ok(imbIssue.detail.includes('275'), 'Detail should mention the 1x frequency');
  });

  it('detects Prop Damage from harmonic peaks', () => {
    const avgThrottle = 40;
    const rpm = 3000 + (avgThrottle / 100) * 27000; // 13800
    const f1x = rpm / 60; // 230 Hz
    const f2x = f1x * 2; // 460 Hz

    const peaks = [
      { freq: Math.round(f1x), db: -15, prominence: 12, bandwidth: 10, label: '电机谐振' },
      { freq: Math.round(f2x), db: -20, prominence: 8, bandwidth: 10, label: '高频噪声' },
    ];
    const rollSpectrum = makeAxisSpectrum({ peaks });

    const bands = [makeBand({ avgThrottle, rollSpectrum })];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    const rollIssues = result.axes.roll.issues;
    assert.ok(rollIssues.some(i => i.type === 'prop_damage'), 'Should detect prop damage');
  });

  it('detects Motor Mismatch when roll and pitch spectra differ', () => {
    const N = 256;
    const frequencies = new Array(N);
    const rollDB = new Array(N);
    const pitchDB = new Array(N);
    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2;
      rollDB[i] = -30 + 15 * Math.sin(i * 0.1);
      pitchDB[i] = -30 + 15 * Math.cos(i * 0.3);
    }

    const rollSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB: rollDB });
    const pitchSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB: pitchDB });

    const bands = [makeBand({ rollSpectrum, pitchSpectrum })];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    assert.ok(result.issues.some(i => i.type === 'motor_mismatch'),
      'Should detect motor mismatch');
  });

  it('returns score 100 when no valid bands exist', () => {
    const bands = [
      makeBand({ valid: false }),
      makeBand({ valid: false }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    assert.equal(result.overall.score, 100);
    assert.equal(result.overall.rating, 'healthy');
    assert.equal(result.issues.length, 0);
  });

  it('handles null and empty input without crashing', () => {
    const r1 = analyzeMotorHealth(null);
    assert.equal(r1.overall.score, 100);
    assert.equal(r1.overall.rating, 'healthy');

    const r2 = analyzeMotorHealth({});
    assert.equal(r2.overall.score, 100);
    assert.equal(r2.overall.rating, 'healthy');

    const r3 = analyzeMotorHealth({ bands: [] });
    assert.equal(r3.overall.score, 100);
  });

  it('escalates severity when issue appears in 3+ bands', () => {
    const avgThrottle = 50;
    const peaks = [{ freq: 275, db: -15, prominence: 10, bandwidth: 10, label: '电机谐振' }];
    const rollSpectrum = makeAxisSpectrum({ peaks });

    const bands = [
      makeBand({ avgThrottle, rollSpectrum }),
      makeBand({ avgThrottle, rollSpectrum }),
      makeBand({ avgThrottle, rollSpectrum }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    const imbIssue = result.axes.roll.issues.find(i => i.type === 'imbalance');
    assert.ok(imbIssue, 'Should detect imbalance');
    assert.equal(imbIssue.bandCount, 3);
    assert.equal(imbIssue.severity, 'moderate', 'mild→moderate after appearing in 3 bands');
  });

  it('overall score is the minimum across axes', () => {
    const N = 256;
    const frequencies = new Array(N);
    const elevatedDB = new Array(N);
    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2;
      elevatedDB[i] = frequencies[i] <= 300 ? -30 : -33;
    }
    const badSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB: elevatedDB });

    const bands = [makeBand({ avgThrottle: 50, rollSpectrum: badSpectrum, pitchSpectrum: badSpectrum })];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    const minScore = Math.min(result.axes.roll.score, result.axes.pitch.score, result.axes.yaw.score);
    assert.equal(result.overall.score, minScore,
      'Overall score should equal the worst axis');
    assert.ok(result.overall.score < 100, 'Score should be penalized');
  });
});

describe('analyzeSymmetry', () => {
  it('returns score 100 for identical axis scores', () => {
    const bands = [
      makeBand({ avgThrottle: 50 }),
      makeBand({ avgThrottle: 75 }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    assert.equal(result.symmetry.score, 100);
    assert.equal(result.symmetry.rating, 'healthy');
    assert.deepEqual(result.symmetry.outliers, []);
    assert.equal(result.symmetry.diagnosis.type, 'balanced');
  });

  it('flags single outlier axis', () => {
    const N = 256;
    const frequencies = new Array(N);
    const elevatedDB = new Array(N);
    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2;
      elevatedDB[i] = frequencies[i] <= 300 ? -30 : -35;
    }
    const badSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB: elevatedDB });

    const bands = [
      makeBand({ avgThrottle: 50, rollSpectrum: badSpectrum }),
      makeBand({ avgThrottle: 75, rollSpectrum: badSpectrum }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    assert.ok(result.axes.roll.score < result.axes.pitch.score,
      'Roll should score lower than pitch');
    if (result.axes.pitch.score - result.axes.roll.score > 15) {
      assert.ok(result.symmetry.outliers.includes('roll'),
        'Roll should be flagged as outlier');
      assert.equal(result.symmetry.diagnosis.type, 'single_motor');
      assert.ok(result.symmetry.diagnosis.message.includes('Roll'),
        'Diagnosis should mention the outlier axis');
    }
  });

  it('flags multi-motor issue', () => {
    const N = 256;
    const frequencies = new Array(N);
    const elevatedDB = new Array(N);
    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2;
      elevatedDB[i] = frequencies[i] <= 300 ? -30 : -28;
    }
    const badSpectrum = makeAxisSpectrum({ frequencies, magnitudesDB: elevatedDB });

    const bands = [
      makeBand({ avgThrottle: 50, rollSpectrum: badSpectrum, pitchSpectrum: badSpectrum }),
      makeBand({ avgThrottle: 75, rollSpectrum: badSpectrum, pitchSpectrum: badSpectrum }),
      makeBand({ avgThrottle: 87, rollSpectrum: badSpectrum, pitchSpectrum: badSpectrum }),
    ];
    const result = analyzeMotorHealth(makeThrottleAnalysis(bands));

    assert.ok(result.axes.roll.score < result.axes.yaw.score,
      'Roll and pitch should score lower than yaw');
    assert.ok(result.symmetry.outliers.length >= 2,
      'Should flag multiple outliers');
    assert.equal(result.symmetry.diagnosis.type, 'multi_motor');
  });

  it('symmetry score decreases with axis divergence', () => {
    const axes1 = {
      roll: { score: 100, rating: 'healthy', issues: [] },
      pitch: { score: 100, rating: 'healthy', issues: [] },
      yaw: { score: 100, rating: 'healthy', issues: [] },
    };
    const axes2 = {
      roll: { score: 100, rating: 'healthy', issues: [] },
      pitch: { score: 100, rating: 'healthy', issues: [] },
      yaw: { score: 60, rating: 'warning', issues: [] },
    };
    const sym1 = analyzeSymmetry(axes1);
    const sym2 = analyzeSymmetry(axes2);

    assert.ok(sym2.score < sym1.score,
      'Divergent axes should have lower symmetry score');
  });

  it('flags two simultaneously low axes against the best performer', () => {
    const axes = {
      roll:  { score: 90, rating: 'healthy', issues: [] },
      pitch: { score: 45, rating: 'critical', issues: [] },
      yaw:   { score: 42, rating: 'critical', issues: [] },
    };
    const sym = analyzeSymmetry(axes);

    assert.ok(sym.score < 80, 'Symmetry score should be below healthy threshold (80), got ' + sym.score);
    assert.notEqual(sym.rating, 'healthy', 'Rating should not be healthy');
    assert.ok(sym.outliers.includes('pitch'), 'pitch should be an outlier');
    assert.ok(sym.outliers.includes('yaw'), 'yaw should be an outlier');
    assert.equal(sym.diagnosis.type, 'multi_motor');
  });

  it('default result includes symmetry', () => {
    const result = analyzeMotorHealth(null);
    assert.ok(result.symmetry, 'Default result should include symmetry');
    assert.equal(result.symmetry.score, 100);
    assert.equal(result.symmetry.rating, 'healthy');
    assert.deepEqual(result.symmetry.outliers, []);
    assert.equal(result.symmetry.diagnosis.type, 'balanced');
  });
});
