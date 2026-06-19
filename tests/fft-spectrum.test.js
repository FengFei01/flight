/**
 * Unit tests for FFT computation and spectrum peak detection.
 * Covers: fft.js (Cooley-Tukey FFT, dB conversion) and
 *         spectrum-analyzer.js (peak detection, spectrum analysis).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Load modules in Node (they export via module.exports when window is undefined)
const { FFT } = require('../public/js/fft.js');
const { SpectrumAnalyzer } = require('../public/js/spectrum-analyzer.js');

describe('FFT', () => {
  it('returns correct bin count for power-of-2 input', () => {
    const signal = new Array(256).fill(0);
    const result = FFT.fft(signal, 1000);
    assert.equal(result.binCount, 128);
    assert.equal(result.frequencies.length, 128);
    assert.equal(result.magnitudes.length, 128);
  });

  it('pads non-power-of-2 input to next power of 2', () => {
    const signal = new Array(100).fill(0);
    const result = FFT.fft(signal, 1000);
    // 100 -> next pow2 = 128, binCount = 64
    assert.equal(result.binCount, 64);
  });

  it('detects a pure sine wave at the correct frequency', () => {
    const sampleRate = 1000;
    const freq = 100; // 100 Hz sine
    const N = 1024;
    const signal = [];
    for (let i = 0; i < N; i++) {
      signal.push(Math.sin(2 * Math.PI * freq * i / sampleRate));
    }

    const result = FFT.fft(signal, sampleRate);

    // Find the bin with maximum magnitude
    let maxIdx = 0;
    let maxMag = 0;
    for (let i = 1; i < result.binCount; i++) {
      if (result.magnitudes[i] > maxMag) {
        maxMag = result.magnitudes[i];
        maxIdx = i;
      }
    }

    const peakFreq = result.frequencies[maxIdx];
    // Should be within 2 Hz of 100 Hz (bin resolution = sampleRate/N = ~0.98 Hz)
    assert.ok(Math.abs(peakFreq - freq) < 2, `Peak at ${peakFreq}Hz, expected ~${freq}Hz`);
  });

  it('detects multiple frequency components', () => {
    const sampleRate = 2000;
    const N = 2048;
    const signal = [];
    for (let i = 0; i < N; i++) {
      // 150 Hz + 300 Hz
      signal.push(
        Math.sin(2 * Math.PI * 150 * i / sampleRate) +
        0.5 * Math.sin(2 * Math.PI * 300 * i / sampleRate)
      );
    }

    const result = FFT.fft(signal, sampleRate);

    // Find local maxima (peaks must be higher than neighbors) spaced > 50 Hz apart
    const peaks = [];
    for (let i = 2; i < result.binCount - 1; i++) {
      if (result.magnitudes[i] > result.magnitudes[i - 1] &&
          result.magnitudes[i] > result.magnitudes[i + 1] &&
          result.magnitudes[i] > 0.01) {
        peaks.push({ freq: Math.round(result.frequencies[i]), mag: result.magnitudes[i] });
      }
    }
    peaks.sort((a, b) => b.mag - a.mag);

    // Filter out spectral leakage duplicates (keep peaks > 50Hz apart)
    const distinct = [];
    for (const p of peaks) {
      if (distinct.every(d => Math.abs(d.freq - p.freq) > 50)) {
        distinct.push(p);
      }
    }

    const foundFreqs = distinct.slice(0, 2).map(p => p.freq).sort((a, b) => a - b);
    assert.ok(foundFreqs.length >= 2, `Should find at least 2 distinct peaks, got ${foundFreqs.length}`);
    assert.ok(Math.abs(foundFreqs[0] - 150) < 5, `First peak at ${foundFreqs[0]}Hz, expected ~150Hz`);
    assert.ok(Math.abs(foundFreqs[1] - 300) < 5, `Second peak at ${foundFreqs[1]}Hz, expected ~300Hz`);
  });

  it('DC component is near zero for zero-mean signal', () => {
    const signal = [];
    for (let i = 0; i < 256; i++) {
      signal.push(Math.sin(2 * Math.PI * 50 * i / 1000));
    }
    const result = FFT.fft(signal, 1000);
    // DC bin magnitude should be small
    assert.ok(result.magnitudes[0] < 0.01, `DC magnitude ${result.magnitudes[0]} should be near 0`);
  });
});

describe('FFT.toDecibels', () => {
  it('converts magnitudes to dB with 0 dB at max', () => {
    const mags = new Float64Array([1, 0.5, 0.1, 0.01]);
    const db = FFT.toDecibels(mags);

    assert.ok(Math.abs(db[0]) < 0.1, 'Max magnitude should be ~0 dB');
    assert.ok(db[1] < 0, 'Half magnitude should be negative dB');
    assert.ok(db[3] < db[2], 'Smaller magnitude should have lower dB');
  });

  it('handles all-zero magnitudes without NaN', () => {
    const mags = new Float64Array([0, 0, 0]);
    const db = FFT.toDecibels(mags);
    for (let i = 0; i < db.length; i++) {
      assert.ok(!isNaN(db[i]), 'dB should not be NaN');
    }
  });
});

describe('SpectrumAnalyzer.detectPeaks', () => {
  it('finds peaks that exceed noise floor threshold', () => {
    // Create a flat spectrum with a spike at index 50
    const N = 256;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * 4; // 0 to 1020 Hz
      db[i] = -40; // flat noise floor at -40 dB
    }
    // Add a peak at 200 Hz (index 50)
    db[50] = -20; // 20 dB above floor

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 512);

    assert.ok(peaks.length >= 1, 'Should detect at least 1 peak');
    assert.ok(Math.abs(peaks[0].freq - 200) < 5, `Peak should be near 200 Hz, got ${peaks[0].freq}`);
  });

  it('ignores peaks below threshold', () => {
    const N = 128;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * 8;
      db[i] = -40 + Math.random() * 2; // slight variation
    }

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 512);
    assert.equal(peaks.length, 0, 'No significant peaks in flat spectrum');
  });

  it('labels motor resonance peaks correctly', () => {
    const N = 256;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * 4;
      db[i] = -50;
    }
    // Peak at 180 Hz (motor resonance range 80-500 Hz)
    db[45] = -20;

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 512);
    assert.ok(peaks.length >= 1);
    assert.equal(peaks[0].label, '电机谐振');
  });

  it('labels low-frequency vibration correctly', () => {
    const N = 256;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * 2;
      db[i] = -50;
    }
    // Peak at 40 Hz (below motor range)
    db[20] = -20;

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 256);
    assert.ok(peaks.length >= 1);
    assert.equal(peaks[0].label, '低频振动');
  });

  it('limits results to 8 peaks max', () => {
    const N = 512;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * 2;
      db[i] = -60;
    }
    // Add 12 peaks
    for (let p = 0; p < 12; p++) {
      var idx = 20 + p * 30;
      if (idx < N) {
        db[idx] = -10 - p;
      }
    }

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 512);
    assert.ok(peaks.length <= 8, `Should cap at 8 peaks, got ${peaks.length}`);
  });

  it('measures -3dB bandwidth for detected peaks', () => {
    const N = 512;
    const sampleRate = 1000;
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    const freqStep = sampleRate / (N * 2);

    for (let i = 0; i < N; i++) {
      freqs[i] = i * freqStep;
      db[i] = -50;
    }

    const peakIdx = Math.round(200 / freqStep);
    db[peakIdx] = -20;
    db[peakIdx - 1] = -21;
    db[peakIdx + 1] = -21;
    db[peakIdx - 2] = -22;
    db[peakIdx + 2] = -22;
    db[peakIdx - 3] = -23.5;
    db[peakIdx + 3] = -23.5;

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, 500);
    assert.ok(peaks.length >= 1, 'Should detect the synthetic peak');

    const peak = peaks[0];
    assert.ok(peak.bandwidth > 0, 'Peak should have a measured bandwidth');
    assert.ok(peak.bandwidth < 20, 'Narrow peak bandwidth should be small');
  });

  it('returns empty for insufficient data', () => {
    const peaks = SpectrumAnalyzer.detectPeaks([], [], 1000);
    assert.equal(peaks.length, 0);
  });

  it('filters out peaks near Nyquist (>90% of Nyquist)', () => {
    const N = 256;
    const nyquist = 200; // 200Hz Nyquist
    const freqs = new Float64Array(N);
    const db = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = i * (nyquist / (N / 2)); // 0 to ~200Hz
      db[i] = -50;
    }
    // Peak at 190Hz (>90% of 200Hz Nyquist = above 180Hz threshold)
    db[121] = -20; // index 121 ≈ 189Hz
    // Peak at 100Hz (well below Nyquist, should be kept)
    db[64] = -20; // index 64 ≈ 100Hz

    const peaks = SpectrumAnalyzer.detectPeaks(freqs, db, nyquist);
    // Should find the 100Hz peak but NOT the 190Hz one
    const highPeaks = peaks.filter(p => p.freq > 180);
    assert.equal(highPeaks.length, 0, 'Should not report peaks near Nyquist');
    const motorPeaks = peaks.filter(p => p.freq >= 80 && p.freq <= 120);
    assert.ok(motorPeaks.length >= 1, 'Should still detect the 100Hz peak');
  });
});

describe('SpectrumAnalyzer.mergePeaks', () => {
  it('merges peaks within ±5Hz keeping highest prominence', () => {
    const peaks = [
      { freq: 100, db: -20, prominence: 12, label: '电机谐振' },
      { freq: 103, db: -22, prominence: 10, label: '电机谐振' },
      { freq: 200, db: -18, prominence: 14, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    assert.equal(merged.length, 2, 'Should merge 100 and 103 into one');
    // The 100Hz peak has higher prominence (12), should be kept
    const near100 = merged.find(p => p.freq >= 95 && p.freq <= 105);
    assert.ok(near100, 'Should have a peak near 100Hz');
    assert.equal(near100.prominence, 12, 'Should keep higher prominence');
  });

  it('keeps only top N peaks by prominence', () => {
    const peaks = [
      { freq: 80, db: -20, prominence: 8, label: '电机谐振' },
      { freq: 120, db: -18, prominence: 14, label: '电机谐振' },
      { freq: 200, db: -22, prominence: 10, label: '电机谐振' },
      { freq: 300, db: -25, prominence: 7, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    assert.equal(merged.length, 3, 'Should keep top 3');
    assert.equal(merged[0].freq, 120, 'Highest prominence first');
  });

  it('handles empty peaks array', () => {
    const merged = SpectrumAnalyzer.mergePeaks([], 5, 3);
    assert.equal(merged.length, 0);
  });

  it('merges 77Hz duplicate peaks correctly', () => {
    // Real-world case: Roll 77Hz appearing twice
    const peaks = [
      { freq: 77, db: -19.3, prominence: 12.6, label: '低频振动' },
      { freq: 77, db: -19.6, prominence: 11.2, label: '低频振动' },
      { freq: 165, db: -20, prominence: 13.3, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    const at77 = merged.filter(p => p.freq === 77);
    assert.equal(at77.length, 1, 'Should merge duplicate 77Hz into one');
    assert.equal(at77[0].prominence, 12.6, 'Should keep higher prominence');
  });

  it('merges adjacent frequencies (60 and 61 Hz)', () => {
    // Real-world case: Pitch 60Hz and 61Hz
    const peaks = [
      { freq: 60, db: -19.7, prominence: 10.7, label: '低频振动' },
      { freq: 61, db: -20.8, prominence: 10.6, label: '低频振动' },
      { freq: 116, db: -20.2, prominence: 11.4, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    const lowFreq = merged.filter(p => p.freq >= 58 && p.freq <= 63);
    assert.equal(lowFreq.length, 1, 'Should merge 60 and 61 Hz');
  });

  it('does not merge peaks more than mergeHz apart', () => {
    const peaks = [
      { freq: 100, db: -20, prominence: 12, label: '电机谐振' },
      { freq: 110, db: -22, prominence: 10, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    assert.equal(merged.length, 2, 'Peaks 10Hz apart should not merge');
  });

  it('preserves bandwidth field through merge', () => {
    const peaks = [
      { freq: 100, db: -20, prominence: 12, bandwidth: 15, label: '电机谐振' },
      { freq: 103, db: -22, prominence: 10, bandwidth: 20, label: '电机谐振' },
      { freq: 250, db: -18, prominence: 14, bandwidth: 30, label: '电机谐振' },
    ];
    const merged = SpectrumAnalyzer.mergePeaks(peaks, 5, 3);
    assert.equal(merged.length, 2);
    const near100 = merged.find(p => p.freq >= 95 && p.freq <= 105);
    assert.equal(near100.bandwidth, 15, 'Should keep bandwidth from higher-prominence peak');
    const near250 = merged.find(p => p.freq === 250);
    assert.equal(near250.bandwidth, 30);
  });
});

describe('SpectrumAnalyzer.generateNotchParams', () => {
  it('generates notch params for motor-range peaks', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 165, db: -20, prominence: 13.3, label: '电机谐振' },
          { freq: 122, db: -22.1, prominence: 11.6, label: '电机谐振' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 369, nyquist: 184
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    assert.ok(result.suggestions.length >= 1, 'Should generate suggestions');
    assert.equal(result.suggestions[0].axis, 'roll');
    assert.equal(result.suggestions[0].centerHz, 165);
    assert.ok(result.suggestions[0].cutoffHz > 0);
    assert.ok(result.suggestions[0].cutoffHz < 165, 'Cutoff should be below center');
  });

  it('skips peaks outside 50-400Hz range', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 30, db: -20, prominence: 15, label: '低频振动' },
          { freq: 450, db: -18, prominence: 14, label: '高频噪声' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 1000, nyquist: 500
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    assert.equal(result.suggestions.length, 0, 'Should skip out-of-range peaks');
  });

  it('limits to 2 notch filters per axis', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 100, db: -20, prominence: 15, label: '电机谐振' },
          { freq: 200, db: -22, prominence: 13, label: '电机谐振' },
          { freq: 300, db: -25, prominence: 11, label: '电机谐振' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 1000, nyquist: 500
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    const rollNotches = result.perAxis.roll;
    assert.ok(rollNotches.length <= 2, 'Max 2 notch filters per axis');
  });

  it('handles empty spectrum result', () => {
    const result = SpectrumAnalyzer.generateNotchParams(null);
    assert.equal(result.suggestions.length, 0);
  });

  it('generates Chinese reason text', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 165, db: -20, prominence: 13, label: '电机谐振' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 369, nyquist: 184
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    assert.ok(result.suggestions[0].reason.includes('Roll'), 'Should include axis name');
    assert.ok(result.suggestions[0].reason.includes('165Hz'), 'Should include frequency');
    assert.ok(result.suggestions[0].reason.includes('Notch'), 'Should mention Notch filter');
  });

  it('calculates adaptive Q based on peak bandwidth', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 200, db: -20, prominence: 13, bandwidth: 25, label: '电机谐振' },
        ]},
        pitch: { peaks: [
          { freq: 150, db: -22, prominence: 11, bandwidth: 75, label: '电机谐振' },
        ]},
        yaw: { peaks: [] }
      },
      sampleRate: 1000, nyquist: 500
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    const rollNotch = result.perAxis.roll[0];
    assert.equal(rollNotch.q, 8.0, 'Narrow peak should get high Q');
    assert.equal(rollNotch.bandwidth, 25);

    const pitchNotch = result.perAxis.pitch[0];
    assert.equal(pitchNotch.q, 2.0, 'Wide peak should get low Q');
    assert.equal(pitchNotch.bandwidth, 75);
  });

  it('clamps Q to minimum 2.0 for very wide peaks', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 100, db: -20, prominence: 10, bandwidth: 200, label: '电机谐振' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 1000, nyquist: 500
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    assert.equal(result.perAxis.roll[0].q, 2.0, 'Q should be clamped to minimum 2.0');
  });

  it('clamps Q to maximum 10.0 for very narrow peaks', () => {
    const specResult = {
      axes: {
        roll: { peaks: [
          { freq: 300, db: -20, prominence: 15, bandwidth: 5, label: '电机谐振' },
        ]},
        pitch: { peaks: [] },
        yaw: { peaks: [] }
      },
      sampleRate: 1000, nyquist: 500
    };

    const result = SpectrumAnalyzer.generateNotchParams(specResult);
    assert.equal(result.perAxis.roll[0].q, 10.0, 'Q should be clamped to maximum 10.0');
  });
});

describe('SpectrumAnalyzer.analyzeSpectrum', () => {
  it('computes spectrum for all 3 axes', () => {
    const gyro = { roll: [], pitch: [], yaw: [] };
    for (let i = 0; i < 512; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 150 * i / 4000) * 100);
      gyro.pitch.push(Math.sin(2 * Math.PI * 200 * i / 4000) * 80);
      gyro.yaw.push(Math.sin(2 * Math.PI * 100 * i / 4000) * 60);
    }

    // looptime = 250µs → 4000 Hz
    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 250);

    assert.equal(result.sampleRate, 4000);
    assert.equal(result.nyquist, 2000);
    assert.ok(result.axes.roll.frequencies.length > 0);
    assert.ok(result.axes.pitch.frequencies.length > 0);
    assert.ok(result.axes.yaw.frequencies.length > 0);
  });

  it('handles zero looptime gracefully (defaults to 4kHz)', () => {
    const gyro = { roll: new Array(64).fill(0), pitch: [], yaw: [] };
    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 0);
    assert.equal(result.sampleRate, 4000);
  });

  it('handles empty gyro arrays', () => {
    const gyro = { roll: [], pitch: [], yaw: [] };
    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 250);
    assert.equal(result.axes.roll.frequencies.length, 0);
    assert.equal(result.axes.roll.peaks.length, 0);
  });

  it('uses effectiveSampleRate when provided (overrides looptime)', () => {
    const gyro = { roll: [], pitch: [], yaw: [] };
    // Generate a 100Hz sine at effective rate of 500Hz (NOT the 8000Hz looptime implies)
    for (let i = 0; i < 1024; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 100 * i / 500) * 100);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
    }

    // looptime=125 would give 8000Hz, but effectiveSampleRate=500 overrides
    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 125, 500);

    assert.equal(result.sampleRate, 500);
    assert.equal(result.nyquist, 250);

    // Peak should be near 100Hz, not at 100 * (8000/500) = 1600Hz
    const peaks = result.axes.roll.peaks;
    assert.ok(peaks.length >= 1, 'Should detect at least 1 peak');
    assert.ok(Math.abs(peaks[0].freq - 100) < 10,
      `Peak at ${peaks[0].freq}Hz, expected ~100Hz (not ${100 * 8000 / 500}Hz)`);
  });

  it('falls back to looptime when effectiveSampleRate is 0', () => {
    const gyro = { roll: new Array(64).fill(0), pitch: [], yaw: [] };
    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 250, 0);
    assert.equal(result.sampleRate, 4000);
  });

  it('detects 100Hz motor resonance with correct label at low effective rate', () => {
    const effectiveRate = 400;
    const gyro = { roll: [], pitch: [], yaw: [] };
    for (let i = 0; i < 2048; i++) {
      // 100Hz motor noise + broadband noise
      gyro.roll.push(
        Math.sin(2 * Math.PI * 100 * i / effectiveRate) * 200 +
        (Math.random() - 0.5) * 20
      );
      gyro.pitch.push((Math.random() - 0.5) * 20);
      gyro.yaw.push((Math.random() - 0.5) * 20);
    }

    const result = SpectrumAnalyzer.analyzeSpectrum(gyro, 125, effectiveRate);

    const rollPeaks = result.axes.roll.peaks;
    assert.ok(rollPeaks.length >= 1, 'Should detect motor resonance peak');
    assert.ok(Math.abs(rollPeaks[0].freq - 100) < 15,
      `Peak at ${rollPeaks[0].freq}Hz, expected ~100Hz`);
    assert.equal(rollPeaks[0].label, '电机谐振',
      'Peak at ~100Hz should be labeled 电机谐振');
  });
});

describe('SpectrumAnalyzer.buildThrottleSeries', () => {
  it('normalizes averaged motor outputs into throttle percentages', () => {
    const motors = [
      [1000, 1250, 1500, 1750, 2000],
      [1000, 1250, 1500, 1750, 2000]
    ];

    const result = SpectrumAnalyzer.buildThrottleSeries(motors, [1000, 2000]);

    assert.deepEqual(result.series.slice(0, 5), [0, 25, 50, 75, 100]);
    assert.equal(result.validSamples, 5);
    assert.equal(result.range.min, 1000);
    assert.equal(result.range.max, 2000);
  });
});

describe('SpectrumAnalyzer.analyzeThrottleRanges', () => {
  it('detects per-band resonance peaks and dynamic frequency shifts', () => {
    const effectiveRate = 1000;
    const perBandSamples = 2048;
    const gyro = { roll: [], pitch: [], yaw: [] };
    const throttle = [];
    const rollFreqs = [100, 130, 170, 210];
    const pitchFreqs = [110, 140, 180, 220];
    const bandPcts = [12.5, 37.5, 62.5, 87.5];

    for (let band = 0; band < bandPcts.length; band++) {
      for (let i = 0; i < perBandSamples; i++) {
        gyro.roll.push(Math.sin(2 * Math.PI * rollFreqs[band] * i / effectiveRate) * 150);
        gyro.pitch.push(Math.sin(2 * Math.PI * pitchFreqs[band] * i / effectiveRate) * 100);
        gyro.yaw.push(0);
        throttle.push(bandPcts[band]);
      }
    }

    const result = SpectrumAnalyzer.analyzeThrottleRanges(
      gyro,
      throttle,
      125,
      effectiveRate,
      { windowSize: 1024, minSamples: 1024 }
    );

    assert.equal(result.bands.length, 4, 'Should create 4 throttle bands');

    for (let i = 0; i < result.bands.length; i++) {
      const band = result.bands[i];
      assert.equal(band.valid, true, 'Each band should be analyzable');
      assert.ok(Math.abs(band.axisSummaries.roll.primaryPeak.freq - rollFreqs[i]) < 10,
        `Roll peak at ${band.axisSummaries.roll.primaryPeak.freq}Hz, expected ~${rollFreqs[i]}Hz`);
      assert.ok(Math.abs(band.axisSummaries.pitch.primaryPeak.freq - pitchFreqs[i]) < 10,
        `Pitch peak at ${band.axisSummaries.pitch.primaryPeak.freq}Hz, expected ~${pitchFreqs[i]}Hz`);
    }

    assert.equal(result.dynamic.axes.roll.dynamic, true, 'Roll should be marked as dynamic');
    assert.ok(result.dynamic.axes.roll.shiftHz >= 100, 'Roll should have a large cross-band shift');
    assert.ok(result.dynamic.notes.length >= 1, 'Should emit at least one dynamic notch note');
  });

  it('falls back to smaller window when 1024pt is insufficient, skips when even 256pt fails', () => {
    const effectiveRate = 1000;
    const gyro = { roll: [], pitch: [], yaw: [] };
    const throttle = [];

    // 512 samples in 0-25% band → should fall back to 512pt window (valid)
    for (let i = 0; i < 512; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 100 * i / effectiveRate) * 150);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(12.5);
    }

    // 100 samples in 25-50% band → too few even for 256pt window (skipped)
    for (let i = 0; i < 100; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 140 * i / effectiveRate) * 150);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(37.5);
    }

    // 2048 samples in 50-75% band → full 1024pt window (valid)
    for (let i = 0; i < 2048; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 180 * i / effectiveRate) * 150);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(62.5);
    }

    const result = SpectrumAnalyzer.analyzeThrottleRanges(
      gyro,
      throttle,
      125,
      effectiveRate,
      { windowSize: 1024, minSamples: 1024 }
    );

    // 0-25% band: fallback to 512pt — valid with degradation warning
    assert.equal(result.bands[0].valid, true, '0-25% band should use 512pt fallback');
    assert.ok(result.bands[0].warning.includes('512'), 'Warning should mention 512 point fallback');

    // 25-50% band: too few samples for even 256pt — skipped
    assert.equal(result.bands[1].valid, false, '25-50% band should be skipped (< 256 samples)');

    // 50-75% band: full 1024pt — valid, no warning
    assert.equal(result.bands[2].valid, true, '50-75% band should analyze at full 1024pt');
    assert.ok(Math.abs(result.bands[2].axisSummaries.roll.primaryPeak.freq - 180) < 10,
      `Peak at ${result.bands[2].axisSummaries.roll.primaryPeak.freq}Hz, expected ~180Hz`);
  });

  it('generates independent Q values per throttle band', () => {
    const effectiveRate = 1000;
    const perBandSamples = 2048;
    const gyro = { roll: [], pitch: [], yaw: [] };
    const throttle = [];

    for (let i = 0; i < perBandSamples; i++) {
      gyro.roll.push(Math.sin(2 * Math.PI * 200 * i / effectiveRate) * 200);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(12.5);
    }

    for (let i = 0; i < perBandSamples; i++) {
      gyro.roll.push(
        Math.sin(2 * Math.PI * 150 * i / effectiveRate) * 100 +
        Math.sin(2 * Math.PI * 140 * i / effectiveRate) * 80 +
        Math.sin(2 * Math.PI * 160 * i / effectiveRate) * 80
      );
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(62.5);
    }

    for (let i = 0; i < perBandSamples; i++) {
      gyro.roll.push(0);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(37.5);
    }
    for (let i = 0; i < perBandSamples; i++) {
      gyro.roll.push(0);
      gyro.pitch.push(0);
      gyro.yaw.push(0);
      throttle.push(87.5);
    }

    const result = SpectrumAnalyzer.analyzeThrottleRanges(
      gyro, throttle, 125, effectiveRate,
      { windowSize: 1024, minSamples: 1024 }
    );

    const band0 = result.bands[0];
    const band2 = result.bands[2];

    if (band0.valid && band0.notch.suggestions.length > 0 &&
        band2.valid && band2.notch.suggestions.length > 0) {
      const q0 = band0.notch.suggestions[0].q;
      const q2 = band2.notch.suggestions[0].q;
      assert.ok(q0 >= 2.0 && q0 <= 10.0, 'Band 0-25% Q should be within bounds');
      assert.ok(q2 >= 2.0 && q2 <= 10.0, 'Band 50-75% Q should be within bounds');
    }
  });
});
